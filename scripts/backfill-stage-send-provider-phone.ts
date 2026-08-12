// One-shot backfill: stamp stage_sends.provider_phone_id from the parent
// stage for rows written before migration 0112 added the column. Idempotent
// — only writes rows where provider_phone_id IS NULL, so a partial run
// resumes cleanly.
//
// Measured on prod 2026-08-12: 1,008,689 NULL rows, 100% resolvable via
// campaign_stages, 3 distinct phones. Everything before 2026-07-18.
//
// Run:  npx tsx scripts/backfill-stage-send-provider-phone.ts           (dry run)
//       npx tsx scripts/backfill-stage-send-provider-phone.ts --apply   (writes)
//
// Each batch is SELECTed, appended to the reversal file, and flushed to disk
// BEFORE the UPDATE that changes those rows — so a crash mid-run can only
// ever leave the reversal file naming rows that were never modified (safe:
// reversing them sets provider_phone_id back to NULL, which is already
// their value), never the other way around. The reversal file is written to
// scripts/.backfill-0129-reversal.csv as (id, provider_phone_id-before)
// pairs — the "before" column is always empty because every affected row's
// prior value is NULL by construction of the WHERE clause.
//
// Reverse with (a bare `id IN (<ids>)` list is not executable for
// 1,008,689 rows — load the CSV into a temp table instead; strip the
// "# run started …" marker lines first, they aren't valid CSV rows):
//   grep -v '^#' scripts/.backfill-0129-reversal.csv > /tmp/backfill-0129-undo.csv
//   psql "$DATABASE_URL" <<'SQL'
//     CREATE TEMP TABLE backfill_0129_undo (id uuid, provider_phone_id text);
//     \copy backfill_0129_undo FROM '/tmp/backfill-0129-undo.csv' WITH (FORMAT csv, HEADER true)
//     UPDATE stage_sends ss SET provider_phone_id = NULL
//       FROM backfill_0129_undo t WHERE ss.id = t.id;
//   SQL
// The CSV (scripts/.backfill-0129-reversal.csv) is a single local file,
// gitignored and with no off-machine copy — if the undo path might ever
// matter, copy it somewhere durable before it's lost.
//
// The reversal file is NEVER truncated: the CSV header is written only once
// on first creation, and each --apply run appends a "# run started <ISO>"
// marker line before its batches, so a second --apply after an interrupted
// first run accumulates onto the same file instead of destroying the first
// run's (now-unrecoverable, since those rows are already non-NULL and will
// never be re-selected) reversal records.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { appendFileSync, existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const BATCH = 50_000;
const REVERSAL = resolve(process.cwd(), "scripts/.backfill-0129-reversal.csv");

async function main() {
  const apply = process.argv.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const [pre] = await db.execute<{
      null_rows: string;
      resolvable: string;
      phones: number[];
    }>(drizzleSql`
      SELECT count(*)::text AS null_rows,
             count(*) FILTER (WHERE cs.provider_phone_id IS NOT NULL)::text AS resolvable,
             array_agg(DISTINCT cs.provider_phone_id)
               FILTER (WHERE cs.provider_phone_id IS NOT NULL) AS phones
      FROM stage_sends ss
      LEFT JOIN campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.provider_phone_id IS NULL
    `);

    console.log(`NULL rows:      ${pre.null_rows}`);
    console.log(`resolvable:     ${pre.resolvable}`);
    console.log(`distinct phones: ${JSON.stringify(pre.phones)}`);

    if (pre.null_rows !== pre.resolvable) {
      // Thrown, not console.error+return: a `return` here would complete
      // main() as soon as `finally` (below) runs, making the `refuse` exit
      // code after the try/finally unreachable — the run would look
      // successful (exit 0) to any caller gating on exit code. Throwing
      // lets it propagate to main().catch(), which prints it and calls
      // process.exit(1) — after `finally` has already closed the pool.
      throw new Error(
        `REFUSING: ${Number(pre.null_rows) - Number(pre.resolvable)} rows have no stage phone. Investigate before writing.`,
      );
    }

    if (!apply) {
      console.log("\nDry run — no rows written. Re-run with --apply to write.");
      return;
    }

    if (!existsSync(REVERSAL)) {
      appendFileSync(REVERSAL, "id,provider_phone_id\n", "utf8");
    }
    appendFileSync(REVERSAL, `# run started ${new Date().toISOString()}\n`, "utf8");

    let total = 0;
    for (;;) {
      // 1. Pure read — same INNER JOIN + provider_phone_id IS NULL + LIMIT
      // selection criteria as the old CTE, but no UPDATE happens here.
      const batch = await db.execute<{ id: string; provider_phone_id: number }>(drizzleSql`
        SELECT ss.id, cs.provider_phone_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.provider_phone_id IS NULL
          AND cs.provider_phone_id IS NOT NULL
        LIMIT ${BATCH}
      `);
      // 2. Nothing left to do.
      if (batch.length === 0) break;

      // 3. Record before writing, flushed to disk synchronously.
      appendFileSync(
        REVERSAL,
        batch.map((r) => `${r.id},`).join("\n") + "\n",
        "utf8",
      );

      // 4. Write exactly the ids just recorded, driven by the explicit
      // (id, provider_phone_id) pairs captured above — not a fresh
      // subquery. The `AND ss.provider_phone_id IS NULL` re-check below
      // means the recorded set is only a superset of the written set: a row
      // stamped by the live app between the SELECT and this UPDATE is
      // skipped here but still named in the reversal file (see the
      // recorded-vs-written check after this query).
      // Bound as two arrays + unnest (constant 2 parameters per batch),
      // NOT a VALUES list of per-row placeholders (that scaled at 2
      // params/row and blew past the driver's 65534-parameter hard limit
      // at BATCH=50_000). drizzleSql's own `${jsArray}` interpolation does
      // NOT bind as a single array parameter either — it spreads back out
      // to one placeholder per element (same failure mode) — so this uses
      // the underlying postgres-js client's `pg.array()`, a real
      // single-parameter array bind. (Not the same technique as
      // lib/telnyx/pg-array.ts, which builds a raw `ARRAY[...]` string via
      // `sql.raw()` — that file is a different mechanism, not a precedent
      // for this one. `pg.array()` was verified independently for this
      // script.)
      const ids = pg.array(batch.map((r) => r.id));
      const phones = pg.array(batch.map((r) => r.provider_phone_id));
      const rows = await db.execute<{ id: string }>(drizzleSql`
        UPDATE stage_sends ss
           SET provider_phone_id = b.provider_phone_id
          FROM (
            SELECT * FROM unnest(${ids}::uuid[], ${phones}::int[])
              AS t(id, provider_phone_id)
          ) AS b
         WHERE ss.id = b.id
           AND ss.provider_phone_id IS NULL
        RETURNING ss.id
      `);
      total += rows.length;
      console.log(`  stamped ${total}`);

      // Recorded-vs-written divergence check. Moot for the real run (counts
      // matched exactly), but the script previously asserted nothing about
      // it: if a row in this batch was stamped by the live app between the
      // SELECT (step 1) and this UPDATE, it's still named in the reversal
      // file but was NOT written by this run — replaying the reversal file
      // as-is would then incorrectly NULL out that legitimate value.
      if (rows.length !== batch.length) {
        console.warn(
          `  WARNING: batch recorded ${batch.length} id(s) for reversal but the UPDATE only wrote ${rows.length}. ` +
            `${batch.length - rows.length} id(s) in the reversal file were NOT written by this run (likely stamped ` +
            `concurrently by the live app) — replaying the reversal file would incorrectly NULL those rows.`,
        );
      }
    }

    const [post] = await db.execute<{ remaining: string }>(
      drizzleSql`SELECT count(*)::text AS remaining FROM stage_sends WHERE provider_phone_id IS NULL`,
    );
    console.log(`\nDone. Stamped ${total}. Remaining NULL: ${post.remaining}`);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
