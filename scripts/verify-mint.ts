import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { mintLink } from "@/lib/links/mint-link";

// Verifies the mint function against the dev DB WITHOUT persisting anything:
// everything runs inside a transaction that is rolled back at the end. It
// reuses existing org/campaign/stage/contact fixtures and creates only a
// throwaway short_domain inside the doomed transaction.
//
//   1. mint twice with the SAME send_token  → identical code, 2nd reused=true
//   2. mint with a DIFFERENT send_token      → distinct code, reused=false
//
// Run: npx tsx scripts/verify-mint.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  let failed = false;

  try {
    await db.transaction(async (tx) => {
      // --- Pick existing fixtures -------------------------------------------
      const org = (await tx.execute(
        sql`SELECT id FROM organizations LIMIT 1`,
      )) as unknown as { id: string }[];
      if (!org[0]) {
        console.log("SKIP: no organizations in the DB — nothing to test.");
        throw new Rollback();
      }
      const orgId = org[0].id;

      // Pick a stage directly so we're guaranteed a campaign+stage pair (the
      // first campaign in the org may have no stages yet).
      const stage = (await tx.execute(sql`
        SELECT cs.id AS stage_id, cs.creative_id, cs.campaign_id, c.brand_id
        FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id
        WHERE c.org_id = ${orgId}
        LIMIT 1
      `)) as unknown as {
        stage_id: number;
        creative_id: number | null;
        campaign_id: number;
        brand_id: number | null;
      }[];
      if (!stage[0]) {
        console.log(`SKIP: org ${orgId} has no campaign stages.`);
        throw new Rollback();
      }
      const campaignId = Number(stage[0].campaign_id);
      const stageId = Number(stage[0].stage_id);
      const creativeId =
        stage[0].creative_id == null ? null : Number(stage[0].creative_id);

      const contacts = (await tx.execute(sql`
        SELECT id FROM contacts WHERE org_id = ${orgId} LIMIT 1
      `)) as unknown as { id: string }[];
      if (!contacts[0]) {
        console.log(`SKIP: org ${orgId} has no contacts.`);
        throw new Rollback();
      }
      const contactId = contacts[0].id;

      // A brand to hang the throwaway short_domain on. Prefer the campaign's.
      let brandId = stage[0].brand_id;
      if (brandId == null) {
        const brand = (await tx.execute(sql`
          SELECT id FROM brands WHERE org_id = ${orgId} LIMIT 1
        `)) as unknown as { id: number }[];
        if (!brand[0]) {
          console.log(`SKIP: org ${orgId} has no brands.`);
          throw new Rollback();
        }
        brandId = Number(brand[0].id);
      }

      // Throwaway short_domain (rolled back with everything else).
      const sd = (await tx.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain, status)
        VALUES (${orgId}, ${brandId}, ${"verify-mint.example"}, 'active')
        RETURNING id
      `)) as unknown as { id: number }[];
      const shortDomainId = Number(sd[0].id);

      const base = {
        orgId,
        campaignId,
        stageId,
        contactId,
        creativeId,
        shortDomainId,
        destinationUrl: "https://example.com/lp?x=1",
        campaignTrackingId: "verify_campaign_tid",
        stageTrackingId: "verify_stage_tid",
      };

      console.log("Test 1 — same send_token reuses the link:");
      const a = await mintLink(tx, { ...base, sendToken: "msg-alpha" });
      assert(a.reused === false, "first mint inserts a new link (reused=false)");
      const b = await mintLink(tx, { ...base, sendToken: "msg-alpha" });
      assert(b.reused === true, "second mint with same token reuses (reused=true)");
      assert(a.code === b.code, `same code reused (${a.code})`);
      assert(a.id === b.id, "same link id reused");

      console.log("Test 2 — different send_token mints a fresh link:");
      const c = await mintLink(tx, { ...base, sendToken: "msg-beta" });
      assert(c.reused === false, "new token mints a new link (reused=false)");
      assert(c.code !== a.code, `distinct code for distinct message (${c.code})`);
      assert(c.id !== a.id, "distinct link id for distinct message");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) {
      console.error("\nVerification FAILED:", err);
      failed = true;
    }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-mint OK.");
}

main().catch((err) => {
  console.error("verify-mint crashed:", err);
  process.exit(1);
});
