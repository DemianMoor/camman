import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/ahoi-dlr";
import { ahoiSourceToE164 } from "@/lib/sends/providers/ahoi";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import { latestSendForAttribution } from "@/lib/sends/poll-opt-outs";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

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

export interface ProcessAhoiInboundOptOutOpts {
  eventId: string;
  orgId: string;
  sourceNumber: string; // 10-digit, from InboundEvent.source (webhook) or the CDR row's src
  message: string;
  // opt_outs.source tag — the CHANNEL (Layer) this event came through. Not to
  // be confused with ahoi_inbound_events.source, which is the channel
  // discriminator column ('webhook'/'cdr') — same underlying fact, different
  // column, named distinctly here to avoid the two colliding in code.
  optOutSource: "ahoi_inbound_webhook" | "ahoi_cdr";
  receivedAt: Date;
}

export type ProcessAhoiInboundOptOutOutcome =
  | { kind: "ignored" }
  | { kind: "invalid_phone" }
  | { kind: "duplicate"; contactId: string }
  | { kind: "suppressed"; contactId: string; attributed: boolean };

// Layer 1 (inbound webhook) + Layer 2 (CDR poll) shared core (spec §6). Both
// channels observe the same kind of signal — "someone replied with a
// STOP-class message" — so they share this one pipeline, distinguished only
// by optOutSource and by which ahoi_inbound_events.source wrote the captured
// row. Mirrors lib/sends/poll-opt-outs.ts's TextHub logic (upsert contact ->
// opt_outs -> attribution) as closely as the schema allows — reused
// (latestSendForAttribution, recomputeStageTotalCost), not forked.
export async function processAhoiInboundOptOut(
  dbc: DbOrTx,
  o: ProcessAhoiInboundOptOutOpts,
): Promise<ProcessAhoiInboundOptOutOutcome> {
  const isStop = isOptOutKeyword(o.message);
  if (!isStop) {
    await dbc.execute(sql`
      UPDATE ahoi_inbound_events SET result = 'ignored', processed_at = now()
      WHERE id = ${o.eventId} AND org_id = ${o.orgId}
    `);
    return { kind: "ignored" };
  }

  // CARRY 2: normalize BEFORE both the dedup lookup key comparison would need
  // it and the contact match/upsert below — ahoiSourceToE164 is the single
  // entry point for "Ahoi wire format -> our storage format".
  const phone = ahoiSourceToE164(o.sourceNumber);
  if (!phone) {
    await dbc.execute(sql`
      UPDATE ahoi_inbound_events SET result = 'invalid_phone', processed_at = now()
      WHERE id = ${o.eventId} AND org_id = ${o.orgId}
    `);
    return { kind: "invalid_phone" };
  }

  // ahoi_inbound_events.source ('webhook'/'cdr') channel discriminator,
  // derived from optOutSource (same underlying fact — see the field comment
  // above). findDuplicateAhoiInbound needs this to know whether THIS event's
  // message needs the CDR " - <n>" suffix stripped before comparison.
  const channel = o.optOutSource === "ahoi_cdr" ? "cdr" : "webhook";

  // CARRY 1: cross-channel dedup BEFORE writing anything. A single physical
  // STOP is captured independently by the webhook (real-time) and the CDR
  // poll (up to a poll-cadence later, covered by the 45-min window) — dedupe
  // on (org, source_number, normalized message, time window), never on
  // provider_uuid (webhook rows have none)
  // or a would-be new opt_out_id (that's a NEW row every time, which is
  // exactly the bug this prevents). See findDuplicateAhoiInbound for the
  // key/window/normalization rationale.
  const dup = await findDuplicateAhoiInbound(dbc, {
    orgId: o.orgId, sourceNumber: o.sourceNumber, message: o.message,
    source: channel, excludeEventId: o.eventId, anchor: o.receivedAt,
  });
  if (dup) {
    // Observable-by-design: log every caught cross-channel duplicate (expected
    // + benign — NOT a Telegram alert). Records both event ids/channels so the
    // dedup rate is greppable in production logs.
    console.warn(
      `[ahoi-optout] cross-channel duplicate STOP caught (deduped) — org=${o.orgId} ` +
        `source_number=${o.sourceNumber} this_event=${o.eventId} (${o.optOutSource}) ` +
        `prior_event=${dup.event_id} (${dup.source}); suppression already recorded, ` +
        `skipping second opt_out + attribution`,
    );
    await dbc.execute(sql`
      UPDATE ahoi_inbound_events
      SET result = 'duplicate', matched_contact_id = ${dup.matched_contact_id},
          matched_stage_send_id = ${dup.matched_stage_send_id}, processed_at = now()
      WHERE id = ${o.eventId} AND org_id = ${o.orgId}
    `);
    return { kind: "duplicate", contactId: dup.matched_contact_id };
  }

  // Upsert the contact (mirrors TextHub's poll-opt-outs.ts exactly) — a STOP
  // must suppress the number even if it isn't an existing contact yet
  // (spec §6 decision (a), G6).
  const c = (await dbc.execute(sql`
    INSERT INTO contacts (org_id, phone_number)
    VALUES (${o.orgId}, ${phone})
    ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
    RETURNING id
  `)) as unknown as { id: string }[];
  const contactId = c[0]!.id;

  // created_at = the STOP's real receipt time, matching TextHub's own
  // reasoning (poll-opt-outs.ts): report buckets and opt_out_attributions
  // must agree on the day it actually happened, not when we processed it.
  const anchorIso = o.receivedAt.toISOString();
  const oo = (await dbc.execute(sql`
    INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
    VALUES (${o.orgId}, ${contactId}, ${phone}, ${o.optOutSource}, ${anchorIso}::timestamptz)
    RETURNING id
  `)) as unknown as { id: number }[];
  const optOutId = oo[0]!.id;

  // Attribution: the SAME cross-provider helper TextHub's poller uses — one
  // STOP credits the single most-recent matching send across ALL stages
  // (any provider) in the trailing window. null -> unattributed, org-wide
  // opt-out still stands.
  const match = await latestSendForAttribution(dbc, o.orgId, phone, anchorIso);
  let attributed = false;
  let matchedStageSendId: string | null = null;
  if (match) {
    matchedStageSendId = match.stage_send_id;
    const ins = (await dbc.execute(sql`
      INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
      VALUES (${o.orgId}, ${optOutId}, ${match.stage_send_id}, ${match.stage_id}, ${match.campaign_id}, ${anchorIso}::timestamptz)
      ON CONFLICT (opt_out_id, stage_id) DO NOTHING
      RETURNING id
    `)) as unknown as { id: number }[];
    if (ins.length > 0) {
      attributed = true;
      await dbc.execute(sql`
        UPDATE campaign_stages
        SET inbound_opt_out_count = inbound_opt_out_count + 1,
            opt_out_count = inbound_opt_out_count + 1
        WHERE id = ${match.stage_id}
      `);
      await recomputeStageTotalCost(dbc, match.stage_id);
    }
  }

  await dbc.execute(sql`
    UPDATE ahoi_inbound_events
    SET result = 'suppressed', matched_contact_id = ${contactId},
        matched_stage_send_id = ${matchedStageSendId}, processed_at = now()
    WHERE id = ${o.eventId} AND org_id = ${o.orgId}
  `);

  return { kind: "suppressed", contactId, attributed };
}
