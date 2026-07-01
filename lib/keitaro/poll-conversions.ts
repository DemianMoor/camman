import { inArray, sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  CAMPAIGN_TIMEZONE,
  formatInCampaignTimezone,
} from "@/lib/campaign-timezone";
import {
  fetchKeitaroConversions,
  type KeitaroReportRow,
} from "@/lib/keitaro/client";
import { stage_sends } from "@/db/schema";

export type Database = typeof db;

// Sales lag clicks (the affiliate fires the conversion postback minutes-to-hours
// — sometimes a day — after the click), so the conversions window is WIDER than
// the clicks poll's 3-day window. Re-reading stable older days is cheap and the
// update is idempotent (dedup on event_id).
const DEFAULT_WINDOW_DAYS = 7;

// Only these statuses are attributed to a recipient row (the conversions/log
// request already filters to them; this is the read-side guard).
const ALLOWED_STATUSES = new Set(["lead", "sale", "rejected"]);

// A stage_sends.id is a UUID; reject anything else before casting in SQL so a
// junk sub_id_1 can't throw on `::uuid`.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KeitaroConversionsPollResult {
  ok: boolean;
  // false ⇒ the conversions fetch failed; rows were left untouched for next cycle.
  degraded: boolean;
  range: { from: string; to: string; timezone: string };
  fetched: number; // conversion rows returned by Keitaro
  recipients: number; // distinct, valid sub_id_1 after the latest-wins fold
  matched: number; // recipients whose sub_id_1 mapped to a stage_sends row
  updated: number; // stage_sends rows actually stamped (new/changed conversion)
  deduped: number; // matched rows already carrying this event_id (no write)
  unmatched: number; // sub_id_1 blank / not a UUID / no stage_sends row
  errored: number; // updates that threw
  unmatched_samples: string[]; // a few sub_id_1 values that didn't map back
  // A few raw conversion rows (verbatim) for debugging what Keitaro sends.
  sample: KeitaroReportRow[];
  error: string | null;
}

// Pinned against the live schema. Revenue → `revenue` (NUMERIC string, no float
// drift). NULL when absent.
function pickRevenue(row: KeitaroReportRow): string | null {
  const v = row.revenue;
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : null;
}

// Conversion timestamp → string. Prefer the conversion `datetime`, fall back to
// the originating `click_datetime`. Stored into a TIMESTAMPTZ column.
function pickConvertedAt(row: KeitaroReportRow): string | null {
  for (const k of ["datetime", "click_datetime"] as const) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function readEventId(row: KeitaroReportRow): string {
  const v = row.event_id;
  return typeof v === "string" ? v.trim() : "";
}

function readSubId1(row: KeitaroReportRow): string {
  const v = row.sub_id_1;
  return typeof v === "string" ? v.trim() : "";
}

function readStatus(row: KeitaroReportRow): string | null {
  const v = row.status;
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return ALLOWED_STATUSES.has(s) ? s : null;
}

function readDatetime(row: KeitaroReportRow): string {
  const v = row.datetime;
  return typeof v === "string" ? v.trim() : "";
}

// Pull the rolling conversions window from Keitaro, fold to the LATEST conversion
// per recipient (sub_id_1 = stage_sends.id), and stamp each recipient's
// stage_sends row with the sale status / revenue / converted-at / event_id.
// Never throws: a fetch failure returns degraded; one bad update is counted and
// skipped.
//
// "Latest wins" — the conversions/log endpoint does NOT support server-side
// ordering, so we sort by the conversion `datetime` in memory and keep the most
// recent event per sub_id_1. A lead→sale→rejected progression always reflects the
// most recent event. DEDUP: a row already carrying the latest event's `event_id`
// is skipped (no redundant write). A sale that ages out of the window is never
// cleared — we only ever UPDATE matched rows, never reset them.
//
// MODEL: one sale per recipient (latest wins). sale_revenue is that conversion's
// revenue, NOT a cumulative sum across repeat sales. The documented upgrade path
// (an append-only keitaro_conversions ledger keyed on event_id, with these
// columns derived) is intentionally not built here.
export async function pollKeitaroConversions(
  database: Database,
  opts?: { windowDays?: number },
): Promise<KeitaroConversionsPollResult> {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const from = `${formatInCampaignTimezone(
    new Date(now.getTime() - (windowDays - 1) * 86_400_000),
    "yyyy-MM-dd",
  )} 00:00:00`;
  const to = formatInCampaignTimezone(now, "yyyy-MM-dd HH:mm:ss");
  const range = { from, to, timezone: CAMPAIGN_TIMEZONE };

  const base: KeitaroConversionsPollResult = {
    ok: false,
    degraded: true,
    range,
    fetched: 0,
    recipients: 0,
    matched: 0,
    updated: 0,
    deduped: 0,
    unmatched: 0,
    errored: 0,
    unmatched_samples: [],
    sample: [],
    error: null,
  };

  const conv = await fetchKeitaroConversions(range);
  if (!conv.ok) {
    return { ...base, error: conv.error };
  }

  const rows = conv.rows;

  // Fold to the latest valid conversion per recipient. No server-side order, so
  // compare `datetime` lexically (Keitaro emits "YYYY-MM-DD HH:MM:SS", which
  // sorts chronologically as a string).
  interface Pick {
    subId1: string;
    status: string;
    revenue: string | null;
    convertedAt: string | null;
    eventId: string;
    dt: string;
  }
  const latest = new Map<string, Pick>();
  const unmatchedSamples = new Set<string>();
  let unmatched = 0;

  for (const row of rows) {
    const subId1 = readSubId1(row);
    const status = readStatus(row);
    if (!subId1 || !status || !UUID_RE.test(subId1)) {
      // Blank/invalid recipient id — can't map back. (Empty sub_id_1 is expected
      // for any conversion whose click predates the sub_id1 redirect rollout.)
      unmatched++;
      if (subId1 && unmatchedSamples.size < 10) unmatchedSamples.add(subId1);
      continue;
    }
    const dt = readDatetime(row);
    const prev = latest.get(subId1);
    if (!prev || dt > prev.dt) {
      latest.set(subId1, {
        subId1,
        status,
        revenue: pickRevenue(row),
        convertedAt: pickConvertedAt(row),
        eventId: readEventId(row),
        dt,
      });
    }
  }

  // Resolve which recipients actually exist in one query, with their current
  // event_id, so we can count matched / updated / deduped exactly.
  const ids = [...latest.keys()];
  const existing = new Map<string, string | null>();
  if (ids.length > 0) {
    const found = await database
      .select({
        id: stage_sends.id,
        keitaro_conversion_id: stage_sends.keitaro_conversion_id,
      })
      .from(stage_sends)
      .where(inArray(stage_sends.id, ids));
    for (const r of found) existing.set(r.id, r.keitaro_conversion_id);
  }

  let matched = 0;
  let updated = 0;
  let deduped = 0;
  let errored = 0;

  // Collect one VALUES tuple per row that needs writing, then flush in a single
  // batched UPDATE (below) instead of one round-trip per conversion — on a busy
  // sales day the old loop spent ~12s of pooler latency on ~200 sequential
  // UPDATEs (measured), against the poll's 300s budget.
  const updateVals: SQL[] = [];
  for (const pick of latest.values()) {
    if (!existing.has(pick.subId1)) {
      unmatched++;
      if (unmatchedSamples.size < 10) unmatchedSamples.add(pick.subId1);
      continue;
    }
    matched++;
    // Dedup on event_id: the row already reflects this exact conversion.
    if (pick.eventId && existing.get(pick.subId1) === pick.eventId) {
      deduped++;
      continue;
    }
    // convertedAt is bound as ::text so postgres-js does NOT infer timestamptz and
    // pre-shift it (a 2h error); the zoned-literal concat + cast happens in the SET
    // clause below (see CLAUDE.md §6). NULL convertedAt → NULL converted_at.
    updateVals.push(
      sql`(${pick.subId1}::uuid, ${pick.status}::text, ${pick.revenue}::numeric, ${pick.convertedAt ?? null}::text, ${pick.eventId || null}::text)`,
    );
  }

  // Flush in chunks (bounds statement size on huge sales days).
  const CHUNK = 500;
  for (let i = 0; i < updateVals.length; i += CHUNK) {
    const chunk = updateVals.slice(i, i + CHUNK);
    try {
      await database.execute(sql`
        UPDATE stage_sends AS s
        SET sale_status = v.status,
            sale_revenue = v.revenue,
            converted_at = (v.converted_at || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz,
            keitaro_conversion_id = v.event_id
        FROM (VALUES ${sql.join(chunk, sql`, `)})
          AS v(id, status, revenue, converted_at, event_id)
        WHERE s.id = v.id
      `);
      updated += chunk.length;
    } catch {
      errored += chunk.length;
    }
  }

  return {
    ok: true,
    degraded: false,
    range,
    fetched: rows.length,
    recipients: latest.size,
    matched,
    updated,
    deduped,
    unmatched,
    errored,
    unmatched_samples: [...unmatchedSamples],
    sample: rows.slice(0, 5),
    error: null,
  };
}
