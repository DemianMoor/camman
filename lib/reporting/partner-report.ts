import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { purchasesBySendSelect } from "@/lib/sale-attribution";
import { getCalibratedLookupRate, lookupCostUsd, type LookupRate } from "./lookup-rate";
import { profitAndRoi } from "./partner-profit";

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
// ⚠️ SEND COST FOR PRE-2026-10-07 DRIP SENDS IS PRICED AT TODAY'S RATE.
// Until then the drip inserts (lib/drip/scheduler.ts, lib/drip/send-one.ts)
// wrote provider_phone_id but not the cost_per_sms snapshot kickoff writes, so
// every earlier drip row is NULL and falls back to the number's live rate. That
// is right wherever the rate was never edited (campaign 1606 foots to its stage
// total_cost exactly) and wrong where it was: campaign 994's stage 3060 implies
// $0.011 against phone 114's current $0.0100, so 994 reads ~$0.005 low. No rate
// edit history exists to recover it from; the owner chose not to backfill.
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
  /**
   * The stage cost model at send grain: each sent message at its rate, PLUS each
   * opt-out reply at the rate of the send it is attributed to — the same
   * rate × (sends + opt-outs) that campaign_stages.total_cost uses
   * (lib/stages/total-cost.ts). Rate = the send's own cost_per_sms snapshot,
   * falling back to the number's CURRENT rate for drip sends made before the
   * drip path started snapshotting it (2026-10-07) — see the header.
   */
  send_cost_usd: number;
  /** NULL when the provider reports no delivery receipts at all — not 0. */
  delivered_pct: number | null;
  clicks: number;
  /** NULL when nothing was sent — a CTR over zero sends is not 0%, it is unknown. */
  ctr: number | null;
  opt_outs: number;
  sales: number;
  revenue_usd: number;
  /** revenue − (send cost + lookup cost). May be negative. */
  net_profit_usd: number;
  /** net profit ÷ (send cost + lookup cost). NULL when that cost is 0 — undefined, not 0%. */
  roi: number | null;
}

export interface PartnerReportResult {
  rows: PartnerReportRow[];
  rate: LookupRate;
  from: string;
  to: string;
}

/**
 * Zero every revenue-derived figure, for a partner whose key has revenue switched off.
 *
 * ⭐ THIS MUST RUN ON THE SERVER, BEFORE THE REPORT IS HANDED TO THE VIEW.
 * `showRevenue: false` only stops the column being RENDERED — the value still
 * travels in the RSC payload and is readable from view-source. That is not a
 * theory: it was caught in the live production smoke check, with `revenue_usd`
 * sitting in the HTML of a page whose key has revenue off. It read 0 at the
 * time, so nothing leaked; the first drip conversion would have published our
 * margin to the partner while the UI still looked correct.
 *
 * ⚠️ NET PROFIT, ROI AND SEND COST GO WITH IT. Net profit and ROI are revenue
 * arithmetic, so leaving them in leaks revenue. Send cost is stripped too: it
 * is our SMS rate, and with revenue ON a partner can derive it anyway
 * (revenue − net − lookup cost), so it is shown exactly when revenue is
 * (owner ruling 2026-10-07) and never otherwise.
 */
export function stripRevenueForPartner(r: PartnerReportResult): PartnerReportResult {
  return {
    ...r,
    rows: r.rows.map((row) => ({
      ...row,
      revenue_usd: 0,
      send_cost_usd: 0,
      net_profit_usd: 0,
      roi: null,
    })),
  };
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
      SELECT ss.id, ss.status, ss.link_id,
             ss.contact_id,
             le.partner_key_id, COALESCE(le.interest_tag, '') AS interest_tag,
             -- Snapshot first, live rate only for un-snapshotted rows (header).
             COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0) AS rate
      FROM stage_sends ss
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
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
    -- Sales and revenue per RECIPIENT ROW, from the conversion_events ledger —
    -- the shared aggregation (lib/sale-attribution.ts), which the dormant rollup
    -- also uses, so the two cannot drift. Revenue is APPROVED only: a held payout
    -- is not partner revenue.
    --
    -- ⚠️ UNEXERCISED BY ANY TEST: getPartnerReport runs against the module-level
    -- db handle, which cannot see a rolled-back proof's fixtures, so this bound is
    -- inert by construction and never executed by
    -- scripts/test-p3-task4-reader-switch-db.ts (the rollup's equivalent bound IS
    -- executed, via its check A8; A7 proves a bound of this shape changes no
    -- number). A test that cannot fail would be worse than saying so here.
    --
    -- BOUNDED BY THIS REPORT'S OWN SEND SET, not by the range. Restricting to the
    -- ids in the attributed CTE can only drop rows the LEFT JOIN below would
    -- discard, so no number moves — where an occurred_at range filter WOULD move
    -- one: a conversion trickles in days after its send, so an upper bound at the
    -- range end would silently drop real payouts from a completed range's report.
    purchases AS (${purchasesBySendSelect(
      orgId,
      sql`AND ce.stage_send_id IN (SELECT a.id FROM attributed a)`,
    )}),
    sends AS (
      SELECT a.partner_key_id, a.interest_tag,
             count(*) FILTER (WHERE a.status = 'sent')::int AS sent,
             coalesce(sum(a.rate) FILTER (WHERE a.status = 'sent'), 0)::float8 AS sent_cost,
             coalesce(sum(p.purchases), 0)::int AS sales,
             coalesce(sum(p.revenue), 0)::float8 AS revenue_usd
      FROM attributed a
      LEFT JOIN purchases p ON p.stage_send_id = a.id
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
    -- One row per opt-out (the same DISTINCT set the Opt-outs column counts),
    -- carrying the rate of the send it replied to: an opt-out reply is billed
    -- like a send (lib/stages/total-cost.ts), so it is part of Send Cost.
    optout_rows AS (
      SELECT a.partner_key_id, a.interest_tag, o.id, max(a.rate) AS rate
      FROM attributed a
      JOIN opt_out_attributions oa ON oa.stage_send_id = a.id
      JOIN opt_outs o ON o.id = oa.opt_out_id
      GROUP BY 1, 2, 3
    ),
    optouts AS (
      SELECT partner_key_id, interest_tag, count(*)::int AS opt_outs,
             sum(rate)::float8 AS optout_cost
      FROM optout_rows
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
           COALESCE(s.revenue_usd, 0)    AS revenue_usd,
           COALESCE(s.sent_cost, 0) + COALESCE(oo.optout_cost, 0) AS send_cost_usd
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
      const lookupCost = lookupCostUsd(Number(r.lookups_spent), rate);
      const sendCost = Number(r.send_cost_usd);
      const revenue = Number(r.revenue_usd);
      const { net_profit_usd, roi } = profitAndRoi(revenue, sendCost, lookupCost);
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
        lookup_cost_usd: lookupCost,
        sent,
        send_cost_usd: sendCost,
        // ⚠️ NULL, NOT 0. Delivery receipts are a provider capability, not a
        // measurement we always have — see the Delivery Report. Reporting 0%
        // for a provider that reports nothing would read as total failure.
        delivered_pct: null,
        clicks,
        // ⚠️ Likewise: a CTR over zero sends is unknown, not 0%.
        ctr: sent > 0 ? clicks / sent : null,
        opt_outs: Number(r.opt_outs),
        sales: Number(r.sales),
        revenue_usd: revenue,
        net_profit_usd,
        roi,
      };
    }),
    rate,
    from,
    to,
  };
}
