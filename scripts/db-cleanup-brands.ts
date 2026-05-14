import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { and, ne, or, eq, ilike, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { brands } from "../db/schema";

// Targeted follow-up to db-cleanup.ts: delete every brand EXCEPT the one
// identified by KEEP_KEY (matches either brand_id or name, case-insensitive).
// After the previous full cleanup, no other table references brands, so
// this is a simple delete with no cascade fanout.

const KEEP_KEY = "gdkn";

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
    const all = await db
      .select({
        id: brands.id,
        brand_id: brands.brand_id,
        name: brands.name,
        status: brands.status,
      })
      .from(brands)
      .orderBy(brands.id);

    console.log("\nCURRENT BRANDS");
    console.log("─".repeat(70));
    console.log(
      `${"id".padStart(4)}  ${"brand_id".padEnd(20)}  ${"name".padEnd(28)}  status`,
    );
    console.log("─".repeat(70));
    for (const b of all) {
      console.log(
        `${String(b.id).padStart(4)}  ${(b.brand_id ?? "").padEnd(20)}  ${(b.name ?? "").padEnd(28)}  ${b.status}`,
      );
    }
    console.log("─".repeat(70));

    // Find the keeper: case-insensitive match on either brand_id or name.
    const keepers = await db
      .select({
        id: brands.id,
        brand_id: brands.brand_id,
        name: brands.name,
      })
      .from(brands)
      .where(
        or(ilike(brands.brand_id, KEEP_KEY), ilike(brands.name, KEEP_KEY)),
      );

    if (keepers.length === 0) {
      console.error(
        `\n✗ No brand matches "${KEEP_KEY}" (checked brand_id and name, case-insensitive). Aborting.`,
      );
      process.exit(1);
    }
    if (keepers.length > 1) {
      console.error(
        `\n✗ Multiple brands match "${KEEP_KEY}" — won't guess which one to keep:`,
      );
      for (const k of keepers) {
        console.error(`    id=${k.id} brand_id=${k.brand_id} name=${k.name}`);
      }
      console.error("Aborting.");
      process.exit(1);
    }
    const keeper = keepers[0];
    const willDelete = all.filter((b) => b.id !== keeper.id);

    console.log(
      `\nKEEPER: id=${keeper.id} brand_id=${keeper.brand_id} name=${keeper.name}`,
    );
    console.log(`WILL DELETE: ${willDelete.length} brand(s)`);
    for (const b of willDelete) {
      console.log(`    id=${b.id} brand_id=${b.brand_id} name=${b.name}`);
    }

    if (!confirm) {
      console.log(
        "\nDry run. Re-run with `--confirm` to delete the brands listed above:\n" +
          "  npx tsx scripts/db-cleanup-brands.ts --confirm",
      );
      return;
    }

    console.log("\n--confirm detected — deleting non-keeper brands…");
    const result = await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(brands)
        .where(and(ne(brands.id, keeper.id)))
        .returning({ id: brands.id });
      return deleted.length;
    });
    console.log(`Deleted ${result} brand(s).`);

    const remaining = await db
      .select({
        id: brands.id,
        brand_id: brands.brand_id,
        name: brands.name,
      })
      .from(brands)
      .orderBy(brands.id);

    console.log("\nREMAINING BRANDS");
    console.log("─".repeat(60));
    for (const b of remaining) {
      console.log(`  id=${b.id} brand_id=${b.brand_id} name=${b.name}`);
    }
    console.log("─".repeat(60));

    if (remaining.length !== 1 || remaining[0].id !== keeper.id) {
      console.error("\n⚠️  Post-state did not match expectations.");
      process.exit(1);
    }
    console.log("\n✓ Exactly one brand remains, matching the keeper.");

    // Silence unused-import lint
    void drizzleSql;
    void eq;
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Brand cleanup crashed:", err);
  process.exit(1);
});
