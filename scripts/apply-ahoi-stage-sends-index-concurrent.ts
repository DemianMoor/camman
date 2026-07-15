// Builds migration 0109's stage_sends.texthub_message_id index WITHOUT a
// write lock, using CREATE INDEX CONCURRENTLY (which cannot run inside
// drizzle-kit's migration transaction). stage_sends is large + hot (820K+
// rows / ~490 MB in prod) — a plain CREATE INDEX would take ACCESS EXCLUSIVE
// and block sends during apply. Run this BEFORE `db:migrate` in prod; the
// migration's plain CREATE INDEX IF NOT EXISTS statement then no-ops, leaving
// the migration recorded in the chain. Idempotent + safe to re-run. Mirrors
// scripts/apply-eligible-indexes-concurrent.ts (migration 0096) and the 0101
// pattern the migration comment references.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const t0 = Date.now();
    process.stdout.write("Building stage_sends_texthub_message_id_idx CONCURRENTLY … ");
    await pg.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS stage_sends_texthub_message_id_idx ` +
        `ON public.stage_sends (texthub_message_id) WHERE texthub_message_id IS NOT NULL`,
    );
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // A failed CONCURRENTLY build leaves an INVALID index behind — report it.
    const invalid = await pg`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname = 'stage_sends_texthub_message_id_idx'`;
    console.log(
      invalid.length ? "⚠ INVALID index — drop + rebuild" : "Index valid ✅",
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
