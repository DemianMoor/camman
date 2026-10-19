// scripts/test-message-formats-db.ts — migration 0216 on the PREVIEW DB (M1.*).
// Every write happens inside one transaction that is rolled back.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-message-formats-db.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { SEED_FORMATS } from "@/lib/messages/format";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Run `fn` in a savepoint; return the Postgres error code it raised, or null. */
async function errCode(tx: Tx, fn: (t: Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await tx.transaction(async (t) => { await fn(t); });
    return null;
  } catch (e) {
    const c = (e as { code?: string; cause?: { code?: string } });
    return c.code ?? c.cause?.code ?? "unknown";
  }
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  try {
    await db.transaction(async (tx) => {
      const orgs = (await tx.execute(sql`
        SELECT o.id,
               count(mf.id)::int AS n,
               count(*) FILTER (WHERE mf.is_default)::int AS defaults,
               json_agg(json_build_object('name', mf.name, 'template', mf.template, 'is_default', mf.is_default) ORDER BY mf.id) AS formats
        FROM organizations o LEFT JOIN message_formats mf ON mf.org_id = o.id
        GROUP BY o.id`)) as unknown as { id: string; n: number; defaults: number; formats: { name: string; template: string; is_default: boolean }[] }[];
      const seeds = JSON.stringify(SEED_FORMATS.map((f) => ({ name: f.name, template: f.template, is_default: f.isDefault })));
      bar("M1.1 every org seeded with exactly T1/T2/T3 = SEED_FORMATS, one default",
        orgs.length > 0 && orgs.every((o) => o.n === 3 && o.defaults === 1 && JSON.stringify(o.formats) === seeds),
        `${orgs.length} orgs`);

      const bad = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE (message_format_id IS NULL) = (custom_text IS NULL))::int AS bad,
               count(*) FILTER (WHERE s.message_format_id <> mf.id)::int AS not_default,
               count(*)::int AS n
        FROM campaign_stages s
        LEFT JOIN message_formats mf ON mf.org_id = s.org_id AND mf.is_default`)) as unknown as { bad: number; not_default: number; n: number }[];
      bar("M1.2 every existing stage backfilled to its org's T1 default", bad[0].bad === 0 && bad[0].not_default === 0, JSON.stringify(bad[0]));

      const camp = (await tx.execute(sql`SELECT id, org_id FROM campaigns ORDER BY id LIMIT 1`)) as unknown as { id: number; org_id: string }[];
      const c = camp[0];
      const ins = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${c.org_id}, ${c.id})
        RETURNING id, message_format_id, custom_text`)) as unknown as { id: number; message_format_id: number; custom_text: string | null }[];
      const def = (await tx.execute(sql`SELECT id FROM message_formats WHERE org_id = ${c.org_id} AND is_default`)) as unknown as { id: number }[];
      bar("M1.3 raw stage INSERT without format columns gets the org default", ins[0].message_format_id === def[0].id && ins[0].custom_text === null);

      bar("M1.4 both columns set violates campaign_stages_format_one_of (23514)",
        (await errCode(tx, (t) => t.execute(sql`INSERT INTO campaign_stages (org_id, campaign_id, message_format_id, custom_text) VALUES (${c.org_id}, ${c.id}, ${def[0].id}, 'x {creative_text}{url}{stop_text}')`))) === "23514");
      bar("M1.5 custom_text alone is accepted (trigger leaves it)",
        (await errCode(tx, (t) => t.execute(sql`INSERT INTO campaign_stages (org_id, campaign_id, custom_text) VALUES (${c.org_id}, ${c.id}, '{creative_text}{url}{stop_text}')`))) === null);
      bar("M1.6 deleting an in-use format is refused (RESTRICT, 23503)",
        (await errCode(tx, (t) => t.execute(sql`DELETE FROM message_formats WHERE id = ${def[0].id}`))) === "23503");
      bar("M1.7 a second default for the org is refused (23505)",
        (await errCode(tx, (t) => t.execute(sql`UPDATE message_formats SET is_default = true WHERE org_id = ${c.org_id} AND NOT is_default`))) === "23505");
      bar("M1.8 the default cannot be disabled (23514)",
        (await errCode(tx, (t) => t.execute(sql`UPDATE message_formats SET is_enabled = false WHERE id = ${def[0].id}`))) === "23514");

      const org = (await tx.execute(sql`INSERT INTO organizations (name) VALUES ('msgfmt-test-org') RETURNING id`)) as unknown as { id: string }[];
      const st = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org[0].id}, ${c.id}) RETURNING message_format_id`)) as unknown as { message_format_id: number }[];
      const seeded = (await tx.execute(sql`SELECT count(*)::int AS n FROM message_formats WHERE org_id = ${org[0].id}`)) as unknown as { n: number }[];
      bar("M1.9 a new org with no formats is seeded by its first stage insert", seeded[0].n === 3 && st[0].message_format_id != null);
      const again = (await tx.execute(sql`SELECT public.ensure_message_formats(${org[0].id}) AS id`)) as unknown as { id: number }[];
      bar("M1.10 ensure_message_formats is idempotent (returns the same default)", again[0].id === st[0].message_format_id);

      const cols = (await tx.execute(sql`
        SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'stage_sends' AND column_name IN ('message_format_id', 'format_custom')
        ORDER BY column_name`)) as unknown as { column_name: string; data_type: string; column_default: string | null; is_nullable: string }[];
      bar("M1.11 stage_sends stamp columns: format_custom boolean NOT NULL DEFAULT false, message_format_id integer NULL",
        cols.length === 2 && cols[0].column_name === "format_custom" && cols[0].column_default === "false" && cols[0].is_nullable === "NO"
          && cols[1].data_type === "integer" && cols[1].is_nullable === "YES", JSON.stringify(cols));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL GREEN (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
