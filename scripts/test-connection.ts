import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createClient } from "@supabase/supabase-js";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbUrl = process.env.DATABASE_URL;

  if (!url || !serviceKey || !dbUrl) {
    throw new Error(
      "Missing required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL",
    );
  }

  console.log("--- Drizzle / postgres connection ---");
  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);
  try {
    const result = await db.execute(drizzleSql`select 1 as ok`);
    console.log("Drizzle query result:", result);
  } finally {
    await pg.end({ timeout: 5 });
  }

  console.log("\n--- Supabase admin client ---");
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1 });
  if (error) {
    throw new Error(`Supabase admin listUsers failed: ${error.message}`);
  }
  console.log(
    "Supabase admin listUsers ok — user count returned:",
    data.users.length,
  );

  console.log("\nAll connections succeeded.");
}

main().catch((err) => {
  console.error("Connection test FAILED:", err);
  process.exit(1);
});
