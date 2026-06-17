import { inArray, sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  CAMPAIGN_TIMEZONE,
  formatInCampaignTimezone,
} from "@/lib/campaign-timezone";
import {
  fetchKeitaroClicks,
  KEITARO_VISIT_CAMPAIGN_NAME,
  type KeitaroReportRow,
} from "@/lib/keitaro/client";
import { stage_sends } from "@/db/schema";

export type Database = typeof db;

// Offer-page reach (Level 2). Mirrors the SALE poll (poll-conversions.ts) but
// reads CLICKS instead of conversions: an OFFER-campaign click (campaign name !=
// gk-lp-visits) carrying sub_id_1 = stage_sends.id means that recipient reached
// the offer page. We stamp stage_sends.offer_reached_at (+ offer_reach_event_id
// for dedup) the first time we see such a click. Reach is MONOTONIC — once
// stamped, never changed or cleared — so a row already carrying an event_id is
// skipped (no status progression, unlike sales).
//
// Window WIDER than the strict click latency because offer clicks can trail the
// landing click; re-reading stable older days is cheap and the stamp is
// idempotent (skip if offer_reach_event_id already set).
const DEFAULT_WINDOW_DAYS = 7;

export interface KeitaroOfferReachPollResult {
  ok: boolean;
  // false ⇒ the clicks fetch failed; rows were left untouched for next cycle.
  degraded: boolean;
  range: { from: string; to: string; timezone: string };
  fetched: number; // click rows returned by Keitaro (sub_id_1 non-empty)
  landing_skipped: number; // gk-lp-visits (Level-1) clicks dropped
  recipients: number; // distinct, valid sub_id_1 (offer clicks) after the fold
  matched: number; // recipients whose sub_id_1 mapped to a stage_sends row
  updated: number; // stage_sends rows newly stamped offer_reached_at
  deduped: number; // matched rows already marked reached (no write)
  unmatched: number; // sub_id_1 blank / not a UUID / no stage_sends row
  errored: number; // updates that threw
  unmatched_samples: string[]; // a few sub_id_1 values that didn't map back
  sample: KeitaroReportRow[]; // a few raw click rows (verbatim) for debugging
  error: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStr(row: KeitaroReportRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v.trim() : "";
}

// Is this click a landing-page VISIT (Level 1) rather than an OFFER reach
// (Level 2)? Classify by the campaign NAME (gk-lp-visits), trimmed +
// case-insensitive — same marker the aggregate clicks poll uses. clicks/log
// returns the campaign name directly, so no campaigns-list join is needed.
function isLandingClick(row: KeitaroReportRow): boolean {
  return (
    readStr(row, "campaign").toLowerCase() ===
    KEITARO_VISIT_CAMPAIGN_NAME.trim().toLowerCase()
  );
}

// Pull the rolling clicks window, drop landing (gk-lp-visits) clicks, fold to the
// EARLIEST offer click per recipient (sub_id_1 = stage_sends.id), and stamp each
// recipient's stage_sends row with offer_reached_at + the click event_id. Never
// throws: a fetch failure returns degraded; one bad update is counted and skipped.
export async function pollKeitaroOfferReaches(
  database: Database,
  opts?: { windowDays?: number },
): Promise<KeitaroOfferReachPollResult> {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const from = `${formatInCampaignTimezone(
    new Date(now.getTime() - (windowDays - 1) * 86_400_000),
    "yyyy-MM-dd",
  )} 00:00:00`;
  const to = formatInCampaignTimezone(now, "yyyy-MM-dd HH:mm:ss");
  const range = { from, to, timezone: CAMPAIGN_TIMEZONE };

  const base: KeitaroOfferReachPollResult = {
    ok: false,
    degraded: true,
    range,
    fetched: 0,
    landing_skipped: 0,
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

  const clicks = await fetchKeitaroClicks(range);
  if (!clicks.ok) {
    return { ...base, error: clicks.error };
  }

  const rows = clicks.rows;

  // Fold to the EARLIEST offer click per recipient. Keitaro emits
  // "YYYY-MM-DD HH:MM:SS", which sorts chronologically as a string.
  interface Pick {
    subId1: string;
    eventId: string;
    dt: string;
  }
  const earliest = new Map<string, Pick>();
  const unmatchedSamples = new Set<string>();
  let unmatched = 0;
  let landingSkipped = 0;

  for (const row of rows) {
    if (isLandingClick(row)) {
      landingSkipped++;
      continue; // Level 1, not Level 2
    }
    const subId1 = readStr(row, "sub_id_1");
    if (!subId1 || !UUID_RE.test(subId1)) {
      unmatched++;
      if (subId1 && unmatchedSamples.size < 10) unmatchedSamples.add(subId1);
      continue;
    }
    const dt = readStr(row, "datetime");
    const prev = earliest.get(subId1);
    if (!prev || (dt && dt < prev.dt)) {
      earliest.set(subId1, { subId1, eventId: readStr(row, "event_id"), dt });
    }
  }

  // Resolve which recipients exist, with their current offer_reach_event_id so
  // we can count matched / updated / deduped exactly and skip already-reached rows.
  const ids = [...earliest.keys()];
  const existing = new Map<string, string | null>();
  if (ids.length > 0) {
    const found = await database
      .select({
        id: stage_sends.id,
        offer_reach_event_id: stage_sends.offer_reach_event_id,
      })
      .from(stage_sends)
      .where(inArray(stage_sends.id, ids));
    for (const r of found) existing.set(r.id, r.offer_reach_event_id);
  }

  let matched = 0;
  let updated = 0;
  let deduped = 0;
  let errored = 0;

  for (const pick of earliest.values()) {
    if (!existing.has(pick.subId1)) {
      unmatched++;
      if (unmatchedSamples.size < 10) unmatchedSamples.add(pick.subId1);
      continue;
    }
    matched++;
    // Reach is monotonic: a row already marked reached is left untouched.
    if (existing.get(pick.subId1) != null) {
      deduped++;
      continue;
    }
    try {
      await database.execute(sql`
        UPDATE stage_sends
        SET offer_reached_at = (${pick.dt} || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz,
            offer_reach_event_id = ${pick.eventId || null}
        WHERE id = ${pick.subId1}::uuid
          AND offer_reached_at IS NULL
      `);
      updated++;
    } catch {
      errored++;
    }
  }

  return {
    ok: true,
    degraded: false,
    range,
    fetched: rows.length,
    landing_skipped: landingSkipped,
    recipients: earliest.size,
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
