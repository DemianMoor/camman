import "server-only";

import { fromZonedTime } from "date-fns-tz";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { purchasesBySendSelect } from "@/lib/sale-attribution";
import { getCalibratedLookupRate, lookupCostUsd, type LookupRate } from "./lookup-rate";
import { profitAndRoi } from "./partner-profit";

// Partner reporting (Drip Phase 7) — partner key x interest tag x ET-day range.
//
// ⭐ EVERY COLUMN IS DATED BY ITS OWN EVENT, ATTRIBUTED TO THE LEAD'S PARTNER x TAG.
//
//   leads / line types / lookups  -> lead_intake_daily.day_et       (intake)
//   sent, send cost               -> stage_sends.sent_at            (the message went out)
//   clicks                        -> clicks.clicked_at
//   opt-outs (+ their send cost)  -> opt_outs.created_at            (the STOP arrived)
//   sales, revenue                -> conversion_events.created_at   (DETECTION, not Keitaro's
//                                                                    event time — the network
//                                                                    lags by hours, and a day's
//                                                                    number must not move after
//                                                                    the day closes)
//
// A row exists for a (partner, tag) the moment ANY of those is non-zero in the
// range — the key set is the UNION of all five sources (see `keys`). Until
// 2026-10-08 the send half was a COHORT: sends created in the range, and the
// clicks / opt-outs / sales those sends ever produced, whenever they happened.
// Under that reading a day with no intake and no sends showed "No leads in this
// period" while eleven sales were being detected on leads sent the day before.
// The two readings sum to the same totals over a range that contains both the
// send and its outcome; they differ on which DAY the outcome is shown.
//
// ⚠️ TWO SOURCES FOR THE INTAKE HALF, BECAUSE ONE CANNOT ANSWER IT.
// A landline lead has NO contact, NO stage_send and NO journey: G4 counts it at
// intake and discards it. So "leads received including landlines" can only come
// from a counter, and no stage-grained helper can ever produce it. That is why
// this does not extend getStageMetricsInRange().
//
// ⚠️ THE LEAD ATTRIBUTION IS ONE-ROW-PER-SEND BY CONSTRUCTION (`viaLead`).
// A contact can hold several journeys over time (a terminal state frees the
// one-live-per-contact slot), so joining stage_sends to drip_journeys on
// (org, contact, campaign) can match MORE THAN ONE journey and silently multiply
// every send, click and sale. That is exactly how the Offer Group Report came to
// report 904,926 sends against a true 88,536. The LATERAL takes the single most
// recent journey that had already started when the send was created, so each
// event row maps to exactly one lead.
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
  /** Messages with status 'sent' whose sent_at falls in the range. */
  sent: number;
  /**
   * The stage cost model at send grain: each message sent in the range at its
   * rate, PLUS each opt-out reply that ARRIVED in the range at the rate of the
   * send it is attributed to — the same rate × (sends + opt-outs) that
   * campaign_stages.total_cost uses (lib/stages/total-cost.ts). Rate = the
   * send's own cost_per_sms snapshot, falling back to the number's CURRENT rate
   * for drip sends made before the drip path started snapshotting it
   * (2026-10-07) — see the header.
   */
  send_cost_usd: number;
  /** NULL when the provider reports no delivery receipts at all — not 0. */
  delivered_pct: number | null;
  clicks: number;
  /** NULL when nothing was sent — a CTR over zero sends is not 0%, it is unknown. */
  ctr: number | null;
  opt_outs: number;
  /** Counted purchases DETECTED in the range, on this partner x tag's leads. */
  sales: number;
  /** Approved revenue of conversions DETECTED in the range. */
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

/** The ET calendar day after `ymd`. UTC-noon arithmetic, so DST cannot shift it. */
function nextDay(ymd: string): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
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

  // The range as UTC instants (half-open), so every timestamp predicate below
  // is a sargable range — never `(ts AT TIME ZONE …)::date = …`, which forces
  // a scan of every row. Same rule as the drip funnel and the grading reports.
  const fromTs = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const toTs = fromZonedTime(`${nextDay(to)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const within = (ts: SQL) => sql`${ts} >= ${fromTs}::timestamptz AND ${ts} < ${toTs}::timestamptz`;

  // Snapshot first, live rate only for un-snapshotted rows (header).
  const rateExpr = sql`COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)`;

  // A drip send (`ss`) -> the ONE lead it belongs to (`le`). ⚠️ LATERAL + LIMIT 1:
  // one journey per send, never many. See header.
  const viaLead = sql`
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
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
      JOIN lead_events le ON le.id = jj.lead_event_id AND le.sandbox = false`;

  const rows = (await db.execute(sql`
    WITH
    -- ── intake: the counters, already at partner x tag x day grain ──────────
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
      FROM lead_intake_daily d
      WHERE d.org_id = ${orgId}::uuid
        AND d.day_et >= ${from}::date AND d.day_et <= ${to}::date
      GROUP BY 1, 2
    ),
    -- ── sent: messages that went out in the range ───────────────────────────
    sends AS (
      SELECT le.partner_key_id, COALESCE(le.interest_tag, '') AS interest_tag,
             count(*)::int AS sent,
             coalesce(sum(${rateExpr}), 0)::float8 AS sent_cost
      FROM stage_sends ss
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      ${viaLead}
      WHERE ss.org_id = ${orgId}::uuid
        AND ss.status = 'sent'
        AND ${within(sql`ss.sent_at`)}
      GROUP BY 1, 2
    ),
    -- ── clicks: clean only, the same definition campaignTierExpr and the click
    -- report use, so the three cannot disagree. Dated by the click. ───────────
    clicks AS (
      SELECT le.partner_key_id, COALESCE(le.interest_tag, '') AS interest_tag,
             count(*)::int AS clicks
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN stage_sends ss ON ss.link_id = l.id
      ${viaLead}
      WHERE ck.org_id = ${orgId}::uuid
        AND ck.classification NOT IN ('bot', 'prefetch', 'suspect')
        AND ${within(sql`ck.clicked_at`)}
      GROUP BY 1, 2
    ),
    -- ── opt-outs: one row per STOP that arrived in the range (the same DISTINCT
    -- set the Opt-outs column counts), carrying the rate of the send it replied
    -- to: an opt-out reply is billed like a send (lib/stages/total-cost.ts). ──
    optout_rows AS (
      SELECT le.partner_key_id, COALESCE(le.interest_tag, '') AS interest_tag,
             o.id, max(${rateExpr}) AS rate
      FROM opt_outs o
      JOIN opt_out_attributions oa ON oa.opt_out_id = o.id
      JOIN stage_sends ss ON ss.id = oa.stage_send_id
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      ${viaLead}
      WHERE o.org_id = ${orgId}::uuid
        AND ${within(sql`o.created_at`)}
      GROUP BY 1, 2, 3
    ),
    optouts AS (
      SELECT partner_key_id, interest_tag, count(*)::int AS opt_outs,
             sum(rate)::float8 AS optout_cost
      FROM optout_rows
      GROUP BY 1, 2
    ),
    -- ── sales and revenue per RECIPIENT ROW, from the conversion_events ledger —
    -- the shared aggregation (lib/sale-attribution.ts), which the dormant rollup
    -- also uses, so the two cannot drift. Revenue is APPROVED only: a held payout
    -- is not partner revenue.
    --
    -- The bound is this report's DATING RULE, not a scan limit: conversions
    -- DETECTED in the range (ce.created_at), whichever day their send went out.
    -- A payout the network reports days after the send lands on the day it was
    -- detected, never on the send's day and never nowhere. A held payout that is
    -- approved later raises its detection day's revenue when it is approved.
    --
    -- ⚠️ UNEXERCISED BY ANY ROLLED-BACK TEST: getPartnerReport runs against the
    -- module-level db handle, which cannot see a rolled-back proof's fixtures
    -- (scripts/test-p3-task4-reader-switch-db.ts proves the shape, not this
    -- bound). scripts/partner-report-activity-proof.ts checks it against
    -- production rows by hand. ────────────────────────────────────────────────
    purchases AS (${purchasesBySendSelect(orgId, sql`AND ${within(sql`ce.created_at`)}`)}),
    sales AS (
      SELECT le.partner_key_id, COALESCE(le.interest_tag, '') AS interest_tag,
             sum(p.purchases)::int AS sales,
             sum(p.revenue)::float8 AS revenue_usd
      FROM purchases p
      JOIN stage_sends ss ON ss.id = p.stage_send_id
      ${viaLead}
      GROUP BY 1, 2
      -- A rejected or unmapped conversion is in the ledger but is not activity.
      HAVING sum(p.purchases) > 0 OR sum(p.revenue) > 0
    ),
    -- ⚠️ THE KEY SET IS A UNION OF EVERY SOURCE, not one source with the others
    -- coalesced onto it. Joining metrics on a COALESCE'd tag silently drops a
    -- (partner, tag) that exists in one source but not another -- which is
    -- exactly what happened on real data: the pre-0171 counter row sits under
    -- '' while its sends carry 'medicare', and the sends vanished. And a day
    -- with no intake still has rows: whichever source has activity.
    keys AS (
      SELECT partner_key_id, interest_tag FROM intake
      UNION SELECT partner_key_id, interest_tag FROM sends
      UNION SELECT partner_key_id, interest_tag FROM clicks
      UNION SELECT partner_key_id, interest_tag FROM optouts
      UNION SELECT partner_key_id, interest_tag FROM sales
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
           COALESCE(sa.sales, 0)         AS sales,
           COALESCE(sa.revenue_usd, 0)   AS revenue_usd,
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
    LEFT JOIN sales   sa ON sa.partner_key_id = ky.partner_key_id AND sa.interest_tag = ky.interest_tag
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
