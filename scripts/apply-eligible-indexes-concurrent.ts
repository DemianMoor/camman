// Builds migration 0096's eligible-partial contacts indexes WITHOUT a write lock,
// using CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's migration
// transaction). Idempotent via IF NOT EXISTS. Run this BEFORE `db:migrate` in prod;
// the migration's plain CREATE INDEX IF NOT EXISTS statements then no-op, leaving
// the migration recorded in the chain. Safe to re-run. Mirrors
// scripts/apply-trgm-concurrent.ts (migration 0088).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

// [index name, ON columns] — predicate is the same for all four.
const INDEXES: Array<[string, string]> = [
  ["contacts_org_eligible_idx", "org_id"],
  ["contacts_org_created_eligible_idx", "org_id, created_at"],
  ["contacts_org_carrier_eligible_idx", "org_id, carrier_norm"],
  ["contacts_org_linetype_eligible_idx", "org_id, line_type"],
];

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    for (const [name, cols] of INDEXES) {
      const t0 = Date.now();
      process.stdout.write(`Building ${name} on contacts (${cols}) … `);
      await pg.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON public.contacts (${cols}) WHERE messaging_status = 'eligible'`,
      );
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    // A failed CONCURRENTLY build leaves an INVALID index behind — report them.
    const invalid = await pg`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname LIKE 'contacts_%_eligible_idx'`;
    console.log(
      invalid.length
        ? `⚠ INVALID indexes: ${invalid.map((r) => r.relname).join(", ")}`
        : "All eligible-partial indexes valid ✅",
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
