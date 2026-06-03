import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  appHostname,
  lookupBrandWebsiteByHost,
  resolveRootTarget,
} from "@/lib/links/root-redirect";

// Verifies the bare-root redirect DECISION logic + DB lookup without
// persisting (rolled-back tx). The actual HTTP behavior (status, /r/ untouched,
// app host) is covered by a separate live smoke test.
//
// Run: npx tsx scripts/verify-root-redirect.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log("appHostname:");
  assert(appHostname("https://app.example.com:3001") === "app.example.com", "parses hostname, strips port");
  assert(appHostname(undefined) === null, "undefined → null");
  assert(appHostname("not a url") === null, "invalid → null");

  console.log("resolveRootTarget:");
  const fake = (map: Record<string, string | null>) => async (h: string) => map[h] ?? null;
  assert(
    (await resolveRootTarget({ host: "app.example.com", appHost: "app.example.com", lookupWebsite: fake({}) })) === "/dashboard",
    "app host → /dashboard (no lookup)",
  );
  assert(
    (await resolveRootTarget({ host: "go.brand.co", appHost: "app.example.com", lookupWebsite: fake({ "go.brand.co": "https://brand.com" }) })) === "https://brand.com",
    "short host with website → website",
  );
  assert(
    (await resolveRootTarget({ host: "go.brand.co", appHost: "app.example.com", lookupWebsite: fake({}) })) === "/dashboard",
    "short host, no website → /dashboard (fall through)",
  );
  assert(
    (await resolveRootTarget({ host: "", appHost: "app.example.com", lookupWebsite: fake({}) })) === "/dashboard",
    "empty host → /dashboard",
  );

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  let failed = false;

  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      if (!org[0]) { console.log("SKIP: no organizations."); throw new Rollback(); }
      const orgId = org[0].id;

      // Brand WITH a website + short domain.
      const withSite = (await tx.execute(sql`
        INSERT INTO brands (org_id, brand_id, name, website) VALUES (${orgId}, ${"vrr-a"}, ${"vrr-a"}, ${"https://brand-a.example"}) RETURNING id
      `)) as unknown as { id: number }[];
      await tx.execute(sql`INSERT INTO short_domains (org_id, brand_id, domain, status) VALUES (${orgId}, ${Number(withSite[0].id)}, ${"go.vrr-a.co"}, 'active')`);

      // Brand WITHOUT a website but with a short domain.
      const noSite = (await tx.execute(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"vrr-b"}, ${"vrr-b"}) RETURNING id
      `)) as unknown as { id: number }[];
      await tx.execute(sql`INSERT INTO short_domains (org_id, brand_id, domain, status) VALUES (${orgId}, ${Number(noSite[0].id)}, ${"go.vrr-b.co"}, 'active')`);

      console.log("lookupBrandWebsiteByHost:");
      assert((await lookupBrandWebsiteByHost(tx, "go.vrr-a.co")) === "https://brand-a.example", "matching host → brand website");
      assert((await lookupBrandWebsiteByHost(tx, "go.vrr-b.co")) === null, "host with no brand website → null");
      assert((await lookupBrandWebsiteByHost(tx, "unknown.example")) === null, "unknown host → null");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-root-redirect OK.");
}

main().catch((err) => { console.error("verify-root-redirect crashed:", err); process.exit(1); });
