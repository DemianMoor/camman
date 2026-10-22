import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import { computePreflightBreakdown } from "@/lib/sends/preflight-breakdown";

// P4-pre: the breakdown's own recipient queries (dedup_1h_predicted, carrier)
// must apply the campaign's offer rules, exactly as kickoff does. Before the
// fix the config query never selected offer_rules_enabled / offer_cooldown_days
// / offer_limit_times, so those queries ran with offer rules OFF and counted
// contacts the send will never include.
//
// Fixture: a campaign with offer rules on (cooldown 7d, limit 5). Pool = A + B.
//   A got this offer 30 days ago (offer_exposures + contact_offer_campaigns) —
//     outside the cooldown, under the limit ⇒ the OFFER RULES admit A, while the
//     LEGACY "ever got this offer" rule (what the breakdown ran before the fix)
//     excludes A. A was also messaged 20 min ago by an offer-less campaign, so
//     as a real recipient A must be dedup-predicted.
//   B is fresh.
// Before the fix: dedup_1h_predicted = 0 (A silently dropped by the legacy rule).
// Rolled-back tx.
//
// Run: npx tsx scripts/test-preflight-breakdown-offer-rules.ts

class Rollback extends Error {}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof dbType;
      const one = async <X>(q: Parameters<typeof tx.execute>[0]): Promise<X> =>
        ((await tx.execute(q)) as unknown as X[])[0];
      const tag = Date.now().toString(36);

      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`)).id;
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"pbo-" + tag}, ${"PBO"}) RETURNING id`);
      const net = await one<{ id: number }>(sql`
        INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${orgId}, ${"pbo-n-" + tag}, ${"N"}) RETURNING id`);
      const offer = await one<{ id: number }>(sql`
        INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${orgId}, ${"pbo-o-" + tag}, ${net.id}, ${"O"}) RETURNING id`);
      const mkCampaign = async (slug: string) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, offer_id, link_mode, status,
                                 exclude_prior_offer_contacts, offer_rules_enabled, offer_cooldown_days, offer_limit_times)
          VALUES (${orgId}, ${slug + tag}, ${brand.id}, ${offer.id}, 'tracked', 'active', true, true, 7, 5) RETURNING id`)).id;
      const mkStage = async (campId: number) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, send_approved, include_no_status, include_clickers, exclude_clickers)
          VALUES (${orgId}, ${campId}, 1, true, true, true, false) RETURNING id`)).id;
      const mkContact = async (n: number) => {
        const phone = `+1564${tag.slice(-4).replace(/\D/g, "7").padStart(4, "7")}${String(n).padStart(3, "0")}`;
        const id = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone}) RETURNING id`)).id;
        return { id, phone };
      };

      const camp = await mkCampaign("pbo-camp-");
      const stage = await mkStage(camp);
      const prev = await mkCampaign("pbo-prev-");
      // The recent send comes from a campaign with NO offer, so it cannot put A
      // back inside this offer's cooldown.
      const noOffer = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
        VALUES (${orgId}, ${"pbo-nooffer-" + tag}, ${brand.id}, 'tracked', 'active') RETURNING id`)).id;
      const noOfferStage = await mkStage(noOffer);

      const a = await mkContact(1);
      const b = await mkContact(2);
      for (const c of [a, b]) {
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
          VALUES (${orgId}, ${camp}, ${c.id}, true, false, false)`);
      }
      // A got this offer 30 days ago from another campaign: outside the 7-day
      // cooldown, 1 of 5 times ⇒ eligible under the offer rules, excluded by the legacy rule.
      await tx.execute(sql`
        INSERT INTO offer_exposures (org_id, contact_id, offer_id, campaign_id, first_sent_at)
        VALUES (${orgId}, ${a.id}, ${offer.id}, ${prev}, now() - interval '30 days')`);
      await tx.execute(sql`
        INSERT INTO contact_offer_campaigns (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
        VALUES (${orgId}, ${a.id}, ${offer.id}, ${prev}, now() - interval '30 days', now() - interval '30 days', 1)`);
      // A was messaged 20 minutes ago by the offer-less campaign.
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${orgId}, ${noOffer}, ${noOfferStage}, ${a.id}, ${a.phone}, ${"x"}, 'sent', now() - interval '20 minutes')`);

      console.log("offer rules on, A past cooldown (legacy rule would drop A) + messaged 20m ago, B fresh:");
      const r = await computePreflightBreakdown(T, { orgId, campaignId: camp, stageId: stage });
      assert(r.materialized_audience === 2, `materialized=2 — kickoff admits A under the offer rules (got ${r.materialized_audience})`);
      assert(r.excluded.content_dedup === 0 && r.excluded.offer_cooldown === 0 && r.excluded.offer_limit === 0,
        `no offer exclusion (got content_dedup=${r.excluded.content_dedup} cooldown=${r.excluded.offer_cooldown} limit=${r.excluded.offer_limit})`);
      assert(r.excluded.dedup_1h_predicted === 1, `dedup_1h_predicted=1 — A is a recipient messaged 20m ago (got ${r.excluded.dedup_1h_predicted})`);
      assert(r.predicted_sends === 1, `predicted=1 (got ${r.predicted_sends})`);
      assert(r.excluded.dedup_1h_predicted <= r.materialized_audience, "invariant: dedup-predicted ⊆ materialized");

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  } finally {
    await pg.end({ timeout: 5 });
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
