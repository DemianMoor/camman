import "./_env-preload";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { seedConversionEvent } from "./_conversion-fixture";
import { changedLedgerStageIds, syncStageDayConversions } from "../lib/keitaro/stage-day-conversions";

// The stage-day projection, run through the REAL exported functions inside a
// transaction that ALWAYS rolls back. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-stage-day-conversions.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
class Rollback extends Error {}

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[]
      )[0].id;

      // One campaign, two stages. Stage B is the control that must stay untouched.
      // schema note: campaigns.slug is NOT NULL + unique per org (not in the
      // brief's INSERT); randomized so re-runs never collide.
      const camp = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode)
          VALUES (${orgId}::uuid, ${`p3sdc-${randomUUID().slice(0, 8)}`}, 'p3 stage-day projection', 'draft', 'tracked') RETURNING id
        `)) as unknown as { id: number }[]
      )[0].id;
      const stage = async (n: number, tracking: string | null) =>
        Number(
          (
            (await tx.execute(sql`
              INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at)
              VALUES (${orgId}::uuid, ${camp}::int, ${n}::int, ${tracking}, now()) RETURNING id
            `)) as unknown as { id: number }[]
          )[0].id,
        );
      const stageA = await stage(1, "p3_test_a");
      const stageB = await stage(2, "p3_test_b");

      const ksr = async (stageId: number, statDate: string, cols: Record<string, number>) => {
        await tx.execute(sql`
          INSERT INTO keitaro_stage_results
            (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
             visit_clicks_clean, checkouts, sales, revenue)
          VALUES (${orgId}::uuid, ${camp}::int, ${stageId}::int, 'seed', ${statDate}::date,
                  ${cols.visits ?? 0}::int, ${cols.checkouts ?? 0}::int, ${cols.sales ?? 0}::int,
                  ${(cols.revenue ?? 0).toFixed(4)}::numeric)
        `);
      };
      const read = async (stageId: number) =>
        (await tx.execute(sql`
          SELECT stat_date::text AS stat_date, visit_clicks_clean, checkouts, sales,
                 revenue::text AS revenue, payout_at_conversion::text AS payout, stage_tracking_id
          FROM keitaro_stage_results WHERE stage_id = ${stageId}::int ORDER BY stat_date
        `)) as unknown as {
          stat_date: string;
          visit_clicks_clean: number;
          checkouts: number;
          sales: number;
          revenue: string;
          payout: string | null;
          stage_tracking_id: string;
        }[];

      // A clicks row that also carries the STALE conversion values a re-dated
      // conversion left behind (bug 2), plus the real conversion day.
      await ksr(stageA, "2026-09-17", { visits: 40, checkouts: 1, sales: 1, revenue: 100 });
      await ksr(stageB, "2026-09-17", { visits: 7, checkouts: 3, sales: 3, revenue: 300 });
      const evt = async (stageId: number, day: string, type: string, revenue: number) =>
        seedConversionEvent(tx, {
          orgId,
          campaignId: camp,
          stageId,
          // Always the purchase type; the lifecycle status is what differs. A
          // `rejected` Keitaro type maps to purchase/rejected (Phase 1 seeds).
          eventKey: "purchase",
          status: type === "rejected" ? "rejected" : "approved",
          revenue,
          keitaroType: type,
        }).then(async (id) => {
          await tx.execute(sql`
            UPDATE conversion_events
            SET occurred_at = (${`${day} 12:00:00`}::text || ' ' || 'America/New_York')::timestamptz
            WHERE id = ${id}::bigint
          `);
          return id;
        });

      await evt(stageA, "2026-09-14", "lead", 100);
      await evt(stageA, "2026-09-14", "sale", 250);
      await evt(stageA, "2026-09-14", "rejected", 0);

      const first = await syncStageDayConversions(tx, { stageIds: [stageA] });
      const rowsA = await read(stageA);
      check("S1 the conversion day gets a row of its own", rowsA.some((r) => r.stat_date === "2026-09-14"));
      const d14 = rowsA.find((r) => r.stat_date === "2026-09-14")!;
      check("S2 sales counts lead + sale + rejected (today's semantics)", d14.sales === 3, JSON.stringify(d14));
      check("S3 checkouts counts the lead only", d14.checkouts === 1, JSON.stringify(d14));
      check("S4 revenue is the ledger sum", Number(d14.revenue) === 350, d14.revenue);
      check("S5 payout_at_conversion = revenue / sales", Number(d14.payout) === 350 / 3 || Math.abs(Number(d14.payout) - 116.6667) < 0.001, String(d14.payout));
      check("S6 the inserted row carries the stage's tracking id", d14.stage_tracking_id === "p3_test_a", d14.stage_tracking_id);
      const d17 = rowsA.find((r) => r.stat_date === "2026-09-17")!;
      check("S7 ⭐ bug 2: the stale conversion day is zeroed", d17.sales === 0 && d17.checkouts === 0 && Number(d17.revenue) === 0, JSON.stringify(d17));
      check("S8 ⭐ its CLICK columns are untouched", d17.visit_clicks_clean === 40, JSON.stringify(d17));
      check("S9 the run reports what it wrote", first.rowsWritten >= 1 && first.rowsZeroed === 1, JSON.stringify(first));

      const second = await syncStageDayConversions(tx, { stageIds: [stageA] });
      check("S10 re-running writes nothing", second.rowsWritten === 0 && second.rowsZeroed === 0, JSON.stringify(second));

      const rowsB = await read(stageB);
      check("S11 ⭐ a stage outside the scope is untouched", rowsB[0].sales === 3 && Number(rowsB[0].revenue) === 300, JSON.stringify(rowsB));

      const empty = await syncStageDayConversions(tx, { stageIds: [] });
      check("S12 an empty scope writes nothing at all", empty.rowsWritten === 0 && empty.rowsZeroed === 0 && empty.stagesInScope === 0);

      const changed = await changedLedgerStageIds(tx, 30);
      check("S13 changedLedgerStageIds finds the stage touched inside the window", changed.includes(stageA));
      await tx.execute(sql`
        UPDATE conversion_events SET updated_at = now() - interval '3 hours' WHERE stage_id = ${stageA}::int
      `);
      const changedAfter = await changedLedgerStageIds(tx, 30);
      check("S14 and not one whose rows are older than the window", !changedAfter.includes(stageA));

      const mirrored = (await tx.execute(sql`
        SELECT checkout_click_count, click_count FROM campaign_stages WHERE id = ${stageA}::int
      `)) as unknown as { checkout_click_count: number; click_count: number }[];
      check("S15 the stage counter mirror ran off the fresh rows", mirrored[0].checkout_click_count === 1, JSON.stringify(mirrored));

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  console.log(`\n${passed} passed, ${failed} failed  (transaction rolled back)`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
