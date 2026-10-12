import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";

// Migration 0204 + 0205 triggers, on the PREVIEW DB, inside one transaction that
// is rolled back (no residue). now() is frozen for the whole transaction, so
// "stamped" = the stamp moved from a backdated value to exactly now().
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
      const camp = async (carry: number | null, cutoff: number | null,
                          o = { org: orgId, status: "active", type: "drip" }) => {
        const id = (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type)
          VALUES (${o.org}::uuid, ${"ct-" + Math.random().toString(36).slice(2, 9)}, 'CT', ${o.status}, ${o.type})
          RETURNING id`)).id;
        await tx.execute(sql`
          INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, carry_days, admission_cutoff_minutes)
          VALUES (${id}, ${o.org}::uuid, 'ct', ${carry}, ${cutoff})`);
        return id;
      };
      const stamp = async (id: number) =>
        (await one<{ w: string | null }>(sql`
          SELECT admission_widened_at AS w FROM drip_campaign_configs WHERE campaign_id = ${id}`)).w;
      const orgStamp = async () =>
        (await one<{ w: string | null }>(sql`
          SELECT drip_admission_widened_at AS w FROM org_settings WHERE org_id = ${orgId}::uuid`)).w;
      // 0205 test-only escape hatch (transaction-local): lets a fixture backdate/clear a stamp.
      const hatch = (on: boolean) =>
        tx.execute(sql`SELECT set_config('camman.allow_widened_backdate', ${on ? "on" : "off"}, true)`);
      const clear = async (id: number) => {
        await hatch(true);
        await tx.execute(sql`
          UPDATE drip_campaign_configs SET admission_widened_at = NULL WHERE campaign_id = ${id}`);
        await hatch(false);
      };
      // Backdate a stamp to BACK (via the hatch) so a later "stamped" is a real change.
      const BACK = sql`(now() - interval '3 days')`;
      const backdate = async (id: number) => {
        await hatch(true);
        await tx.execute(sql`UPDATE drip_campaign_configs SET admission_widened_at = ${BACK} WHERE campaign_id = ${id}`);
        await hatch(false);
      };
      const backdateOrg = async (org: string) => {
        await hatch(true);
        await tx.execute(sql`UPDATE org_settings SET drip_admission_widened_at = ${BACK} WHERE org_id = ${org}::uuid`);
        await hatch(false);
      };
      const cfgIs = async (id: number, expr: SQL) =>
        (await one<{ ok: boolean }>(sql`
          SELECT (admission_widened_at IS NOT DISTINCT FROM ${expr}) AS ok
          FROM drip_campaign_configs WHERE campaign_id = ${id}`)).ok;
      const orgIs = async (org: string, expr: SQL) =>
        (await one<{ ok: boolean }>(sql`
          SELECT (drip_admission_widened_at IS NOT DISTINCT FROM ${expr}) AS ok
          FROM org_settings WHERE org_id = ${org}::uuid`)).ok;
      const NOW = sql`now()`;
      const setStatus = (id: number, status: string) =>
        tx.execute(sql`UPDATE campaigns SET status = ${status} WHERE id = ${id}`);

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

      // ── 0205 edge cases ─────────────────────────────────────────────────
      const m = await camp(1, 0);
      await backdate(m);
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET carry_days = 0, admission_cutoff_minutes = 1439 WHERE campaign_id = ${m}`);
      bar("T12 mixed net-narrowing (carry 1→0 + cutoff 0→1439) → NOT stamped", await cfgIs(m, BACK));

      await backdate(a); // a has carry 3 after T7
      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, carry_days)
        VALUES (${a}, ${orgId}::uuid, 'ct', 1)
        ON CONFLICT (campaign_id) DO UPDATE SET carry_days = EXCLUDED.carry_days`);
      bar("T13 narrowing upsert 3→1 → NOT stamped (unchanged)", await cfgIs(a, BACK));

      await tx.execute(sql`UPDATE org_settings SET drip_carry_days = 2 WHERE org_id = ${orgId}::uuid`);
      const e0 = await camp(0, null);
      await backdate(e0);
      await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = NULL WHERE campaign_id = ${e0}`);
      bar("T14 cfg explicit carry 0 → NULL while org carry is 2 → stamped", await cfgIs(e0, NOW));

      await backdateOrg(orgId);
      await tx.execute(sql`UPDATE org_settings SET drip_carry_days = 1 WHERE org_id = ${orgId}::uuid`);
      bar("T15a org narrowing 2→1 → org stamp unchanged", await orgIs(orgId, BACK));

      // org2 has NO org_settings row yet.
      const org2 = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES ('__CARRY_TRIGGER_TEST_2__') RETURNING id`)).id;
      let t16 = true, t16d = "";
      let inh = 0, c2 = 0;
      try {
        inh = await camp(null, null, { org: org2, status: "active", type: "drip" });
        c2 = await camp(1, null, { org: org2, status: "active", type: "drip" });
        await tx.execute(sql`UPDATE drip_campaign_configs SET admission_cutoff_minutes = 0 WHERE campaign_id = ${inh}`);
      } catch (err) { t16 = false; t16d = String(err); }
      bar("T16 cfg writes with no org_settings row → no error, 0 defaults",
        t16 && (await cfgIs(inh, sql`NULL::timestamptz`)) && (await cfgIs(c2, NOW)), t16d);
      // back to fully inheriting for T17
      await tx.execute(sql`UPDATE drip_campaign_configs SET admission_cutoff_minutes = NULL WHERE campaign_id = ${inh}`);

      await tx.execute(sql`INSERT INTO org_settings (org_id, drip_carry_days) VALUES (${org2}::uuid, 1)`);
      bar("T15b org INSERT with carry 1 (new org) → stamped", await orgIs(org2, NOW));

      await backdateOrg(org2);
      await tx.execute(sql`UPDATE org_settings SET drip_carry_days = 2 WHERE org_id = ${org2}::uuid`);
      bar("T17a org raise → org stamped", await orgIs(org2, NOW));
      bar("T17b …inheriting cfg row's stamp stays NULL", await cfgIs(inh, sql`NULL::timestamptz`));

      await backdate(a);
      await tx.execute(sql`UPDATE drip_campaign_configs SET admission_widened_at = NULL WHERE campaign_id = ${a}`);
      bar("T18a cfg SET widened = NULL → stays OLD", await cfgIs(a, BACK));
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET admission_widened_at = (now() - interval '4 days') WHERE campaign_id = ${a}`);
      bar("T18b cfg SET widened = OLD - 1 day → stays OLD", await cfgIs(a, BACK));
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET admission_widened_at = now() + interval '1 minute' WHERE campaign_id = ${a}`);
      bar("T18c cfg SET widened = now() + 1 min → accepted", await cfgIs(a, sql`now() + interval '1 minute'`));

      await backdateOrg(orgId);
      await tx.execute(sql`UPDATE org_settings SET drip_admission_widened_at = NULL WHERE org_id = ${orgId}::uuid`);
      bar("T19a org SET widened = NULL → stays OLD", await orgIs(orgId, BACK));
      await tx.execute(sql`
        UPDATE org_settings SET drip_admission_widened_at = (now() - interval '4 days') WHERE org_id = ${orgId}::uuid`);
      bar("T19b org SET widened = OLD - 1 day → stays OLD", await orgIs(orgId, BACK));
      await tx.execute(sql`
        UPDATE org_settings SET drip_admission_widened_at = now() + interval '1 minute' WHERE org_id = ${orgId}::uuid`);
      bar("T19c org SET widened = now() + 1 min → accepted", await orgIs(orgId, sql`now() + interval '1 minute'`));

      await hatch(true);
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET admission_widened_at = now() - interval '10 days' WHERE campaign_id = ${a}`);
      bar("T20a hatch 'on' → backdate applied", await cfgIs(a, sql`now() - interval '10 days'`));
      await hatch(false);
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET admission_widened_at = now() - interval '20 days' WHERE campaign_id = ${a}`);
      bar("T20b hatch 'off' again → backdate blocked", await cfgIs(a, sql`now() - interval '10 days'`));

      // Campaign status: entering active/paused stamps the cfg (0205). The hatch is
      // OFF here, so these also prove the forward-only guard admits now().
      const d = await camp(0, null);
      await setStatus(d, "completed");
      await backdate(d);
      await setStatus(d, "active");
      bar("T21a drip completed → active → stamped", await cfgIs(d, NOW));
      await backdate(d);
      await setStatus(d, "paused");
      bar("T21b drip active → paused → NOT stamped", await cfgIs(d, BACK));
      await setStatus(d, "active");
      bar("T21c drip paused → active → NOT stamped", await cfgIs(d, BACK));
      await setStatus(d, "archived");
      bar("T21d drip active → archived → NOT stamped", await cfgIs(d, BACK));
      await setStatus(d, "paused");
      bar("T21e drip archived → paused → stamped", await cfgIs(d, NOW));
      const dr = await camp(0, null, { org: orgId, status: "draft", type: "drip" });
      await backdate(dr);
      await setStatus(dr, "active");
      bar("T21f drip draft → active → stamped", await cfgIs(dr, NOW));
      const rg = await camp(0, null, { org: orgId, status: "draft", type: "regular" });
      await backdate(rg);
      await setStatus(rg, "active");
      bar("T21g REGULAR draft → active → touches nothing", await cfgIs(rg, BACK));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL PASS (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
