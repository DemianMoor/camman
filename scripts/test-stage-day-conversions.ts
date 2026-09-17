import "./_env-preload";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { seedConversionEvent } from "./_conversion-fixture";
import {
  PROJECTION_JOB_NAME,
  PROJECTION_WATERMARK_OVERLAP_MINUTES,
  advanceProjectionWatermark,
  discoverChangedLedgerStages,
  runStageDayProjection,
  syncStageDayConversions,
} from "../lib/keitaro/stage-day-conversions";

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

// The route's two guards live in a branch no DB fixture can reach (the projection
// only runs after an `ok` Keitaro ingest, and the alert only on the cron path), so
// they are asserted on the SOURCE of the route that owns them.
function routeGuards() {
  const src = readFileSync("app/api/keitaro/poll/route.ts", "utf8");
  const start = src.indexOf("if (ledger.result?.ok) {");
  const end = src.indexOf("\n  return {", start);
  const guarded = start > 0 && end > start ? src.slice(start, end) : "";
  check(
    "G1 the projection runs ONLY inside the ingest-ok branch (an incomplete window skips it)",
    guarded.includes("runStageDayProjection(db, { extraStageIds: poll.stage_ids })") &&
      src.split("runStageDayProjection(").length === 2,
    `start=${start} end=${end}`,
  );
  check(
    "G2 the composed scope is the poll's click-window stages + whatever discovery found",
    guarded.includes("extraStageIds: poll.stage_ids"),
  );
  check(
    "G3 the projection alert is evaluated on the CRON path only",
    /if \(isCron\) \{\s*\n\s*try \{\s*\n\s*await evaluateProjectionAlert\(db, outcome\);/.test(guarded) &&
      src.split("evaluateProjectionAlert(").length === 2,
    guarded.slice(-400),
  );
}

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  console.log("route guards (source)");
  routeGuards();

  try {
    await db.transaction(async (tx) => {
      console.log("\nprojection");
      const orgId = (
        (await tx.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[]
      )[0].id;

      // Start from "the projection has never run" (the row is self-creating).
      await tx.execute(sql`DELETE FROM cron_locks WHERE job_name = ${PROJECTION_JOB_NAME}`);

      // One campaign, four stages:
      //   A — the stage under test (ledger rows + a stale conversion day)
      //   B — the control OUTSIDE every scope
      //   C — in scope with NO ledger rows at all (C1 a)
      //   D — a ledger row but no clicks (the mirror's positive-only fields)
      // schema note: campaigns.slug is NOT NULL + unique per org; stage tracking_id
      // is unique per org — both randomized so re-runs never collide.
      const camp = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode)
          VALUES (${orgId}::uuid, ${`p3sdc-${randomUUID().slice(0, 8)}`}, 'p3 stage-day projection', 'draft', 'tracked') RETURNING id
        `)) as unknown as { id: number }[]
      )[0].id;
      const run = randomUUID().slice(0, 8);
      const stage = async (n: number, tracking: string | null) =>
        Number(
          (
            (await tx.execute(sql`
              INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at)
              VALUES (${orgId}::uuid, ${camp}::int, ${n}::int, ${tracking}, now()) RETURNING id
            `)) as unknown as { id: number }[]
          )[0].id,
        );
      const tidA = `p3_${run}_a`;
      const stageA = await stage(1, tidA);
      const stageB = await stage(2, `p3_${run}_b`);
      const stageC = await stage(3, `p3_${run}_c`);
      const stageD = await stage(4, `p3_${run}_d`);
      // D's manually-owned counters: the mirror must leave these alone.
      await tx.execute(sql`
        UPDATE campaign_stages SET click_count = 77, sales_count = 5 WHERE id = ${stageD}::int
      `);

      const ksr = async (stageId: number, statDate: string, cols: Record<string, number>) => {
        await tx.execute(sql`
          INSERT INTO keitaro_stage_results
            (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
             visit_clicks_clean, checkouts, sales, revenue, pending_revenue, payout_at_conversion)
          VALUES (${orgId}::uuid, ${camp}::int, ${stageId}::int, 'seed', ${statDate}::date,
                  ${cols.visits ?? 0}::int, ${cols.checkouts ?? 0}::int, ${cols.sales ?? 0}::int,
                  ${(cols.revenue ?? 0).toFixed(4)}::numeric, ${(cols.pending ?? 0).toFixed(4)}::numeric,
                  ${cols.payout === undefined ? null : cols.payout.toFixed(4)}::numeric)
        `);
      };
      const read = async (stageId: number) =>
        (await tx.execute(sql`
          SELECT stat_date::text AS stat_date, visit_clicks_clean, checkouts, sales,
                 revenue::text AS revenue, pending_revenue::text AS pending,
                 payout_at_conversion::text AS payout, stage_tracking_id
          FROM keitaro_stage_results WHERE stage_id = ${stageId}::int ORDER BY stat_date
        `)) as unknown as {
          stat_date: string;
          visit_clicks_clean: number;
          checkouts: number;
          sales: number;
          revenue: string;
          pending: string;
          payout: string | null;
          stage_tracking_id: string;
        }[];
      const stageRow = async (stageId: number) =>
        (
          (await tx.execute(sql`
            SELECT click_count, checkout_click_count, sales_count
            FROM campaign_stages WHERE id = ${stageId}::int
          `)) as unknown as { click_count: number; checkout_click_count: number; sales_count: number }[]
        )[0];
      const watermark = async () =>
        (
          (await tx.execute(sql`
            SELECT watermark::text AS watermark FROM cron_locks WHERE job_name = ${PROJECTION_JOB_NAME}
          `)) as unknown as { watermark: string | null }[]
        )[0]?.watermark ?? null;

      // A clicks row that also carries the STALE conversion values a re-dated
      // conversion left behind (bug 2), plus the real conversion day.
      await ksr(stageA, "2026-09-17", { visits: 40, checkouts: 1, sales: 1, revenue: 100, pending: 50, payout: 100 });
      // MONTHS before the ledger's earliest conversion for this stage (C1 b).
      await ksr(stageA, "2026-05-01", { sales: 2, revenue: 200, payout: 100 });
      await ksr(stageB, "2026-09-17", { visits: 7, checkouts: 3, sales: 3, revenue: 300 });
      // In scope, but this stage has NO ledger row anywhere (C1 a).
      await ksr(stageC, "2026-08-01", { sales: 4, revenue: 400, payout: 100 });

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

      const leadA = await evt(stageA, "2026-09-14", "lead", 100);
      await evt(stageA, "2026-09-14", "sale", 250);
      await evt(stageA, "2026-09-14", "rejected", 0);
      await evt(stageD, "2026-09-15", "lead", 60);

      const first = await syncStageDayConversions(tx, { stageIds: [stageA, stageC] });
      const rowsA = await read(stageA);
      check("S1 the conversion day gets a row of its own", rowsA.some((r) => r.stat_date === "2026-09-14"));
      const d14 = rowsA.find((r) => r.stat_date === "2026-09-14")!;
      check("S2 sales counts lead + sale + rejected (today's semantics)", d14.sales === 3, JSON.stringify(d14));
      check("S3 checkouts counts the lead only", d14.checkouts === 1, JSON.stringify(d14));
      check("S4 revenue is the ledger sum", Number(d14.revenue) === 350, d14.revenue);
      check(
        "S5 payout_at_conversion = revenue / sales",
        Math.abs(Number(d14.payout) - 350 / 3) < 0.001,
        String(d14.payout),
      );
      check("S6 the inserted row carries the stage's tracking id", d14.stage_tracking_id === tidA, d14.stage_tracking_id);
      const d17 = rowsA.find((r) => r.stat_date === "2026-09-17")!;
      check(
        "S7 ⭐ bug 2 / C1 (d): a stale day INSIDE the ledger's coverage is still zeroed",
        d17.sales === 0 && d17.checkouts === 0 && Number(d17.revenue) === 0,
        JSON.stringify(d17),
      );
      check("S8 ⭐ its CLICK columns are untouched", d17.visit_clicks_clean === 40, JSON.stringify(d17));
      check("S8b zeroing clears payout_at_conversion", d17.payout === null, JSON.stringify(d17));
      check("S8c zeroing resets pending_revenue too (migration 0182)", Number(d17.pending) === 0, JSON.stringify(d17));
      check("S9 the run reports what it wrote", first.rowsWritten >= 1 && first.rowsZeroed === 1, JSON.stringify(first));
      check(
        "S9b it reports the scope it was GIVEN, not the stages that happen to have rows",
        first.stagesInScope === 2,
        JSON.stringify(first),
      );

      console.log("\nC1 — the zeroing never outruns the ledger's coverage");
      check(
        "C1a ⭐ a stage in scope with NO ledger rows at all keeps its historical rows",
        (await read(stageC))[0].sales === 4 && Number((await read(stageC))[0].revenue) === 400,
        JSON.stringify(await read(stageC)),
      );
      const may = rowsA.find((r) => r.stat_date === "2026-05-01")!;
      check(
        "C1b ⭐ a stage-day months older than the ledger's earliest conversion for that stage is never zeroed",
        may.sales === 2 && Number(may.revenue) === 200 && Number(may.payout) === 100,
        JSON.stringify(may),
      );
      check(
        "C1b2 the run reports the coverage floor it applied",
        first.coverageFloor === "2026-09-14" && first.refused === null,
        JSON.stringify(first),
      );

      const second = await syncStageDayConversions(tx, { stageIds: [stageA, stageC] });
      check("S10 re-running writes nothing", second.rowsWritten === 0 && second.rowsZeroed === 0, JSON.stringify(second));

      const rowsB = await read(stageB);
      check("S11 ⭐ a stage outside the scope is untouched", rowsB[0].sales === 3 && Number(rowsB[0].revenue) === 300, JSON.stringify(rowsB));

      const empty = await syncStageDayConversions(tx, { stageIds: [] });
      check(
        "S12 an empty scope writes nothing at all",
        empty.rowsWritten === 0 && empty.rowsZeroed === 0 && empty.stagesInScope === 0 && empty.refused === null,
      );

      console.log("\nI2 — the mirror must be able to correct DOWNWARDS");
      const mirroredUp = await stageRow(stageA);
      check(
        "M1 the counter mirror ran off the fresh rows",
        mirroredUp.checkout_click_count === 1,
        JSON.stringify(mirroredUp),
      );
      // The projection is non-monotonic: drop the only `lead` and the day's
      // checkouts fall to 0. The stage counter must follow it down.
      await tx.execute(sql`DELETE FROM conversion_events WHERE id = ${leadA}::bigint`);
      const third = await syncStageDayConversions(tx, { stageIds: [stageA, stageD] });
      const d14After = (await read(stageA)).find((r) => r.stat_date === "2026-09-14")!;
      check("M2 the projected day recomputes downwards", d14After.checkouts === 0 && d14After.sales === 2, JSON.stringify(d14After));
      const mirroredDown = await stageRow(stageA);
      check(
        "M3 ⭐ checkout_click_count follows it DOWN to 0 (the positive-only guard would have kept 1)",
        mirroredDown.checkout_click_count === 0,
        JSON.stringify(mirroredDown),
      );
      const stageDRow = await stageRow(stageD);
      check(
        "M4 click_count (Keitaro visits) keeps its positive-only guard — a 0 sum leaves the manual 77",
        stageDRow.click_count === 77,
        JSON.stringify(stageDRow),
      );
      check("M5 sales_count is never touched by either mode", stageDRow.sales_count === 5, JSON.stringify(stageDRow));
      check(
        "M6 checkout_click_count is exact for D as well (1 lead)",
        stageDRow.checkout_click_count === 1 && third.rowsWritten >= 1,
        JSON.stringify({ stageDRow, third }),
      );

      console.log("\nI3 — resumable discovery (cron_locks watermark)");
      const d1 = await discoverChangedLedgerStages(tx);
      check(
        "D1 a first run has no cursor and looks back LEDGER_CHANGE_LOOKBACK_MINUTES",
        d1.watermarkFrom === null && d1.stageIds.includes(stageA) && !d1.truncated,
        JSON.stringify(d1),
      );
      await tx.execute(sql`
        UPDATE conversion_events SET updated_at = now() - interval '3 hours' WHERE stage_id = ${stageA}::int
      `);
      const d2 = await discoverChangedLedgerStages(tx);
      check(
        "D2 and not a stage whose rows are older than the window",
        !d2.stageIds.includes(stageA),
        JSON.stringify(d2),
      );
      // The stranding case: the projection last succeeded 3h ago (6+ failed
      // ticks). A fixed 30-min lookback would never see these rows again.
      await tx.execute(sql`
        UPDATE conversion_events SET updated_at = now() - interval '2 hours' WHERE stage_id = ${stageA}::int
      `);
      await advanceProjectionWatermark(tx, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
      const d3 = await discoverChangedLedgerStages(tx);
      check(
        "D3 ⭐ an old watermark EXTENDS the window back, so a stage stranded by failed ticks is still found",
        d3.stageIds.includes(stageA) && d3.watermarkFrom !== null,
        JSON.stringify(d3),
      );
      const overlapOk =
        new Date(d3.windowFrom).getTime() <=
        new Date(d3.watermarkFrom!).getTime() - (PROJECTION_WATERMARK_OVERLAP_MINUTES - 1) * 60_000;
      check("D3b the window starts at least the overlap before the watermark", overlapOk, JSON.stringify(d3));

      // Back to a fresh cursor, with two stages changed at different times.
      await tx.execute(sql`UPDATE cron_locks SET watermark = NULL WHERE job_name = ${PROJECTION_JOB_NAME}`);
      await tx.execute(sql`
        UPDATE conversion_events SET updated_at = now() - interval '10 minutes' WHERE stage_id = ${stageA}::int
      `);
      await tx.execute(sql`
        UPDATE conversion_events SET updated_at = now() - interval '4 minutes' WHERE stage_id = ${stageD}::int
      `);
      const capped = await discoverChangedLedgerStages(tx, { limit: 1 });
      check(
        "D4 a change set past the cap is truncated, oldest first, and the cursor stops at what it kept",
        capped.truncated &&
          capped.stageIds.length === 1 &&
          capped.stageIds[0] === stageA &&
          capped.resumeTo !== capped.windowTo,
        JSON.stringify(capped),
      );

      const projected = await runStageDayProjection(tx, { extraStageIds: [stageB] });
      check(
        "D5 the scope is extraStageIds ∪ discovered",
        projected.stagesInScope === 3 &&
          projected.discovery.stageIds.includes(stageA) &&
          projected.discovery.stageIds.includes(stageD),
        JSON.stringify(projected),
      );
      check(
        "D6 the watermark advances only after the projection — to the window it covered",
        projected.discovery.watermarkFrom === null &&
          projected.watermarkTo === projected.discovery.resumeTo &&
          (await watermark()) !== null,
        JSON.stringify({ projected, stored: await watermark() }),
      );
      const projectedAgain = await runStageDayProjection(tx, {});
      check(
        "D7 the next run starts from the stored cursor",
        projectedAgain.discovery.watermarkFrom === projected.watermarkTo,
        JSON.stringify(projectedAgain.discovery),
      );

      console.log("\nC1 (c) — the empty-ledger refusal");
      const beforeRefusal = JSON.stringify(await read(stageA));
      const wmBefore = await watermark();
      try {
        // A savepoint so the outer transaction's fixtures survive.
        await tx.transaction(async (tx2) => {
          await tx2.execute(sql`DELETE FROM conversion_events`);
          const refused = await syncStageDayConversions(tx2, { stageIds: [stageA, stageC] });
          check(
            "C1c ⭐ an empty ledger refuses and writes nothing",
            refused.refused === "empty_ledger" &&
              refused.rowsWritten === 0 &&
              refused.rowsZeroed === 0 &&
              refused.coverageFloor === null,
            JSON.stringify(refused),
          );
          const afterRefusal = JSON.stringify(
            (await tx2.execute(sql`
              SELECT stat_date::text AS stat_date, visit_clicks_clean, checkouts, sales,
                     revenue::text AS revenue, pending_revenue::text AS pending,
                     payout_at_conversion::text AS payout, stage_tracking_id
              FROM keitaro_stage_results WHERE stage_id = ${stageA}::int ORDER BY stat_date
            `)) as unknown as unknown[],
          );
          check("C1c2 ⭐ every stored stage-day is byte-identical after the refusal", afterRefusal === beforeRefusal, afterRefusal);
          const refusedRun = await runStageDayProjection(tx2, { extraStageIds: [stageB] });
          const wmAfter = (
            (await tx2.execute(sql`
              SELECT watermark::text AS watermark FROM cron_locks WHERE job_name = ${PROJECTION_JOB_NAME}
            `)) as unknown as { watermark: string | null }[]
          )[0]?.watermark ?? null;
          check(
            "C1c3 a refusal does NOT advance the watermark",
            refusedRun.refused === "empty_ledger" &&
              refusedRun.watermarkTo === refusedRun.discovery.watermarkFrom &&
              wmAfter === wmBefore,
            JSON.stringify({ refusedRun, wmBefore, wmAfter }),
          );
          throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }
      check(
        "C1c4 the savepoint rolled back — the ledger is back",
        ((await tx.execute(sql`SELECT count(*)::int AS n FROM conversion_events WHERE stage_id = ${stageA}::int`)) as unknown as {
          n: number;
        }[])[0].n === 2,
      );

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
