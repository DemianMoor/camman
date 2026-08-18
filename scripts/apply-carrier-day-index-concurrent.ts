// Builds migration 0143's per-carrier daily-cap index WITHOUT a write lock,
// using CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's
// migration transaction). stage_sends is large and HOT — a plain CREATE INDEX
// takes ACCESS EXCLUSIVE and would block live sending for the whole build.
//
// Run this BEFORE `db:migrate` in prod; the migration's plain
// CREATE INDEX IF NOT EXISTS then no-ops and the migration stays recorded in
// the chain. Idempotent and safe to re-run. Mirrors
// scripts/apply-ahoi-stage-sends-index-concurrent.ts (migration 0109).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const INDEX = "stage_sends_phone_carrier_sent_day_idx";

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const t0 = Date.now();
    process.stdout.write(`Building ${INDEX} CONCURRENTLY … `);
    await pg.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ` +
        `ON public.stage_sends (provider_phone_id, carrier_norm, sent_at) ` +
        `WHERE status = 'sent'`,
    );
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // A failed CONCURRENTLY build leaves an INVALID index behind that the
    // planner ignores while it still costs write amplification — report it
    // loudly rather than exiting 0 on a half-built index.
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
