import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-cap-schema.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const cols = (await db.execute(sql`
    SELECT table_name || '.' || column_name AS c, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE (table_name, column_name) IN (('drip_campaign_configs','hourly_cap'),('drip_campaign_configs','hourly_carry'),
      ('drip_journeys','hour_start'),('drip_journeys','hour_fresh'),('org_settings','drip_hourly_cap_enabled'))
  `)) as unknown as { c: string; data_type: string; is_nullable: string; column_default: string | null }[];
  const by = new Map(cols.map((r) => [r.c, r]));
  bar("S1 hourly_cap int nullable", by.get("drip_campaign_configs.hourly_cap")?.data_type === "integer" && by.get("drip_campaign_configs.hourly_cap")?.is_nullable === "YES");
  bar("S2 hourly_carry bool default false", by.get("drip_campaign_configs.hourly_carry")?.column_default === "false" && by.get("drip_campaign_configs.hourly_carry")?.is_nullable === "NO");
  bar("S3 hour_start timestamptz", by.get("drip_journeys.hour_start")?.data_type === "timestamp with time zone");
  bar("S4 hour_fresh boolean", by.get("drip_journeys.hour_fresh")?.data_type === "boolean");
  bar("S5 org flag default false", by.get("org_settings.drip_hourly_cap_enabled")?.column_default === "false");

  const cons = (await db.execute(sql`
    SELECT conname FROM pg_constraint
    WHERE conname IN ('drip_campaign_configs_hourly_cap_check','drip_journeys_hour_pair_check')`)) as unknown as { conname: string }[];
  bar("S6 both CHECKs exist", cons.length === 2, cons.map((c) => c.conname).join(","));

  const idx = (await db.execute(sql`
    SELECT indexname FROM pg_indexes WHERE indexname IN
      ('drip_journeys_campaign_first_send_idx','drip_journeys_hourly_queue_idx','drip_journeys_missed_hour_idx')`)) as unknown as { indexname: string }[];
  bar("S7 three indexes exist", idx.length === 3, idx.map((i) => i.indexname).join(","));

  // CHECK behaviour. Preview may hold no drip rows, so each probe INSERTs its own
  // throwaway row inside a transaction that is ALWAYS rolled back, with FK/trigger
  // enforcement off (session_replication_role = replica; CHECKs still apply). A
  // positive control (a valid row is accepted) guards against a vacuous pass.
  const columnsExist = cols.length === 5;
  const probe = async (insertSql: (bad: boolean) => ReturnType<typeof sql>, bad: boolean) => {
    let outcome = "accepted";
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(insertSql(bad));
        throw new Error("ROLLBACK_OK");
      });
    } catch (e) {
      const err = e as Error & { constraint_name?: string; cause?: { constraint_name?: string; message?: string } };
      outcome = err.message === "ROLLBACK_OK" ? "accepted" : `${err.constraint_name ?? err.cause?.constraint_name ?? ""}|${err.cause?.message ?? err.message}`;
    }
    return outcome;
  };
  const cfgInsert = (bad: boolean) => sql`
    INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, hourly_cap)
    VALUES (2147483000, gen_random_uuid(), 'schema-test', ${bad ? 0 : 5})`;
  const jnyInsert = (bad: boolean) => sql`
    INSERT INTO drip_journeys (org_id, contact_id, lead_event_id, campaign_id, state, hour_start, hour_fresh)
    VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 2147483000, 'routed', now(), ${bad ? sql`NULL` : sql`true`})`;
  if (columnsExist) {
    const cOk = await probe(cfgInsert, false);
    const cBad = await probe(cfgInsert, true);
    bar("S8a valid hourly_cap=5 accepted (control)", cOk === "accepted", cOk === "accepted" ? "" : cOk);
    bar("S8 hourly_cap = 0 rejected by CHECK", cBad.startsWith("drip_campaign_configs_hourly_cap_check|"), cBad);
    const jOk = await probe(jnyInsert, false);
    const jBad = await probe(jnyInsert, true);
    bar("S9a valid hour pair accepted (control)", jOk === "accepted", jOk === "accepted" ? "" : jOk);
    bar("S9 hour_start without hour_fresh rejected by CHECK", jBad.startsWith("drip_journeys_hour_pair_check|"), jBad);
  } else {
    bar("S8 hourly_cap = 0 rejected by CHECK", false, "columns missing");
    bar("S9 hour_start without hour_fresh rejected by CHECK", false, "columns missing");
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
