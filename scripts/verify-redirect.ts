import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { classifyClick } from "@/lib/links/classify-click";
import { mintLink } from "@/lib/links/mint-link";
import { resolveAndLogClick } from "@/lib/links/resolve-click";

// Verifies the redirect/click-logging path WITHOUT persisting anything:
// everything runs inside a rolled-back transaction. Mints a link, then
// resolves its code and asserts the destination, classification, and that a
// clicks row was written. Also checks the pure classifier and the
// unknown-code (404) path.
//
// Run: npx tsx scripts/verify-redirect.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // Pure classifier — no DB needed.
  console.log("Classifier:");
  assert(classifyClick("Mozilla/5.0 (iPhone)") === "human", "real UA → human");
  assert(classifyClick("facebookexternalhit/1.1") === "bot", "crawler UA → bot");
  assert(classifyClick(null) === "unknown", "missing UA → unknown");
  assert(
    classifyClick("Mozilla/5.0", { secPurpose: "prefetch;prerender" }) === "prefetch",
    "prefetch header → prefetch",
  );

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  let failed = false;

  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(
        sql`SELECT id FROM organizations LIMIT 1`,
      )) as unknown as { id: string }[];
      if (!org[0]) {
        console.log("SKIP: no organizations in the DB.");
        throw new Rollback();
      }
      const orgId = org[0].id;

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

      const contacts = (await tx.execute(sql`
        SELECT id FROM contacts WHERE org_id = ${orgId} LIMIT 1
      `)) as unknown as { id: string }[];
      if (!contacts[0]) {
        console.log(`SKIP: org ${orgId} has no contacts.`);
        throw new Rollback();
      }

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

      const sd = (await tx.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain, status)
        VALUES (${orgId}, ${brandId}, ${"verify-redirect.example"}, 'active')
        RETURNING id
      `)) as unknown as { id: number }[];

      const destinationUrl = "https://example.com/lp?utm=verify";
      const minted = await mintLink(tx, {
        orgId,
        campaignId: Number(stage[0].campaign_id),
        stageId: Number(stage[0].stage_id),
        contactId: contacts[0].id,
        creativeId:
          stage[0].creative_id == null ? null : Number(stage[0].creative_id),
        shortDomainId: Number(sd[0].id),
        destinationUrl,
        sendToken: "redirect-test",
        campaignTrackingId: "verify_campaign_tid",
        stageTrackingId: "verify_stage_tid",
      });

      console.log("Resolve + log:");
      const result = await resolveAndLogClick(tx, {
        code: minted.code,
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0 (iPhone)",
        referer: null,
      });
      assert(result !== null, "known code resolves");
      assert(
        result!.destinationUrl === destinationUrl,
        "resolves to the minted destination",
      );
      assert(result!.classification === "human", "iPhone UA classified human");

      const clickRows = (await tx.execute(sql`
        SELECT classification, ip FROM clicks WHERE link_id = ${minted.id}
      `)) as unknown as { classification: string; ip: string | null }[];
      assert(clickRows.length === 1, "exactly one click row logged");
      assert(clickRows[0].classification === "human", "click row classification persisted");
      assert(clickRows[0].ip === "203.0.113.7", "click row captured the IP");

      const miss = await resolveAndLogClick(tx, { code: "definitely-not-a-real-code" });
      assert(miss === null, "unknown code returns null (→ 404)");

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
  console.log("verify-redirect OK.");
}

main().catch((err) => {
  console.error("verify-redirect crashed:", err);
  process.exit(1);
});
