import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { applyBrandShortDomain, normalizeShortDomain } from "@/lib/sends/short-domain";

// Verifies brand short-domain handling WITHOUT persisting (rolled-back tx):
// hostname normalization, one-per-brand upsert (update in place), cross-brand
// (org_id, domain) conflict, clear-on-empty, and the UNIQUE(brand_id)
// constraint.
//
// Run: npx tsx scripts/verify-brand-domains.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log("normalizeShortDomain:");
  const n1 = normalizeShortDomain("https://go.brand.co/lp?x=1");
  assert(n1.ok && n1.host === "go.brand.co", "strips scheme + path");
  const n2 = normalizeShortDomain("GO.Brand.CO:8080");
  assert(n2.ok && n2.host === "go.brand.co", "lowercases + strips port");
  const n3 = normalizeShortDomain("");
  assert(n3.ok && n3.host === null, "empty → null (clear)");
  const n4 = normalizeShortDomain("notadomain");
  assert(!n4.ok, "rejects a bare label with no TLD");

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

      const mk = async (bid: string) =>
        Number(((await tx.execute(sql`
          INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${bid}, ${bid}) RETURNING id
        `)) as unknown as { id: number }[])[0].id);
      const brandA = await mk("vbd-a");
      const brandB = await mk("vbd-b");

      const rowCount = async (brandId: number) =>
        Number(((await tx.execute(sql`SELECT count(*)::int AS n FROM short_domains WHERE brand_id = ${brandId}`)) as unknown as { n: number }[])[0].n);
      const domainOf = async (brandId: number) =>
        ((await tx.execute(sql`SELECT domain FROM short_domains WHERE brand_id = ${brandId} LIMIT 1`)) as unknown as { domain: string }[])[0]?.domain ?? null;

      console.log("Upsert (one per brand):");
      const r1 = await applyBrandShortDomain(tx, { orgId, brandId: brandA, rawDomain: "https://go.brand-a.co/x" });
      assert(r1.ok && r1.domain === "go.brand-a.co", "sets A's domain (normalized)");
      assert((await rowCount(brandA)) === 1, "A has exactly one row");

      const r2 = await applyBrandShortDomain(tx, { orgId, brandId: brandA, rawDomain: "go.brand-a-new.co" });
      assert(r2.ok && (await domainOf(brandA)) === "go.brand-a-new.co", "updating A replaces in place");
      assert((await rowCount(brandA)) === 1, "A still has exactly one row (no second)");

      console.log("Cross-brand conflict:");
      const r3 = await applyBrandShortDomain(tx, { orgId, brandId: brandB, rawDomain: "go.brand-a-new.co" });
      assert(!r3.ok && r3.reason === "domain_taken", "B can't take A's domain (org_id,domain unique)");

      console.log("Clear:");
      const r4 = await applyBrandShortDomain(tx, { orgId, brandId: brandA, rawDomain: "" });
      assert(r4.ok && r4.domain === null, "empty clears A's domain");
      assert((await rowCount(brandA)) === 0, "A has no row after clear");

      console.log("UNIQUE(brand_id):");
      await applyBrandShortDomain(tx, { orgId, brandId: brandB, rawDomain: "go.brand-b.co" });
      let dup = false;
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`INSERT INTO short_domains (org_id, brand_id, domain, status) VALUES (${orgId}, ${brandB}, ${"go.brand-b-2.co"}, 'active')`);
        });
      } catch { dup = true; }
      assert(dup, "a second short_domains row for the same brand is rejected");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-brand-domains OK.");
}

main().catch((err) => { console.error("verify-brand-domains crashed:", err); process.exit(1); });
