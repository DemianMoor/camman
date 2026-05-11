import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const EXPECTED_TABLES = ["affiliate_networks", "offers"] as const;

const EXPECTED_POLICIES: Record<string, string[]> = {
  affiliate_networks: [
    "affiliate_networks_select_own_org",
    "affiliate_networks_insert_manager_or_higher",
    "affiliate_networks_update_manager_or_higher",
  ],
  offers: [
    "offers_select_own_org",
    "offers_insert_manager_or_higher",
    "offers_update_manager_or_higher",
  ],
};

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);
  let failures = 0;

  try {
    // Tables exist
    const tableRows = await db.execute<{ table_name: string }>(drizzleSql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('affiliate_networks', 'offers')
    `);
    const present = new Set(tableRows.map((r) => r.table_name));
    console.log("--- Tables ---");
    for (const t of EXPECTED_TABLES) {
      console.log(`  ${present.has(t) ? "✓" : "✗"} ${t}`);
      if (!present.has(t)) failures++;
    }

    // Columns
    for (const t of EXPECTED_TABLES) {
      const cols = await db.execute<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(drizzleSql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${t}
        ORDER BY ordinal_position
      `);
      console.log(`\n--- ${t} (${cols.length} columns) ---`);
      for (const c of cols) {
        const nullable = c.is_nullable === "YES" ? "NULL" : "NOT NULL";
        const def = c.column_default ? ` default ${c.column_default}` : "";
        console.log(
          `  ${c.column_name.padEnd(20)} ${c.data_type.padEnd(30)} ${nullable}${def}`,
        );
      }
    }

    // RLS enabled
    const rlsRows = await db.execute<{
      tablename: string;
      rowsecurity: boolean;
    }>(drizzleSql`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('affiliate_networks', 'offers')
    `);
    const rlsMap = new Map(rlsRows.map((r) => [r.tablename, r.rowsecurity]));
    console.log("\n--- RLS enabled ---");
    for (const t of EXPECTED_TABLES) {
      const on = rlsMap.get(t);
      console.log(`  ${on ? "✓" : "✗"} ${t} — rowsecurity = ${on}`);
      if (!on) failures++;
    }

    // Policies
    const polRows = await db.execute<{
      tablename: string;
      policyname: string;
      cmd: string;
    }>(drizzleSql`
      SELECT tablename, policyname, cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('affiliate_networks', 'offers')
      ORDER BY tablename, policyname
    `);
    const polByTable = new Map<string, Set<string>>();
    for (const r of polRows) {
      if (!polByTable.has(r.tablename)) polByTable.set(r.tablename, new Set());
      polByTable.get(r.tablename)!.add(r.policyname);
    }
    console.log("\n--- Policies ---");
    for (const [t, expected] of Object.entries(EXPECTED_POLICIES)) {
      const present = polByTable.get(t) ?? new Set();
      console.log(`  ${t}:`);
      for (const p of expected) {
        const ok = present.has(p);
        const cmd = polRows.find(
          (r) => r.tablename === t && r.policyname === p,
        )?.cmd;
        console.log(`    ${ok ? "✓" : "✗"} ${p}${cmd ? ` (${cmd})` : ""}`);
        if (!ok) failures++;
      }
      // No DELETE policies should exist
      const del = polRows.find((r) => r.tablename === t && r.cmd === "DELETE");
      console.log(
        `    DELETE policy: ${del ? `✗ found ${del.policyname}` : "✓ none (expected)"}`,
      );
      if (del) failures++;
    }

    // Foreign key offers.network_id -> affiliate_networks.id ON DELETE SET NULL
    const fk = await db.execute<{
      constraint_name: string;
      delete_rule: string;
      update_rule: string;
    }>(drizzleSql`
      SELECT rc.constraint_name, rc.delete_rule, rc.update_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'offers'
        AND rc.unique_constraint_name = (
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name = 'affiliate_networks' AND constraint_type = 'PRIMARY KEY'
        )
    `);
    console.log("\n--- FK offers.network_id → affiliate_networks.id ---");
    if (fk[0]) {
      const ok = fk[0].delete_rule === "SET NULL";
      console.log(`  ${ok ? "✓" : "✗"} delete_rule = ${fk[0].delete_rule}`);
      if (!ok) failures++;
    } else {
      console.log("  ✗ FK not found");
      failures++;
    }

    console.log(
      failures === 0
        ? "\nOffers/networks schema verification passed."
        : `\nFAILED: ${failures} issue(s) found.`,
    );
    if (failures > 0) process.exit(1);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Verification FAILED:", err);
  process.exit(1);
});
