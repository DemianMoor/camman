import { sql, type SQL } from "drizzle-orm";

// PRECONDITION CHECKS FOR PROD-FACING DIAGNOSTICS.
//
// The reporting read path (lib/reporting/stage-funnel.ts::getStageMetricsInRange)
// selects columns that only exist once their migrations are applied, so a
// read-only diagnostic pointed at a database that is behind dies on a raw
// Postgres `42703 undefined_column` — a message that says nothing about
// migrations and is very easy to read as "the reporting path is broken", which is
// exactly the wrong conclusion to reach during a cutover.
//
// These helpers turn that into one sentence that names the MISSING COLUMN, the
// migration that adds it, and the two ways forward. Cheap, and they cost nothing
// once the migrations are applied (one catalogue query).
//
// ⭐ THE GUARD'S SET IS THE READ PATH'S SET, AND THAT IS WHAT MAKES IT A GUARD.
// It used to check `pending_revenue` (0182) ALONE, under a helper named after
// that one column. Then the read path widened — Phase 5 added `events` and
// `unmapped_conversions` (0185) to the very same projection — and the guard did
// not. Against a database at 0182-0184 the script then PASSED its own
// precondition and died on the raw 42703 one line later: the guard had become a
// reassurance. The list below is therefore the whole projection, not a
// highlight, and bar G1 of scripts/test-require-migration.ts derives the
// expected set from stage-funnel.ts's source so a column added to the select
// without being added here goes red BEFORE it reaches a database that lacks it.

/** Anything with Drizzle's `.execute()` — the global `db`, a tx, or a script's own client. */
export interface SqlExecutor {
  execute: (query: SQL) => Promise<unknown>;
}

/** The one table the reporting read path projects from. */
export const REPORTING_TABLE = "keitaro_stage_results";

/** One column that projection names, and the migration that introduced it. */
export interface RequiredColumn {
  column: string;
  migration: string;
}

/**
 * Every `keitaro_stage_results` column getStageMetricsInRange names — in its
 * projection, in its WHERE, and in the lifetime-revenue aggregate beside it.
 *
 * `migration` is the file that ADDS the column, which is what the operator has
 * to apply; it is printed, so it must be right. 0061 created the table, 0062
 * split visits from redirects, 0182 added pending money, 0185 the per-event
 * breakdown.
 */
export const REPORTING_READ_COLUMNS: readonly RequiredColumn[] = [
  { column: "org_id", migration: "0061" },
  { column: "campaign_id", migration: "0061" },
  { column: "stage_id", migration: "0061" },
  { column: "stage_tracking_id", migration: "0061" },
  { column: "stat_date", migration: "0061" },
  { column: "raw_clicks", migration: "0061" },
  { column: "clean_clicks", migration: "0061" },
  { column: "sales", migration: "0061" },
  { column: "revenue", migration: "0061" },
  { column: "cost", migration: "0061" },
  { column: "visit_clicks_raw", migration: "0062" },
  { column: "visit_clicks_clean", migration: "0062" },
  { column: "redirect_clicks_raw", migration: "0062" },
  { column: "redirect_clicks_clean", migration: "0062" },
  { column: "pending_revenue", migration: "0182" },
  { column: "events", migration: "0185" },
  { column: "unmapped_conversions", migration: "0185" },
];

/** Which of `required` the database does not have. PURE — bar G2 drives it directly. */
export function missingColumns(
  required: readonly RequiredColumn[],
  present: ReadonlySet<string>,
): RequiredColumn[] {
  return required.filter((c) => !present.has(c.column));
}

/**
 * The refusal, as text. PURE, so the bar can read the sentence the operator gets
 * instead of asserting on a process exit code alone.
 *
 * It NAMES EVERY MISSING COLUMN with its migration. Naming only the first would
 * send the operator round the loop once per column, and the whole point of this
 * helper is that one run tells you what to apply.
 */
export function migrationPreconditionMessage(
  scriptName: string,
  missing: readonly RequiredColumn[],
): string {
  const migrations = [...new Set(missing.map((c) => c.migration))].sort();
  return [
    "",
    `${scriptName}: PRECONDITION NOT MET — this database needs migration${
      migrations.length > 1 ? "s" : ""
    } ${migrations.join(", ")}.`,
    "",
    ...missing.map(
      (c) => `  MISSING: ${REPORTING_TABLE}.${c.column}  (added by migration ${c.migration})`,
    ),
    "",
    "  This script reaches getStageMetricsInRange (lib/reporting/stage-funnel.ts),",
    "  which selects those columns unconditionally, so it would fail with Postgres",
    "  42703 undefined_column.",
    "",
    "  That is a MISSING MIGRATION, not a reporting regression.",
    "",
    "  Either:",
    "    • point it at camman-v2, where the Phase 3-5 migrations are applied:",
    `        DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" npx tsx scripts/${scriptName}.ts`,
    "    • or apply the migration(s) above to the database you are pointing at.",
    "",
  ].join("\n");
}

/** The columns `table` actually has, from the catalogue. One query, no array interpolation. */
async function presentColumns(dbc: SqlExecutor, table: string): Promise<Set<string>> {
  const rows = (await dbc.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
  `)) as unknown as { column_name: string }[];
  return new Set(rows.map((r) => r.column_name));
}

/**
 * Refuse to run unless this database carries EVERY column the reporting read
 * path selects. Exits 1 with the missing columns named, instead of letting a
 * 42703 surface raw.
 */
export async function requireReportingColumns(
  dbc: SqlExecutor,
  scriptName: string,
): Promise<void> {
  const present = await presentColumns(dbc, REPORTING_TABLE);
  const missing = missingColumns(REPORTING_READ_COLUMNS, present);
  if (missing.length === 0) return;
  console.error(migrationPreconditionMessage(scriptName, missing));
  process.exit(1);
}
