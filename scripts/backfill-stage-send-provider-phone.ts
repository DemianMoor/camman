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
// Writes a reversal file (id,provider_phone_id pairs BEFORE the change is
// applied) to scripts/.backfill-0129-reversal.csv so the change can be undone.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { appendFileSync, writeFileSync } from "node:fs";
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
    console.error(
      `REFUSING: ${Number(pre.null_rows) - Number(pre.resolvable)} rows have no stage phone. Investigate before writing.`,
    );
    await pg.end();
    process.exit(1);
  }

  if (!apply) {
    console.log("\nDry run — no rows written. Re-run with --apply to write.");
    await pg.end();
    return;
  }

  writeFileSync(REVERSAL, "id,provider_phone_id\n", "utf8");
  let total = 0;
  for (;;) {
    const rows = await db.execute<{ id: number; provider_phone_id: number }>(drizzleSql`
      WITH batch AS (
        SELECT ss.id, cs.provider_phone_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.provider_phone_id IS NULL
          AND cs.provider_phone_id IS NOT NULL
        LIMIT ${BATCH}
      )
      UPDATE stage_sends ss
         SET provider_phone_id = b.provider_phone_id
        FROM batch b
       WHERE ss.id = b.id
      RETURNING ss.id, ss.provider_phone_id
    `);
    if (rows.length === 0) break;
    appendFileSync(
      REVERSAL,
      rows.map((r) => `${r.id},`).join("\n") + "\n",
      "utf8",
    );
    total += rows.length;
    console.log(`  stamped ${total}`);
  }

  const [post] = await db.execute<{ remaining: string }>(
    drizzleSql`SELECT count(*)::text AS remaining FROM stage_sends WHERE provider_phone_id IS NULL`,
  );
  console.log(`\nDone. Stamped ${total}. Remaining NULL: ${post.remaining}`);
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
