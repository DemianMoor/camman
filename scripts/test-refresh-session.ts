// Tests for the report-refresh session connection and the independent
// per-view refresh. PREVIEW DATABASE ONLY — _require-preview-db refuses
// anything else, and test 9 deliberately renames a matview, so this must never
// be pointed at production.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-refresh-session.ts
import "./_env-preload";
import "./_require-preview-db";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

import {
  REFRESH_STATEMENT_TIMEOUT,
  REFRESH_WORK_MEM,
  toSessionModeUrl,
  withRefreshSession,
} from "../lib/reporting/refresh-session";
import { refreshOfferGroupReport } from "../lib/reporting/offer-group-report";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const REPO = path.resolve(__dirname, "..");
const VIEWS = [
  "offer_report_org_summary_mv",
  "offer_group_report_mv",
  "offer_report_offer_totals_mv",
  "audience_report_group_totals_mv",
];

// ── source-scan bar ──────────────────────────────────────────────────────────
// Line endings are normalized before matching so the bar behaves identically on
// a CRLF working copy (Windows, core.autocrlf=true) and an LF one (CI, Linux).
// A needle that only matches one of the two is a bar that silently stops
// guarding half the time.
function scanSource(file: string, needles: string[]): boolean {
  const raw = fs.readFileSync(path.join(REPO, file), "utf8");
  const normalized = raw.replace(/\r\n/g, "\n");
  return needles.some((n) => normalized.includes(n));
}

async function main() {
  // ── 1-2. URL derivation (pure) ─────────────────────────────────────────────
  const txn = toSessionModeUrl("postgresql://u:p@db.example.com:6543/postgres?prepare=false");
  check(
    "toSessionModeUrl rewrites the transaction pooler port 6543 -> 5432",
    new URL(txn).port === "5432",
    `got port ${new URL(txn).port}`,
  );
  check(
    "toSessionModeUrl drops the transaction-pooler prepare=false flag",
    !new URL(txn).searchParams.has("prepare"),
  );

  const already = toSessionModeUrl("postgresql://u:p@db.example.com:5432/postgres");
  check(
    "toSessionModeUrl passes a session-mode URL through unchanged",
    new URL(already).port === "5432" && new URL(already).hostname === "db.example.com",
  );

  // ── 3-5. The settings actually apply, and PERSIST across statements ────────
  // Each read below is its OWN execute() call, deliberately separate from the
  // SET that set it. On a transaction pooler those land on different backends
  // and the value reverts; that this does not happen is the whole point of the
  // session-mode connection.
  const readings = await withRefreshSession(async (db) => {
    const first = (await db.execute(sql`
      select (select setting::bigint from pg_settings where name = 'work_mem') as wm,
             (select setting::bigint from pg_settings where name = 'statement_timeout') as st
    `)) as unknown as { wm: string; st: string }[];
    // A second, later statement — proves it is not just the first read winning.
    const second = (await db.execute(sql`
      select (select setting::bigint from pg_settings where name = 'work_mem') as wm,
             (select setting::bigint from pg_settings where name = 'statement_timeout') as st
    `)) as unknown as { wm: string; st: string }[];
    return { first: first[0], second: second[0] };
  });

  check(
    `work_mem applied on the refresh session (${REFRESH_WORK_MEM} = 393216kB)`,
    Number(readings.first.wm) === 393216,
    `read back ${readings.first.wm}kB`,
  );
  check(
    `statement_timeout applied on the refresh session (${REFRESH_STATEMENT_TIMEOUT} = 180000ms)`,
    Number(readings.first.st) === 180000,
    `read back ${readings.first.st}ms`,
  );
  check(
    "both settings still hold on a LATER statement (session mode, not per-transaction)",
    Number(readings.second.wm) === 393216 && Number(readings.second.st) === 180000,
    `second read: work_mem=${readings.second.wm}kB statement_timeout=${readings.second.st}ms`,
  );

  // ── 6-7. The connection is closed, on both paths ───────────────────────────
  let escaped: PostgresJsDatabase | null = null;
  await withRefreshSession(async (db) => {
    escaped = db;
  });
  let closedAfterSuccess = false;
  try {
    await escaped!.execute(sql`select 1`);
  } catch {
    closedAfterSuccess = true;
  }
  check("connection is closed after a successful run", closedAfterSuccess);

  let escapedOnThrow: PostgresJsDatabase | null = null;
  const boom = new Error("deliberate failure inside the session");
  let rethrown: unknown = null;
  try {
    await withRefreshSession(async (db) => {
      escapedOnThrow = db;
      throw boom;
    });
  } catch (e) {
    rethrown = e;
  }
  check("withRefreshSession rethrows what fn() threw", rethrown === boom);
  let closedAfterThrow = false;
  try {
    await escapedOnThrow!.execute(sql`select 1`);
  } catch {
    closedAfterThrow = true;
  }
  check("connection is closed by `finally` when fn() throws", closedAfterThrow);

  // ── 8. A clean run refreshes all four and stamps all four ──────────────────
  const probe = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const stampsBefore = await readStamps(probe);

  const clean = await refreshOfferGroupReport();
  check("clean run reports no failures", clean.failed.length === 0, clean.failed.join(", "));
  check("clean run returns one outcome per view", clean.outcomes.length === 4);
  check(
    "clean run marks every view ok",
    clean.outcomes.every((o) => o.ok),
    clean.outcomes.map((o) => `${o.view}=${o.ok}`).join(" "),
  );
  const stampsAfter = await readStamps(probe);
  check(
    "clean run advances all four report_refresh_log stamps",
    VIEWS.every((v) => stampsAfter[v] > stampsBefore[v]),
    VIEWS.map((v) => `${v}:${stampsAfter[v] > stampsBefore[v]}`).join(" "),
  );

  // ── 9. THE POINT OF THE CHANGE: one view's failure freezes ONE view ────────
  // Rename the group matview out from under the refresh so its statement fails
  // with "relation does not exist". Dependent matviews reference it by OID, so
  // audience_report_group_totals_mv is unaffected and still refreshes — which
  // is exactly the isolation being tested.
  const before = await readStamps(probe);
  let partial: Awaited<ReturnType<typeof refreshOfferGroupReport>> | null = null;
  let threw: unknown = null;
  try {
    await probe`alter materialized view offer_group_report_mv rename to offer_group_report_mv_rt`;
    // Caught here on purpose: if the loop ever goes back to aborting the run on
    // the first failure, that must surface as a RED check, not as a crash that
    // skips every assertion after it.
    try {
      partial = await refreshOfferGroupReport();
    } catch (e) {
      threw = e;
    }
  } finally {
    await probe`alter materialized view offer_group_report_mv_rt rename to offer_group_report_mv`;
  }
  const after = await readStamps(probe);

  check(
    "a failing view does NOT throw out of refreshOfferGroupReport",
    threw === null && partial !== null,
    threw ? `threw: ${(threw as Error).message}` : "returned null",
  );
  if (partial === null) {
    // Every remaining assertion reads `partial`; report them all RED rather
    // than crashing on the first dereference.
    for (const name of [
      "the failing view is reported in `failed`",
      "the failure carries an error message (reported, not swallowed)",
      "the OTHER THREE views still refreshed — including the two queued behind it",
      "the other three stamped their own success in report_refresh_log",
      "the failed view did NOT stamp a success (its staleness stays visible)",
    ]) {
      check(name, false, "refreshOfferGroupReport threw — the run aborted");
    }
  } else {
  check(
    "the failing view is reported in `failed`",
    partial!.failed.length === 1 && partial!.failed[0] === "offer_group_report_mv",
    `failed=[${partial!.failed.join(", ")}]`,
  );
  check(
    "the failure carries an error message (reported, not swallowed)",
    Boolean(partial!.outcomes.find((o) => o.view === "offer_group_report_mv")?.error),
  );
  const others = VIEWS.filter((v) => v !== "offer_group_report_mv");
  check(
    "the OTHER THREE views still refreshed — including the two queued behind it",
    others.every((v) => partial!.outcomes.find((o) => o.view === v)?.ok === true),
    others.map((v) => `${v}=${partial!.outcomes.find((o) => o.view === v)?.ok}`).join(" "),
  );
  check(
    "the other three stamped their own success in report_refresh_log",
    others.every((v) => after[v] > before[v]),
    others.map((v) => `${v}:${after[v] > before[v]}`).join(" "),
  );
  check(
    "the failed view did NOT stamp a success (its staleness stays visible)",
    after["offer_group_report_mv"] === before["offer_group_report_mv"],
  );
  }

  await probe.end();

  // ── 10-11. Source-scan bars ────────────────────────────────────────────────
  check(
    "the refresh loop reports per-view failures instead of throwing out",
    scanSource("lib/reporting/offer-group-report.ts", [
      "ok: false,",
      "outcomes.filter((o) => !o.ok)",
    ]),
  );
  check(
    "the route surfaces which views succeeded and which did not",
    scanSource("app/api/cron/refresh-offer-group-report/route.ts", [
      '"refresh_partial"',
      "refreshed,",
    ]),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function readStamps(probe: postgres.Sql): Promise<Record<string, number>> {
  const rows = await probe`select view_name, refreshed_at from report_refresh_log`;
  const out: Record<string, number> = {};
  for (const r of rows as unknown as { view_name: string; refreshed_at: Date | null }[]) {
    out[r.view_name] = r.refreshed_at ? new Date(r.refreshed_at).getTime() : 0;
  }
  return out;
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
