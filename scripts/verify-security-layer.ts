import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const EXPECTED_TABLES = [
  "organizations",
  "org_members",
  "invites",
  "brands",
] as const;

const EXPECTED_POLICIES: Record<string, string[]> = {
  organizations: ["organizations_select_own", "organizations_update_owner"],
  org_members: [
    "org_members_select_own_org",
    "org_members_insert_by_admins",
    "org_members_update_by_owners",
    "org_members_delete_by_admins_except_last_owner",
  ],
  invites: [
    "invites_select_own_org",
    "invites_insert_by_admins",
    "invites_delete_by_admins",
  ],
  brands: [
    "brands_select_own_org",
    "brands_insert_manager_or_higher",
    "brands_update_manager_or_higher",
  ],
};

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);
  let failures = 0;

  try {
    // 1. current_org_id() function
    const fnRows = await db.execute<{ proname: string; security_definer: boolean }>(drizzleSql`
      SELECT p.proname, p.prosecdef AS security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'current_org_id'
    `);
    console.log("--- current_org_id() function ---");
    if (fnRows.length === 1) {
      console.log(`  ✓ exists; SECURITY DEFINER = ${fnRows[0].security_definer}`);
      if (!fnRows[0].security_definer) {
        console.log("  ✗ expected SECURITY DEFINER");
        failures++;
      }
    } else {
      console.log("  ✗ NOT FOUND");
      failures++;
    }

    // 2. RLS enabled on all four tables
    const rlsRows = await db.execute<{ tablename: string; rowsecurity: boolean }>(drizzleSql`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const rlsMap = new Map(rlsRows.map((r) => [r.tablename, r.rowsecurity]));
    console.log("\n--- RLS enabled ---");
    for (const t of EXPECTED_TABLES) {
      const on = rlsMap.get(t);
      console.log(`  ${on ? "✓" : "✗"} ${t} — rowsecurity = ${on}`);
      if (!on) failures++;
    }

    // 3. Policies
    const polRows = await db.execute<{
      tablename: string;
      policyname: string;
      cmd: string;
    }>(drizzleSql`
      SELECT tablename, policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);
    const polByTable = new Map<string, Set<string>>();
    for (const r of polRows) {
      if (!polByTable.has(r.tablename)) polByTable.set(r.tablename, new Set());
      polByTable.get(r.tablename)!.add(r.policyname);
    }
    console.log("\n--- Policies ---");
    for (const [table, expected] of Object.entries(EXPECTED_POLICIES)) {
      const present = polByTable.get(table) ?? new Set();
      console.log(`  ${table}:`);
      for (const p of expected) {
        const ok = present.has(p);
        const cmd = polRows.find((r) => r.tablename === table && r.policyname === p)?.cmd;
        console.log(`    ${ok ? "✓" : "✗"} ${p}${cmd ? ` (${cmd})` : ""}`);
        if (!ok) failures++;
      }
      // Note any unexpected policies
      for (const p of present) {
        if (!expected.includes(p)) {
          console.log(`    ? unexpected: ${p}`);
        }
      }
    }

    // brands must NOT have a DELETE policy
    const brandsDelete = polRows.find(
      (r) => r.tablename === "brands" && r.cmd === "DELETE",
    );
    console.log(
      `  brands DELETE policy: ${brandsDelete ? `✗ found ${brandsDelete.policyname}` : "✓ none (as expected)"}`,
    );
    if (brandsDelete) failures++;

    // 4. Trigger on auth.users
    const trigRows = await db.execute<{
      tgname: string;
      tgrelid_table: string;
      tgenabled: string;
    }>(drizzleSql`
      SELECT t.tgname, c.relname AS tgrelid_table, t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.tgname = 'on_auth_user_created'
        AND n.nspname = 'auth'
        AND c.relname = 'users'
    `);
    console.log("\n--- Trigger on auth.users ---");
    if (trigRows.length === 1) {
      console.log(
        `  ✓ on_auth_user_created on auth.users (tgenabled = ${trigRows[0].tgenabled})`,
      );
    } else {
      console.log("  ✗ NOT FOUND");
      failures++;
    }

    console.log(
      failures === 0
        ? "\nSecurity layer verification passed."
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
