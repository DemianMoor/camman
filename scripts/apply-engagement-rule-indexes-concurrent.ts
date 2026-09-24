// Builds migration 0189's two contact_engagement indexes WITHOUT a write lock,
// using CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's
// migration transaction). contact_engagement is 973,731 rows / 467 MB and is
// rewritten by the engagement job every 15 minutes — a plain CREATE INDEX takes
// ACCESS EXCLUSIVE for the whole build and would block that job.
//
// Run this BEFORE `db:migrate` in prod; the migration's plain
// CREATE INDEX IF NOT EXISTS then no-ops and the migration stays recorded in
// the chain. Idempotent and safe to re-run. Mirrors
// scripts/apply-carrier-day-index-concurrent.ts (0143) and
// scripts/apply-lifecycle-status-column.ts (0188).
//
// WHY THESE TWO. Spec §4 of the contact-lifecycle design specified them and
// 0187 did not create them. Without them every last_message_* / last_click_*
// segment rule is a sequential scan of 467 MB (measured 2026-09-24: 1,022 ms to
// 1,465 ms each) against a preview endpoint with a hard 10 s statement_timeout.
//
// Dry run by default. Run outside the send window.
//   npx tsx scripts/apply-engagement-rule-indexes-concurrent.ts
//   npx tsx scripts/apply-engagement-rule-indexes-concurrent.ts --apply
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const INDEXES: { name: string; columns: string }[] = [
  { name: "contact_engagement_org_last_sent_idx", columns: "(org_id, last_sent_at)" },
  { name: "contact_engagement_org_last_click_idx", columns: "(org_id, last_click_at)" },
];

const APPLY = process.argv.includes("--apply");

async function main() {
  // max:1, no prepared statements — CONCURRENTLY needs a plain autocommit conn.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${APPLY ? "APPLYING to" : "DRY RUN against"} ${host}\n`);

  try {
    const [{ n: rows }] = (await pg`
      SELECT count(*)::int AS n FROM contact_engagement`) as unknown as { n: number }[];
    console.log(`contact_engagement: ${Number(rows).toLocaleString()} rows\n`);

    for (const idx of INDEXES) {
      const [{ exists }] = (await pg`
        SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = ${idx.name}) AS exists`) as unknown as {
        exists: boolean;
      }[];
      if (exists) {
        console.log(`${idx.name} — already present, skipping`);
        continue;
      }
      if (!APPLY) {
        console.log(`${idx.name} — WOULD BUILD CONCURRENTLY ${idx.columns}`);
        continue;
      }
      const t0 = Date.now();
      process.stdout.write(`${idx.name} — building CONCURRENTLY … `);
      await pg.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx.name} ` +
          `ON public.contact_engagement ${idx.columns}`,
      );
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    // A failed CONCURRENTLY build leaves an INVALID index that the planner
    // ignores while it still costs write amplification on every job run —
    // report it loudly rather than exiting 0 on a half-built index.
    const invalid = (await pg`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid
        AND c.relname = ANY(${INDEXES.map((i) => i.name)})`) as unknown as {
      relname: string;
    }[];
    if (invalid.length > 0) {
      console.error(
        `\n⚠ INVALID: ${invalid.map((r) => r.relname).join(", ")} — drop each and re-run this script.`,
      );
      process.exit(1);
    }

    if (APPLY) {
      const sizes = (await pg`
        SELECT relname, pg_size_pretty(pg_relation_size(oid)) AS size
        FROM pg_class WHERE relname = ANY(${INDEXES.map((i) => i.name)})
        ORDER BY relname`) as unknown as { relname: string; size: string }[];
      console.log("");
      for (const r of sizes) console.log(`  ${r.relname.padEnd(40)} ${r.size}`);
      console.log("\nBoth indexes valid ✅");
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
