// Controlled, ordered apply of migrations 0095–0098 for the Telnyx lookup feature,
// honoring the apply conditions:
//   - SET lock_timeout = '5s' on the session (a blocked lock aborts, never queues).
//   - Retry a statement that fails on lock acquisition (55P03) rather than queue.
//   - Order: 0095 -> 0096 (minus the eligible indexes) -> concurrent index build
//     -> 0097 -> 0098.
// It applies the DDL only; it does NOT write drizzle's ledger. Run `npm run
// db:migrate` AFTER this (all DDL is idempotent, so it re-runs as no-ops and
// records the ledger correctly), then `verify-migration-integrity`.
// All statements are idempotent, so this script is safe to re-run.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { readFileSync } from "node:fs";
import postgres from "postgres";

const LOCK_TIMEOUT = "5s";
const MAX_LOCK_RETRIES = 5;
const LOCK_NOT_AVAILABLE = "55P03";

function statementsOf(tag: string): string[] {
  const sql = readFileSync(`db/migrations/${tag}.sql`, "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    // Drop chunks that are only comments/blank (no executable SQL line).
    .filter((s) => s.split("\n").some((l) => l.trim() && !l.trim().startsWith("--")));
}

// The eligible-partial contacts indexes are built CONCURRENTLY (below), not in the
// migration transaction — skip them here so the manual apply never locks contacts.
function isEligibleIndexBuild(stmt: string): boolean {
  return /CREATE INDEX IF NOT EXISTS contacts_org_\w*eligible_idx/.test(stmt);
}

const CONCURRENT_INDEXES: Array<[string, string]> = [
  ["contacts_org_eligible_idx", "org_id"],
  ["contacts_org_created_eligible_idx", "org_id, created_at"],
  ["contacts_org_carrier_eligible_idx", "org_id, carrier_norm"],
  ["contacts_org_linetype_eligible_idx", "org_id, line_type"],
];

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    // Session GUC on the single pooled connection — a blocked lock aborts (55P03)
    // instead of queueing; runWithLockRetry then retries.
    await pg.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    console.log(`lock_timeout = ${LOCK_TIMEOUT}\n`);

    for (const tag of ["0095_phone_lookups_carrier_mappings_settings", "0096_contacts_carrier_messaging_status"]) {
      console.log(`=== applying ${tag} ===`);
      for (const stmt of statementsOf(tag)) {
        if (tag.startsWith("0096") && isEligibleIndexBuild(stmt)) {
          console.log(`  · skip (built concurrently): ${firstLine(stmt)}`);
          continue;
        }
        await runWithLockRetry(pg, stmt);
      }
      console.log("");
    }

    console.log("=== building eligible-partial indexes CONCURRENTLY (no write lock) ===");
    for (const [name, cols] of CONCURRENT_INDEXES) {
      const t0 = Date.now();
      process.stdout.write(`  ${name} … `);
      await pg.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON public.contacts (${cols}) WHERE messaging_status = 'eligible'`,
      );
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    console.log("");

    for (const tag of ["0097_lookup_batches_queue", "0098_segment_rules_phone_carrier"]) {
      console.log(`=== applying ${tag} ===`);
      for (const stmt of statementsOf(tag)) await runWithLockRetry(pg, stmt);
      console.log("");
    }

    // Report any INVALID index left by a failed CONCURRENTLY build.
    const invalid = await pg`
      SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname LIKE 'contacts_%_eligible_idx'`;
    console.log(
      invalid.length
        ? `⚠ INVALID indexes: ${invalid.map((r) => r.relname).join(", ")}`
        : "All eligible-partial indexes valid ✅",
    );
    console.log("\nDDL applied. Next: `npm run db:migrate` then verify-migration-integrity.");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

function firstLine(stmt: string): string {
  return (stmt.split("\n").find((l) => l.trim() && !l.trim().startsWith("--")) ?? "").trim().slice(0, 70);
}

async function runWithLockRetry(pg: postgres.Sql, stmt: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pg.unsafe(stmt);
      console.log(`  ✓ ${firstLine(stmt)}`);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === LOCK_NOT_AVAILABLE && attempt < MAX_LOCK_RETRIES) {
        console.log(`  ↻ lock busy (55P03), retry ${attempt}/${MAX_LOCK_RETRIES}: ${firstLine(stmt)}`);
        continue; // retry rather than queue
      }
      console.error(`  ✗ ${firstLine(stmt)}\n      ${(e as Error).message}`);
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
