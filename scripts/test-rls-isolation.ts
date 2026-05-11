import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createClient } from "@supabase/supabase-js";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { brands, org_members } from "../db/schema";

interface TestUser {
  id: string;
  email: string;
  password: string;
  orgId: string;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const dbUrl = process.env.DATABASE_URL!;

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);

  const users: TestUser[] = [];
  let userABrandId: number | null = null;
  let failure = false;

  async function createUser(label: string): Promise<TestUser> {
    const email = `rls-${label}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
    const password = `Pw_${randomBytes(16).toString("base64url")}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `RLS ${label}` },
    });
    if (error) throw error;
    const userId = data.user.id;
    const memberRows = await db
      .select()
      .from(org_members)
      .where(eq(org_members.user_id, userId));
    if (memberRows.length !== 1) {
      throw new Error(
        `User ${label}: expected 1 org_members row, got ${memberRows.length}`,
      );
    }
    return { id: userId, email, password, orgId: memberRows[0].org_id };
  }

  try {
    // 1+2. Create User A and User B; trigger gives each their own org.
    console.log("--- Setup ---");
    const userA = await createUser("A");
    users.push(userA);
    console.log(`  User A: ${userA.email}`);
    console.log(`    user_id: ${userA.id}`);
    console.log(`    org_id:  ${userA.orgId}`);

    const userB = await createUser("B");
    users.push(userB);
    console.log(`  User B: ${userB.email}`);
    console.log(`    user_id: ${userB.id}`);
    console.log(`    org_id:  ${userB.orgId}`);

    if (userA.orgId === userB.orgId) {
      throw new Error("FATAL: User A and User B got the same org_id");
    }

    // 3. Insert a brand for User A's org via admin/Drizzle (bypasses RLS).
    const inserted = await db
      .insert(brands)
      .values({
        brand_id: `TBA-${Date.now()}`,
        org_id: userA.orgId,
        name: "Test Brand A",
      })
      .returning();
    userABrandId = inserted[0].id;
    console.log(`\n  Inserted brand for User A's org: brands.id = ${userABrandId}`);

    // 4. Sign in as User B with the anon key. PostgREST will apply the JWT
    //    automatically, so the supabase-js client respects RLS.
    console.log("\n--- Test: User B signs in, queries User A's data ---");
    const clientB = createClient(url, anonKey);
    const { data: signInB, error: signInBErr } = await clientB.auth.signInWithPassword({
      email: userB.email,
      password: userB.password,
    });
    if (signInBErr) throw signInBErr;
    console.log(`  User B signed in (session expires at ${signInB.session?.expires_at})`);

    // 5a. SELECT all brands — should return zero rows (B can't see A's brand).
    const { data: brandsAsB, error: brandsAsBErr } = await clientB
      .from("brands")
      .select("*");
    if (brandsAsBErr) throw brandsAsBErr;
    console.log(`  brands visible to User B: ${brandsAsB?.length ?? 0}`);
    if ((brandsAsB?.length ?? 0) !== 0) {
      console.log("  ✗ SHOWSTOPPER: User B can see User A's brand!");
      console.log("    rows:", JSON.stringify(brandsAsB, null, 2));
      failure = true;
    } else {
      console.log("  ✓ User B cannot see User A's brand");
    }

    // 5b. SELECT organizations where id = User A's org id — should be empty.
    const { data: orgsAsB, error: orgsAsBErr } = await clientB
      .from("organizations")
      .select("*")
      .eq("id", userA.orgId);
    if (orgsAsBErr) throw orgsAsBErr;
    console.log(
      `  organizations(id=A's org) visible to User B: ${orgsAsB?.length ?? 0}`,
    );
    if ((orgsAsB?.length ?? 0) !== 0) {
      console.log("  ✗ SHOWSTOPPER: User B can see User A's organization row");
      failure = true;
    } else {
      console.log("  ✓ User B cannot see User A's organization");
    }

    // 5c. Bonus sanity check: User B SHOULD see their own org.
    const { data: ownOrgB, error: ownOrgBErr } = await clientB
      .from("organizations")
      .select("*");
    if (ownOrgBErr) throw ownOrgBErr;
    console.log(`  organizations visible to User B (own): ${ownOrgB?.length ?? 0}`);
    if ((ownOrgB?.length ?? 0) !== 1 || ownOrgB?.[0].id !== userB.orgId) {
      console.log("  ✗ User B should see exactly 1 org (their own)");
      failure = true;
    } else {
      console.log("  ✓ User B sees exactly their own org");
    }

    await clientB.auth.signOut();

    // 6. Sign in as User A — should see the brand.
    console.log("\n--- Test: User A signs in, sees own brand ---");
    const clientA = createClient(url, anonKey);
    const { error: signInAErr } = await clientA.auth.signInWithPassword({
      email: userA.email,
      password: userA.password,
    });
    if (signInAErr) throw signInAErr;

    const { data: brandsAsA, error: brandsAsAErr } = await clientA
      .from("brands")
      .select("*");
    if (brandsAsAErr) throw brandsAsAErr;
    console.log(`  brands visible to User A: ${brandsAsA?.length ?? 0}`);
    if ((brandsAsA?.length ?? 0) !== 1 || brandsAsA?.[0].id !== userABrandId) {
      console.log("  ✗ User A should see exactly their 1 brand");
      failure = true;
    } else {
      console.log("  ✓ User A sees their own brand");
    }

    await clientA.auth.signOut();

    console.log(
      failure
        ? "\n*** RLS ISOLATION FAILED ***"
        : "\nRLS isolation passed.",
    );
    if (failure) process.exit(1);
  } finally {
    // 7. Cleanup.
    console.log("\n--- Cleanup ---");
    if (userABrandId !== null) {
      const res = await db
        .delete(brands)
        .where(eq(brands.id, userABrandId))
        .returning();
      console.log(`  Deleted brand ${userABrandId} (${res.length} row)`);
    }
    for (const u of users) {
      const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
      console.log(
        `  Deleted user ${u.id} ${delErr ? `(error: ${delErr.message})` : ""}`,
      );
      const orgDel = await db.execute(
        drizzleSql`DELETE FROM public.organizations WHERE id = ${u.orgId}`,
      );
      console.log(`    org ${u.orgId} delete — rows: ${orgDel.count ?? "?"}`);
    }
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("RLS isolation test FAILED:", err);
  process.exit(1);
});
