import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const EXPECTED = ["organizations", "org_members", "invites", "brands"] as const;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);

  try {
    const tableRows = await db.execute<{ table_name: string }>(drizzleSql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `);
    const present = new Set(tableRows.map((r) => r.table_name));

    console.log("--- Tables in 'public' schema ---");
    for (const name of EXPECTED) {
      console.log(`  ${present.has(name) ? "✓" : "✗"} ${name}`);
    }
    const missing = EXPECTED.filter((n) => !present.has(n));
    if (missing.length > 0) {
      throw new Error(`Missing tables: ${missing.join(", ")}`);
    }

    for (const name of EXPECTED) {
      const cols = await db.execute<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(drizzleSql`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = ${name}
        order by ordinal_position
      `);
      console.log(`\n--- ${name} (${cols.length} columns) ---`);
      for (const c of cols) {
        const nullable = c.is_nullable === "YES" ? "NULL" : "NOT NULL";
        const def = c.column_default ? ` default ${c.column_default}` : "";
        console.log(`  ${c.column_name.padEnd(20)} ${c.data_type.padEnd(30)} ${nullable}${def}`);
      }
    }

    console.log("\nSchema verification passed.");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Verification FAILED:", err);
  process.exit(1);
});
