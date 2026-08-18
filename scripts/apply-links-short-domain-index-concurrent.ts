// Builds migration 0144's links.short_domain_id index WITHOUT a write lock,
// using CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's
// migration transaction).
//
// `links` is large (3.28M rows) and is written on EVERY tracked send — a plain
// CREATE INDEX takes ACCESS EXCLUSIVE and would block link minting, and
// therefore sending, for the whole build.
//
// Run this BEFORE `db:migrate` in prod; the migration's plain
// CREATE INDEX IF NOT EXISTS then no-ops and the migration stays recorded in
// the chain. Idempotent and safe to re-run. Mirrors
// scripts/apply-carrier-day-index-concurrent.ts (migration 0143).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const INDEX = "links_short_domain_id_idx";

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const t0 = Date.now();
    process.stdout.write(`Building ${INDEX} CONCURRENTLY … `);
    await pg.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON public.links (short_domain_id)`,
    );
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // A failed CONCURRENTLY build leaves an INVALID index behind that the
    // planner ignores while it still costs write amplification on every mint.
    const invalid = await pg`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname = ${INDEX}`;
    if (invalid.length) {
      console.error(`⚠ ${INDEX} is INVALID — drop it and re-run this script.`);
      process.exit(1);
    }
    console.log("Index valid ✅");
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
