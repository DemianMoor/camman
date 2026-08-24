import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { purchasedClause } from "@/lib/sale-attribution";
import { getCalibratedLookupRate, lookupCostUsd, type LookupRate } from "./lookup-rate";

// Partner reporting (Drip Phase 7) — partner key x interest tag x ET-day range.
//
// ⚠️ TWO SOURCES, BECAUSE ONE CANNOT ANSWER BOTH HALVES.
//
//   intake half  -> lead_intake_daily (counters written in the intake txn)
//   send half    -> stage_sends, reached through the journey
//
// A landline lead has NO contact, NO stage_send and NO journey: G4 counts it at
// intake and discards it. So "leads received including landlines" can only come
// from a counter, and no stage-grained helper can ever produce it. That is why
// this does not extend getStageMetricsInRange().
//
// ⚠️ THE SEND JOIN IS ONE-ROW-PER-SEND BY CONSTRUCTION.
// A contact can hold several journeys over time (a terminal state frees the
// one-live-per-contact slot), so joining stage_sends to drip_journeys on
// (org, contact, campaign) can match MORE THAN ONE journey and silently multiply
// every send. That is exactly how the Offer Group Report came to report 904,926
// sends against a true 88,536. The LATERAL below takes the single most recent
// journey that had already started when the send was created, so the join can
// only ever produce one row per stage_send.
//
// ⚠️ SANDBOX IS EXCLUDED EVERYWHERE (card). A sandbox key must appear in neither
// report; it is filtered on lead_events.sandbox, not on the key, because a key
// can be flipped out of sandbox after leads have arrived under it.

export interface PartnerReportRow {
  partner_key_id: number;
  partner_slug: string;
  partner_name: string;
  interest_tag: string;
  /** Intake — from the counters. */
  leads_received: number;
  mobile: number;
  voip: number;
  unknown: number;
  landline: number;
  duplicate: number;
  rejected: number;
  lookups_spent: number;
  lookup_cost_usd: number;
  /** Sends — through the journey. */
  sent: number;
  /** NULL when the provider reports no delivery receipts at all — not 0. */
  delivered_pct: number | null;
  clicks: number;
  /** NULL when nothing was sent — a CTR over zero sends is not 0%, it is unknown. */
  ctr: number | null;
  opt_outs: number;
  sales: number;
  revenue_usd: number;
}

export interface PartnerReportResult {
  rows: PartnerReportRow[];
  rate: LookupRate;
  from: string;
  to: string;
}

/**
 * @param from,to inclusive ET calendar days, `YYYY-MM-DD`.
 * @param partnerKeyId restrict to one partner (the signed-link view always does).
 */
export async function getPartnerReport(
  orgId: string,
  from: string,
  to: string,
  partnerKeyId?: number,
): Promise<PartnerReportResult> {
  const rate = await getCalibratedLookupRate();
  const onlyPartner = partnerKeyId != null ? sql`AND k.id = ${partnerKeyId}` : sql``;

  const rows = (await db.execute(sql`
    WITH bounds AS (
      SELECT ${from}::date AS from_day, ${to}::date AS to_day
    ),
    -- ── intake half: the counters, already at partner x tag x day grain ──────
    intake AS (
      SELECT d.partner_key_id, d.interest_tag,
             sum(d.received)::int      AS leads_received,
             sum(d.mobile)::int        AS mobile,
             sum(d.voip)::int          AS voip,
             sum(d.unknown)::int       AS unknown,
             sum(d.landline)::int      AS landline,
             sum(d.duplicate)::int     AS duplicate,
             sum(d.rejected)::int      AS rejected,
             sum(d.lookups_spent)::int AS lookups_spent
      FROM lead_intake_daily d, bounds b
      WHERE d.org_id = ${orgId}::uuid
        AND d.day_et >= b.from_day AND d.day_et <= b.to_day
      GROUP BY 1, 2
    ),
    -- ── send half: every drip send, attributed to EXACTLY ONE journey ────────
    attributed AS (
      SELECT ss.id, ss.status, ss.sale_status, ss.sale_revenue, ss.link_id,
             ss.contact_id,
             le.partner_key_id, COALESCE(le.interest_tag, '') AS interest_tag
      FROM stage_sends ss
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      CROSS JOIN bounds b
      -- ⚠️ LATERAL + LIMIT 1: one journey per send, never many. See header.
      JOIN LATERAL (
        SELECT j.lead_event_id
        FROM drip_journeys j
        WHERE j.org_id = ss.org_id
          AND j.contact_id = ss.contact_id
          AND j.campaign_id = ss.campaign_id
          AND (j.first_send_at IS NULL OR j.first_send_at <= ss.created_at)
        ORDER BY j.routed_at DESC
        LIMIT 1
      ) jj ON true
      JOIN lead_events le ON le.id = jj.lead_event_id AND le.sandbox = false
      WHERE ss.org_id = ${orgId}::uuid
        AND (ss.created_at AT TIME ZONE 'America/New_York')::date >= b.from_day
        AND (ss.created_at AT TIME ZONE 'America/New_York')::date <= b.to_day
    ),
    sends AS (
      SELECT partner_key_id, interest_tag,
             count(*) FILTER (WHERE status = 'sent')::int AS sent,
             count(*) FILTER (WHERE ${purchasedClause("attributed")})::int AS sales,
             COALESCE(sum(sale_revenue) FILTER (WHERE ${purchasedClause("attributed")}), 0)::float8
               AS revenue_usd
      FROM attributed
      GROUP BY 1, 2
    ),
    -- clicks: clean only, the same definition campaignTierExpr and the click
    -- report use, so the three cannot disagree.
    clicks AS (
      SELECT a.partner_key_id, a.interest_tag, count(*)::int AS clicks
      FROM attributed a
      JOIN links l ON l.id = a.link_id
      JOIN clicks ck ON ck.link_id = l.id
        AND ck.classification NOT IN ('bot', 'prefetch', 'suspect')
      GROUP BY 1, 2
    ),
    optouts AS (
      SELECT a.partner_key_id, a.interest_tag, count(DISTINCT o.id)::int AS opt_outs
      FROM attributed a
      JOIN opt_out_attributions oa ON oa.stage_send_id = a.id
      JOIN opt_outs o ON o.id = oa.opt_out_id
      GROUP BY 1, 2
    ),
    -- ⚠️ THE KEY SET IS A UNION OF EVERY SOURCE, not one source with the others
    -- coalesced onto it. Joining metrics on a COALESCE'd tag silently drops a
    -- (partner, tag) that exists in one source but not another -- which is
    -- exactly what happened on real data: the pre-0171 counter row sits under
    -- '' while its sends carry 'medicare', and the sends vanished.
    keys AS (
      SELECT partner_key_id, interest_tag FROM intake
      UNION
      SELECT partner_key_id, interest_tag FROM sends
    )
    SELECT k.id AS partner_key_id, k.partner_slug, k.name AS partner_name,
           ky.interest_tag,
           COALESCE(i.leads_received, 0) AS leads_received,
           COALESCE(i.mobile, 0)         AS mobile,
           COALESCE(i.voip, 0)           AS voip,
           COALESCE(i.unknown, 0)        AS unknown,
           COALESCE(i.landline, 0)       AS landline,
           COALESCE(i.duplicate, 0)      AS duplicate,
           COALESCE(i.rejected, 0)       AS rejected,
           COALESCE(i.lookups_spent, 0)  AS lookups_spent,
           COALESCE(s.sent, 0)           AS sent,
           COALESCE(cl.clicks, 0)        AS clicks,
           COALESCE(oo.opt_outs, 0)      AS opt_outs,
           COALESCE(s.sales, 0)          AS sales,
           COALESCE(s.revenue_usd, 0)    AS revenue_usd
    FROM keys ky
    JOIN partner_keys k
      ON k.id = ky.partner_key_id
     AND k.org_id = ${orgId}::uuid
     -- ⚠️ A sandbox KEY never appears at all (card): absent, not zeroed.
     AND k.sandbox = false
    LEFT JOIN intake  i  ON i.partner_key_id  = ky.partner_key_id AND i.interest_tag  = ky.interest_tag
    LEFT JOIN sends   s  ON s.partner_key_id  = ky.partner_key_id AND s.interest_tag  = ky.interest_tag
    LEFT JOIN clicks  cl ON cl.partner_key_id = ky.partner_key_id AND cl.interest_tag = ky.interest_tag
    LEFT JOIN optouts oo ON oo.partner_key_id = ky.partner_key_id AND oo.interest_tag = ky.interest_tag
    WHERE TRUE ${onlyPartner}
    ORDER BY k.partner_slug, ky.interest_tag
  `)) as unknown as Record<string, number | string>[];

  return {
    rows: rows.map((r) => {
      const sent = Number(r.sent);
      const clicks = Number(r.clicks);
      return {
        partner_key_id: Number(r.partner_key_id),
        partner_slug: String(r.partner_slug),
        partner_name: String(r.partner_name),
        interest_tag: String(r.interest_tag),
        leads_received: Number(r.leads_received),
        mobile: Number(r.mobile),
        voip: Number(r.voip),
        unknown: Number(r.unknown),
        landline: Number(r.landline),
        duplicate: Number(r.duplicate),
        rejected: Number(r.rejected),
        lookups_spent: Number(r.lookups_spent),
        lookup_cost_usd: lookupCostUsd(Number(r.lookups_spent), rate),
        sent,
        // ⚠️ NULL, NOT 0. Delivery receipts are a provider capability, not a
        // measurement we always have — see the Delivery Report. Reporting 0%
        // for a provider that reports nothing would read as total failure.
        delivered_pct: null,
        clicks,
        // ⚠️ Likewise: a CTR over zero sends is unknown, not 0%.
        ctr: sent > 0 ? clicks / sent : null,
        opt_outs: Number(r.opt_outs),
        sales: Number(r.sales),
        revenue_usd: Number(r.revenue_usd),
      };
    }),
    rate,
    from,
    to,
  };
}
