import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignTierExpr } from "@/lib/campaign-tier";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { followupDueAt, type FollowupTier } from "./followup-timing";
import { isDripPostureOn } from "./in-use";
import { closeJourneyUnengaged } from "./lifecycle";
import { numbersWithHeadroom, pickNumber } from "./numbers";
import { dispatchDripSend, GateRefused, MintRefused } from "./send-one";

// Behavioural follow-up scheduling (Drip Phase 6).
//
// ⚠️ THE TIER MODEL IS NOT REBUILT HERE (G3). campaignTierExpr already returns
// (contact_id, tier) with exactly the four states this needs — 0 ignored,
// 1 clicked, 2 reached_offer, 3 converted — high-water, campaign-scoped, and
// defining "clean click" identically to the click report. Two definitions of
// "clicked" is precisely how the report and the lanes would drift apart. Tier 3
// never selects a lane: a buyer EXITS.
//
// ⚠️ FOLLOW-UPS GO THROUGH THE SAME SEND PATH AS FIRST-SENDS (G1). Same mint,
// same opt-out gate, same stage_sends insert, same unmodified drain. That is
// what gives them quiet hours, the cross-campaign phone dedup, every breaker and
// latch, credential resolution and pacing — none of which is re-implemented.

export interface FollowupResult {
  postureOn: boolean;
  considered: number;
  inserted: number;
  notDue: number;
  noDetection: number;
  tierMismatch: number;
  alreadySent: number;
  capBlocked: number;
  numbersExhausted: number;
  pausedSkipped: number;
  gateRefused: number;
  mintRefused: number;
  /** Journeys closed completed/unengaged because the Ignored lane fired (R4). */
  closedUnengaged: number;
}

interface CandidateRow {
  journey_id: string;
  contact_id: string;
  phone: string;
  campaign_id: number;
  campaign_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  brand_landing_host: string | null;
  campaign_tracking_id: string | null;
  campaign_paused: boolean;
  daily_cap: number | null;
  first_send_at: string;
  first_stage_id: number;
  child_stage_id: number;
  child_tier: number;
  child_minutes: number;
  child_creative_text: string | null;
  child_creative_id: number | null;
  child_stop_text: string | null;
  child_tracking_id: string | null;
  child_full_url: string | null;
  lp_id: number | null;
  lp_kind: string | null;
  lp_slug: string | null;
  lp_external_url: string | null;
  lp_status: string | null;
  tier: number;
  detected_at: string | null;
  already_sent: boolean;
}

const BATCH = 200;

export async function runDripFollowups(now = new Date()): Promise<FollowupResult> {
  const res: FollowupResult = {
    postureOn: false, considered: 0, inserted: 0, notDue: 0, noDetection: 0,
    tierMismatch: 0, alreadySent: 0, capBlocked: 0, numbersExhausted: 0,
    pausedSkipped: 0, gateRefused: 0, mintRefused: 0, closedUnengaged: 0,
  };

  const orgs = (await db.execute(sql`
    SELECT DISTINCT org_id FROM drip_journeys WHERE state = 'active'
  `)) as unknown as { org_id: string }[];

  for (const { org_id: orgId } of orgs) {
    if (!(await isDripPostureOn(orgId))) continue;
    res.postureOn = true;

    // ⚠️ PER CAMPAIGN, because campaignTierExpr is CAMPAIGN-SCOPED by design —
    // only signals tied to THIS campaign count toward a lane. Fetching across
    // campaigns would have meant inlining a second copy of the tier definition,
    // which is exactly how the click report and the lanes would drift apart.
    const camps = (await db.execute(sql`
      SELECT DISTINCT j.campaign_id
      FROM drip_journeys j
      JOIN drip_campaign_configs cfg
        ON cfg.campaign_id = j.campaign_id AND cfg.behavioral_enabled
      WHERE j.org_id = ${orgId}::uuid AND j.state = 'active'
        AND j.campaign_id IS NOT NULL AND j.first_send_at IS NOT NULL
    `)) as unknown as { campaign_id: number }[];

    const rows: CandidateRow[] = [];
    for (const { campaign_id: campaignId } of camps) {
      const got = (await db.execute(sql`
        SELECT j.id AS journey_id, j.contact_id, ct.phone_number AS phone,
               j.campaign_id, c.name AS campaign_name,
               c.brand_id, b.name AS brand_name, b.landing_host AS brand_landing_host,
               c.tracking_id AS campaign_tracking_id,
               (c.send_paused IS TRUE) AS campaign_paused,
               cfg.daily_cap,
               j.first_send_at, j.first_stage_id,
               ch.id AS child_stage_id, ch.behavioral_tier AS child_tier,
               ch.drip_followup_minutes AS child_minutes,
               cr.text AS child_creative_text, ch.creative_id AS child_creative_id,
               ch.stop_text AS child_stop_text, ch.tracking_id AS child_tracking_id,
               ch.full_url AS child_full_url,
               lp.id AS lp_id, lp.kind AS lp_kind, lp.slug AS lp_slug,
               lp.external_url AS lp_external_url, lp.status AS lp_status,
               COALESCE(bt.tier, 0) AS tier,
               CASE ch.behavioral_tier
                 WHEN 1 THEN (SELECT min(ck.clicked_at) FROM links l
                                JOIN clicks ck ON ck.link_id = l.id
                               WHERE l.campaign_id = j.campaign_id
                                 AND l.contact_id = j.contact_id
                                 AND l.org_id = j.org_id
                                 AND ck.classification NOT IN ('bot','prefetch','suspect'))
                 WHEN 2 THEN (SELECT min(ss.offer_reached_detected_at) FROM stage_sends ss
                               WHERE ss.campaign_id = j.campaign_id
                                 AND ss.contact_id = j.contact_id
                                 AND ss.org_id = j.org_id
                                 AND ss.offer_reached_detected_at IS NOT NULL)
                 ELSE NULL
               END AS detected_at,
               EXISTS (SELECT 1 FROM stage_sends ss2
                        WHERE ss2.stage_id = ch.id AND ss2.contact_id = j.contact_id
                          AND ss2.org_id = j.org_id) AS already_sent
        FROM drip_journeys j
        JOIN contacts ct ON ct.id = j.contact_id
        JOIN campaigns c ON c.id = j.campaign_id
        LEFT JOIN brands b ON b.id = c.brand_id
        JOIN drip_campaign_configs cfg
          ON cfg.campaign_id = c.id AND cfg.behavioral_enabled
        JOIN campaign_stages ch
          ON ch.parent_stage_id = j.first_stage_id
         AND ch.org_id = j.org_id
         AND ch.archived_at IS NULL
         AND ch.drip_active IS TRUE
         AND ch.drip_followup_minutes IS NOT NULL
        LEFT JOIN creatives cr ON cr.id = ch.creative_id
        LEFT JOIN offer_landing_pages lp
               ON lp.id = ch.landing_page_id AND lp.org_id = ch.org_id
        -- the ONE shared tier definition (G3)
        LEFT JOIN (${campaignTierExpr(campaignId, orgId)}) bt
               ON bt.contact_id = j.contact_id
        WHERE j.org_id = ${orgId}::uuid
          AND j.campaign_id = ${campaignId}
          AND j.state = 'active'
          AND j.first_send_at IS NOT NULL
        ORDER BY j.first_send_at
        LIMIT ${BATCH}
      `)) as unknown as CandidateRow[];
      rows.push(...got);
    }

    for (const r of rows) {
      res.considered++;

      if (r.already_sent) { res.alreadySent++; continue; }
      if (r.campaign_paused) { res.pausedSkipped++; continue; }

      // ⚠️ EXACT tier match, and tier 3 never matches any lane — a buyer has
      // exited, and campaignTierExpr is high-water so 3 outranks everything.
      if (Number(r.tier) !== Number(r.child_tier)) { res.tierMismatch++; continue; }

      const due = followupDueAt({
        tier: r.child_tier as FollowupTier,
        minutes: r.child_minutes,
        detectedAt: r.detected_at ? new Date(r.detected_at) : null,
        firstSentAt: new Date(r.first_send_at),
      });
      if (!due.due) { res.noDetection++; continue; }
      if (due.at > now) { res.notDue++; continue; }
      if (!r.child_creative_text) { res.mintRefused++; continue; }

      // Daily cap counts EVERY drip send on the campaign, first-sends included —
      // a follow-up costs the same money and the same carrier reputation.
      if (r.daily_cap != null) {
        const c = (await db.execute(sql`
          SELECT count(*)::int AS n FROM stage_sends ss
          WHERE ss.campaign_id = ${r.campaign_id}
            AND ss.status IN ('sent','sending','pending')
            AND ss.created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York')
                                  AT TIME ZONE 'America/New_York'
        `)) as unknown as { n: number }[];
        if (c[0].n >= r.daily_cap) { res.capBlocked++; continue; }
      }

      const numbers = await numbersWithHeadroom(db, { campaignId: r.campaign_id, now });
      const number = pickNumber(numbers);
      if (!number) { res.numbersExhausted++; continue; }

      const phoneRow = (await db.execute(sql`
        SELECT pp.opt_out_footer AS phone_footer, prov.opt_out_footer AS provider_footer,
               prov.adapter_code
        FROM provider_phones pp
        LEFT JOIN sms_providers prov ON prov.id = pp.provider_id
        WHERE pp.id = ${number.provider_phone_id} LIMIT 1
      `)) as unknown as {
        phone_footer: string | null; provider_footer: string | null; adapter_code: string | null;
      }[];
      const pr = phoneRow[0];
      const { getDescriptor } = await import("@/lib/sends/providers/registry");
      const descriptor = pr?.adapter_code ? getDescriptor(pr.adapter_code) : null;
      const footer = resolveOptOutFooter({
        numberFooter: pr?.phone_footer ?? null,
        providerFooter: pr?.provider_footer ?? null,
        stageStopText: r.child_stop_text,
        providerAppendsOwnOptOut: descriptor?.appendsOwnOptOut === true,
      });

      try {
        await db.transaction(async (tx) => {
          await dispatchDripSend(tx, {
            orgId,
            campaignId: r.campaign_id,
            stageId: r.child_stage_id,
            contactId: r.contact_id,
            phone: r.phone,
            creativeId: r.child_creative_id,
            creativeText: r.child_creative_text!,
            brandName: r.brand_name ?? "",
            brandId: r.brand_id,
            brandLandingHost: r.brand_landing_host,
            handEditedUrl: r.child_full_url,
            campaignTrackingId: r.campaign_tracking_id,
            stageTrackingId: r.child_tracking_id,
            providerPhoneId: number.provider_phone_id,
            adapterCode: pr?.adapter_code ?? null,
            footer,
            landingPage: {
              id: r.lp_id, kind: r.lp_kind, slug: r.lp_slug,
              external_url: r.lp_external_url, status: r.lp_status,
            },
          });

          // ⭐ THE IGNORED LANE IS TERMINAL (ruling R4). Tier 0 means no click,
          // no offer reach, no purchase — and the tier is high-water, so this
          // contact can never fall into a lower lane. The send above is the last
          // thing this journey will ever do, so it closes here, in the SAME
          // transaction: both, or neither.
          if (r.child_tier === 0) {
            const closed = await closeJourneyUnengaged(tx, {
              orgId,
              journeyId: r.journey_id,
            });
            if (closed.closed > 0) res.closedUnengaged++;
          }
        });
        res.inserted++;
      } catch (e) {
        if (e instanceof MintRefused) {
          console.error(`[drip-followups] MINT REFUSED journey ${r.journey_id} ` +
            `(child ${r.child_stage_id}, tier ${r.child_tier}): ${e.reason} — ${e.message}`);
          res.mintRefused++; continue;
        }
        if (e instanceof GateRefused) {
          console.error(`[drip-followups] opt-out gate REFUSED journey ${r.journey_id} ` +
            `(child ${r.child_stage_id}): ${e.message}`);
          res.gateRefused++; continue;
        }
        const code = (e as { cause?: { code?: string } })?.cause?.code;
        if (code !== "23505") throw e;
      }
    }
  }
  return res;
}
