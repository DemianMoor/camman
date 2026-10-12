import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";

// Migration 0204 triggers, on the PREVIEW DB, inside one transaction that is
// rolled back (no residue).
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-carry-over-trigger.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
class Rollback extends Error {}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: SQL) => ((await tx.execute(q)) as unknown as T[])[0];
      const orgId = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES ('__CARRY_TRIGGER_TEST__') RETURNING id`)).id;
      await tx.execute(sql`INSERT INTO org_settings (org_id) VALUES (${orgId}::uuid)
                           ON CONFLICT (org_id) DO NOTHING`);
      const camp = async (carry: number | null, cutoff: number | null) => {
        const id = (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type)
          VALUES (${orgId}::uuid, ${"ct-" + Math.random().toString(36).slice(2, 9)}, 'CT', 'active', 'drip')
          RETURNING id`)).id;
        await tx.execute(sql`
          INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, carry_days, admission_cutoff_minutes)
          VALUES (${id}, ${orgId}::uuid, 'ct', ${carry}, ${cutoff})`);
        return id;
      };
      const stamp = async (id: number) =>
        (await one<{ w: string | null }>(sql`
          SELECT admission_widened_at AS w FROM drip_campaign_configs WHERE campaign_id = ${id}`)).w;
      const orgStamp = async () =>
        (await one<{ w: string | null }>(sql`
          SELECT drip_admission_widened_at AS w FROM org_settings WHERE org_id = ${orgId}::uuid`)).w;
      const clear = (id: number) => tx.execute(sql`
        UPDATE drip_campaign_configs SET admission_widened_at = NULL WHERE campaign_id = ${id}`);

      const a = await camp(null, null);
      bar("T1 INSERT with window 0 → no stamp", (await stamp(a)) === null);
      const b = await camp(1, null);
      bar("T2 INSERT with carry 1 → stamped", (await stamp(b)) !== null);

      await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = 2 WHERE campaign_id = ${a}`);
      bar("T3 raise carry 0→2 → stamped", (await stamp(a)) !== null);
      await clear(a);
      await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = 1 WHERE campaign_id = ${a}`);
      bar("T4 lower carry 2→1 → NOT stamped", (await stamp(a)) === null);
      await tx.execute(sql`UPDATE drip_campaign_configs SET admission_cutoff_minutes = 30 WHERE campaign_id = ${a}`);
      bar("T5 raise cutoff → stamped", (await stamp(a)) !== null);
      await clear(a);
      await tx.execute(sql`UPDATE drip_campaign_configs SET priority = 5 WHERE campaign_id = ${a}`);
      bar("T6 unrelated column → NOT stamped", (await stamp(a)) === null);

      // Upsert path used by PUT /drip-config: INSERT … ON CONFLICT DO UPDATE
      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, carry_days)
        VALUES (${a}, ${orgId}::uuid, 'ct', 3)
        ON CONFLICT (campaign_id) DO UPDATE SET carry_days = EXCLUDED.carry_days`);
      bar("T7 upsert raise 1→3 → stamped", (await stamp(a)) !== null);

      bar("T8 org INSERT default → no stamp", (await orgStamp()) === null);
      await tx.execute(sql`UPDATE org_settings SET drip_carry_days = 1 WHERE org_id = ${orgId}::uuid`);
      bar("T9 org raise → org stamped", (await orgStamp()) !== null);

      let rejected = false;
      try {
        await tx.execute(sql`SAVEPOINT s8`);
        await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = 8 WHERE campaign_id = ${a}`);
      } catch { rejected = true; await tx.execute(sql`ROLLBACK TO SAVEPOINT s8`); }
      bar("T10 carry_days 8 rejected by CHECK", rejected);

      const cd = (await one<{ d: number }>(sql`
        SELECT column_default AS d FROM information_schema.columns
        WHERE table_name = 'drip_journeys' AND column_name = 'carried_days'`)).d;
      bar("T11 drip_journeys.carried_days default 0", String(cd) === "0", String(cd));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL PASS (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
