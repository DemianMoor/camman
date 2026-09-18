import { sql, type SQL } from "drizzle-orm";

// PRECONDITION CHECKS FOR PROD-FACING DIAGNOSTICS.
//
// Phase 3's readers select columns that only exist once the phase's migrations
// are applied. Prod is at 0180 until Task 8 Step 5 applies 0181/0182/0183, so a
// read-only diagnostic pointed at prod today dies on a raw Postgres
// `42703 undefined_column` — a message that says nothing about migrations and is
// very easy to read as "the reporting path is broken", which is exactly the
// wrong conclusion to reach during the cutover.
//
// These helpers turn that into one sentence that names the migration, the
// column, and the two ways forward. Cheap, and they cost nothing once the
// migration is applied (one catalogue lookup).

/** Anything with Drizzle's `.execute()` — the global `db`, a tx, or a script's own client. */
export interface SqlExecutor {
  execute: (query: SQL) => Promise<unknown>;
}

async function columnExists(dbc: SqlExecutor, table: string, column: string): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    SELECT 1 AS present
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * `keitaro_stage_results.pending_revenue` (migration 0182) — selected
 * unconditionally by lib/reporting/stage-funnel.ts::getStageMetricsInRange, so
 * EVERY caller of it needs 0182 applied wherever it is pointed. Exits 1 with an
 * explanation instead of letting the 42703 surface raw.
 */
export async function requirePendingRevenueColumn(dbc: SqlExecutor, scriptName: string): Promise<void> {
  if (await columnExists(dbc, "keitaro_stage_results", "pending_revenue")) return;
  console.error(
    [
      "",
      `${scriptName}: PRECONDITION NOT MET — this database needs migration 0182.`,
      "",
      "  keitaro_stage_results.pending_revenue does not exist here. This script calls",
      "  getStageMetricsInRange (lib/reporting/stage-funnel.ts), which selects that",
      "  column unconditionally, so it would fail with Postgres 42703 undefined_column.",
      "",
      "  That is a MISSING MIGRATION, not a reporting regression.",
      "",
      "  Either:",
      "    • point it at camman-v2, where 0181-0183 are applied:",
      `        DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" npx tsx scripts/${scriptName}.ts`,
      "    • or wait until Phase 3 Task 8 Step 5 applies 0181/0182/0183 to prod.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
