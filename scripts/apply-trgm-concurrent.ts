// Builds migration 0088's phone-search indexes WITHOUT a write lock, using
// CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's migration
// transaction). Idempotent via IF NOT EXISTS. After this runs, `db:migrate`
// applies 0088 and its plain CREATE INDEX IF NOT EXISTS statements no-op,
// leaving the migration recorded in the chain. Safe to re-run.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const INDEXES: Array<[string, string]> = [
  ["contacts_phone_number_trgm_idx", "public.contacts"],
  ["opt_outs_phone_number_trgm_idx", "public.opt_outs"],
  ["opt_ins_phone_number_trgm_idx", "public.opt_ins"],
  ["clickers_phone_number_trgm_idx", "public.clickers"],
];

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    console.log("Ensuring pg_trgm extension…");
    await pg.unsafe(
      "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions",
    );
    for (const [name, table] of INDEXES) {
      const t0 = Date.now();
      process.stdout.write(`Building ${name} on ${table} … `);
      await pg.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} USING gin (phone_number extensions.gin_trgm_ops)`,
      );
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    // Report any INVALID indexes (a failed CONCURRENTLY build leaves one behind).
    const invalid = await pg`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname LIKE '%trgm%'`;
    console.log(
      invalid.length
        ? `⚠ INVALID indexes: ${invalid.map((r) => r.relname).join(", ")}`
        : "All trigram indexes valid ✅",
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
