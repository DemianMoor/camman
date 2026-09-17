import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createClient } from "@supabase/supabase-js";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { organizations, org_members, event_types } from "../db/schema";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const dbUrl = process.env.DATABASE_URL!;

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);

  const email = `trigger-test-${Date.now()}@example.com`;
  const password = `Pw_${randomBytes(16).toString("base64url")}`;
  let userId: string | null = null;
  let createdOrgId: string | null = null;

  try {
    console.log(`Creating test user: ${email}`);
    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: "Trigger Test" },
    });
    if (createErr) throw createErr;
    userId = createData.user.id;
    console.log(`  user_id: ${userId}`);

    // Look up the org_members row for this user (admin/Drizzle = bypasses RLS).
    const memberRows = await db
      .select()
      .from(org_members)
      .where(eq(org_members.user_id, userId));
    console.log(`\norg_members rows for user: ${memberRows.length}`);
    if (memberRows.length !== 1) {
      throw new Error(
        `Expected exactly 1 org_members row, got ${memberRows.length}`,
      );
    }
    const member = memberRows[0];
    createdOrgId = member.org_id;
    console.log(`  member.id:   ${member.id}`);
    console.log(`  member.role: ${member.role}`);
    console.log(`  member.org_id: ${member.org_id}`);
    if (member.role !== "owner") {
      throw new Error(`Expected role 'owner', got '${member.role}'`);
    }

    const orgRows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, createdOrgId));
    console.log(`\norganizations rows for org: ${orgRows.length}`);
    if (orgRows.length !== 1) {
      throw new Error(`Expected exactly 1 organizations row, got ${orgRows.length}`);
    }
    const org = orgRows[0];
    console.log(`  org.id:   ${org.id}`);
    console.log(`  org.name: ${org.name}`);
    if (org.name !== "Trigger Test's Organization") {
      throw new Error(
        `Expected org name "Trigger Test's Organization", got "${org.name}"`,
      );
    }

    // 0183: handle_new_user() now seeds this org's event-type registry
    // (purchase + registration) in the same trigger transaction as the org +
    // org_members inserts.
    const eventTypeRows = await db
      .select()
      .from(event_types)
      .where(eq(event_types.org_id, createdOrgId));
    console.log(`\nevent_types rows for org: ${eventTypeRows.length}`);
    if (eventTypeRows.length !== 2) {
      throw new Error(
        `Expected exactly 2 event_types rows, got ${eventTypeRows.length}`,
      );
    }
    const purchase = eventTypeRows.find((et) => et.key === "purchase");
    if (!purchase || !purchase.is_purchase || !purchase.counts_revenue) {
      throw new Error(
        `Expected 'purchase' event type with is_purchase && counts_revenue, got ${JSON.stringify(purchase)}`,
      );
    }
    const registration = eventTypeRows.find((et) => et.key === "registration");
    if (!registration || !registration.is_retarget_signal) {
      throw new Error(
        `Expected 'registration' event type with is_retarget_signal, got ${JSON.stringify(registration)}`,
      );
    }
    console.log(`  purchase:     is_purchase=${purchase.is_purchase} counts_revenue=${purchase.counts_revenue}`);
    console.log(`  registration: is_retarget_signal=${registration.is_retarget_signal}`);

    console.log("\nTrigger test passed.");
  } finally {
    // Cleanup
    if (userId) {
      console.log(`\nCleanup: deleting user ${userId}`);
      const { error: delErr } = await admin.auth.admin.deleteUser(userId);
      if (delErr) console.error(`  user delete failed: ${delErr.message}`);
      else console.log("  user deleted (org_members row CASCADEd)");
    }
    if (createdOrgId) {
      const result = await db.execute(
        drizzleSql`DELETE FROM public.organizations WHERE id = ${createdOrgId}`,
      );
      console.log(`  organizations DELETE — rows affected: ${result.count ?? "?"}`);
    }
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Trigger test FAILED:", err);
  process.exit(1);
});
