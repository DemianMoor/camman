import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  ceilingBreached,
  countSentSince,
  resolve24hCap,
  resolveMinuteCap,
} from "@/lib/sends/circuit-breakers";
import { isOutsideSendWindow, type ProviderSendWindow } from "@/lib/quiet-hours";

// Phase 3 — backlog-stall detector. A catch-all safety net for ANY reason the
// send queue silently stops draining (head-of-line blocking, a wedged provider,
// a bad deploy, a pooler stall): it flags stages that SHOULD be sending right now
// but have made no send progress for a while. Independent of the specific
// failure — if messages sit undrained, this notices.
//
// Read-only. Meant to run on a slow cadence (the hourly Telegram cron) so a
// persistent stall nags ~hourly without spamming every 5-minute drain tick.

/**
 * Why a stage with undrained rows is sitting still.
 *
 * `stalled` is the alarm: nothing explains it, so something is wrong.
 * `rate_24h` / `rate_minute` are NOT alarms — the drain is refusing to claim
 * another batch because the provider is at a ceiling the operator configured
 * (`sms_providers.max_sends_per_24h` / `max_sends_per_minute`). That is a hold
 * ON PURPOSE, exactly like a paused provider or closed quiet hours, and the
 * whole point of this detector is to not cry wolf about those.
 */
export type StallHold = "stalled" | "rate_24h" | "rate_minute";

export interface StalledStage {
  stage_id: number;
  campaign: string;
  stage_number: number | null;
  label: string | null;
  tracking_id: string | null;
  provider_name: string | null;
  pending: number;
  last_sent: string | null; // ISO, or null if nothing ever sent
  materialized_at: string | null;
  hold: StallHold;
  /** Human detail for a ceiling hold, e.g. "30,038/30,000 in 24h". Null when stalled. */
  hold_detail: string | null;
}

interface StallRow extends Omit<StalledStage, "pending" | "last_sent" | "hold" | "hold_detail"> {
  org_id: string;
  provider_id: number | null;
  max_sends_per_24h: number | null;
  max_sends_per_minute: number | null;
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

export interface StageSendStats {
  pending: number;
  last_sent: string | null;
}

/**
 * Per-stage `pending` count and latest `sent_at`, for a SMALL list of stage ids.
 *
 * ⭐ THIS MUST STAY A GROUPED AGGREGATE OVER `stage_id = ANY(...)`, NOT A
 * CORRELATED SCALAR SUBQUERY IN THE CANDIDATE QUERY. That is not a style
 * preference — it is the fix for a full-day production outage (2026-08-27).
 *
 * `(SELECT max(ss.sent_at) FROM stage_sends ss WHERE ss.stage_id = s.id)` looks
 * harmless, but Postgres rewrites a bare `max()` into "walk an index on sent_at
 * backwards and stop at the first match". The only index leading with sent_at is
 * `stage_sends_sent_at_contact_idx`, so `stage_id` becomes a FILTER rather than
 * an index condition — and for a stage that has NEVER SENT there is no first
 * match, so it scans the entire index and returns nothing. Measured on prod with
 * 3.86M rows: 48s PER CANDIDATE ROW (1,846,869 rows removed by filter, 3.15M
 * buffers). Two never-sent candidates = 96s, which blew through the caller's
 * 60s maxDuration and silently killed every hourly Telegram report for a day.
 *
 * With `GROUP BY stage_id` the min/max index rewrite does not apply, so the
 * planner uses `stage_sends_stage_id_idx` as an Index Cond and touches only that
 * stage's rows: 3.7ms for the same two stages. The pathological plan is not
 * merely unlikely here, it is unreachable.
 *
 * Guarded by scripts/test-stall-detector-perf.ts.
 */
export async function stageSendStats(
  dbc: typeof db,
  stageIds: number[],
): Promise<Map<number, StageSendStats>> {
  const out = new Map<number, StageSendStats>();
  if (stageIds.length === 0) return out;
  // sql.join, NOT `${stageIds}` — Drizzle flattens a JS array in a sql template
  // into positional params and Postgres rejects it (42809/42804).
  const idList = sql.join(
    stageIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await dbc.execute(sql`
    SELECT ss.stage_id                                          AS stage_id,
           count(*) FILTER (WHERE ss.status = 'pending')::int   AS pending,
           max(ss.sent_at)                                      AS last_sent
    FROM stage_sends ss
    WHERE ss.stage_id IN (${idList})
    GROUP BY ss.stage_id
  `)) as unknown as { stage_id: number; pending: number; last_sent: string | null }[];
  for (const r of rows) {
    out.set(Number(r.stage_id), {
      pending: Number(r.pending ?? 0),
      last_sent: r.last_sent,
    });
  }
  return out;
}

// A stage is a stall CANDIDATE (per SQL) when it should be actively draining but
// hasn't sent anything in `thresholdMinutes`:
//   • active tracked campaign, approved, not archived, materialization COMPLETE,
//   • not missed, not lane-held (slip_hold), provider not paused,
//   • org sending on (sends_enabled) and not emergency-paused,
//   • released (sent_at set) OR due for first release (scheduled_at <= now),
//   • ELIGIBLE — materialized AND due AND released — more than the threshold
//     ago (the grace that lets a stage just coming due get going),
//   • has `pending` rows, and NO `sent` row in the trailing threshold window.
// The final in-window check (per-provider ET window) is applied in JS so a stage
// legitimately paused for quiet hours is NOT reported as stalled.
export async function findStalledStages(
  dbc: typeof db,
  opts: { now: Date; thresholdMinutes: number; orgId?: string },
): Promise<StalledStage[]> {
  const { now, thresholdMinutes, orgId } = opts;
  const nowIso = now.toISOString();
  const rows = (await dbc.execute(sql`
    SELECT s.id                AS stage_id,
           c.org_id            AS org_id,
           c.name              AS campaign,
           s.stage_number      AS stage_number,
           s.label             AS label,
           s.tracking_id       AS tracking_id,
           p.id                AS provider_id,
           p.name              AS provider_name,
           p.max_sends_per_24h    AS max_sends_per_24h,
           p.max_sends_per_minute AS max_sends_per_minute,
           s.materialized_at   AS materialized_at,
           p.send_window_weekday_start AS send_window_weekday_start,
           p.send_window_weekday_end   AS send_window_weekday_end,
           p.send_window_weekend_start AS send_window_weekend_start,
           p.send_window_weekend_end   AS send_window_weekend_end
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN org_settings os ON os.org_id = c.org_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      -- P7/P8: don't flag a campaign-paused stage as "stalled" (it's intentionally held).
      AND (c.send_paused IS NOT TRUE)
      AND s.send_approved = true
      AND s.archived_at IS NULL
      AND s.materialized_at IS NOT NULL
      -- ⭐ The grace runs from when the stage became ELIGIBLE TO DRAIN, not from
      -- when it was materialized. Materialization is a PRE-pass that now runs
      -- hours ahead of the send (150 min ahead for the stage that produced the
      -- false alarm on 2026-08-29; 205 of the 207 stages materialized in the
      -- prior 7 days led their scheduled_at by more than 30 min), so anchoring
      -- the grace on materialized_at alone spends all of it before the stage is
      -- even allowed to send. The instant scheduled_at passed, the stage was
      -- alarm-eligible, and the only thing still suppressing the alarm was "has
      -- a sent row in the trailing window" — which a stage that has NEVER sent
      -- cannot have until the drain physically reaches it. Four stages came due
      -- together at 14:00:00; the drain works due stages round-robin and the
      -- fourth got its first row out at 14:01:08, while this hourly cron
      -- (0 * * * *) ran in the 29-second gap after the third stage's first send.
      -- A fully healthy queue was reported as "2934 pending, never sent".
      --
      -- Same lesson as pacingHolds() below: a watchdog must reproduce the
      -- predicate of the thing it watches — here the drain's START condition, not
      -- only its stop conditions. sent_at (the fire-lock stamp) is in the
      -- GREATEST too, so a stage released with no scheduled_at gets the same
      -- grace from its release. materialized_at is NOT NULL above, so the
      -- COALESCEs make the expression total.
      AND GREATEST(
            s.materialized_at,
            COALESCE(s.scheduled_at, s.materialized_at),
            COALESCE(s.sent_at, s.materialized_at)
          ) < ${nowIso}::timestamptz - make_interval(mins => ${thresholdMinutes})
      AND s.schedule_missed_at IS NULL
      AND s.slip_hold_at IS NULL
      AND (p.send_paused IS NOT TRUE)
      -- Provider posture (0138). This detector's whole job is to suppress
      -- alarms for stages that are HELD ON PURPOSE — which is why every other
      -- hold predicate (campaign pause, provider pause, org switch, org
      -- emergency stop) already appears here. A provider switched off is
      -- exactly such a hold, so without this line turning one off would fire a
      -- stall alert for every stage it owns.
      AND (p.sends_enabled IS NOT FALSE)
      AND os.sends_enabled = true
      AND (os.sends_paused IS NOT TRUE)
      AND (s.sent_at IS NOT NULL OR (s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${nowIso}))
      AND EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'sent'
          AND ss.sent_at > ${nowIso}::timestamptz - make_interval(mins => ${thresholdMinutes})
      )
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.materialized_at ASC
  `)) as unknown as StallRow[];

  // Quiet-hours guard: a stage whose provider window is currently CLOSED is
  // legitimately holding, not stalled — drop it. Filter FIRST, then fetch
  // pending/last_sent for the survivors only (see stageSendStats).
  const inWindow = rows.filter((r) => {
    const cfg: ProviderSendWindow = {
      send_window_weekday_start: r.send_window_weekday_start,
      send_window_weekday_end: r.send_window_weekday_end,
      send_window_weekend_start: r.send_window_weekend_start,
      send_window_weekend_end: r.send_window_weekend_end,
    };
    return !isOutsideSendWindow(cfg, now);
  });

  const stats = await stageSendStats(
    dbc,
    inWindow.map((r) => r.stage_id),
  );
  const holds = await pacingHolds(dbc, inWindow);

  return inWindow.map((r) => {
    const hold = holds.get(r.stage_id);
    return {
      stage_id: r.stage_id,
      campaign: r.campaign,
      stage_number: r.stage_number,
      label: r.label,
      tracking_id: r.tracking_id,
      provider_name: r.provider_name,
      pending: stats.get(r.stage_id)?.pending ?? 0,
      last_sent: stats.get(r.stage_id)?.last_sent ?? null,
      materialized_at: r.materialized_at,
      hold: hold?.hold ?? "stalled",
      hold_detail: hold?.detail ?? null,
    };
  });
}

/**
 * Classify each candidate by whether its provider is currently AT a pacing
 * ceiling, using the drain's own predicate.
 *
 * ⭐ THIS MIRRORS lib/sends/drain.ts — `countSentSince(org, provider, window) >=
 * resolve*Cap(...)` is literally the condition that makes the drain break with
 * `stopReason = "rate_24h"` / `"rate_minute"`. Reproducing the drain's own test
 * is the point: the detector must agree with the thing it is describing, or it
 * reports "STALLED — check provider health" about a queue that is behaving
 * exactly as configured. That happened on 2026-08-27: Text Request sat at
 * 30,038 against a 30,000/24h ceiling, which read as 3,976 stalled messages.
 *
 * Counted per (org, provider) — the same grain the drain counts on — and once
 * per distinct pair, not per stage, so a provider owning ten stalled stages
 * costs one query. Providers with no ceiling configured resolve to the module
 * defaults, exactly as the drain resolves them.
 */
async function pacingHolds(
  dbc: typeof db,
  rows: StallRow[],
): Promise<Map<number, { hold: StallHold; detail: string }>> {
  const out = new Map<number, { hold: StallHold; detail: string }>();
  const pairs = new Map<string, StallRow>();
  for (const r of rows) {
    if (r.provider_id == null) continue;
    pairs.set(`${r.org_id}:${r.provider_id}`, r);
  }

  const verdicts = new Map<string, { hold: StallHold; detail: string }>();
  for (const [key, r] of pairs) {
    const providerId = r.provider_id as number;
    const cap24h = resolve24hCap(r.max_sends_per_24h);
    const sent24h = await countSentSince(dbc, r.org_id, providerId, 86_400);
    if (ceilingBreached(sent24h, cap24h)) {
      verdicts.set(key, {
        hold: "rate_24h",
        detail: `${sent24h.toLocaleString("en-US")}/${cap24h.toLocaleString("en-US")} in the last 24h`,
      });
      continue;
    }
    const minuteCap = resolveMinuteCap(r.max_sends_per_minute);
    const sent60 = await countSentSince(dbc, r.org_id, providerId, 60);
    if (ceilingBreached(sent60, minuteCap)) {
      verdicts.set(key, {
        hold: "rate_minute",
        detail: `${sent60.toLocaleString("en-US")}/${minuteCap.toLocaleString("en-US")} in the last minute`,
      });
    }
  }

  for (const r of rows) {
    if (r.provider_id == null) continue;
    const v = verdicts.get(`${r.org_id}:${r.provider_id}`);
    if (v) out.set(r.stage_id, v);
  }
  return out;
}

// Human-readable Telegram alert body for a non-empty stall list. Caller decides
// whether to send (only when the list is non-empty).
function stageLine(s: StalledStage, now: Date): string {
  const stageBit = s.stage_number != null ? `stage ${s.stage_number}` : `stage id ${s.stage_id}`;
  const labelBit = s.label ? ` "${s.label}"` : "";
  const trackBit = s.tracking_id ? ` [${s.tracking_id}]` : "";
  const lastBit = s.last_sent
    ? `last send ${Math.round((now.getTime() - new Date(s.last_sent).getTime()) / 60000)}m ago`
    : "never sent";
  return `• "${s.campaign}" · ${stageBit}${labelBit}${trackBit} — ${s.pending} pending, ${lastBit} (${s.provider_name ?? "?"})`;
}

/** Stages whose non-drain is unexplained — the only ones worth an alarm. */
export function trulyStalled(stages: StalledStage[]): StalledStage[] {
  return stages.filter((s) => s.hold === "stalled");
}

/**
 * Alert body. Caller sends only when `trulyStalled()` is non-empty.
 *
 * Stages held at a provider's pacing ceiling are NEVER the reason an alert
 * fires — they are working as configured — but when an alert does fire they are
 * listed underneath, named, so the operator sees the whole queue rather than a
 * partial picture that invites the wrong diagnosis.
 */
export function formatStallAlert(stages: StalledStage[], now: Date, thresholdMinutes: number): string {
  const stalled = trulyStalled(stages);
  const capped = stages.filter((s) => s.hold !== "stalled");
  const totalPending = stalled.reduce((n, s) => n + s.pending, 0);
  const lines = stalled.slice(0, 15).map((s) => stageLine(s, now));
  const more = stalled.length > 15 ? `\n…and ${stalled.length - 15} more.` : "";

  let msg =
    `⚠️ Send queue STALLED — ${stalled.length} stage(s), ${totalPending} message(s) not draining ` +
    `(no send in ${thresholdMinutes}m, in-window, provider not paused).\n` +
    lines.join("\n") +
    more +
    `\nCheck the send-scheduled cron / provider health. This is the backlog-stall safety net.`;

  if (capped.length > 0) {
    const cappedPending = capped.reduce((n, s) => n + s.pending, 0);
    // One line per provider — the ceiling is a provider fact, not a stage fact,
    // so N stages behind one exhausted provider must not read as N problems.
    const byProvider = new Map<string, { stages: number; pending: number; detail: string }>();
    for (const s of capped) {
      const k = `${s.provider_name ?? "?"} (${s.hold === "rate_24h" ? "24h cap" : "per-minute cap"})`;
      const prev = byProvider.get(k) ?? { stages: 0, pending: 0, detail: s.hold_detail ?? "" };
      byProvider.set(k, { stages: prev.stages + 1, pending: prev.pending + s.pending, detail: prev.detail });
    }
    msg +=
      `\n\nNot stalled — held at a pacing ceiling (${capped.length} stage(s), ` +
      `${cappedPending} message(s) waiting, will resume on their own):\n` +
      [...byProvider.entries()]
        .map(([k, v]) => `• ${k} — ${v.stages} stage(s), ${v.pending} pending · ${v.detail}`)
        .join("\n");
  }
  return msg;
}
