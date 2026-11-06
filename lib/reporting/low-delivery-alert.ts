import { sql } from "drizzle-orm";

import { CAMPAIGN_TIMEZONE, formatCampaignDateTime } from "@/lib/campaign-timezone";
import {
  DLR_SOURCES,
  queryDeliveryByStage,
  type DbOrTx,
} from "@/lib/reporting/delivery";

// Low-delivery Telegram alert (migration 0236 adds the on/off switch,
// notification_settings.delivery_alert_enabled).
//
// A stage whose matured sends (sent ≥ 60 min ago) have Delivered % below 70%
// pages ONCE, with the providers' error codes. Delivered % uses the shared
// definition in lib/reporting/delivery.ts (delivered ÷ sent, a missing receipt
// counts against it), so the alert and the Delivery report cannot disagree.
//
// Only providers with a DLR intake (DLR_SOURCES: txr / ahi / tls) can be
// judged. TextHub has no receipts — its sends would read as 0% delivered — so
// its (stage, number) rows are dropped before the rate is computed.
//
// Window: sends whose sent_at is in [now − 2 h, now − 60 min). Every send is
// seen by six 10-min ticks before it leaves the window.
// ⚠️ The look-back IS the cost: queryDeliveryByStage scans every txr receipt
// since (window start − 1 h) by received_at, one heap page per row (no index
// on the send key). A 6 h look-back read ~106K pages per tick and ran 15–35 s
// on prod under IO pressure, one tick 504'd at 60 s (2026-11-06); 1 h reads
// ~3/8 of that. A regular stage is latched once forever; a drip stage sends all
// day for weeks, so its latch is per ET day (one alert per drip stage per day).

export const LOW_DELIVERY_THRESHOLD = 0.7;
export const LOW_DELIVERY_MATURITY_MINUTES = 60;
export const LOW_DELIVERY_LOOKBACK_HOURS = 1;
// Below this many matured sends the percentage is noise.
export const LOW_DELIVERY_MIN_SENDS = 50;
const TOP_CODES = 6;

// Where each provider's receipt keeps its failure code. Text Request sends two
// families for one failure — its own 4-digit code on the callback (2002) and
// the carrier's 5-digit code (30007) — so per message the carrier code wins.
const CODE_EXPR: Record<string, string> = {
  txr: `coalesce(nullif(error_code, ''), substring(raw_body from '"error_code"\\s*:\\s*"?([A-Za-z0-9_.-]+)'))`,
  ahi: `coalesce(nullif(smpp_code, ''), nullif(error, ''))`,
  tls: `nullif(error_message, '')`,
};

// Carrier codes as Text Request passes them through (Twilio numbering). Only
// codes whose meaning is certain; anything else is shown bare.
export const ERROR_CODE_LABELS: Record<string, string> = {
  "30003": "unreachable handset",
  "30004": "blocked by recipient/carrier",
  "30005": "unknown or inactive number",
  "30006": "landline or unreachable carrier",
  "30007": "carrier spam filter",
  "30008": "unknown carrier error",
};

export interface ErrorCodeCount {
  code: string;
  messages: number;
}

export interface LowDeliveryBreach {
  org_id: string;
  stage_id: number;
  stage_number: number;
  campaign_id: number;
  campaign_name: string;
  tracking_id: string | null;
  is_drip: boolean;
  provider_name: string;
  phone_numbers: string[];
  creative_id: number | null;
  creative_text: string | null;
  first_sent_at: Date;
  last_sent_at: Date;
  sent: number;
  delivered: number;
  undelivered: number;
  no_receipt: number;
  error_codes: ErrorCodeCount[];
}

export function isLowDelivery(sent: number, delivered: number): boolean {
  return sent >= LOW_DELIVERY_MIN_SENDS && delivered / sent < LOW_DELIVERY_THRESHOLD;
}

export function etDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAMPAIGN_TIMEZONE }).format(now);
}

export function lowDeliveryAlertKey(stageId: number, isDrip: boolean, now: Date): string {
  return isDrip
    ? `low-delivery:stage:${stageId}:${etDay(now)}`
    : `low-delivery:stage:${stageId}`;
}

export function lowDeliveryWindow(now: Date): { fromUtc: Date; maturedBefore: Date } {
  const maturedBefore = new Date(now.getTime() - LOW_DELIVERY_MATURITY_MINUTES * 60_000);
  const fromUtc = new Date(maturedBefore.getTime() - LOW_DELIVERY_LOOKBACK_HOURS * 3_600_000);
  return { fromUtc, maturedBefore };
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * Stages in this org whose matured sends are below the threshold. Read-only.
 *
 * ⚠️ Runs in its own transaction with enable_nestloop = off. A one-stage
 * queryDeliveryByStage on the default planner measured 4.4 s vs 0.5 s
 * (stage 5939, 2026-11-06) — the misplan delivery-report.md §5b documents for
 * the Activity block. One stage in the window is this monitor's common case.
 */
export async function findLowDeliveryStages(
  dbc: DbOrTx,
  orgId: string,
  now: Date,
): Promise<LowDeliveryBreach[]> {
  return dbc.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_nestloop = off`);
    return findInTx(tx, orgId, now);
  });
}

async function findInTx(dbc: DbOrTx, orgId: string, now: Date): Promise<LowDeliveryBreach[]> {
  const { fromUtc, maturedBefore } = lowDeliveryWindow(now);

  // (stage, number) pairs in the window whose provider HAS receipts.
  const pairs = (await dbc.execute(sql`
    SELECT DISTINCT ss.stage_id, ss.provider_phone_id
    FROM stage_sends ss
    JOIN provider_phones pp ON pp.id = ss.provider_phone_id
    JOIN sms_providers sp ON sp.id = pp.provider_id
    WHERE ss.org_id = ${orgId}::uuid
      AND ss.status = 'sent'
      AND ss.sent_at >= ${ts(fromUtc)} AND ss.sent_at < ${ts(maturedBefore)}
      AND sp.sms_provider_id IN (${sql.join(
        Object.keys(DLR_SOURCES).map((k) => sql`${k}`),
        sql`, `,
      )})
  `)) as unknown as { stage_id: number; provider_phone_id: number }[];
  if (pairs.length === 0) return [];

  const capable = new Set(pairs.map((p) => `${p.stage_id}:${p.provider_phone_id}`));
  const rows = await queryDeliveryByStage(dbc, orgId, {
    fromUtc,
    toExclusiveUtc: maturedBefore,
    stageIds: [...new Set(pairs.map((p) => Number(p.stage_id)))],
  });

  const perStage = new Map<number, { sent: number; delivered: number; undelivered: number; no_receipt: number }>();
  for (const r of rows) {
    if (!capable.has(`${r.stage_id}:${r.provider_phone_id}`)) continue;
    const acc = perStage.get(r.stage_id) ?? { sent: 0, delivered: 0, undelivered: 0, no_receipt: 0 };
    acc.sent += r.sent;
    acc.delivered += r.delivered;
    acc.undelivered += r.undelivered;
    acc.no_receipt += r.no_receipt;
    perStage.set(r.stage_id, acc);
  }

  const breaches: LowDeliveryBreach[] = [];
  for (const [stageId, c] of perStage) {
    if (!isLowDelivery(c.sent, c.delivered)) continue;
    const meta = await stageMeta(dbc, orgId, stageId, fromUtc, maturedBefore);
    if (!meta) continue;
    breaches.push({
      ...meta,
      org_id: orgId,
      stage_id: stageId,
      ...c,
      error_codes: await errorCodes(dbc, orgId, stageId, fromUtc, maturedBefore),
    });
  }
  return breaches;
}

async function stageMeta(dbc: DbOrTx, orgId: string, stageId: number, fromUtc: Date, maturedBefore: Date) {
  const rows = (await dbc.execute(sql`
    SELECT cs.stage_number, c.id AS campaign_id, c.name AS campaign_name, c.tracking_id,
           (c.type = 'drip') AS is_drip, cr.id AS creative_id, cr.text AS creative_text,
           w.first_sent_at, w.last_sent_at, w.provider_name, w.phone_numbers
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id AND c.org_id = cs.org_id
    LEFT JOIN creatives cr ON cr.id = cs.creative_id
    CROSS JOIN LATERAL (
      SELECT min(ss.sent_at) AS first_sent_at, max(ss.sent_at) AS last_sent_at,
             string_agg(DISTINCT sp.name, ', ') AS provider_name,
             array_agg(DISTINCT pp.phone_number) AS phone_numbers
      FROM stage_sends ss
      JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      JOIN sms_providers sp ON sp.id = pp.provider_id
      WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id = cs.id AND ss.status = 'sent'
        AND ss.sent_at >= ${ts(fromUtc)} AND ss.sent_at < ${ts(maturedBefore)}
    ) w
    WHERE cs.id = ${stageId} AND cs.org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    stage_number: Number(r.stage_number),
    campaign_id: Number(r.campaign_id),
    campaign_name: String(r.campaign_name),
    tracking_id: (r.tracking_id as string | null) ?? null,
    is_drip: Boolean(r.is_drip),
    provider_name: String(r.provider_name ?? "?"),
    phone_numbers: (r.phone_numbers as string[] | null) ?? [],
    creative_id: r.creative_id == null ? null : Number(r.creative_id),
    creative_text: (r.creative_text as string | null) ?? null,
    first_sent_at: new Date(r.first_sent_at as string),
    last_sent_at: new Date(r.last_sent_at as string),
  };
}

// Counts UNDELIVERED messages (no delivered receipt) by their failure code,
// one code per message: the carrier's 5-digit code when the receipts carry one.
async function errorCodes(
  dbc: DbOrTx,
  orgId: string,
  stageId: number,
  fromUtc: Date,
  maturedBefore: Date,
): Promise<ErrorCodeCount[]> {
  // ⚠️ SHAPE: receipts are GROUPED per message first and the stage's sends
  // joined after — the same shape as terminalCte in delivery.ts. The first
  // version filtered receipts with `key IN (SELECT id FROM sends)`; the planner
  // estimated 5 sends × 234 receipts (actual ~1,200 × a day of txr) and chose a
  // nested loop: 28 s for one stage. Grouped first, it hash-joins.
  const blocks = Object.entries(DLR_SOURCES).map(([key, s]) => {
    const code = sql.raw(CODE_EXPR[key] ?? "NULL::text");
    return sql`
      SELECT ${sql.raw(s.key)} AS ss_id,
             bool_or(lower(status) = 'delivered') AS d,
             max(${code}) FILTER (WHERE ${code} ~ '^[0-9]{5}$') AS carrier_code,
             max(${code}) AS any_code
      FROM ${sql.raw(s.table)}
      WHERE lower(status) IN ('delivered', 'undelivered')
        AND ${sql.raw(s.key)} IS NOT NULL
        AND received_at >= ${ts(fromUtc)} - interval '1 hour'
        ${s.filter ? sql`AND ${sql.raw(s.filter)}` : sql``}
      GROUP BY 1`;
  });
  const rows = (await dbc.execute(sql`
    WITH terminal AS (${sql.join(blocks, sql` UNION ALL `)})
    SELECT coalesce(max(t.carrier_code), max(t.any_code), '(no code)') AS code
    FROM stage_sends ss
    JOIN terminal t ON t.ss_id = ss.id
    WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id = ${stageId} AND ss.status = 'sent'
      AND ss.sent_at >= ${ts(fromUtc)} AND ss.sent_at < ${ts(maturedBefore)}
    GROUP BY ss.id
    HAVING NOT bool_or(t.d)
  `)) as unknown as { code: string }[];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  return [...counts]
    .map(([code, messages]) => ({ code, messages }))
    .sort((a, b) => b.messages - a.messages || a.code.localeCompare(b.code));
}

const n = (v: number) => v.toLocaleString("en-US");
const pct = (num: number, den: number) => (den === 0 ? "0%" : `${((100 * num) / den).toFixed(1)}%`);

export function formatLowDeliveryAlert(b: LowDeliveryBreach): string {
  const codes = b.error_codes.slice(0, TOP_CODES).map((c) => {
    const label = ERROR_CODE_LABELS[c.code];
    return `  ${c.code}${label ? ` (${label})` : ""}: ${n(c.messages)}`;
  });
  const more = b.error_codes.length - TOP_CODES;
  if (more > 0) codes.push(`  …and ${more} more code${more === 1 ? "" : "s"}`);
  const creative = b.creative_text
    ? `Creative #${b.creative_id}: ${b.creative_text.length > 140 ? `${b.creative_text.slice(0, 140)}…` : b.creative_text}`
    : null;

  return [
    `⚠️ Low delivery: ${pct(b.delivered, b.sent)} delivered (alert below ${LOW_DELIVERY_THRESHOLD * 100}%)`,
    `Campaign ${b.campaign_id}${b.is_drip ? " (drip)" : ""}: ${b.campaign_name}`,
    `Tracking ID ${b.tracking_id ?? "—"} · Stage ${b.stage_number}`,
    `${b.provider_name} · ${b.phone_numbers.join(", ")}`,
    `Sends checked: ${formatCampaignDateTime(b.first_sent_at)} – ${formatCampaignDateTime(b.last_sent_at)} (at least ${LOW_DELIVERY_MATURITY_MINUTES} min old)`,
    `Sent ${n(b.sent)} · Delivered ${n(b.delivered)} · Undelivered ${n(b.undelivered)} · No receipt ${n(b.no_receipt)}`,
    codes.length > 0 ? `Error codes (messages):\n${codes.join("\n")}` : "Error codes: none reported",
    creative,
  ]
    .filter((l): l is string => l != null)
    .join("\n");
}
