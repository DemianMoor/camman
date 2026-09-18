import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { db } from "../db/client";
import { seedConversionEvent } from "./_conversion-fixture";
import { CAMPAIGN_TIMEZONE } from "../lib/campaign-timezone";
import { decideProjectionAlert, projectionOutcomeFor } from "../lib/conversions/monitor";
import {
  MAX_CHANGED_STAGE_IDS,
  PROJECTION_JOB_NAME,
  PROJECTION_WATERMARK_OVERLAP_MINUTES,
  advanceProjectionWatermark,
  discoverChangedLedgerStages,
  readProjectionCoverage,
  runStageDayProjection,
  syncStageDayConversions,
  type DbOrTx,
} from "../lib/keitaro/stage-day-conversions";
import { parseEventMap } from "../lib/reporting/event-columns";
import {
  approvedRevenueClause,
  pendingRevenueClause,
  purchasedClause,
  rescueSendIds,
} from "../lib/sale-attribution";

// The stage-day projection, run through the REAL exported functions inside a
// transaction that ALWAYS rolls back. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-stage-day-conversions.ts
// The refusal itself is the `_require-preview-db` import above — an allowlist,
// and early enough that nothing can query ahead of it.

// The projection's filter constants are module-PRIVATE, so the independent
// recomputation is built from the shared CLAUSES instead, and writes the
// checkout test itself. That is deliberate: the two sides must not be the same
// object, or the comparison proves nothing.
const SALES_FILTER = purchasedClause();
const REVENUE_FILTER = approvedRevenueClause();
const PENDING_REVENUE_FILTER = pendingRevenueClause();
const CHECKOUT_FILTER = sql`ce.keitaro_type = 'lead'`;

// Read from the REGISTRY, not written down — the same rule the columns follow.
// Resolved once, inside the transaction, after the `deposit` type is seeded.
let PURCHASE_KEYS = new Set<string>();

/** One event type's entry inside `keitaro_stage_results.events`, as it arrives through `::text`. */
type Tally = { n: number; pending_n: number; revenue: number | string; pending_revenue: number | string };
/** A key the projection never wrote is genuinely absent — never an all-zero entry. */
type EvMap = Record<string, Tally | undefined>;

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

// ⚠️ SOURCE ASSERTIONS, not behaviour. The route's guards live in a branch no DB
// fixture can reach (the projection only runs after an `ok` Keitaro ingest, and
// the alert only on the cron path), so they are asserted by reading the text of
// the route that owns them. They go red on a rename or a reformat and they cannot
// see what the branch actually does at runtime — every other check in this file
// runs the real exported functions.
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

// THE NO-ADVANCE-ON-THROW PATH, as behaviour (review fix A7). A throw inside the
// projection must leave the cursor alone, and in production `dbc` is the POOL —
// every statement autocommits, so "the transaction rolled it back" is NOT the
// reason nothing moved. A rolled-back savepoint could therefore never prove this:
// it would pass even if the advance ran. So the real exported function is driven
// against a recording fake `dbc` that answers each statement and throws on the
// write, and the proof is that the sequence it issued contains no watermark
// UPDATE.
async function throwPathIssuesNoAdvance() {
  const dialect = new PgDialect();
  const seen: string[] = [];
  const fake = {
    execute: async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql;
      seen.push(text);
      if (/INSERT INTO cron_locks/.test(text)) {
        return [
          {
            watermark_from: "2026-09-17 10:00:00+00",
            window_from: "2026-09-17 09:55:00+00",
            window_to: "2026-09-17 10:30:00+00",
          },
        ];
      }
      if (/max\(ce\.updated_at\)/.test(text)) return [{ stage_id: 4242, last_changed: "2026-09-17 10:05:00+00" }];
      if (/ledger_has_rows/.test(text)) {
        return [
          {
            ledger_has_rows: true,
            ledger_floor: "2026-05-01",
            coverage_floor: "2026-09-14",
            reported_history_floor: null,
          },
        ];
      }
      if (/INSERT INTO keitaro_stage_results/.test(text)) throw new Error("simulated write failure");
      throw new Error(`unexpected statement: ${text.slice(0, 120)}`);
    },
  } as unknown as DbOrTx;

  let message = "";
  try {
    await runStageDayProjection(fake, {});
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check(
    "T1 the projection propagates the write failure (it does not swallow it)",
    message === "simulated write failure",
    message,
  );
  check(
    "T2 ⭐ and issued NO watermark UPDATE — the cursor cannot move on a throw",
    seen.length > 0 && !seen.some((s) => /UPDATE cron_locks/.test(s)),
    JSON.stringify(seen.map((s) => s.slice(0, 40))),
  );
  check(
    "T3 the sequence really reached the write (so T2 is about the throw, not an early exit)",
    seen.some((s) => /INSERT INTO keitaro_stage_results/.test(s)),
    String(seen.length),
  );
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  console.log("route guards (source assertions)");
  routeGuards();

  console.log("\nthe cursor on a THROW (no DB — a recording fake dbc)");
  await throwPathIssuesNoAdvance();

  try {
    await db.transaction(async (tx) => {
      console.log("\nfixture");
      const orgId = (
        (await tx.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[]
      )[0].id;

      // Start from "the projection has never run" (the row is self-creating).
      await tx.execute(sql`DELETE FROM cron_locks WHERE job_name = ${PROJECTION_JOB_NAME}`);

      // One campaign, five stages. A and Y are the reviewer's X/Y pair, and the
      // point of the shape is that a GLOBAL coverage floor would pass the naive
      // version of these checks (review fix A6):
      //   A — covered EARLY (a ledger conversion on 2026-05-01) and again LATE,
      //       plus a stale conversion day inside its coverage
      //   Y — covered only LATE (2026-09-14), with a stale non-zero row on
      //       2026-06-01 — AFTER the global floor (A's 2026-05-01) but BEFORE
      //       Y's own. A global floor zeroes it; the per-stage floor must not.
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
      const stageY = await stage(5, `p3_${run}_y`);
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
                 revenue::text AS revenue, pending_revenue::text AS pending_revenue,
                 events::text AS events, unmapped_conversions AS unmapped_conversions,
                 payout_at_conversion::text AS payout, stage_tracking_id
          FROM keitaro_stage_results WHERE stage_id = ${stageId}::int ORDER BY stat_date
        `)) as unknown as {
          stat_date: string;
          visit_clicks_clean: number;
          checkouts: number;
          sales: number;
          revenue: string;
          pending_revenue: string;
          events: string;
          unmapped_conversions: number;
          payout: string | null;
          stage_tracking_id: string;
        }[];
      // EVERY stored stage-day, for byte-identity assertions. camman-v2 holds no
      // keitaro_stage_results rows of its own, so this is the fixture exactly.
      const readAll = async (dbc: DbOrTx) =>
        (await dbc.execute(sql`
          SELECT stage_id, stat_date::text AS stat_date, visit_clicks_clean, checkouts, sales,
                 revenue::text AS revenue, pending_revenue::text AS pending_revenue,
                 events::text AS events, unmapped_conversions AS unmapped_conversions,
                 payout_at_conversion::text AS payout
          FROM keitaro_stage_results ORDER BY stage_id, stat_date
        `)) as unknown as unknown[];
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

      // The three fixture days. EARLY is A's coverage start and therefore the
      // GLOBAL ledger floor; MID sits between the global floor and Y's own floor;
      // LATE is Y's coverage start.
      const EARLY = "2026-05-01";
      const MID = "2026-06-01";
      const LATE = "2026-09-14";

      // A clicks row that also carries the STALE conversion values a re-dated
      // conversion left behind (bug 2), plus the real conversion day.
      await ksr(stageA, "2026-09-17", { visits: 40, checkouts: 1, sales: 1, revenue: 100, pending: 50, payout: 100 });
      // ⭐ THE PER-STAGE FLOOR ROW. Inside the GLOBAL coverage (EARLY), outside
      // stage Y's own (LATE) — so only a per-stage floor protects it.
      await ksr(stageY, MID, { sales: 2, revenue: 200, payout: 100 });
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

      const leadA = await evt(stageA, LATE, "lead", 100);
      await evt(stageA, LATE, "sale", 250);
      await evt(stageA, LATE, "rejected", 0);
      await evt(stageD, "2026-09-15", "lead", 60);
      // A is covered from EARLY — this row is what makes the GLOBAL floor older
      // than Y's stale MID row.
      await evt(stageA, EARLY, "sale", 400);
      // Y is covered ONLY from LATE.
      await evt(stageY, LATE, "sale", 150);

      const scope = [stageA, stageC, stageY];

      console.log("\nA2 — the coverage guard: the ledger must reach the reported history");
      // The world-state the per-stage checks below depend on, measured rather
      // than assumed: if these two floors ever coincide, B1 stops proving
      // anything and this check says so instead of passing quietly.
      const covAll = await readProjectionCoverage(tx, { stageIds: scope });
      const covY = await readProjectionCoverage(tx, { stageIds: [stageY] });
      check(
        "A2a the fixture's floors are the ones the per-stage proof needs: global EARLY < MID < Y's own LATE",
        covAll.ledgerFloor === EARLY && covY.coverageFloor === LATE && EARLY < MID && MID < LATE,
        JSON.stringify({ covAll, covY }),
      );
      check(
        "A2b (case ii) coverage reaches the whole reported history, so the run is allowed",
        covAll.refused === null && covAll.reportedHistoryFloor === null,
        JSON.stringify(covAll),
      );
      // CASE (i): one reported conversion day OLDER than anything the ledger
      // knows — an interrupted backfill, or prod today. In a savepoint, so the
      // fixture survives it.
      const beforeGuard = JSON.stringify(await readAll(tx));
      const wmBeforeGuard = await watermark();
      try {
        await tx.transaction(async (tx2) => {
          await tx2.execute(sql`
            INSERT INTO keitaro_stage_results
              (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue)
            VALUES (${orgId}::uuid, ${camp}::int, ${stageC}::int, 'seed', '2026-04-01'::date, 9::int, 900::numeric)
          `);
          const refused = await syncStageDayConversions(tx2, { stageIds: scope });
          check(
            "A2c ⭐ (case i) reported history older than the ledger's coverage refuses the WHOLE projection",
            refused.refused === "ledger_behind_history" &&
              refused.rowsWritten === 0 &&
              refused.rowsZeroed === 0,
            JSON.stringify(refused),
          );
          check(
            "A2d it names both dates: the reported history's start and the ledger's",
            refused.reportedHistoryFloor === "2026-04-01" && refused.ledgerFloor === EARLY,
            JSON.stringify(refused),
          );
          const staleStillThere = (await tx2.execute(sql`
            SELECT sales, revenue::text AS revenue FROM keitaro_stage_results
            WHERE stage_id = ${stageA}::int AND stat_date = '2026-09-17'::date
          `)) as unknown as { sales: number; revenue: string }[];
          check(
            "A2e ⭐ nothing was written AND nothing zeroed — the bug-2 correction is refused too, by design",
            staleStillThere[0].sales === 1 && Number(staleStillThere[0].revenue) === 100,
            JSON.stringify(staleStillThere),
          );
          const guardRun = await runStageDayProjection(tx2, { extraStageIds: [stageB] });
          check(
            "A2f the scheduled run holds its cursor on this refusal",
            guardRun.refused === "ledger_behind_history" &&
              guardRun.watermarkHeld === true &&
              guardRun.watermarkTo === guardRun.discovery.watermarkFrom,
            JSON.stringify({ refused: guardRun.refused, held: guardRun.watermarkHeld }),
          );
          const decision = decideProjectionAlert(projectionOutcomeFor(guardRun));
          const text = decision.state === "firing" ? decision.text : "";
          check(
            "A2g ⭐ and it pages, naming both dates and the fix (backfill, then the resync)",
            decision.state === "firing" &&
              text.includes("2026-04-01") &&
              text.includes(EARLY) &&
              text.includes("backfill-conversion-events.ts --apply") &&
              text.includes("resync-stage-day-conversions.ts --apply"),
            text,
          );
          throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }
      check(
        "A2h the savepoint rolled back and the guard left no trace",
        JSON.stringify(await readAll(tx)) === beforeGuard && (await watermark()) === wmBeforeGuard,
      );

      console.log("\nprojection (case ii — inside coverage)");
      const first = await syncStageDayConversions(tx, { stageIds: scope });
      const rowsA = await read(stageA);
      check("S1 the conversion day gets a row of its own", rowsA.some((r) => r.stat_date === LATE));
      const d14 = rowsA.find((r) => r.stat_date === LATE)!;
      check("S2 sales counts the counted PURCHASE events only (rejected is not a sale)", d14.sales === 2, JSON.stringify(d14));
      check("S3 checkouts still counts the lead-TYPE rows", d14.checkouts === 1, JSON.stringify(d14));
      check("S4 revenue is the APPROVED sum", Number(d14.revenue) === 350, d14.revenue);
      check("S5 payout_at_conversion = revenue / sales", Math.abs(Number(d14.payout) - 175) < 0.001, String(d14.payout));

      const pendingId = await seedConversionEvent(tx, {
        orgId,
        campaignId: camp,
        stageId: stageA,
        eventKey: "purchase",
        status: "pending",
        revenue: 60,
        keitaroType: "lead",
      });
      await tx.execute(sql`
        UPDATE conversion_events
        SET occurred_at = ('2026-09-14 12:00:00'::text || ' ' || 'America/New_York')::timestamptz
        WHERE id = ${pendingId}::bigint
      `);
      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const wp = (await read(stageA)).find((r) => r.stat_date === "2026-09-14")!;
      check("S5b ⭐ a pending purchase IS a sale", wp.sales === 3, JSON.stringify(wp));
      check("S5c ⭐ its payout is NOT in revenue", Number(wp.revenue) === 350, wp.revenue);
      check("S5d ⭐ it is in pending_revenue, on its own", Number(wp.pending_revenue) === 60, wp.pending_revenue);
      check("S6 the inserted row carries the stage's tracking id", d14.stage_tracking_id === tidA, d14.stage_tracking_id);
      const d17 = rowsA.find((r) => r.stat_date === "2026-09-17")!;
      check(
        "S7 ⭐ bug 2 / C1 (d): a stale day INSIDE the ledger's coverage is still zeroed",
        d17.sales === 0 && d17.checkouts === 0 && Number(d17.revenue) === 0,
        JSON.stringify(d17),
      );
      check("S8 ⭐ its CLICK columns are untouched", d17.visit_clicks_clean === 40, JSON.stringify(d17));
      check("S8b zeroing clears payout_at_conversion", d17.payout === null, JSON.stringify(d17));
      check("S8c zeroing resets pending_revenue too (migration 0182)", Number(d17.pending_revenue) === 0, JSON.stringify(d17));
      check("S9 the run reports what it wrote", first.rowsWritten >= 1 && first.rowsZeroed === 1, JSON.stringify(first));
      check(
        "S9b it reports the scope it was GIVEN, not the stages that happen to have rows",
        first.stagesInScope === 3,
        JSON.stringify(first),
      );

      console.log("\nC1 — the zeroing never outruns the ledger's coverage");
      check(
        "C1a ⭐ a stage in scope with NO ledger rows at all keeps its historical rows",
        (await read(stageC))[0].sales === 4 && Number((await read(stageC))[0].revenue) === 400,
        JSON.stringify(await read(stageC)),
      );
      const yMid = (await read(stageY)).find((r) => r.stat_date === MID)!;
      check(
        "C1b ⭐⭐ THE PER-STAGE FLOOR: Y's stale MID row survives although it is INSIDE the global coverage (a global floor would zero it)",
        yMid.sales === 2 && Number(yMid.revenue) === 200 && Number(yMid.payout) === 100,
        JSON.stringify(yMid),
      );
      const early = rowsA.find((r) => r.stat_date === EARLY)!;
      check(
        "C1b1 A's EARLY day is projected from its own ledger row (this is what makes the global floor older than MID)",
        early !== undefined && early.sales === 1 && Number(early.revenue) === 400,
        JSON.stringify(early),
      );
      check(
        "C1b2 the run reports the coverage floor it applied, and the global bound it passed",
        first.coverageFloor === EARLY && first.ledgerFloor === EARLY && first.refused === null,
        JSON.stringify(first),
      );

      const second = await syncStageDayConversions(tx, { stageIds: scope });
      check("S10 re-running writes nothing", second.rowsWritten === 0 && second.rowsZeroed === 0, JSON.stringify(second));

      const rowsB = await read(stageB);
      check("S11 ⭐ a stage outside the scope is untouched", rowsB[0].sales === 3 && Number(rowsB[0].revenue) === 300, JSON.stringify(rowsB));

      const empty = await syncStageDayConversions(tx, { stageIds: [] });
      check(
        "S12 an empty scope writes nothing at all",
        empty.rowsWritten === 0 && empty.rowsZeroed === 0 && empty.stagesInScope === 0 && empty.refused === null,
      );

      console.log("\nA9 — the payout_at_conversion distinctness clause");
      // An older path (or a row predating the column) leaves payout NULL while
      // checkouts/sales/revenue already match the ledger. Without payout in the
      // upsert's WHERE, that row can never be repaired — so a row differing ONLY
      // in payout must be rewritten.
      await tx.execute(sql`
        UPDATE keitaro_stage_results SET payout_at_conversion = NULL
        WHERE stage_id = ${stageA}::int AND stat_date = ${LATE}::date
      `);
      const payoutRun = await syncStageDayConversions(tx, { stageIds: [stageA] });
      const d14Payout = (await read(stageA)).find((r) => r.stat_date === LATE)!;
      check(
        "P1 ⭐ a row that differs only in payout IS rewritten, and nothing else about it moves",
        payoutRun.rowsWritten === 1 &&
          payoutRun.rowsZeroed === 0 &&
          Math.abs(Number(d14Payout.payout) - 350 / 3) < 0.001 &&
          d14Payout.sales === 3 &&
          // checkouts = 2: leadA AND the S5b pending purchase are both
          // keitaro_type = 'lead' — CHECKOUT_FILTER doesn't look at status.
          d14Payout.checkouts === 2 &&
          Number(d14Payout.revenue) === 350,
        JSON.stringify({ payoutRun, d14Payout }),
      );

      console.log("\nA3 — the projected row's org");
      // A ledger row carrying another org's id for a real stage. The INSERT takes
      // org_id from the LEDGER row, so joining campaign_stages on the id alone
      // would create a keitaro_stage_results row under the WRONG org, mirroring
      // this org's stage counters into it.
      const otherOrg = (
        (await tx.execute(sql`
          INSERT INTO organizations (name) VALUES (${`p3-other-${run}`}) RETURNING id::text AS id
        `)) as unknown as { id: string }[]
      )[0].id;
      await seedConversionEvent(tx, {
        orgId: otherOrg,
        campaignId: camp,
        stageId: stageA,
        revenue: 999,
        keitaroType: "sale",
      });
      const beforeOrg = JSON.stringify(await readAll(tx));
      const orgRun = await syncStageDayConversions(tx, { stageIds: [stageA] });
      const wrongOrg = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n FROM keitaro_stage_results WHERE org_id = ${otherOrg}::uuid
        `)) as unknown as { n: number }[]
      )[0].n;
      check(
        "O1 ⭐ a ledger row whose org does not match its stage writes NO row under that org",
        wrongOrg === 0,
        JSON.stringify({ wrongOrg, orgRun }),
      );
      check(
        "O2 and it cannot reach the stage's real rows either — every stored row is byte-identical",
        JSON.stringify(await readAll(tx)) === beforeOrg && orgRun.rowsWritten === 0 && orgRun.rowsZeroed === 0,
        JSON.stringify(orgRun),
      );

      console.log("\nI2 — the mirror must be able to correct DOWNWARDS");
      const mirroredUp = await stageRow(stageA);
      check(
        // 2, not 1: leadA AND the S5b pending purchase both carry
        // keitaro_type = 'lead' (CHECKOUT_FILTER ignores status).
        "M1 the counter mirror ran off the fresh rows",
        mirroredUp.checkout_click_count === 2,
        JSON.stringify(mirroredUp),
      );
      // The projection is non-monotonic: drop leadA and the day's checkouts
      // fall from 2 to 1 — the S5b pending purchase is still keitaro_type =
      // 'lead' and keeps counting as a checkout regardless of its status. The
      // stage counter must follow the projection down.
      await tx.execute(sql`DELETE FROM conversion_events WHERE id = ${leadA}::bigint`);
      const third = await syncStageDayConversions(tx, { stageIds: [stageA, stageD] });
      const d14After = (await read(stageA)).find((r) => r.stat_date === "2026-09-14")!;
      check("M2 the projected day recomputes downwards", d14After.checkouts === 1 && d14After.sales === 2, JSON.stringify(d14After));
      const mirroredDown = await stageRow(stageA);
      check(
        "M3 ⭐ checkout_click_count follows it DOWN (the positive-only guard would have kept it at 2)",
        mirroredDown.checkout_click_count === 1,
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
        "D4 a change set past the cap is truncated, and the ids kept are the oldest changes",
        capped.truncated && capped.stageIds.length === 1 && capped.stageIds[0] === stageA,
        JSON.stringify(capped),
      );

      // A5 — THE CAP MUST NOT CLAIM PROGRESS. The window still holds stages this
      // run never named, so the cursor stays put and the run pages; the previous
      // version advanced to the last id it kept, which strands the remainder
      // whenever the change set shares one updated_at.
      const wmBeforeCap = await watermark();
      const cappedRun = await runStageDayProjection(tx, { limit: 1 });
      check(
        "D4b ⭐ a truncated discovery HOLDS the watermark (it projected a prefix, not the window)",
        cappedRun.discovery.truncated &&
          cappedRun.watermarkHeld === true &&
          cappedRun.watermarkTo === cappedRun.discovery.watermarkFrom &&
          (await watermark()) === wmBeforeCap,
        JSON.stringify({ held: cappedRun.watermarkHeld, before: wmBeforeCap, stored: await watermark() }),
      );
      check(
        "D4c it still PROJECTED the stages it kept (the cap costs freshness, not the write)",
        cappedRun.refused === null && cappedRun.stagesInScope === 1,
        JSON.stringify(cappedRun),
      );
      const cappedDecision = decideProjectionAlert(projectionOutcomeFor(cappedRun));
      const cappedText = cappedDecision.state === "firing" ? cappedDecision.text : "";
      check(
        "D4d ⭐ and it pages — a capped tick cannot pass silently — naming the resync as the way out",
        cappedDecision.state === "firing" &&
          cappedText.includes("watermark") &&
          cappedText.includes("resync-stage-day-conversions.ts --apply"),
        cappedText,
      );
      check(
        "D4e the cap is a real ceiling, not a stub: MAX_CHANGED_STAGE_IDS is larger than this dataset's stage count",
        MAX_CHANGED_STAGE_IDS >= 20000,
        String(MAX_CHANGED_STAGE_IDS),
      );

      const projected = await runStageDayProjection(tx, { extraStageIds: [stageB] });
      check(
        "D5 the scope is extraStageIds ∪ discovered",
        projected.stagesInScope === 4 &&
          projected.discovery.stageIds.includes(stageA) &&
          projected.discovery.stageIds.includes(stageD) &&
          projected.discovery.stageIds.includes(stageY),
        JSON.stringify(projected),
      );
      check(
        "D6 an UNtruncated run advances the watermark to the window it covered",
        projected.discovery.truncated === false &&
          projected.watermarkHeld === false &&
          projected.watermarkTo === projected.discovery.resumeTo &&
          projected.discovery.resumeTo === projected.discovery.windowTo &&
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
      const ledgerRowsBefore = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n FROM conversion_events WHERE stage_id = ${stageA}::int
        `)) as unknown as { n: number }[]
      )[0].n;
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
              refused.coverageFloor === null &&
              refused.ledgerHasRows === false,
            JSON.stringify(refused),
          );
          const afterRefusal = JSON.stringify(
            (await tx2.execute(sql`
              SELECT stat_date::text AS stat_date, visit_clicks_clean, checkouts, sales,
                     revenue::text AS revenue, pending_revenue::text AS pending_revenue,
                     events::text AS events, unmapped_conversions AS unmapped_conversions,
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
              refusedRun.watermarkHeld === true &&
              refusedRun.watermarkTo === refusedRun.discovery.watermarkFrom &&
              wmAfter === wmBefore,
            JSON.stringify({ refusedRun, wmBefore, wmAfter }),
          );
          throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }
      const ledgerRowsAfter = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n FROM conversion_events WHERE stage_id = ${stageA}::int
        `)) as unknown as { n: number }[]
      )[0].n;
      check(
        "C1c4 the savepoint rolled back — the ledger is back",
        ledgerRowsAfter === ledgerRowsBefore && ledgerRowsBefore > 0,
        JSON.stringify({ ledgerRowsBefore, ledgerRowsAfter }),
      );

      console.log("\nRule F closing check (Task 6 precondition) — the numerator can never sit outside the rescue");
      // A fresh stage, fresh recipients, one stage_sends row per recipient (so
      // rescueSendIds — keyed on stage_send_id — has something to evaluate).
      // Isolated from every earlier fixture on this campaign.
      const stageF = await stage(6, `p3_${run}_f`);
      const mkSend = async (tag: string) => {
        const cid = (
          (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number)
            VALUES (${orgId}::uuid, ${`+1215${run}${tag}`})
            RETURNING id::text AS id
          `)) as unknown as { id: string }[]
        )[0].id;
        const sid = (
          (await tx.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
            VALUES (${orgId}::uuid, ${camp}::int, ${stageF}::int, ${cid}::uuid, ${`+1${tag}`}, 'probe', 'sent', now())
            RETURNING id::text AS id
          `)) as unknown as { id: string }[]
        )[0].id;
        return { cid, sid };
      };
      // One recipient per shape the brief requires covered: an APPROVED purchase
      // (positive control), a REJECTED purchase, a $0 REGISTRATION, and UNMAPPED
      // in both forms — (a) event_type_id AND status both NULL (no mapping rule),
      // (b) event_type_id NULL with status='approved' (a status-only mapping rule,
      // lib/conversions/build-rows.ts:5-7,140).
      const approvedSend = await mkSend("appr");
      const rejectedSend = await mkSend("rej");
      const registrationSend = await mkSend("reg");
      const unmappedSend = await mkSend("unmap");
      const unmappedStatusSend = await mkSend("unmaps");
      const CLOSE_DAY = "2026-09-16";
      const closeEvt = async (send: { sid: string }, args: Parameters<typeof seedConversionEvent>[1]) => {
        const id = await seedConversionEvent(tx, { ...args, stageSendId: send.sid, stageId: stageF, campaignId: camp });
        await tx.execute(sql`
          UPDATE conversion_events
          SET occurred_at = (${`${CLOSE_DAY} 12:00:00`}::text || ' ' || 'America/New_York')::timestamptz
          WHERE id = ${id}::bigint
        `);
        return id;
      };
      await closeEvt(approvedSend, { orgId, eventKey: "purchase", status: "approved", revenue: 42, keitaroType: "sale" });
      await closeEvt(rejectedSend, { orgId, eventKey: "purchase", status: "rejected", revenue: 77, keitaroType: "rejected" });
      await closeEvt(registrationSend, { orgId, eventKey: "registration", status: "approved", revenue: 0, keitaroType: "registration" });
      // shape (a): no mapping rule at all.
      await closeEvt(unmappedSend, { orgId, revenue: 55, keitaroType: "upsell" });
      // shape (b): a status-only mapping rule.
      await closeEvt(unmappedStatusSend, { orgId, status: "approved", revenue: 66, keitaroType: "upsell" });

      await syncStageDayConversions(tx, { stageIds: [stageF] });
      const rowF = (await read(stageF)).find((r) => r.stat_date === CLOSE_DAY)!;
      check(
        "RF1 the projected stage-day counts ONLY the approved purchase — rejected, registration and both unmapped shapes contribute nothing",
        rowF.sales === 1 && Number(rowF.revenue) === 42 && Number(rowF.pending_revenue) === 0,
        JSON.stringify(rowF),
      );

      const fSends = [approvedSend, rejectedSend, registrationSend, unmappedSend, unmappedStatusSend];
      const fIdsArr = sql`ARRAY[${sql.join(fSends.map((s) => sql`${s.sid}`), sql`, `)}]::uuid[]`;
      const rescuedRows = (await tx.execute(sql`
        SELECT r.stage_send_id::text AS id FROM (${rescueSendIds(null)}) r WHERE r.stage_send_id = ANY(${fIdsArr})
      `)) as unknown as { id: string }[];
      const rescuedSet = new Set(rescuedRows.map((r) => r.id));
      check(
        "RF2 ⭐ ONLY the approved purchase's recipient is rescued into the EPC denominator — rejected/registration/both unmapped shapes are not",
        rescuedSet.size === 1 && rescuedSet.has(approvedSend.sid),
        JSON.stringify([...rescuedSet]),
      );

      // RF3-STRUCTURAL: the shared definitions themselves never violate the
      // invariant — no row purchasedClause()/approvedRevenueClause() would count
      // sits outside rescueSendIds's rescue. True by construction of
      // lib/sale-attribution.ts (rescueSendIds is is_purchase OR counts_revenue,
      // a strict superset of each), so this alone would stay green even if
      // lib/keitaro/stage-day-conversions.ts regressed to a different filter —
      // it is a regression guard on the shared module, not on the projection.
      const structuralViolations = (await tx.execute(sql`
        SELECT ce.id, ce.stage_send_id::text AS stage_send_id, ce.status, ce.keitaro_type
        FROM conversion_events ce
        WHERE ce.stage_send_id = ANY(${fIdsArr})
          AND (${purchasedClause()} OR ${approvedRevenueClause()})
          AND NOT EXISTS (
            SELECT 1 FROM (${rescueSendIds(null)}) r WHERE r.stage_send_id = ce.stage_send_id
          )
      `)) as unknown as { id: number; stage_send_id: string; status: string; keitaro_type: string }[];
      check(
        "RF3 the shared purchase/revenue definitions never violate the rescue invariant",
        structuralViolations.length === 0,
        JSON.stringify(structuralViolations),
      );

      // RF3b ⭐⭐ THE CLOSING CHECK, tied to what the PROJECTION actually wrote
      // (rowF), not just to the shared predicates in isolation. Recompute the
      // purchase count / approved revenue restricted to ONLY the rescued
      // recipients, using the same shared clauses, and require the stage-day
      // row syncStageDayConversions wrote to equal that restriction exactly. If
      // the projection's SALES_FILTER/REVENUE_FILTER ever drift from the shared
      // definitions, this stored sum diverges from the rescue-restricted one and
      // goes red — it does not merely infer safety from "0 rejected rows today".
      const rescueScoped = (
        (await tx.execute(sql`
          SELECT count(*) FILTER (WHERE ${purchasedClause()})::int AS sales,
                 coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::numeric(12, 4) AS revenue
          FROM conversion_events ce
          WHERE ce.stage_send_id = ANY(${fIdsArr})
            AND EXISTS (SELECT 1 FROM (${rescueSendIds(null)}) r WHERE r.stage_send_id = ce.stage_send_id)
        `)) as unknown as { sales: number; revenue: string }[]
      )[0];
      check(
        "RF3b ⭐⭐ THE CLOSING CHECK: the projected stage-day's sales/revenue equal the rescue-restricted purchase/revenue count exactly",
        rowF.sales === Number(rescueScoped.sales) && Number(rowF.revenue) === Number(rescueScoped.revenue),
        JSON.stringify({ rowF, rescueScoped }),
      );

      // RF4 ⭐ RED PROOF that RF3b is not vacuous — the OLD, PRE-TASK-6
      // type-based filter (retyped: that code no longer exists to import, same
      // convention as scripts/test-p3-task4-reader-switch-db.ts) DOES violate
      // the invariant on this exact fixture: the rejected row satisfies
      // `keitaro_type IN ('lead', 'sale', 'rejected')` but fails rescueSendIds's
      // `status IN ('pending','approved')`, so it would have counted revenue
      // outside the rescue — precisely the window Task 6 closes. This is proven
      // against the RETYPED literal here; the real module was independently
      // mutated to this exact literal and restored byte-identically (cmp
      // silent) as part of this task's verification — see the report.
      const oldSalesFilter = sql`ce.keitaro_type IN ('lead', 'sale', 'rejected')`;
      const oldViolations = (await tx.execute(sql`
        SELECT ce.id, ce.stage_send_id::text AS stage_send_id
        FROM conversion_events ce
        WHERE ce.stage_send_id = ANY(${fIdsArr})
          AND ${oldSalesFilter}
          AND NOT EXISTS (
            SELECT 1 FROM (${rescueSendIds(null)}) r WHERE r.stage_send_id = ce.stage_send_id
          )
      `)) as unknown as { id: number; stage_send_id: string }[];
      check(
        "RF4 ⭐ RED PROOF — the OLD type-based filter DOES violate the invariant on this fixture (the rejected row)",
        oldViolations.length === 1 && oldViolations[0]?.stage_send_id === rejectedSend.sid,
        JSON.stringify(oldViolations),
      );

      console.log("\nPB — a lead-typed NON-PURCHASE day must not oscillate (the registration case)");
      // ⚠️ THE ZEROING'S "EXPLAINED" TEST MUST COVER EVERY COLUMN IT ZEROES.
      // Until Task 6, SALES_FILTER was `keitaro_type IN ('lead','sale','rejected')`
      // — a strict SUPERSET of CHECKOUT_FILTER (`keitaro_type = 'lead'`) — so
      // `SALES ∨ REVENUE ∨ PENDING` implied the checkout side and nothing had to
      // say so. Task 6 flipped SALES_FILTER to the ledger's purchase predicate and
      // broke that containment. A stage-day whose ONLY ledger rows are lead-TYPE
      // non-purchases — a $0 REGISTRATION arriving with keitaro_type 'lead' (what
      // this account's registration postbacks look like), or an UNMAPPED row —
      // then has `checkouts` written by the INSERT and zeroed by the UPDATE in the
      // SAME run: the projection writes and zeroes on every */5 tick forever, and
      // campaign_stages.checkout_click_count flaps with it. Zero impact while no
      // registration is mapped; it fires the day one lands.
      const stageG = await stage(7, `p3_${run}_g`);
      const PB_DAY = "2026-09-16";
      const pbEvt = async (args: Parameters<typeof seedConversionEvent>[1]) => {
        const id = await seedConversionEvent(tx, { ...args, stageId: stageG, campaignId: camp });
        await tx.execute(sql`
          UPDATE conversion_events
          SET occurred_at = (${`${PB_DAY} 12:00:00`}::text || ' ' || 'America/New_York')::timestamptz
          WHERE id = ${id}::bigint
        `);
        return id;
      };
      // Both shapes that reach `checkouts` without reaching sales/revenue/pending.
      await pbEvt({ orgId, eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead" });
      await pbEvt({ orgId, keitaroType: "lead" }); // UNMAPPED: NULL type, NULL status

      const pb1 = await syncStageDayConversions(tx, { stageIds: [stageG] });
      const g1 = (await read(stageG)).find((r) => r.stat_date === PB_DAY)!;
      const gMirror1 = await stageRow(stageG);
      const pb2 = await syncStageDayConversions(tx, { stageIds: [stageG] });
      const g2 = (await read(stageG)).find((r) => r.stat_date === PB_DAY)!;
      const gMirror2 = await stageRow(stageG);
      check(
        "PB1 ⭐ the day's `checkouts` SURVIVES the same run's zeroing UPDATE (2 lead-type rows, no purchase, no revenue)",
        g1 !== undefined &&
          g1.checkouts === 2 &&
          g1.sales === 0 &&
          Number(g1.revenue) === 0 &&
          Number(g1.pending_revenue) === 0 &&
          pb1.rowsZeroed === 0,
        JSON.stringify({ pb1, g1 }),
      );
      check(
        "PB2 ⭐⭐ IDEMPOTENCE: a second consecutive run leaves the row byte-identical, and still NON-ZERO",
        g2 !== undefined && g2.checkouts === 2 && JSON.stringify(g1) === JSON.stringify(g2),
        JSON.stringify({ g1, g2 }),
      );
      check(
        "PB3 ⭐ and the second run writes nothing and zeroes nothing — the oscillation is 1 written + 1 zeroed EVERY tick",
        pb2.rowsWritten === 0 && pb2.rowsZeroed === 0,
        JSON.stringify(pb2),
      );
      check(
        "PB4 ⭐ campaign_stages.checkout_click_count follows, and holds across both runs",
        gMirror1.checkout_click_count === 2 && gMirror2.checkout_click_count === 2,
        JSON.stringify({ gMirror1, gMirror2 }),
      );

      // ── Phase 5: the per-event block ──────────────────────────────────────
      // Every fixture below lands on its OWN stat_date so one shape can never be
      // read through another. Dates are set explicitly because seedConversionEvent
      // stamps now().
      //
      // ⚠️ THE ROW LOOKUPS BELOW ARE OPTIONAL, NOT `!`. A mutation these bars exist
      // to catch (an inner join in place of the LEFT JOIN) makes a whole stage-day
      // row disappear, and a `!` would turn that into a TypeError — a crash proves
      // nothing. Undefined has to reach `check()` as a FAILED assertion.
      console.log("\nPhase 5 — the per-event breakdown (`events` / `unmapped_conversions`)");
      const day = async (id: number, d: string) => {
        await tx.execute(sql`
          UPDATE conversion_events
          SET occurred_at = (${d}::text || ' 12:00:00 America/New_York')::timestamptz
          WHERE id = ${id}::bigint
        `);
      };
      type StoredRow = Awaited<ReturnType<typeof read>>[number];
      const dayRow = async (d: string): Promise<StoredRow | undefined> =>
        (await read(stageA)).find((r) => r.stat_date === d);
      const evOf = (r: StoredRow | undefined): EvMap => (r ? (JSON.parse(r.events) as EvMap) : {});
      const sumField = (m: EvMap, f: "revenue" | "pending_revenue") =>
        Object.values(m).reduce((s, v) => s + Number(v?.[f] ?? 0), 0);

      // regonly — a $0 registration, alone on 2026-09-20.
      await day(
        await seedConversionEvent(tx, { orgId, campaignId: camp, stageId: stageA, eventKey: "registration", status: "approved", revenue: 0 }),
        "2026-09-20",
      );
      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const reg = await dayRow("2026-09-20");
      const regEv = evOf(reg);
      check("P1 ⭐ a registration produces an `events` entry under its own key", regEv.registration?.n === 1, reg?.events ?? "no row");
      check("P2 ⭐ a registration is NOT a sale", reg?.sales === 0, JSON.stringify(reg));
      check("P3 ⭐ a registration carries NO revenue (its type is not counts_revenue)", Number(regEv.registration?.revenue ?? -1) === 0, reg?.events ?? "no row");
      check("P4 the registration stage-day has no unmapped rows", reg?.unmapped_conversions === 0, String(reg?.unmapped_conversions));
      check("P5 ⭐ no purchase key was invented for a registration-only day", reg !== undefined && regEv.purchase === undefined, reg?.events ?? "no row");

      // regonly_zeroing — re-project with NOTHING changed.
      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const reg2 = await dayRow("2026-09-20");
      check(
        "P6 ⭐ re-projecting a REGISTRATION-ONLY day does not wipe its breakdown (the widened zeroing anti-join)",
        evOf(reg2).registration !== undefined,
        reg2?.events ?? "no row",
      );

      // purchonly / pendpurch / rejpurch — EACH ALONE on its own stat_date, so a
      // bar can be satisfied only by that one shape being placed correctly.
      for (const [status, revenue, date] of [
        ["approved", 80, "2026-09-21"],
        ["pending", 60, "2026-09-25"],
        ["rejected", 99, "2026-09-26"],
      ] as const) {
        await day(
          await seedConversionEvent(tx, { orgId, campaignId: camp, stageId: stageA, eventKey: "purchase", status, revenue }),
          date,
        );
      }
      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const p1 = await dayRow("2026-09-21");
      const p1ev = evOf(p1);
      check(
        "P7a ⭐ an approved purchase ALONE: n=1, no pending, $80 revenue",
        p1ev.purchase?.n === 1 && p1ev.purchase.pending_n === 0 && Number(p1ev.purchase.revenue) === 80 && Number(p1ev.purchase.pending_revenue) === 0,
        p1?.events ?? "no row",
      );
      const p2 = await dayRow("2026-09-25");
      const p2ev = evOf(p2);
      check(
        "P7b ⭐ a PENDING purchase ALONE is counted (n=1) and its money is pending only",
        p2ev.purchase?.n === 1 && p2ev.purchase.pending_n === 1 && Number(p2ev.purchase.revenue) === 0 && Number(p2ev.purchase.pending_revenue) === 60,
        p2?.events ?? "no row",
      );
      const p3 = await dayRow("2026-09-26");
      check(
        "P7c ⭐ a REJECTED purchase ALONE produces an EMPTY events object and $0 everywhere",
        p3?.events === "{}" && p3.sales === 0 && Number(p3.revenue) === 0 && Number(p3.pending_revenue) === 0,
        JSON.stringify(p3),
      );

      // mixedday — the ONE day where all three statuses share an entry, which is
      // where the subset/exclusion arithmetic is worth asserting together.
      for (const [status, revenue] of [["approved", 80], ["pending", 60], ["rejected", 99]] as const) {
        await day(
          await seedConversionEvent(tx, { orgId, campaignId: camp, stageId: stageA, eventKey: "purchase", status, revenue }),
          "2026-09-27",
        );
      }
      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const pur = await dayRow("2026-09-27");
      const purEv = evOf(pur);
      check("P7 ⭐ counted purchases are approved + pending, never rejected", purEv.purchase?.n === 2, pur?.events ?? "no row");
      check("P8 ⭐ pending_n is the pending SUBSET of n, not a sibling count", purEv.purchase?.pending_n === 1, pur?.events ?? "no row");
      check("P9 ⭐ per-event revenue is APPROVED only", Number(purEv.purchase?.revenue) === 80, pur?.events ?? "no row");
      check("P10 ⭐ the held payout is in pending_revenue, on its own", Number(purEv.purchase?.pending_revenue) === 60, pur?.events ?? "no row");
      check(
        "P11 ⭐ the rejected $99 is in NO field of the entry",
        Number(purEv.purchase?.revenue) + Number(purEv.purchase?.pending_revenue) === 140,
        pur?.events ?? "no row",
      );

      // ⭐ THE FOOTING BARS. `sales`/`revenue`/`pending_revenue` come from
      // SALES_FILTER / REVENUE_FILTER / PENDING_REVENUE_FILTER; the object's
      // fields come from countedClause + the event_types join. Two different
      // expressions in the same statement, asserted equal — so a change to the
      // shared clauses that does not reach the per-event side goes RED here.
      const sumN = (e: EvMap, pred: (k: string) => boolean) =>
        Object.entries(e).filter(([k]) => pred(k)).reduce((s, [, v]) => s + (v?.n ?? 0), 0);
      check("P12 ⭐ sales = Σ n over is_purchase types", pur?.sales === sumN(purEv, (k) => k === "purchase"), `${pur?.sales} vs ${sumN(purEv, (k) => k === "purchase")}`);
      check(
        "P13 ⭐ revenue = Σ per-event revenue",
        Math.abs(Number(pur?.revenue) - sumField(purEv, "revenue")) < 1e-6,
        `${pur?.revenue} vs ${JSON.stringify(purEv)}`,
      );
      check(
        "P14 ⭐ pending_revenue = Σ per-event pending_revenue",
        Math.abs(Number(pur?.pending_revenue) - sumField(purEv, "pending_revenue")) < 1e-6,
        `${pur?.pending_revenue} vs ${JSON.stringify(purEv)}`,
      );

      // The three unmapped shapes, EACH ON ITS OWN DAY.
      await day(await seedConversionEvent(tx, { orgId, campaignId: camp, stageId: stageA }), "2026-09-22");
      await day(await seedConversionEvent(tx, { orgId, campaignId: camp, stageId: stageA, status: "approved" }), "2026-09-28");
      const purchaseTypeId = (
        (await tx.execute(sql`SELECT id FROM event_types WHERE org_id = ${orgId}::uuid AND key = 'purchase'`)) as unknown as { id: number }[]
      )[0].id;
      const statusNullId = (
        (await tx.execute(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
             occurred_at, campaign_id, stage_id)
          VALUES (${orgId}::uuid, ${"p5-statusnull-" + Date.now()}, 'lead', 'lead', ${purchaseTypeId}::int, NULL, 55,
                  now(), ${camp}::int, ${stageA}::int)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await day(statusNullId, "2026-09-29");

      // ⭐ foreign_type — the shape C-3 is about, and the one no other fixture can
      // reach: a ledger row in THIS org carrying ANOTHER org's event_type_id.
      // conversion_events.event_type_id has a plain FK to event_types(id) with no
      // composite (id, org_id), so this is representable, and
      // PURCHASE_EVENT_TYPE_IDS (lib/sale-attribution.ts) is not org-scoped, so
      // SALES_FILTER counts it while the org-scoped join cannot place it.
      const orgB = (
        (await tx.execute(sql`
          INSERT INTO organizations (name) VALUES (${"p5-orgB-" + Date.now()}) RETURNING id::text AS id
        `)) as unknown as { id: string }[]
      )[0].id;
      const foreignTypeId = (
        (await tx.execute(sql`
          INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
          VALUES (${orgB}::uuid, 'purchase', 'Purchase', 10, true, true, false)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const foreignId = (
        (await tx.execute(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
             occurred_at, campaign_id, stage_id)
          VALUES (${orgId}::uuid, ${"p5-foreign-" + Date.now()}, 'sale', 'sale', ${foreignTypeId}::int, 'approved', 70,
                  now(), ${camp}::int, ${stageA}::int)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await day(foreignId, "2026-09-30");

      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const un = await dayRow("2026-09-22");
      const un2 = await dayRow("2026-09-28");
      const un3 = await dayRow("2026-09-29");
      const fr = await dayRow("2026-09-30");
      check("P15a ⭐ no type AND no status is counted unmapped", un?.unmapped_conversions === 1 && un.events === "{}", JSON.stringify(un));
      check("P15b ⭐ no type WITH a real status is counted unmapped (a status-only mapping rule)", un2?.unmapped_conversions === 1 && un2.events === "{}", JSON.stringify(un2));
      check("P15c ⭐ a MAPPED type with a NULL status is counted unmapped", un3?.unmapped_conversions === 1 && un3.events === "{}", JSON.stringify(un3));
      check(
        "P17 ⭐ none of the three is a sale or revenue",
        [un, un2, un3].every((r) => r !== undefined && r.sales === 0 && Number(r.revenue) === 0 && Number(r.pending_revenue) === 0),
        JSON.stringify([un, un2, un3]),
      );
      check(
        "P18 ⭐ a CROSS-ORG event_type_id is counted UNMAPPED — the `et.key IS NULL` fix, and the only bar that can prove it",
        fr?.unmapped_conversions === 1 && fr.events === "{}",
        JSON.stringify(fr),
      );
      check(
        "P18b ⭐ …and it is exactly the residual the footing identity carries: SALES_FILTER still counts it, so sales=1 with an EMPTY breakdown, which is now VISIBLE in the badge instead of nowhere",
        fr?.sales === 1 && Number(fr.revenue) === 70,
        JSON.stringify(fr),
      );

      // deposit3 — a key the statement has never seen.
      await tx.execute(sql`
        INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
        VALUES (${orgId}::uuid, 'deposit', 'Deposits', 30, true, true, false)
      `);
      const depTypeId = (
        (await tx.execute(sql`SELECT id FROM event_types WHERE org_id = ${orgId}::uuid AND key = 'deposit'`)) as unknown as { id: number }[]
      )[0].id;
      const depId = (
        (await tx.execute(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
             occurred_at, campaign_id, stage_id)
          VALUES (${orgId}::uuid, ${"p5-deposit-" + Date.now()}, 'sale', 'sale', ${depTypeId}::int, 'approved', 25,
                  now(), ${camp}::int, ${stageA}::int)
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await day(depId, "2026-09-23");
      await syncStageDayConversions(tx, { stageIds: [stageA] });
      const dep = await dayRow("2026-09-23");
      const depEv = evOf(dep);
      check("P19 ⭐ a THIRD event type gets its own entry, with no code change", depEv.deposit?.n === 1, dep?.events ?? "no row");
      check("P20 ⭐ and it counts as a sale, because its registry row says is_purchase", dep?.sales === 1, JSON.stringify(dep));
      check("P21 ⭐ and its money is revenue, because its registry row says counts_revenue", Number(dep?.revenue) === 25 && Number(depEv.deposit?.revenue) === 25, dep?.events ?? "no row");

      // ⭐ INDEPENDENT RECOMPUTATION, differently shaped: no CTE, no jsonb, no
      // grouping by key — a flat aggregate straight off the ledger. This is the
      // proof that re-graining the statement did not move a scalar; a retyped copy
      // of the old statement would only prove the typist agreed with themselves.
      //
      // ⚠️ ORG-SCOPED (CLAUDE.md §3), and not only on principle: the A3 fixture
      // above deliberately parks a ledger row for ANOTHER org on this very stage,
      // which writes no keitaro_stage_results row at all. An unscoped recomputation
      // would read that day as a missing row and report drift that is by design.
      const indep = (await tx.execute(sql`
        SELECT (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date::text AS stat_date,
               count(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
               count(*) FILTER (WHERE ${CHECKOUT_FILTER})::int AS checkouts,
               coalesce(sum(ce.revenue) FILTER (WHERE ${REVENUE_FILTER}), 0)::text AS revenue,
               coalesce(sum(ce.revenue) FILTER (WHERE ${PENDING_REVENUE_FILTER}), 0)::text AS pending_revenue
        FROM conversion_events ce
        WHERE ce.stage_id = ${stageA}::int AND ce.org_id = ${orgId}::uuid
        GROUP BY 1
      `)) as unknown as { stat_date: string; sales: number; checkouts: number; revenue: string; pending_revenue: string }[];
      const stored = new Map((await read(stageA)).map((r) => [r.stat_date, r]));
      let drift = 0;
      for (const i of indep) {
        const s = stored.get(i.stat_date);
        if (
          !s ||
          s.sales !== i.sales ||
          s.checkouts !== i.checkouts ||
          Math.abs(Number(s.revenue) - Number(i.revenue)) > 1e-6 ||
          Math.abs(Number(s.pending_revenue) - Number(i.pending_revenue)) > 1e-6
        ) {
          drift++;
          console.log(`      drift on ${i.stat_date}: stored=${JSON.stringify(s)} independent=${JSON.stringify(i)}`);
        }
      }
      check("P22 ⭐ every scalar matches a flat, independently shaped recomputation", drift === 0, `${drift} day(s) differ`);
      // The complement: a stored day the recomputation does NOT cover is a day the
      // ledger no longer explains, and the ONLY legitimate shape for it is a fully
      // zeroed row (fixture S7's stale 2026-09-17). Stated as a property rather
      // than as `indep.length === stored.size`, which is false by construction here.
      const uncovered = [...stored.values()].filter((r) => !indep.some((i) => i.stat_date === r.stat_date));
      check(
        "P23 ⭐ the recomputation covered every stored day the ledger explains — and each day it does not is fully ZEROED",
        indep.length > 0 &&
          uncovered.every(
            (r) =>
              r.sales === 0 &&
              r.checkouts === 0 &&
              Number(r.revenue) === 0 &&
              Number(r.pending_revenue) === 0 &&
              r.events === "{}" &&
              r.unmapped_conversions === 0,
          ),
        `${indep.length} ledger days, ${stored.size} stored, uncovered=${JSON.stringify(uncovered.map((r) => r.stat_date))}`,
      );

      // ⭐ THE PARTITION BAR — this is what "structural" actually means here, and
      // it is the bar that replaces the claim the first draft of this plan made
      // and could not support. Every conversion_events row on a stage-day is in
      // EXACTLY ONE of: PLACED (a same-org event_types.key and a non-NULL status
      // — it has an entry in `events`, possibly all-zero and therefore filtered
      // out of the object) or UNMAPPED (counted in unmapped_conversions). No row
      // is in both; no row is in neither.
      const part = (await tx.execute(sql`
        SELECT (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date::text AS stat_date,
               count(*)::int AS total,
               count(*) FILTER (WHERE et.key IS NOT NULL AND ce.status IS NOT NULL)::int AS placed,
               count(*) FILTER (WHERE et.key IS NULL OR ce.status IS NULL)::int AS unplaced
        FROM conversion_events ce
        LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
        WHERE ce.stage_id = ${stageA}::int AND ce.org_id = ${orgId}::uuid
        GROUP BY 1
      `)) as unknown as { stat_date: string; total: number; placed: number; unplaced: number }[];
      check(
        "P23a ⭐ placed + unplaced = every ledger row, on every stage-day (the partition)",
        part.length > 0 && part.every((r) => r.placed + r.unplaced === r.total),
        JSON.stringify(part),
      );
      check(
        "P23b ⭐ the stored unmapped_conversions IS the unplaced count, day for day",
        part.length > 0 && part.every((r) => (stored.get(r.stat_date)?.unmapped_conversions ?? -1) === r.unplaced),
        JSON.stringify(part),
      );
      // The footing identity, with its residual named rather than assumed away.
      // `strays` is the number of UNPLACED rows that SALES_FILTER nevertheless
      // counts — today only the cross-org shape can do that. On a healthy corpus
      // it is 0; fixture `foreign_type` makes it 1, which is why this bar asserts
      // the identity WITH the term rather than asserting the term is zero.
      PURCHASE_KEYS = new Set(
        ((await tx.execute(sql`
           SELECT key FROM event_types WHERE org_id = ${orgId}::uuid AND is_purchase
         `)) as unknown as { key: string }[]).map((r) => r.key),
      );
      const strays = (await tx.execute(sql`
        SELECT count(*)::int AS n
        FROM conversion_events ce
        LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
        WHERE ce.stage_id = ${stageA}::int AND ce.org_id = ${orgId}::uuid AND et.key IS NULL AND ${SALES_FILTER}
      `)) as unknown as { n: number }[];
      const totalSales = [...stored.values()].reduce((s, r) => s + r.sales, 0);
      const totalPurchaseN = [...stored.values()].reduce(
        (s, r) => s + sumN(evOf(r), (k) => PURCHASE_KEYS.has(k)),
        0,
      );
      check(
        "P23c ⭐ sales = Σ (is_purchase) n + strays — the identity WITH its residual, not a hopeful equality",
        totalSales === totalPurchaseN + Number(strays[0].n),
        `${totalSales} vs ${totalPurchaseN} + ${strays[0].n}`,
      );
      check(
        "P23d ⭐ the residual is exactly the cross-org fixture — 1, not 0, so this bar is exercised and not a countdown",
        Number(strays[0].n) === 1,
        String(strays[0].n),
      );
      // ⭐ THE SAME IDENTITY FOR MONEY, ACROSS THE WHOLE CORPUS. P13 is one day;
      // this one is every stored day at once, and it is the bar that catches a
      // per-event revenue aggregate that stops reading `counts_revenue` — the
      // flag lives ONLY on the per-event side, so dropping it moves no scalar and
      // no single-day purchase bar. Its residual is the same cross-org row,
      // counted in dollars.
      const strayRevenue = (await tx.execute(sql`
        SELECT coalesce(sum(ce.revenue), 0)::text AS amount
        FROM conversion_events ce
        LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
        WHERE ce.stage_id = ${stageA}::int AND ce.org_id = ${orgId}::uuid AND et.key IS NULL AND ${REVENUE_FILTER}
      `)) as unknown as { amount: string }[];
      const totalRevenue = [...stored.values()].reduce((s, r) => s + Number(r.revenue), 0);
      const totalEvRevenue = [...stored.values()].reduce((s, r) => s + sumField(evOf(r), "revenue"), 0);
      check(
        "P14b ⭐ revenue = Σ per-event revenue + strays, over EVERY stored day",
        Math.abs(totalRevenue - (totalEvRevenue + Number(strayRevenue[0].amount))) < 1e-6,
        `${totalRevenue} vs ${totalEvRevenue} + ${strayRevenue[0].amount}`,
      );
      check(
        "P14c ⭐ the revenue residual is the cross-org $70 — non-zero, so P14b is exercised and not a countdown",
        Number(strayRevenue[0].amount) === 70,
        strayRevenue[0].amount,
      );

      // The parse the readers will do, against a REAL row (the driver returns
      // jsonb as parsed JS, so the numerics arrive as NUMBERS here, not strings —
      // parseEventMap accepts both, and this is the bar for the number form).
      //
      // ⚠️ THE ROW IS THE MIXED DAY (2026-09-27), not the brief's 2026-09-21: the
      // asserted pair (n = 2 AND revenue = 80) is the mixed day's — 2026-09-21
      // carries ONE approved purchase, so its n is 1 and P7a says so. The values
      // are the brief's, verbatim; the date is the one they describe.
      const live = (await tx.execute(sql`
        SELECT events FROM keitaro_stage_results
        WHERE org_id = ${orgId}::uuid AND stage_id = ${stageA}::int AND stat_date = '2026-09-27'::date
      `)) as unknown as { events: unknown }[];
      const parsed = parseEventMap(live[0]?.events);
      check(
        "P24 ⭐ parseEventMap reads a REAL jsonb row (numeric form, not the text form)",
        parsed.purchase?.revenue === 80 && parsed.purchase?.n === 2,
        JSON.stringify(live[0]?.events),
      );

      // ── Step 3b: the ledger_behind_history probe knows the two new columns ──
      // ⚠️ LAST, AND IN SAVEPOINTS. This refusal is GLOBAL: it aborts the whole
      // projection, so a fixture that trips it would mask every bar after it.
      console.log("\nA2 (Phase 5) — the third refusal still fires on the NEW columns alone");
      // ⭐ THE WORLD-STATE THIS PAIR IS ABOUT. Without a historical row the very
      // same call must NOT refuse, or P25/P26 would pass against a projection that
      // refuses everything and prove nothing.
      const beforeHistorical = await syncStageDayConversions(tx, { stageIds: [stageA] });
      check(
        "P24b the same call refuses NOTHING before the historical row is seeded",
        beforeHistorical.refused === null,
        JSON.stringify(beforeHistorical),
      );
      // The ledger's GLOBAL floor is stage A's EARLY conversion (2026-05-01), so a
      // stored row on 2026-04-02 is reported history the ledger cannot reach. Each
      // shape is seeded in its OWN savepoint and rolled back, because the refusal
      // is global and would otherwise mask everything after it.
      const historicalRow = async (label: string, extraCols: SQL, extraVals: SQL) => {
        try {
          await tx.transaction(async (tx2) => {
            await tx2.execute(sql`
              INSERT INTO keitaro_stage_results
                (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, ${extraCols})
              VALUES (${orgId}::uuid, ${camp}::int, ${stageC}::int, 'seed', '2026-04-02'::date, ${extraVals})
            `);
            const refused = await syncStageDayConversions(tx2, { stageIds: [stageA] });
            check(
              label,
              refused.refused === "ledger_behind_history" &&
                refused.rowsWritten === 0 &&
                refused.rowsZeroed === 0 &&
                refused.reportedHistoryFloor === "2026-04-02",
              JSON.stringify(refused),
            );
            throw new Rollback();
          });
        } catch (err) {
          if (!(err instanceof Rollback)) throw err;
        }
      };
      // Every SCALAR left at its default 0 — `events` alone carries the signal.
      await historicalRow(
        "P25 ⭐ a historical row whose ONLY signal is `events` still trips ledger_behind_history",
        sql`events`,
        sql`'{"registration": {"n": 1, "pending_n": 0, "revenue": 0, "pending_revenue": 0}}'::jsonb`,
      );
      await historicalRow(
        "P26 ⭐ and one whose only signal is unmapped_conversions does too",
        sql`unmapped_conversions`,
        sql`3::int`,
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
