import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";

// Migration 0208 (drip_daily_rollup + org_settings.drip_daily_results_enabled)
// on the PREVIEW DB, inside one transaction that is rolled back (no residue).
// Each refusal runs under a SAVEPOINT so the transaction survives it.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-daily-rollup-schema.ts
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
      // The constraint name a statement is refused with, or null if it succeeded.
      let sp = 0;
      const refusal = async (q: SQL): Promise<string | null> => {
        const name = `s${++sp}`;
        await tx.execute(sql.raw(`SAVEPOINT ${name}`));
        try {
          await tx.execute(q);
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
          return null;
        } catch (e) {
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
          const c = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
          return `${c?.code ?? "?"}:${c?.constraint_name ?? ""}`;
        }
      };

      const reg = await one<{ t: string | null; rls: boolean; pol: number }>(sql`
        SELECT to_regclass('public.drip_daily_rollup')::text AS t,
               COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.drip_daily_rollup')), false) AS rls,
               (SELECT count(*)::int FROM pg_policies WHERE tablename = 'drip_daily_rollup' AND cmd = 'SELECT') AS pol`);
      if (!reg.t) {
        console.log("  ✗ drip_daily_rollup does not exist — 0208 not applied to this DB");
        process.exit(1);
      }
      bar("S1 table exists, RLS on, one SELECT policy", reg.rls && reg.pol === 1, JSON.stringify(reg));

      const orgId = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES ('__DRIP_DAILY_ROLLUP_SCHEMA_TEST__') RETURNING id`)).id;
      const flag = await one<{ v: boolean }>(sql`
        INSERT INTO org_settings (org_id) VALUES (${orgId}::uuid)
        ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
        RETURNING drip_daily_results_enabled AS v`);
      bar("S2 org_settings.drip_daily_results_enabled defaults false", flag.v === false);

      const cid = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}::uuid, ${"ddr-" + Math.random().toString(36).slice(2, 9)}, 'DDR', 'paused', 'drip') RETURNING id`)).id;
      const sid = (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number) VALUES (${orgId}::uuid, ${cid}, 1) RETURNING id`)).id;
      const pid = (await one<{ id: number }>(sql`
        INSERT INTO partners (org_id, name, slug) VALUES (${orgId}::uuid, 'DDR partner', ${"ddr" + Date.now()}) RETURNING id`)).id;
      const kid = (await one<{ id: number }>(sql`
        INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, secret_last4, interest_tag_mode)
        VALUES (${orgId}::uuid, ${pid}, ${"ddr" + Date.now()}, 'DDR key', ${"tok-" + Math.random()}, 'x', 'abcd', 'default')
        RETURNING id`)).id;

      const ins = (cols: SQL) => sql`
        INSERT INTO drip_daily_rollup (org_id, campaign_id, basis, day_et, stage_id, partner_key_id, ${cols})`;
      const ok = await refusal(sql`${ins(sql`admitted, admitted_carried, leads_admitted) VALUES
        (${orgId}::uuid, ${cid}, 'activity', '2026-10-10', NULL, ${kid}, 10, 2, 9`)}`);
      bar("S3 valid lead row inserts", ok === null, String(ok));
      const ok2 = await refusal(sql`${ins(sql`first_sends, clicks, revenue, send_cost, latency_hist) VALUES
        (${orgId}::uuid, ${cid}, 'activity', '2026-10-10', ${sid}, NULL, 5, 1, 3.5, 0.06, '{0,2,3}'`)}`);
      bar("S4 valid Unattributed stage row inserts", ok2 === null, String(ok2));

      bar("S5 basis 'other' refused",
        (await refusal(sql`${ins(sql`admitted) VALUES (${orgId}::uuid, ${cid}, 'other', '2026-10-10', NULL, NULL, 1`)}`))
          === "23514:drip_daily_rollup_basis_check");
      bar("S6 lead row carrying a send counter refused",
        (await refusal(sql`${ins(sql`first_sends) VALUES (${orgId}::uuid, ${cid}, 'activity', '2026-10-11', NULL, NULL, 1`)}`))
          === "23514:drip_daily_rollup_row_kind");
      bar("S7 stage row carrying a lead counter refused",
        (await refusal(sql`${ins(sql`admitted) VALUES (${orgId}::uuid, ${cid}, 'activity', '2026-10-11', ${sid}, NULL, 1`)}`))
          === "23514:drip_daily_rollup_row_kind");
      bar("S8 carried > admitted refused",
        (await refusal(sql`${ins(sql`admitted, admitted_carried) VALUES (${orgId}::uuid, ${cid}, 'cohort', '2026-10-11', NULL, NULL, 1, 2`)}`))
          === "23514:drip_daily_rollup_nonneg");
      bar("S9 delivered > dlr_sent refused",
        (await refusal(sql`${ins(sql`dlr_sent, delivered) VALUES (${orgId}::uuid, ${cid}, 'cohort', '2026-10-11', ${sid}, NULL, 1, 2`)}`))
          === "23514:drip_daily_rollup_nonneg");
      bar("S10 duplicate lead cell (NULL stage) refused — NULLS NOT DISTINCT",
        (await refusal(sql`${ins(sql`admitted) VALUES (${orgId}::uuid, ${cid}, 'activity', '2026-10-10', NULL, ${kid}, 1`)}`))
          === "23505:drip_daily_rollup_cell_uniq");
      bar("S11 duplicate Unattributed cell (NULL key) refused",
        (await refusal(sql`${ins(sql`first_sends) VALUES (${orgId}::uuid, ${cid}, 'activity', '2026-10-10', ${sid}, NULL, 1`)}`))
          === "23505:drip_daily_rollup_cell_uniq");
      bar("S12 same cell under the other basis is a different cell",
        (await refusal(sql`${ins(sql`first_sends) VALUES (${orgId}::uuid, ${cid}, 'cohort', '2026-10-10', ${sid}, NULL, 1`)}`)) === null);

      bar("S13 deleting a stage that owns cells refused (NO ACTION)",
        (await refusal(sql`DELETE FROM campaign_stages WHERE id = ${sid}`))?.startsWith("23503:") === true);
      bar("S14 deleting a partner key that owns cells refused (NO ACTION)",
        (await refusal(sql`DELETE FROM partner_keys WHERE id = ${kid}`))?.startsWith("23503:") === true);

      // The whole-campaign cascade must still work (why NO ACTION, not RESTRICT).
      const del = await refusal(sql`DELETE FROM campaigns WHERE id = ${cid}`);
      const left = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM drip_daily_rollup WHERE campaign_id = ${cid}`);
      bar("S15 deleting the campaign cascades through stages + cells", del === null && left.n === 0,
        `${del} / ${left.n} cells left`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const residue = (await db.execute(sql`
    SELECT count(*)::int AS n FROM organizations WHERE name = '__DRIP_DAILY_ROLLUP_SCHEMA_TEST__'`)) as unknown as { n: number }[];
  bar("S16 rolled back: no fixture org left", residue[0]?.n === 0);
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
