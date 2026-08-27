// Guard for the query shape that killed every hourly Telegram report on
// 2026-08-27 (see lib/sends/stall-detector.ts → stageSendStats).
//
// THE WORLD-STATE THIS MODELS: "a stall candidate that has NEVER SENT." That is
// the pathological input — not a big table, not many candidates. A stage with no
// `sent_at` row is what turns a correlated `max(ss.sent_at) WHERE stage_id = s.id`
// into a full backward walk of `stage_sends_sent_at_contact_idx` (stage_id is a
// FILTER there, not an index condition), because there is no first match to stop
// at. Measured on prod: 48s for ONE such stage.
//
// The test does not depend on a never-sent stage existing in live data — it
// synthesises the input by picking a stage id that provably has ZERO stage_sends
// rows, so the guard cannot quietly expire once the live queue unblocks.
// Read-only: no rows are written.
import "./_env-preload";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { findStalledStages, stageSendStats } from "@/lib/sends/stall-detector";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
}

// stageSendStats must resolve a never-sent stage from stage_id, not by scanning
// the sent_at index. 500ms is ~100x the measured good plan (3.7ms) and ~100x
// BELOW the bad one (48s), so it cannot be tripped by ordinary load.
const STATS_BUDGET_MS = 500;
// End-to-end budget for the detector against live data. The caller (the hourly
// Telegram cron) has a 10s watch timeout and a 60s function limit.
const DETECTOR_BUDGET_MS = 10000;

async function main() {
  const maxRow = (await db.execute(
    sql`SELECT coalesce(max(stage_id), 0)::int AS m FROM stage_sends`,
  )) as unknown as { m: number }[];
  const absentId = Number(maxRow[0].m) + 1000;

  const total = (await db.execute(
    sql`SELECT count(*)::bigint AS n FROM stage_sends`,
  )) as unknown as { n: string }[];
  const present = (await db.execute(
    sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${absentId}`,
  )) as unknown as { n: number }[];

  console.log(`scope: stage_sends has ${Number(total[0].n).toLocaleString()} rows`);
  console.log(`scope: probing stage_id=${absentId} (rows for it: ${present[0].n})`);
  // A probe id that HAS rows would not model "never sent" — fail loudly rather
  // than pass against the wrong input.
  check("probe stage id has zero sends (models 'never sent')", Number(present[0].n) === 0);
  check(
    "table is large enough for the bad plan to be catastrophic",
    Number(total[0].n) > 100_000,
    `only ${total[0].n} rows — guard is not meaningful on a small table`,
  );

  // ── the guard ─────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const stats = await stageSendStats(db, [absentId]);
  const statsMs = Date.now() - t0;
  console.log(`stageSendStats([never-sent]) took ${statsMs}ms`);
  check(
    `stageSendStats resolves a never-sent stage in <${STATS_BUDGET_MS}ms`,
    statsMs < STATS_BUDGET_MS,
    `took ${statsMs}ms — the correlated max() plan is back (was 48,000ms)`,
  );
  check("never-sent stage yields no stats row", stats.get(absentId) === undefined);

  // The plan itself, so a regression is diagnosable and not just "slow today".
  const plan = (await db.execute(sql`
    EXPLAIN (COSTS OFF)
    SELECT ss.stage_id, count(*) FILTER (WHERE ss.status = 'pending')::int, max(ss.sent_at)
    FROM stage_sends ss WHERE ss.stage_id IN (${absentId}) GROUP BY ss.stage_id
  `)) as unknown as Record<string, string>[];
  const planText = plan.map((r) => Object.values(r)[0]).join("\n");
  check(
    "plan does not fall back to the sent_at index",
    !planText.includes("stage_sends_sent_at_contact_idx"),
    `\n${planText}`,
  );

  // ── end to end against live data ──────────────────────────────────────────
  const t1 = Date.now();
  const stalled = await findStalledStages(db, { now: new Date(), thresholdMinutes: 30 });
  const detectorMs = Date.now() - t1;
  const neverSent = stalled.filter((s) => s.last_sent === null).length;
  console.log(
    `findStalledStages took ${detectorMs}ms — ${stalled.length} stalled ` +
      `(${neverSent} of them never-sent)`,
  );
  check(
    `findStalledStages completes in <${DETECTOR_BUDGET_MS}ms`,
    detectorMs < DETECTOR_BUDGET_MS,
    `took ${detectorMs}ms`,
  );
  // Every returned stage must carry its stats — proves the second-pass join back
  // onto the candidate list did not silently drop rows.
  check(
    "every stalled stage has a pending count",
    stalled.every((s) => Number.isFinite(s.pending) && s.pending > 0),
    JSON.stringify(stalled.map((s) => ({ id: s.stage_id, pending: s.pending }))),
  );

  await pgConn.end();
  console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
