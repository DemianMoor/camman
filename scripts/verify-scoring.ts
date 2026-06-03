import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getCampaignClickReport } from "@/lib/links/click-report";
import { isDatacenterAsn } from "@/lib/links/datacenter-asns";
import { mintLink } from "@/lib/links/mint-link";
import { scoreClicks, type Enricher } from "@/lib/links/score-clicks";
import { scoreClick } from "@/lib/links/scoring";

// Verifies the scoring pipeline WITHOUT persisting anything (rolled-back tx)
// and WITHOUT MaxMind (a fake enricher maps test IPs to ASNs). Covers:
//   - pure scoreClick: datacenter, scanner UA, residential human, prefetch,
//     missing-UA reasons
//   - datacenter-ASN matching (number + org keyword)
//   - the job: enriches + scores pending rows; idempotent re-score
//   - clean-vs-raw report math on a tracked campaign
//
// Run: npx tsx scripts/verify-scoring.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// Deterministic fake: 198.51.100.x = residential, 10.0.0.x = datacenter.
const fakeEnricher: Enricher = async (ip) => {
  if (ip === "10.0.0.1") return { asn: 16509, asnOrg: "AMAZON-02", country: "US" };
  if (ip === "198.51.100.5") return { asn: 7922, asnOrg: "Comcast Cable", country: "US" };
  return { asn: null, asnOrg: null, country: null };
};

async function main() {
  console.log("Pure scoreClick:");
  const dc = scoreClick({ firstPassClassification: "human", userAgent: "Mozilla/5.0 (iPhone)", asn: 16509, asnOrg: "AMAZON-02", isDatacenter: true });
  assert(dc.classification === "suspect" && dc.score === 60, "datacenter alone → suspect (60)");
  assert(dc.reasons.includes("datacenter_asn"), "datacenter reason recorded");

  const dcScanner = scoreClick({ firstPassClassification: "bot", userAgent: "curl/8.0", asn: 16509, asnOrg: "AMAZON-02", isDatacenter: true });
  assert(dcScanner.classification === "bot" && dcScanner.score === 100, "datacenter + scanner UA → bot (100)");

  const human = scoreClick({ firstPassClassification: "human", userAgent: "Mozilla/5.0 (iPhone)", asn: 7922, asnOrg: "Comcast Cable", isDatacenter: false });
  assert(human.classification === "human" && human.score === 0, "residential iPhone → human (0)");
  assert(Array.isArray(human.reasons), "reasons recorded even for human (empty ok)");

  const noUa = scoreClick({ firstPassClassification: "unknown", userAgent: null, asn: 7922, asnOrg: "Comcast Cable", isDatacenter: false });
  assert(noUa.score === 25 && noUa.classification === "human" && noUa.reasons.includes("missing_user_agent"), "missing UA → 25, human, reason recorded (soft spot)");

  const pf = scoreClick({ firstPassClassification: "prefetch", userAgent: "Mozilla/5.0", asn: null, asnOrg: null, isDatacenter: null });
  assert(pf.classification === "prefetch", "prefetch first-pass stays prefetch");

  console.log("Datacenter ASN list:");
  assert(isDatacenterAsn(16509, null) === true, "AWS ASN number matches");
  assert(isDatacenterAsn(null, "Hetzner Online GmbH") === true, "org keyword matches");
  assert(isDatacenterAsn(7922, "Comcast Cable") === false, "residential ISP does not match");

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

      const stage = (await tx.execute(sql`
        SELECT cs.id AS stage_id, cs.creative_id, cs.campaign_id, c.brand_id
        FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE c.org_id = ${orgId} LIMIT 1
      `)) as unknown as { stage_id: number; creative_id: number | null; campaign_id: number; brand_id: number | null }[];
      if (!stage[0]) { console.log("SKIP: no campaign stages."); throw new Rollback(); }
      const campaignId = Number(stage[0].campaign_id);
      const stageId = Number(stage[0].stage_id);

      const contacts = (await tx.execute(sql`SELECT id FROM contacts WHERE org_id = ${orgId} LIMIT 3`)) as unknown as { id: string }[];
      if (contacts.length < 1) { console.log("SKIP: no contacts."); throw new Rollback(); }

      let brandId = stage[0].brand_id;
      if (brandId == null) {
        const brand = (await tx.execute(sql`SELECT id FROM brands WHERE org_id = ${orgId} LIMIT 1`)) as unknown as { id: number }[];
        if (!brand[0]) { console.log("SKIP: no brands."); throw new Rollback(); }
        brandId = Number(brand[0].id);
      }

      // Force this campaign to tracked so the report exercises the tracked path.
      await tx.execute(sql`UPDATE campaigns SET link_mode = 'tracked' WHERE id = ${campaignId}`);

      const sd = (await tx.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain, status)
        VALUES (${orgId}, ${brandId}, ${"verify-scoring.example"}, 'active') RETURNING id
      `)) as unknown as { id: number }[];
      const shortDomainId = Number(sd[0].id);

      // Three clicks: datacenter (→bot), residential human, no-UA.
      const fixtures = [
        { ip: "10.0.0.1", ua: "curl/8.0", token: "score-dc" },
        { ip: "198.51.100.5", ua: "Mozilla/5.0 (iPhone)", token: "score-human" },
        { ip: "203.0.113.9", ua: null, token: "score-noua" },
      ];
      let i = 0;
      for (const f of fixtures) {
        const link = await mintLink(tx, {
          orgId, campaignId, stageId,
          contactId: contacts[i % contacts.length].id,
          creativeId: stage[0].creative_id == null ? null : Number(stage[0].creative_id),
          shortDomainId, destinationUrl: "https://example.com/lp",
          sendToken: f.token, campaignTrackingId: "vs_tid", stageTrackingId: "vs_stid",
        });
        // first-pass classification mirrors what the redirect would store.
        const cls = f.ua === null ? "unknown" : (f.ua.includes("curl") ? "bot" : "human");
        await tx.execute(sql`
          INSERT INTO clicks (org_id, link_id, ip, user_agent, classification)
          VALUES (${orgId}, ${link.id}, ${f.ip}, ${f.ua}, ${cls})
        `);
        i++;
      }

      console.log("Scoring job (pending):");
      const r1 = await scoreClicks(tx, { mode: "pending", enricher: fakeEnricher });
      assert(r1.scored === 3, "scored all 3 pending clicks");
      assert((r1.byClassification.bot ?? 0) === 1, "1 bot (datacenter + curl)");
      assert((r1.byClassification.human ?? 0) === 2, "2 human (residential + no-UA below cutoff)");

      const afterPending = (await tx.execute(sql`SELECT count(*)::int AS n FROM clicks WHERE link_id IN (SELECT id FROM links WHERE stage_id = ${stageId}) AND scored_at IS NULL`)) as unknown as { n: number }[];
      assert(Number(afterPending[0].n) === 0, "no pending rows remain after scoring");

      console.log("Idempotent re-score:");
      const r2 = await scoreClicks(tx, { mode: "rescore", enricher: fakeEnricher });
      assert(r2.scored === 3, "re-score touches all 3 rows");
      assert((r2.byClassification.bot ?? 0) === 1 && (r2.byClassification.human ?? 0) === 2, "re-score yields identical verdicts (idempotent)");

      console.log("Clean-vs-raw report:");
      const report = await getCampaignClickReport(tx, orgId, campaignId);
      if (!report || report.source !== "tracked") {
        throw new Error("expected a tracked report");
      }
      assert(report.source === "tracked", "report source is tracked");
      const row = report.stages.find((s) => s.stage_id === stageId);
      assert(!!row, "stage present in report");
      assert(row!.raw === 3, "raw = 3");
      assert(row!.bot === 1, "1 bot in breakdown");
      assert(row!.clean === 2, "clean = 2 (raw - bot/prefetch/suspect)");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-scoring OK.");
}

main().catch((err) => { console.error("verify-scoring crashed:", err); process.exit(1); });
