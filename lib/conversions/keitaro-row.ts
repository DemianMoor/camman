import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import type { KeitaroReportRange, KeitaroReportRow } from "@/lib/keitaro/client";

// One Keitaro conversion normalised for the conversion_events ledger. Pure — no
// DB, no env — so every parsing rule is checked by
// scripts/test-conversion-ledger-rows.ts.
export interface LedgerSourceRow {
  eventId: string;
  tid: string | null;
  clickSubid: string | null;
  subId1: string | null; // lowercased; = stage_sends.id when the click was ours
  subId3: string | null; // = campaign_stages.tracking_id
  keitaroStatus: string; // lowercased raw resolved status
  keitaroType: string; // lowercased conversion_type name — the mapping key
  revenue: string; // NUMERIC string, 4dp
  currency: string | null;
  occurredAtEt: string; // ORIGINAL conversion time, "YYYY-MM-DD HH:MM:SS" ET
  lastPostbackAtEt: string; // Keitaro's current `datetime`
  keitaroOfferId: number | null;
  version: number | null;
  statusHistory: string | null;
  rawParams: Record<string, unknown> | null;
}

const ET_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const HISTORY_TS_RE = /\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)/g;

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function int(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

// Keitaro moves a conversion's `datetime` to the LATEST postback when it updates
// the conversion in place (measured 2026-09-17: a re-post moved one from 09-14 to
// 09-17). status_history keeps each transition as "N. Type (YYYY-MM-DD HH:MM:SS)"
// in the report timezone (equal to `datetime` on all 1,458 never-updated rows),
// so its EARLIEST stamp is the original time. Earliest rather than first-listed:
// the listing order of a multi-entry history is not verified.
export function originalConversionTimeEt(
  statusHistory: string | null,
  datetime: string,
): string {
  if (!statusHistory) return datetime;
  const stamps = [...statusHistory.matchAll(HISTORY_TS_RE)].map((m) => m[1]);
  if (stamps.length === 0) return datetime;
  return stamps.reduce((a, b) => (b < a ? b : a));
}

export function parseKeitaroLedgerRow(row: KeitaroReportRow): LedgerSourceRow | null {
  const eventId = text(row.event_id);
  const datetime = text(row.datetime);
  const keitaroStatus = text(row.status)?.toLowerCase() ?? null;
  const keitaroType = text(row.conversion_type)?.toLowerCase() ?? null;
  if (!eventId || !datetime || !ET_DATETIME_RE.test(datetime) || !keitaroStatus || !keitaroType) {
    return null;
  }
  // Missing revenue is a malformed row, not $0 — a real $0 conversion carries 0.
  if (row.revenue === undefined || row.revenue === null || row.revenue === "") return null;
  const revenue = typeof row.revenue === "number" ? row.revenue : Number(row.revenue);
  if (!Number.isFinite(revenue)) return null;
  const params =
    row.params !== null && typeof row.params === "object" && !Array.isArray(row.params)
      ? (row.params as Record<string, unknown>)
      : null;
  const statusHistory = text(row.status_history);
  const offerId = int(row.offer_id);
  return {
    eventId,
    tid: text(row.tid),
    clickSubid: text(row.sub_id),
    subId1: text(row.sub_id_1)?.toLowerCase() ?? null,
    subId3: text(row.sub_id_3),
    keitaroStatus,
    keitaroType,
    revenue: revenue.toFixed(4),
    currency: text(params?.currency)?.toUpperCase() ?? null,
    occurredAtEt: originalConversionTimeEt(statusHistory, datetime),
    lastPostbackAtEt: datetime,
    keitaroOfferId: offerId !== null && offerId > 0 ? offerId : null,
    version: int(row.version),
    statusHistory,
    rawParams: params,
  };
}

// Contiguous ET calendar-day windows of `days` days from fromDate 00:00:00 up to
// nowEt. Keitaro filters conversions/log by the conversion's current `datetime`.
export function etDayWindows(
  fromDate: string,
  nowEt: string,
  days: number,
): KeitaroReportRange[] {
  const out: KeitaroReportRange[] = [];
  const endDay = nowEt.slice(0, 10);
  const DAY = 86_400_000;
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); ; t += days * DAY) {
    const start = new Date(t).toISOString().slice(0, 10);
    if (start > endDay) break;
    const last = new Date(t + (days - 1) * DAY).toISOString().slice(0, 10);
    out.push({
      from: `${start} 00:00:00`,
      to: last >= endDay ? nowEt : `${last} 23:59:59`,
      timezone: CAMPAIGN_TIMEZONE,
    });
  }
  return out;
}

// The live ingest's window (Phase 2, /api/keitaro/poll): ET "today − 6 days"
// 00:00:00 through now = 7 ET calendar days. Calendar arithmetic on the ET DATE
// string, not now − 6×24h: across a DST fall-back week the 24h arithmetic starts
// a day late (scripts/test-conversion-monitor.ts R3). Keitaro filters
// conversions/log by a conversion's CURRENT datetime, and a re-post moves that
// forward, so an in-place update of an older conversion re-enters this window.
export const LIVE_INGEST_DAYS = 7;

export function liveIngestRange(now: Date): KeitaroReportRange {
  const nowEt = formatInCampaignTimezone(now, "yyyy-MM-dd HH:mm:ss");
  const fromDay = new Date(
    Date.parse(`${nowEt.slice(0, 10)}T00:00:00Z`) - (LIVE_INGEST_DAYS - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return { from: `${fromDay} 00:00:00`, to: nowEt, timezone: CAMPAIGN_TIMEZONE };
}
