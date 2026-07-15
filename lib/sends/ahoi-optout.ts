import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/ahoi-dlr";

// CARRY 1: a single physical STOP is captured independently by the inbound
// webhook (real-time) and the CDR poll (*/15, up to ~15min later) — two
// ahoi_inbound_events rows, no shared identity (webhook rows have no
// provider_uuid to key on). Dedup on (org_id, source_number,
// NORMALIZED message, time window) against rows already fully processed
// (result='suppressed') instead.
//
// Window rationale: the CDR poll cadence is 15 minutes (Section 3). 45
// minutes survives even a MISSED CDR poll tick (15-min cadence + one skipped
// tick + margin) so a webhook STOP and its later CDR twin still fall in the
// same window, without being so wide it risks conflating two genuinely
// separate STOP replies from the same number as one event.
//
// Message MUST be normalized: the CDR export represents the SAME text
// DIFFERENTLY from the webhook — it STRIPS COMMAS and APPENDS a segment
// marker (Phase 0 recon), so the webhook's "Stop" arrives in the CDR as
// "Stop - 1" (or "... - 2 of 2" for a multi-segment message). A naive
// message = message equality would DEFEAT the dedup. normalizeAhoiMessage-
// ForDedup reconciles both representations; the comparison is
// normalized-to-normalized on BOTH sides (done in JS below, not SQL, since
// the candidate set for one (org, number, window) is tiny).
//
// NOT a DB constraint or pg_advisory_xact_lock: no natural shared identity
// exists to constrain on, and advisory locks are a documented anti-pattern
// in this codebase under the transaction pooler (see lib/cron/lease.ts). The
// residual race (both channels processing the exact same event in the same
// instant) is accepted as rare and harmless — worst case one redundant
// opt_out_attributions credit, never a suppression miss. When the guard DOES
// catch a duplicate the caller logs it (processAhoiInboundOptOut) so the
// dedup is observable in production.
export const AHOI_OPTOUT_DEDUP_WINDOW_MINUTES = 45;

// Reconcile the webhook vs CDR message representations to a comparable form.
// SOURCE-AWARE: the trailing " - <n>" / " - <n> of <m>" segment marker is
// ALWAYS appended by the CDR export and NEVER present in a webhook payload —
// so stripping it unconditionally corrupts real message content that happens
// to end in "<word>-<digits>" (e.g. webhook "Stop order 555-1234" would lose
// "-1234"). Only CDR-sourced text gets the marker stripped; webhook text is
// never touched by that regex. Both sources still get: commas removed (CDR
// strips them), whitespace collapsed, trimmed, lowercased. Pure.
export function normalizeAhoiMessageForDedup(
  msg: string | null,
  source: string,
): string {
  if (!msg) return "";
  let out = msg;
  if (source === "cdr") {
    out = out.replace(/\s*-\s*\d+(?:\s+of\s+\d+)?\s*$/i, ""); // drop CDR segment suffix
  }
  return out
    .replace(/,/g, "")    // CDR strips commas
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .toLowerCase();
}

export interface DuplicateAhoiInbound {
  event_id: string;             // the PRIOR row's id (for the dedup log line)
  source: string;               // the PRIOR row's channel ('webhook' | 'cdr')
  matched_contact_id: string;
  matched_stage_send_id: string | null;
}

export async function findDuplicateAhoiInbound(
  dbc: DbOrTx,
  opts: {
    orgId: string;
    sourceNumber: string;
    message: string;
    source: string;
    excludeEventId: string;
    anchor: Date;
    windowMinutes?: number;
  },
): Promise<DuplicateAhoiInbound | null> {
  const windowMin = opts.windowMinutes ?? AHOI_OPTOUT_DEDUP_WINDOW_MINUTES;
  const anchorIso = opts.anchor.toISOString();
  // Fetch the (tiny) candidate set by org/number/window, then match on the
  // NORMALIZED message in JS — SQL-side normalization of the stored `message`
  // column would need a fragile regexp_replace chain to mirror the helper.
  const rows = (await dbc.execute(sql`
    SELECT id, source, message, matched_contact_id, matched_stage_send_id
    FROM ahoi_inbound_events
    WHERE org_id = ${opts.orgId}
      AND source_number = ${opts.sourceNumber}
      AND result = 'suppressed'
      AND matched_contact_id IS NOT NULL
      AND id != ${opts.excludeEventId}
      AND received_at BETWEEN ${anchorIso}::timestamptz - (${windowMin} * interval '1 minute')
                           AND ${anchorIso}::timestamptz + (${windowMin} * interval '1 minute')
    ORDER BY received_at ASC
  `)) as unknown as {
    id: string; source: string; message: string | null;
    matched_contact_id: string; matched_stage_send_id: string | null;
  }[];
  const target = normalizeAhoiMessageForDedup(opts.message, opts.source);
  const hit = rows.find(
    (r) => normalizeAhoiMessageForDedup(r.message, r.source) === target,
  );
  return hit
    ? {
        event_id: hit.id,
        source: hit.source,
        matched_contact_id: hit.matched_contact_id,
        matched_stage_send_id: hit.matched_stage_send_id,
      }
    : null;
}
