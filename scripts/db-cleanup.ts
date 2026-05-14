import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// One-off cleanup utility. Empties every domain table EXCEPT brands,
// preserves the user account + organization + owner-role membership,
// then resets SERIAL sequences (except brands_id_seq) so new records
// start at id=1.
//
// Two-step execution:
//   npx tsx scripts/db-cleanup.ts           → prints BEFORE counts, exits
//   npx tsx scripts/db-cleanup.ts --confirm → runs the wipe transaction
//
// The wipe runs in a single transaction. Any error rolls everything back.

// (schema, table, displayLabel). Order doesn't matter for counts —
// only for the deletion order, which is hardcoded below.
const TABLES: Array<{ schema: string; table: string; label: string }> = [
  { schema: "auth", table: "users", label: "auth.users (PRESERVED)" },
  { schema: "public", table: "organizations", label: "organizations (PRESERVED)" },
  { schema: "public", table: "org_members", label: "org_members (PRESERVED)" },
  { schema: "public", table: "invites", label: "invites" },
  { schema: "public", table: "brands", label: "brands (PRESERVED)" },
  { schema: "public", table: "affiliate_networks", label: "affiliate_networks" },
  { schema: "public", table: "offers", label: "offers" },
  { schema: "public", table: "sms_providers", label: "sms_providers" },
  { schema: "public", table: "provider_phones", label: "provider_phones" },
  { schema: "public", table: "routing_types", label: "routing_types" },
  { schema: "public", table: "traffic_types", label: "traffic_types" },
  { schema: "public", table: "utm_tags", label: "utm_tags" },
  { schema: "public", table: "segment_groups", label: "segment_groups" },
  { schema: "public", table: "segment_segment_groups", label: "segment_segment_groups" },
  { schema: "public", table: "segments", label: "segments" },
  { schema: "public", table: "segment_contacts", label: "segment_contacts" },
  { schema: "public", table: "segment_stats", label: "segment_stats" },
  { schema: "public", table: "contacts", label: "contacts" },
  { schema: "public", table: "opt_outs", label: "opt_outs" },
  { schema: "public", table: "opt_out_brands", label: "opt_out_brands" },
  { schema: "public", table: "opt_out_providers", label: "opt_out_providers" },
  { schema: "public", table: "opt_ins", label: "opt_ins" },
  { schema: "public", table: "clickers", label: "clickers" },
  { schema: "public", table: "creatives", label: "creatives" },
  { schema: "public", table: "campaigns", label: "campaigns" },
  { schema: "public", table: "campaign_audience_pool", label: "campaign_audience_pool" },
  { schema: "public", table: "campaign_stages", label: "campaign_stages" },
  { schema: "public", table: "stage_results_imports", label: "stage_results_imports" },
  { schema: "public", table: "stage_result_rows", label: "stage_result_rows" },
  { schema: "public", table: "result_import_mappings", label: "result_import_mappings" },
];

// Tables that must keep their existing counts after cleanup.
const PRESERVED_TABLES = new Set([
  "auth.users",
  "public.organizations",
  "public.org_members",
  "public.brands",
]);

type CountRow = { schema: string; table: string; label: string; count: number };

async function getCounts(
  db: ReturnType<typeof drizzle>,
): Promise<CountRow[]> {
  // One round-trip per table. Could batch with a UNION ALL, but the
  // explicit per-table query makes it obvious which one is failing if
  // a table name is wrong.
  const results: CountRow[] = [];
  for (const t of TABLES) {
    const rows = (await db.execute(
      drizzleSql.raw(
        `SELECT count(*)::int AS count FROM ${t.schema}.${t.table}`,
      ),
    )) as unknown as { count: number }[];
    results.push({
      schema: t.schema,
      table: t.table,
      label: t.label,
      count: rows[0]?.count ?? 0,
    });
  }
  return results;
}

function printCountsTable(title: string, rows: CountRow[]) {
  const labelWidth = Math.max(...rows.map((r) => r.label.length), 10);
  const countWidth = Math.max(...rows.map((r) => String(r.count).length), 5);
  const totalWidth = labelWidth + countWidth + 5;
  const bar = "─".repeat(totalWidth);
  console.log(`\n${title}`);
  console.log(bar);
  for (const r of rows) {
    const label = r.label.padEnd(labelWidth);
    const count = String(r.count).padStart(countWidth);
    console.log(`${label}  │  ${count}`);
  }
  console.log(bar);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Missing DATABASE_URL in .env.local");
    process.exit(1);
  }
  const confirm = process.argv.includes("--confirm");

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const before = await getCounts(db);
    printCountsTable("BEFORE CLEANUP", before);

    if (!confirm) {
      console.log(
        "\nBEFORE counts shown above. Ready to delete.\n" +
          "Re-run with `--confirm` flag to proceed:\n" +
          "  npx tsx scripts/db-cleanup.ts --confirm",
      );
      return;
    }

    console.log(
      "\n--confirm flag detected — running cleanup transaction…",
    );

    await db.transaction(async (tx) => {
      // Layer 1 — bottom of the DAG (no other table depends on these)
      await tx.execute(drizzleSql`DELETE FROM stage_result_rows`);
      await tx.execute(drizzleSql`DELETE FROM stage_results_imports`);
      await tx.execute(drizzleSql`DELETE FROM campaign_audience_pool`);
      await tx.execute(drizzleSql`DELETE FROM campaign_stages`);
      await tx.execute(drizzleSql`DELETE FROM campaigns`);

      // Layer 2 — engagement and suppression
      await tx.execute(drizzleSql`DELETE FROM clickers`);
      await tx.execute(drizzleSql`DELETE FROM opt_ins`);
      await tx.execute(drizzleSql`DELETE FROM opt_out_brands`);
      await tx.execute(drizzleSql`DELETE FROM opt_out_providers`);
      await tx.execute(drizzleSql`DELETE FROM opt_outs`);

      // Layer 3 — segments and their relationships
      await tx.execute(drizzleSql`DELETE FROM segment_contacts`);
      await tx.execute(drizzleSql`DELETE FROM segment_segment_groups`);
      await tx.execute(drizzleSql`DELETE FROM segment_stats`);
      await tx.execute(drizzleSql`DELETE FROM segments`);
      await tx.execute(drizzleSql`DELETE FROM segment_groups`);

      // Layer 4 — contacts (audience-layer leaf)
      await tx.execute(drizzleSql`DELETE FROM contacts`);

      // Layer 5 — creatives and import mappings
      await tx.execute(drizzleSql`DELETE FROM creatives`);
      await tx.execute(drizzleSql`DELETE FROM result_import_mappings`);

      // Layer 6 — provider hierarchy
      await tx.execute(drizzleSql`DELETE FROM provider_phones`);
      await tx.execute(drizzleSql`DELETE FROM sms_providers`);

      // Layer 7 — offer/network hierarchy
      await tx.execute(drizzleSql`DELETE FROM utm_tags`);
      await tx.execute(drizzleSql`DELETE FROM offers`);
      await tx.execute(drizzleSql`DELETE FROM affiliate_networks`);

      // Layer 8 — simple lookups
      await tx.execute(drizzleSql`DELETE FROM routing_types`);
      await tx.execute(drizzleSql`DELETE FROM traffic_types`);

      // Layer 9 — invites (keep org_members, organizations, brands, and the user)
      await tx.execute(drizzleSql`DELETE FROM invites`);

      // Reset all SERIAL sequences to 1, except brands_id_seq (which we
      // keep so brand ids stay stable for any external references).
      const sequences = (await tx.execute(drizzleSql`
        SELECT sequence_name FROM information_schema.sequences
        WHERE sequence_schema = 'public'
          AND sequence_name <> 'brands_id_seq'
      `)) as unknown as { sequence_name: string }[];

      for (const row of sequences) {
        await tx.execute(
          drizzleSql.raw(
            `ALTER SEQUENCE public."${row.sequence_name}" RESTART WITH 1`,
          ),
        );
      }
      console.log(
        `  reset ${sequences.length} sequence(s) (brands_id_seq preserved)`,
      );
    });

    console.log("Transaction committed.");

    const after = await getCounts(db);
    printCountsTable("AFTER CLEANUP", after);

    // Assertions
    const issues: string[] = [];
    const beforeByKey = new Map<string, number>(
      before.map((r) => [`${r.schema}.${r.table}`, r.count]),
    );
    for (const r of after) {
      const key = `${r.schema}.${r.table}`;
      if (PRESERVED_TABLES.has(key)) {
        const prev = beforeByKey.get(key) ?? 0;
        if (r.count !== prev) {
          issues.push(
            `${key}: expected unchanged (${prev}), got ${r.count}`,
          );
        }
      } else {
        if (r.count !== 0) {
          issues.push(`${key}: expected 0 rows, got ${r.count}`);
        }
      }
    }

    if (issues.length > 0) {
      console.error("\n⚠️  ASSERTION FAILURES:");
      for (const i of issues) console.error("  " + i);
      console.error(
        "\nTransaction was already committed. Investigate manually.",
      );
      process.exit(1);
    }
    console.log("\n✓ All invariants satisfied. Cleanup complete.");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Cleanup script crashed:", err);
  process.exit(1);
});
