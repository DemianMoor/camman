import { readFileSync } from "node:fs";

import {
  migrationPreconditionMessage,
  missingColumns,
  REPORTING_READ_COLUMNS,
  REPORTING_TABLE,
  requireReportingColumns,
  type SqlExecutor,
} from "./_require-migration";

// PURE — no database. Run: npx tsx scripts/test-require-migration.ts
//
// ⭐ WHAT THIS GUARDS IS A GUARD, AND THE FAILURE IT EXISTS FOR ALREADY HAPPENED.
// scripts/_require-migration.ts refused to run a prod-facing diagnostic against a
// database missing `keitaro_stage_results.pending_revenue` (0182). Phase 5 then
// widened the very projection it protects — `events` and `unmapped_conversions`
// (0185) — and the guard did not follow. Against a database at 0182-0184 the
// script PASSED its own precondition and died one line later on a raw Postgres
// 42703, which is precisely the failure the helper exists to prevent.
//
// G1 is the bar that would have caught it: the guard's column list is compared
// with the columns the READ PATH'S SOURCE actually names, so a column added to
// the projection without being added to the guard goes red here — on a machine
// with no database at all — instead of on the first operator to point a script
// at a database that is behind.

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

// ── G1: the guard's set IS the read path's set ──────────────────────────────
// Derived from the source, not transcribed from it: every
// `keitaro_stage_results.<column>` getStageMetricsInRange names. Set EQUALITY in
// both directions — a column added to the projection and forgotten here is the
// bug this file exists for, and a column left here after the projection stopped
// selecting it is a refusal that asks for a migration nothing needs.
const funnelSrc = readFileSync("lib/reporting/stage-funnel.ts", "utf8");
const fromSource = new Set(
  [...funnelSrc.matchAll(new RegExp(`${REPORTING_TABLE}\\.([a-z_][a-z0-9_]*)`, "g"))].map(
    (m) => m[1],
  ),
);
const guarded = new Set(REPORTING_READ_COLUMNS.map((c) => c.column));
const notGuarded = [...fromSource].filter((c) => !guarded.has(c)).sort();
const notSelected = [...guarded].filter((c) => !fromSource.has(c)).sort();
check(
  `G1 ⭐ the guard covers EVERY keitaro_stage_results column the read path selects (${fromSource.size} in source, ${guarded.size} guarded)`,
  fromSource.size > 10 && notGuarded.length === 0 && notSelected.length === 0,
  `unguarded=[${notGuarded.join(",")}] stale=[${notSelected.join(",")}]`,
);
// Positive control for the extractor itself: if the regex silently matched
// nothing, G1 above would pass vacuously on an empty set.
check(
  "G1b the extractor really reads the source (it finds the two columns 0185 added)",
  fromSource.has("events") && fromSource.has("unmapped_conversions"),
  [...fromSource].sort().join(","),
);

// ── G2: a 0182-era database is NAMED, not left to 42703 ─────────────────────
// The world: every column the reporting projection needs EXCEPT the two that
// migration 0185 adds — i.e. exactly a database at 0182, 0183 or 0184. This is
// the state the old guard passed.
const AT_0182 = new Set(
  REPORTING_READ_COLUMNS.filter((c) => c.migration !== "0185").map((c) => c.column),
);
const missing = missingColumns(REPORTING_READ_COLUMNS, AT_0182);
check(
  "G2 ⭐ a database at 0182-0184 is MISSING, and the guard says which two columns",
  missing.length === 2 &&
    missing.every((c) => c.migration === "0185") &&
    missing.some((c) => c.column === "events") &&
    missing.some((c) => c.column === "unmapped_conversions"),
  JSON.stringify(missing),
);
const msg = migrationPreconditionMessage("test-stage-funnel", missing);
check(
  "G2b ⭐ …and the MESSAGE names the column and the migration, not a bare error code",
  msg.includes(`${REPORTING_TABLE}.events`) &&
    msg.includes(`${REPORTING_TABLE}.unmapped_conversions`) &&
    msg.includes("migration 0185") &&
    msg.includes("PRECONDITION NOT MET") &&
    msg.includes("test-stage-funnel"),
  msg,
);
// The old, narrow world: pending_revenue alone missing must still be caught and
// must name 0182 — widening the guard may not drop the case it started as.
const AT_0181 = new Set(
  REPORTING_READ_COLUMNS.filter(
    (c) => c.migration !== "0182" && c.migration !== "0185",
  ).map((c) => c.column),
);
const missing0181 = missingColumns(REPORTING_READ_COLUMNS, AT_0181);
check(
  "G2c the original case survives the widening: a 0181 database names pending_revenue AND 0182",
  missing0181.some((c) => c.column === "pending_revenue" && c.migration === "0182") &&
    migrationPreconditionMessage("x", missing0181).includes("0182, 0185"),
  migrationPreconditionMessage("x", missing0181),
);

// ── G3: the REAL function, wired end to end ─────────────────────────────────
// missingColumns/migrationPreconditionMessage are pure and asserted above; this
// drives requireReportingColumns itself against a stub catalogue, so the query,
// the diff and the exit are proved together rather than assumed to be connected.
const executorWith = (cols: Iterable<string>): SqlExecutor => ({
  execute: async () => [...cols].map((c) => ({ column_name: c })),
});
const EXITED = Symbol("exit");
async function runGuard(cols: Iterable<string>): Promise<{ code: number | null; err: string }> {
  const realExit = process.exit;
  const realError = console.error;
  let code: number | null = null;
  let err = "";
  // The real helper calls process.exit(1); replacing it with a throw is what
  // lets this bar observe the refusal instead of taking the whole run down.
  (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => {
    code = c ?? 0;
    throw EXITED;
  }) as never;
  console.error = (...a: unknown[]) => {
    err += a.map(String).join(" ");
  };
  try {
    await requireReportingColumns(executorWith(cols), "test-stage-funnel");
  } catch (e) {
    if (e !== EXITED) throw e;
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  return { code, err };
}

async function main() {
  const behind = await runGuard(AT_0182);
  check(
    "G3 ⭐ requireReportingColumns EXITS 1 on a 0182-era catalogue and prints the missing columns",
    behind.code === 1 &&
      behind.err.includes(`${REPORTING_TABLE}.events`) &&
      behind.err.includes("migration 0185"),
    JSON.stringify(behind),
  );
  const current = await runGuard(guarded);
  check(
    "G3b ⭐ …and RETURNS, silently, when every column is present (the one-sided control)",
    current.code === null && current.err === "",
    JSON.stringify(current),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
