import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  isDlrCapable,
  queryDeliveryByStage,
  type DbOrTx,
  type DeliveryStageRow,
  type PhoneMeta,
} from "@/lib/reporting/delivery";
import { addEtDays, etDayBounds, getDeliveryByStage } from "@/lib/reporting/delivery-rollup";

// =============================================================================
// CAMPAIGN ACTIVITY — the counts behind /campaigns/[id]'s Activity block that
// are more than a status count (ClickUp 869fchavb): opt-outs and delivery.
// Used by app/api/campaigns/[campaignId]/activity and by
// scripts/verify-delivery-grains.ts, which runs these exact statements.
// =============================================================================

// Opt-outs: sends of this campaign with a STOP reply LINKED to them, across
// every provider's intake table. Exact linkage only — matched_stage_send_id,
// set by each provider's opt-out processor; no phone+time attribution (owner
// ruling), so a non-STOP reply ('ignored', never linked) is not counted.
// 'duplicate' / 'already_opted_out' are the same STOP captured twice (webhook +
// poll) or a repeat STOP; DISTINCT on the send absorbs them. The card this
// replaces read texthub_inbound_events only, so it was 0 on every txr/tls/ahi
// campaign.
export async function countCampaignOptOuts(
  dbc: DbOrTx,
  orgId: string,
  campaignId: number,
): Promise<number> {
  const rows = (await dbc.execute(sql`
    WITH stops AS (
      SELECT matched_stage_send_id AS ss_id FROM texthub_inbound_events
      WHERE org_id = ${orgId}::uuid AND result IN ('suppressed', 'duplicate', 'already_opted_out')
      UNION ALL
      SELECT matched_stage_send_id FROM textrequest_inbound_events
      WHERE org_id = ${orgId}::uuid AND result IN ('suppressed', 'duplicate', 'already_opted_out')
      UNION ALL
      SELECT matched_stage_send_id FROM tells_webhook_events
      WHERE org_id = ${orgId}::uuid AND kind = 'inbound'
        AND result IN ('suppressed', 'duplicate', 'already_opted_out')
      UNION ALL
      SELECT matched_stage_send_id FROM ahoi_inbound_events
      WHERE org_id = ${orgId}::uuid AND result IN ('suppressed', 'duplicate', 'already_opted_out')
    )
    SELECT count(DISTINCT ss.id)::int AS n
    FROM stops
    JOIN stage_sends ss ON ss.id = stops.ss_id
    WHERE ss.org_id = ${orgId}::uuid AND ss.campaign_id = ${campaignId}
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// =============================================================================
// Delivery cards
//
// Composes the EXISTING delivery definitions for one campaign, whole lifetime.
// No new delivery query: the buckets come from stage_delivery_rollup
// (getDeliveryByStage) and the live queryDeliveryByStage, both of which compute
// their cells with terminalCte + DELIVERY_COUNTS in lib/reporting/delivery.ts.
//
//   older ET days  → rollup cells (frozen / settled every 3 h)
//   last 2 ET days → live query, matured sends only (sent_at < now − 60 min)
//   younger sends  → PENDING, counted, never bucketed
//
// ⚠️ WHY THE LIVE HALF STARTS THE DAY BEFORE THE CUTOFF'S DAY. Tier A of the
// rollup refreshes TODAY only; yesterday's last ~10 minutes of sends reach the
// rollup at the next 3-hourly settle. Reading yesterday from the rollup would
// make Messages Sent briefly lower than the direct status='sent' count. Two
// days back is always settled.
//
// ⚠️ PENDING IS EVERY SEND YOUNGER THAN THE CUTOFF, receipt or not (owner
// ruling, option A). Delivered + Failed Delivery + No Status therefore foot to
// the MATURED capable sends, and matured + pending = capable sent.
//
// MATURITY = 60 min for every provider. Measured 2026-10-06 (first terminal
// receipt after the send): within 1 h tls 98.7%, txr 97.1%, ahi 99.2%. The
// tripwire's 10 min (DLR_MATURITY_MINUTES) covers only 92.2% of tls receipts —
// ~8% would show as No Status first. txr's tail (p99 ≈ 29 h, the reconcile
// poll) is not captured by any threshold; the UI says No Status shrinks.
// =============================================================================

export const ACTIVITY_DLR_MATURITY_MINUTES = 60;

export interface PendingRow {
  stage_id: number;
  provider_phone_id: number | null;
  sent: number;
}

export interface CampaignDeliveryRows {
  /** Matured sends, (stage, phone) grain: rollup days + the live window. */
  matured: DeliveryStageRow[];
  /** Sends younger than the cutoff, (stage, phone) grain. */
  pending: PendingRow[];
  /** First ET day read live (everything before it came from the rollup). */
  liveFromDay: string;
  cutoff: Date;
}

/**
 * The live half of the campaign read, in its own transaction.
 *
 * ⚠️ enable_nestloop = off is LOAD-BEARING, and scoped to this transaction so
 * nothing else (the tripwire, the reconciliation) is affected. For a
 * single-stage stageIds list the planner estimates ~7 sends (4,491 actual on
 * campaign 1595) and nested-loops them over every receipt group in the window:
 * 131M join-filter comparisons, 8–12 s. With nested loops off it hash-joins in
 * ~0.3 s with identical rows (scripts/verify-delivery-grains.ts proves the
 * equality on every run).
 */
export async function queryLiveCampaignDelivery(
  stageIds: number[],
  orgId: string,
  fromUtc: Date,
  cutoff: Date,
  now: Date,
): Promise<{ matured: DeliveryStageRow[]; pending: PendingRow[] }> {
  if (stageIds.length === 0) return { matured: [], pending: [] };
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_nestloop = off`);
    const matured = await queryDeliveryByStage(tx, orgId, {
      fromUtc,
      toExclusiveUtc: now,
      maturedBefore: cutoff,
      stageIds,
    });
    const pending = (await tx.execute(sql`
      SELECT stage_id, provider_phone_id, count(*)::int AS sent
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid
        AND status = 'sent'
        AND stage_id = ANY(${sql`ARRAY[${sql.join(
          stageIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::int[]`})
        AND sent_at >= ${cutoff.toISOString()}::timestamptz
      GROUP BY 1, 2
    `)) as unknown as Record<string, unknown>[];
    return {
      matured,
      pending: pending.map((r) => ({
        stage_id: Number(r.stage_id),
        provider_phone_id: r.provider_phone_id == null ? null : Number(r.provider_phone_id),
        sent: Number(r.sent),
      })),
    };
  });
}

export async function getCampaignDeliveryRows(
  orgId: string,
  stageIds: number[],
  now = new Date(),
): Promise<CampaignDeliveryRows> {
  const cutoff = new Date(now.getTime() - ACTIVITY_DLR_MATURITY_MINUTES * 60_000);
  const liveFromDay = addEtDays(formatInCampaignTimezone(cutoff, "yyyy-MM-dd"), -1);
  const [closed, live] = await Promise.all([
    getDeliveryByStage(orgId, { from: "2000-01-01", to: addEtDays(liveFromDay, -1) }, stageIds),
    queryLiveCampaignDelivery(
      stageIds,
      orgId,
      etDayBounds({ from: liveFromDay, to: liveFromDay }).fromUtc,
      cutoff,
      now,
    ),
  ]);
  return { matured: [...closed, ...live.matured], pending: live.pending, liveFromDay, cutoff };
}

// ---------------------------------------------------------------------------
// PURE SUMMARY — no DB
// ---------------------------------------------------------------------------

// The DLR columns are `| null`, never `| 0`, when nothing behind them is
// DLR-capable — the same type-is-the-gate rule as lib/reporting/delivery.ts.
export interface DeliveryCardCells {
  /** Every status='sent' send at this grain, capable or not. */
  sent: number;
  dlr_capable: boolean;
  /** Sends on DLR-capable numbers (matured + pending). Coverage numerator. */
  capable_sent: number | null;
  /** Capable sends older than the cutoff. The % denominator. */
  matured: number | null;
  delivered: number | null;
  undelivered: number | null;
  no_receipt: number | null;
  pending: number | null;
  /** Over matured. */
  delivered_pct: number | null;
  undelivered_pct: number | null;
  no_receipt_pct: number | null;
  /** Over capable_sent. */
  pending_pct: number | null;
}

export interface StagePhoneDeliveryRow extends DeliveryCardCells {
  stage_id: number;
  provider_phone_id: number | null;
  phone_number: string | null;
  provider_key: string | null;
}

export interface CampaignDeliverySummary extends DeliveryCardCells {
  maturity_minutes: number;
  /** Stage × sending-number breakdown, stage then sent desc. Sums to the totals. */
  by_stage_phone: StagePhoneDeliveryRow[];
}

interface Acc {
  sent: number;
  capable_sent: number;
  matured: number;
  delivered: number;
  undelivered: number;
  no_receipt: number;
  pending: number;
}

const zero = (): Acc => ({
  sent: 0, capable_sent: 0, matured: 0, delivered: 0, undelivered: 0, no_receipt: 0, pending: 0,
});

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);

function cells(a: Acc): DeliveryCardCells {
  const capable = a.capable_sent > 0;
  const g = (n: number) => (capable ? n : null);
  return {
    sent: a.sent,
    dlr_capable: capable,
    capable_sent: g(a.capable_sent),
    matured: g(a.matured),
    delivered: g(a.delivered),
    undelivered: g(a.undelivered),
    no_receipt: g(a.no_receipt),
    pending: g(a.pending),
    delivered_pct: capable ? pct(a.delivered, a.matured) : null,
    undelivered_pct: capable ? pct(a.undelivered, a.matured) : null,
    no_receipt_pct: capable ? pct(a.no_receipt, a.matured) : null,
    pending_pct: capable ? pct(a.pending, a.capable_sent) : null,
  };
}

export function summarizeCampaignDelivery(
  matured: DeliveryStageRow[],
  pending: PendingRow[],
  phones: Map<number, PhoneMeta>,
): CampaignDeliverySummary {
  const total = zero();
  const byKey = new Map<string, { stage_id: number; provider_phone_id: number | null; acc: Acc }>();
  const slot = (stageId: number, phoneId: number | null) => {
    const k = `${stageId}|${phoneId ?? "null"}`;
    let s = byKey.get(k);
    if (!s) byKey.set(k, (s = { stage_id: stageId, provider_phone_id: phoneId, acc: zero() }));
    return s.acc;
  };
  // Capability resolves through the SEND's stamped number, exactly as the
  // report's rollups do — never through the stage.
  const capableOf = (phoneId: number | null) =>
    isDlrCapable(phoneId == null ? null : phones.get(phoneId)?.provider_key);

  for (const r of matured) {
    const capable = capableOf(r.provider_phone_id);
    for (const a of [total, slot(r.stage_id, r.provider_phone_id)]) {
      a.sent += r.sent;
      if (!capable) continue;
      a.capable_sent += r.sent;
      a.matured += r.sent;
      a.delivered += r.delivered;
      a.undelivered += r.undelivered;
      a.no_receipt += r.no_receipt;
    }
  }
  for (const r of pending) {
    const capable = capableOf(r.provider_phone_id);
    for (const a of [total, slot(r.stage_id, r.provider_phone_id)]) {
      a.sent += r.sent;
      if (!capable) continue;
      a.capable_sent += r.sent;
      a.pending += r.sent;
    }
  }

  const by_stage_phone = [...byKey.values()]
    .map(({ stage_id, provider_phone_id, acc }) => {
      const meta = provider_phone_id == null ? null : phones.get(provider_phone_id);
      return {
        stage_id,
        provider_phone_id,
        phone_number: meta?.phone_number ?? null,
        provider_key: meta?.provider_key ?? null,
        ...cells(acc),
      };
    })
    .sort((a, b) => a.stage_id - b.stage_id || b.sent - a.sent);

  return { ...cells(total), maturity_minutes: ACTIVITY_DLR_MATURITY_MINUTES, by_stage_phone };
}
