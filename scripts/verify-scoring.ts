import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getCampaignClickReport } from "@/lib/links/click-report";
import { isDatacenterAsn } from "@/lib/links/datacenter-asns";
import { mintLink } from "@/lib/links/mint-link";
import { scoreClicks, type Enricher, type StatusCheck } from "@/lib/links/score-clicks";
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
  if (ip === "10.0.0.1") return { asn: 16509, asnOrg: "AMAZON-02" };
  if (ip === "198.51.100.5") return { asn: 7922, asnOrg: "Comcast Cable" };
  return { asn: null, asnOrg: null };
};

// Enrichment available — the normal case. Injected so the verify script never
// imports the server-only geoip module.
const healthyStatus: StatusCheck = async () => ({ available: true, reason: "ok", source: "fresh" });
// Enrichment unavailable — simulates a MaxMind 429 / missing key.
const degradedStatus: StatusCheck = async () => ({ available: false, reason: "rate_limited", source: "none" });

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

      // Reuse the brand's existing short_domain if it has one (one-per-brand
      // unique index; it may also be referenced by real links so we can't
      // delete it). Otherwise mint a throwaway one for the test.
      const existingSd = (await tx.execute(sql`
        SELECT id FROM short_domains WHERE brand_id = ${brandId} LIMIT 1
      `)) as unknown as { id: number }[];
      let shortDomainId: number;
      if (existingSd[0]) {
        shortDomainId = Number(existingSd[0].id);
      } else {
        const sd = (await tx.execute(sql`
          INSERT INTO short_domains (org_id, brand_id, domain, status)
          VALUES (${orgId}, ${brandId}, ${"verify-scoring.example"}, 'active') RETURNING id
        `)) as unknown as { id: number }[];
        shortDomainId = Number(sd[0].id);
      }

      // scoreClicks is a whole-table job, so isolate the test from any real
      // clicks already in the table (e.g. from live test-sends). clicks is a
      // leaf table — nothing FKs to it — and we're in a rolled-back tx, so the
      // real rows are restored on rollback.
      await tx.execute(sql`DELETE FROM clicks WHERE org_id = ${orgId}`);

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
      const r1 = await scoreClicks(tx, { mode: "pending", enricher: fakeEnricher, statusCheck: healthyStatus });
      assert(r1.scored === 3, "scored all 3 pending clicks");
      assert(r1.degraded === false, "healthy run is not degraded");
      assert(r1.enrichment.withAsn === 2, "2 of 3 clicks resolved an ASN (enrichment canary)");
      assert((r1.byClassification.bot ?? 0) === 1, "1 bot (datacenter + curl)");
      assert((r1.byClassification.human ?? 0) === 2, "2 human (residential + no-UA below cutoff)");

      const afterPending = (await tx.execute(sql`SELECT count(*)::int AS n FROM clicks WHERE link_id IN (SELECT id FROM links WHERE stage_id = ${stageId}) AND scored_at IS NULL`)) as unknown as { n: number }[];
      assert(Number(afterPending[0].n) === 0, "no pending rows remain after scoring");

      console.log("Idempotent re-score:");
      const r2 = await scoreClicks(tx, { mode: "rescore", enricher: fakeEnricher, statusCheck: healthyStatus });
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
      assert(row!.enriched === 2, "enriched = 2 (clicks with an ASN) — canary");

      // The landmine guard: a degraded run must NOT score rows (no scored_at),
      // it must leave them pending so a later healthy run re-scores them.
      console.log("Degraded enrichment leaves rows pending + self-heals:");
      const link4 = await mintLink(tx, {
        orgId, campaignId, stageId,
        contactId: contacts[0].id,
        creativeId: stage[0].creative_id == null ? null : Number(stage[0].creative_id),
        shortDomainId, destinationUrl: "https://example.com/lp",
        sendToken: "score-degraded", campaignTrackingId: "vs_tid", stageTrackingId: "vs_stid",
      });
      await tx.execute(sql`
        INSERT INTO clicks (org_id, link_id, ip, user_agent, classification)
        VALUES (${orgId}, ${link4.id}, ${"198.51.100.5"}, ${"Mozilla/5.0 (iPhone)"}, 'human')
      `);

      const rDeg = await scoreClicks(tx, { mode: "pending", enricher: fakeEnricher, statusCheck: degradedStatus });
      assert(rDeg.scored === 0, "degraded run scores 0 rows");
      assert(rDeg.degraded === true, "degraded flag is set");
      const stillPending = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM clicks
        WHERE link_id = ${link4.id} AND scored_at IS NULL
      `)) as unknown as { n: number }[];
      assert(Number(stillPending[0].n) === 1, "the new click is left PENDING (scored_at NULL), not falsely scored");

      const rHeal = await scoreClicks(tx, { mode: "pending", enricher: fakeEnricher, statusCheck: healthyStatus });
      assert(rHeal.scored === 1, "a later healthy run self-heals: picks up the pending row");
      assert(rHeal.degraded === false, "healthy re-run is not degraded");

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
