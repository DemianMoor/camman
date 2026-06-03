import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  hasResolvableCredential,
  maskApiKey,
  resolveProviderApiKey,
} from "@/lib/sends/provider-credential";

// Verifies brand-scoped provider credentials WITHOUT persisting anything
// (rolled-back tx): masking, resolution precedence (brand key > provider
// default > none), and the unique constraints (one default per provider, one
// key per (provider, brand)).
//
// Run: npx tsx scripts/verify-credentials.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log("Masking:");
  assert(maskApiKey("BRANDKEY-5678").last4 === "5678", "last4 = last 4 chars");
  assert(maskApiKey("BRANDKEY-5678").masked === "••••5678", "masked hides all but last4");

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
      const brand = (await tx.execute(sql`SELECT id FROM brands WHERE org_id = ${orgId} LIMIT 1`)) as unknown as { id: number }[];
      if (!brand[0]) { console.log("SKIP: no brands."); throw new Rollback(); }
      const brandId = Number(brand[0].id);

      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status)
        VALUES (${"vc-prov"}, ${orgId}, ${"VC Provider"}, true, 'active') RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = Number(prov[0].id);

      console.log("Resolution precedence:");
      // No keys yet.
      assert(
        (await hasResolvableCredential(tx, { orgId, providerId, brandId })) === false,
        "no credential → hasResolvable false",
      );

      // Provider-default key.
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${providerId}, NULL, ${"DEFAULT-0000"})
      `);
      assert(
        (await resolveProviderApiKey(tx, { orgId, providerId, brandId })) === "DEFAULT-0000",
        "brand with no own key → falls back to provider default",
      );

      // Brand-specific key wins.
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${providerId}, ${brandId}, ${"BRANDKEY-5678"})
      `);
      assert(
        (await resolveProviderApiKey(tx, { orgId, providerId, brandId })) === "BRANDKEY-5678",
        "brand-specific key takes precedence over default",
      );
      assert(
        (await resolveProviderApiKey(tx, { orgId, providerId, brandId: 999999 })) === "DEFAULT-0000",
        "a different brand still resolves to the default",
      );
      assert(
        (await hasResolvableCredential(tx, { orgId, providerId, brandId })) === true,
        "hasResolvable true once a key exists",
      );

      console.log("Unique constraints:");
      let dup1 = false;
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${providerId}, NULL, ${"X"})`);
        });
      } catch { dup1 = true; }
      assert(dup1, "second provider-default (brand_id NULL) rejected");

      let dup2 = false;
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${providerId}, ${brandId}, ${"Y"})`);
        });
      } catch { dup2 = true; }
      assert(dup2, "second key for the same (provider, brand) rejected");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-credentials OK.");
}

main().catch((err) => { console.error("verify-credentials crashed:", err); process.exit(1); });
