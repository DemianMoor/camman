// Verifies the Prepare progress counter (…/send/materialize-progress) against a
// RE-PREPARED stage — the shape that exposed the bug in production.
//
// Aborting a stage cancels its pending rows to 'rejected' and keeps them for
// audit; re-preparing then adds a fresh set of live rows alongside. The route's
// count had no status filter, so it reported the PRIOR run's residue as progress
// for the CURRENT one — stage 1710 read 8,843 against 4,445 real recipients
// (~2x), and the bar started near-full before a single new row existed.
//
// The fix excludes 'rejected' only. 'skipped_opted_out' rows are legitimately
// created BY the run in progress (recipients suppressed at materialization time,
// migration 0116), so counting them keeps the bar tracking the preflight target.
//
// Fixture is manual-mode + not-approved ⇒ inert to both cron phases; it never
// mints links and cannot send. Full cleanup in `finally`.
//
// Run: npx tsx scripts/test-materialize-progress-count.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

const TAG = "__wt-materialize-progress-test__";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  let campaignId: number | null = null;

  try {
    const seed = (
      await db.execute(sql`
        SELECT c.org_id, c.brand_id, cr.id AS creative_id
        FROM campaigns c
        JOIN creatives cr ON cr.org_id = c.org_id AND cr.text IS NOT NULL
        WHERE c.brand_id IS NOT NULL
        LIMIT 1`)
    )[0] as { org_id: string; brand_id: number; creative_id: number };
    const orgId = seed.org_id;

    const contacts = (await db.execute(sql`
      SELECT id, phone_number FROM contacts
      WHERE org_id = ${orgId} AND is_archived = false
      LIMIT 10`)) as unknown as { id: string; phone_number: string }[];
    if (contacts.length < 10) throw new Error("need >=10 contacts");

    campaignId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-" + Date.now()}, ${TAG}, 'active', 'manual')
          RETURNING id`)
      )[0].id,
    );
    const mkStage = async (n: number) =>
      Number(
        (
          await db.execute(sql`
            INSERT INTO campaign_stages
              (org_id, campaign_id, stage_number, creative_id, short_url, stop_text,
               scheduled_at, send_approved, include_no_status, include_clickers, exclude_clickers)
            VALUES (${orgId}, ${campaignId}, ${n}, ${seed.creative_id},
                    'https://example.com/x', 'Reply STOP to opt out',
                    now() - interval '1 minute', false, true, false, false)
            RETURNING id`)
        )[0].id,
      );
    const reprepared = await mkStage(1);
    const freshStage = await mkStage(2);

    const addRow = async (stageId: number, contactIdx: number, status: string) => {
      const c = contacts[contactIdx];
      await db.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${campaignId}, ${stageId}, ${c.id}, ${c.phone_number}, 'x', ${status})`);
    };

    // THE ROUTE'S QUERY. `filtered` is the fixed form; `unfiltered` is what
    // shipped before, kept so the test proves the delta rather than asserting a
    // bare number that could pass for the wrong reason.
    const counter = async (stageId: number) => {
      const r = (await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM stage_sends ss
            WHERE ss.stage_id = ${stageId} AND ss.org_id = ${orgId}
              AND ss.status <> 'rejected') AS filtered,
          (SELECT count(*)::int FROM stage_sends ss
            WHERE ss.stage_id = ${stageId} AND ss.org_id = ${orgId}) AS unfiltered,
          (s.materialized_at IS NOT NULL) AS complete
        FROM campaign_stages s WHERE s.id = ${stageId} AND s.org_id = ${orgId}
        LIMIT 1`)) as unknown as { filtered: number; unfiltered: number; complete: boolean }[];
      return {
        filtered: Number(r[0].filtered),
        unfiltered: Number(r[0].unfiltered),
        complete: r[0].complete === true,
      };
    };

    // ---- 1. Prior aborted run: 8 cancelled + 2 suppressed, nothing live ----
    console.log("1) aborted stage, before the re-prepare starts:");
    for (let i = 0; i < 8; i++) await addRow(reprepared, i, "rejected");
    for (let i = 8; i < 10; i++) await addRow(reprepared, i, "skipped_opted_out");
    let c1 = await counter(reprepared);
    check("counter reports 2, not 10 (8 cancelled rows excluded)", c1.filtered === 2, `got ${c1.filtered}`);
    check("unfiltered WOULD report 10 — the bug", c1.unfiltered === 10, `got ${c1.unfiltered}`);
    check("not complete (materialized_at NULL)", c1.complete === false);

    // ---- 2. Re-prepare in flight: live rows land for the SAME contacts ----
    // Legal despite stage_sends_active_contact_uniq: that index covers only
    // status IN ('pending','sending'), so a contact may hold one live row plus
    // any number of audit rows — exactly production (4,389 contacts on 1710).
    console.log("2) re-prepare in flight (partial):");
    for (let i = 0; i < 4; i++) await addRow(reprepared, i, "pending");
    c1 = await counter(reprepared);
    check("counter tracks the NEW run: 4 pending + 2 prior suppressed = 6", c1.filtered === 6, `got ${c1.filtered}`);
    check("counter RISES with progress (6 > 2)", c1.filtered > 2);
    check("unfiltered would read 14 — inflated past the real audience", c1.unfiltered === 14, `got ${c1.unfiltered}`);

    // ---- 3. A suppression recorded BY this run must COUNT ----
    // This is why 'skipped_opted_out' is not excluded: the row is real progress
    // against the preflight target, just not a sendable one.
    console.log("3) suppression recorded during THIS run:");
    await addRow(reprepared, 4, "skipped_opted_out");
    c1 = await counter(reprepared);
    check("a skipped_opted_out row written by this run is counted (7)", c1.filtered === 7, `got ${c1.filtered}`);

    // ---- 4. Run completes ----
    console.log("4) re-prepare complete:");
    for (let i = 5; i < 8; i++) await addRow(reprepared, i, "pending");
    await db.execute(sql`UPDATE campaign_stages SET materialized_at = now() WHERE id = ${reprepared}`);
    c1 = await counter(reprepared);
    const live = Number(
      (
        (await db.execute(sql`
          SELECT count(*)::int AS n FROM stage_sends
          WHERE stage_id = ${reprepared} AND status IN ('pending','sending','sent')`)) as unknown as { n: number }[]
      )[0].n,
    );
    check("7 live rows materialized", live === 7, `got ${live}`);
    check("counter = 10 (7 live + 3 suppressed), NOT 18", c1.filtered === 10, `got ${c1.filtered}`);
    check("unfiltered would read 18 — ~1.8x the real audience", c1.unfiltered === 18, `got ${c1.unfiltered}`);
    check("complete flips true from materialized_at", c1.complete === true);
    // The headline property: the old count overstated, the new one cannot.
    check("fixed counter <= unfiltered, and strictly less when residue exists", c1.filtered < c1.unfiltered);

    // ---- 5. Regression guard: a never-aborted stage is unaffected ----
    console.log("5) first-time Prepare (no prior run) — unchanged:");
    for (let i = 0; i < 6; i++) await addRow(freshStage, i, "pending");
    await addRow(freshStage, 6, "skipped_opted_out");
    const c2 = await counter(freshStage);
    check("filtered === unfiltered when no rejected rows exist", c2.filtered === c2.unfiltered, `${c2.filtered} vs ${c2.unfiltered}`);
    check("counts all 7 rows", c2.filtered === 7, `got ${c2.filtered}`);
  } finally {
    if (campaignId != null) {
      await db.execute(sql`DELETE FROM stage_sends WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_stages WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    }
    await pg.end({ timeout: 5 });
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
