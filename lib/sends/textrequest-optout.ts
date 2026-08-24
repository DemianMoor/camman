import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/textrequest-dlr";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import {
  checkOptOutRateBreaker,
  type OptOutRateCheckResult,
} from "@/lib/sends/optout-rate-breaker";
import { latestSendForAttribution } from "@/lib/sends/poll-opt-outs";
import { textrequestPhoneToE164 } from "@/lib/sends/providers/textrequest";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";
import { closeJourneyOnOptOut } from "@/lib/drip/lifecycle";

// Text Request opt-out intake (Phase 4) — the single write path behind all six
// capture channels. Deliberately a mirror of processAhoiInboundOptOut
// (lib/sends/ahoi-optout.ts): same contact upsert, same opt_outs insert, same
// cascade-cancel of pending sends, same attribution helper, same stage counters,
// same campaign opt-out-rate breaker. Divergences from Ahoi are only where Text
// Request's signals genuinely differ, and each one is called out below.

// The six capture channels (textrequest_inbound_events.source). Split into two
// SHAPES, which is the distinction the logic actually turns on:
//
//  MESSAGE-shaped — an inbound SMS whose text we must classify ourselves:
//    webhook_msg_received, poll_messages
//  STATE-shaped — Text Request telling us the contact IS opted out. The fact is
//    authoritative, there is no text to match, and it can be re-observed
//    indefinitely (the contact stays opted out forever):
//    webhook_contact_updated, poll_contacts, dlr, send_reject
export type TxrOptOutChannel =
  | "webhook_msg_received"
  | "poll_messages"
  | "webhook_contact_updated"
  | "poll_contacts"
  | "dlr"
  | "send_reject";

const MESSAGE_SHAPED: ReadonlySet<TxrOptOutChannel> = new Set([
  "webhook_msg_received",
  "poll_messages",
]);

export function isMessageShapedChannel(channel: TxrOptOutChannel): boolean {
  return MESSAGE_SHAPED.has(channel);
}

// opt_outs.source tag per channel — the suppression's provenance, kept distinct
// per channel so reporting can tell a real-time STOP from a backstop catch.
// (opt_outs.source is free text; `reason` is the CHECK-constrained column.)
const OPT_OUT_SOURCE: Record<TxrOptOutChannel, string> = {
  webhook_msg_received: "textrequest_inbound_webhook",
  poll_messages: "textrequest_messages_poll",
  webhook_contact_updated: "textrequest_contact_webhook",
  poll_contacts: "textrequest_contacts_poll",
  dlr: "textrequest_dlr_optout",
  send_reject: "textrequest_send_reject",
};

// Cross-channel dedup window. Matches Ahoi's 45 minutes for the same reason:
// the poll cadence (15 min) plus a missed tick plus margin, so a webhook STOP
// and its later polled twin land in one window without being wide enough to
// conflate two genuinely separate STOP replies.
//
// SMALLER JOB HERE THAN IN AHOI: for message-shaped signals Text Request gives
// both channels the SAME message GUID, so duplicate capture is already blocked
// by the unique index on (provider_id, provider_uuid) (migration 0124) — the
// second channel never even reaches this code. This window therefore only has to
// catch CROSS-SHAPE duplicates: a STOP reply (message) and Text Request's own
// contact_updated for the same person (state), which share no identifier.
export const TXR_OPTOUT_DEDUP_WINDOW_MINUTES = 45;

// TR does not mangle message text between channels (Ahoi's CDR export strips
// commas and appends a segment marker, which is why normalizeAhoiMessageForDedup
// is source-aware). So normalization here is the plain form, and — critically —
// a null message (every state-shaped signal) is a WILDCARD: state and message
// signals about the same number in the same window are the same physical
// opt-out, and treating them as one is correct, not a lost event.
function normalizeTxrMessage(msg: string | null): string {
  return (msg ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DuplicateTxrInbound {
  event_id: string;
  source: string;
  matched_contact_id: string;
  matched_stage_send_id: string | null;
}

export async function findDuplicateTxrInbound(
  dbc: DbOrTx,
  opts: {
    orgId: string;
    sourceNumber: string;
    message: string | null;
    excludeEventId: string;
    anchor: Date;
    windowMinutes?: number;
  },
): Promise<DuplicateTxrInbound | null> {
  const windowMin = opts.windowMinutes ?? TXR_OPTOUT_DEDUP_WINDOW_MINUTES;
  const anchorIso = opts.anchor.toISOString();
  const rows = (await dbc.execute(sql`
    SELECT id, source, message, matched_contact_id, matched_stage_send_id
    FROM textrequest_inbound_events
    WHERE org_id = ${opts.orgId}
      AND source_number = ${opts.sourceNumber}
      AND result = 'suppressed'
      AND matched_contact_id IS NOT NULL
      AND id != ${opts.excludeEventId}
      AND received_at BETWEEN ${anchorIso}::timestamptz - (${windowMin} * interval '1 minute')
                           AND ${anchorIso}::timestamptz + (${windowMin} * interval '1 minute')
    ORDER BY received_at ASC
  `)) as unknown as {
    id: string;
    source: string;
    message: string | null;
    matched_contact_id: string;
    matched_stage_send_id: string | null;
  }[];
  const target = normalizeTxrMessage(opts.message);
  const hit = rows.find((r) => {
    const prior = normalizeTxrMessage(r.message);
    // Either side lacking text ⇒ same-fact match (see normalizeTxrMessage).
    if (!prior || !target) return true;
    return prior === target;
  });
  return hit
    ? {
        event_id: hit.id,
        source: hit.source,
        matched_contact_id: hit.matched_contact_id,
        matched_stage_send_id: hit.matched_stage_send_id,
      }
    : null;
}

export interface ProcessTxrOptOutOpts {
  eventId: string;
  orgId: string;
  // The CONTACT's number as Text Request sends it (11-digit, no '+').
  sourceNumber: string | null;
  // Message text for message-shaped channels; null for state-shaped ones.
  message: string | null;
  channel: TxrOptOutChannel;
  receivedAt: Date;
}

export type ProcessTxrOptOutOutcome =
  | { kind: "ignored" }
  | { kind: "invalid_phone" }
  | { kind: "duplicate"; contactId: string }
  | { kind: "already_opted_out"; contactId: string }
  | {
      kind: "suppressed";
      contactId: string;
      attributed: boolean;
      // Set when this opt-out tripped the campaign opt-out-rate breaker — the
      // caller fires the Telegram alert post-commit.
      breakerTrip: { campaignId: number; result: OptOutRateCheckResult } | null;
    };

export async function processTextrequestOptOut(
  dbc: DbOrTx,
  o: ProcessTxrOptOutOpts,
): Promise<ProcessTxrOptOutOutcome> {
  const stamp = (result: string, extra?: { contactId?: string; stageSendId?: string | null }) =>
    dbc.execute(sql`
      UPDATE textrequest_inbound_events
      SET result = ${result},
          processed_at = now(),
          matched_contact_id = COALESCE(${extra?.contactId ?? null}::uuid, matched_contact_id),
          matched_stage_send_id = COALESCE(${extra?.stageSendId ?? null}::uuid, matched_stage_send_id)
      WHERE id = ${o.eventId} AND org_id = ${o.orgId}
    `);

  // Message-shaped signals must clear the keyword gate — an inbound "thanks" is
  // not an opt-out. State-shaped signals skip it: Text Request has already told
  // us the contact is opted out, and there is no text to judge.
  if (isMessageShapedChannel(o.channel) && !isOptOutKeyword(o.message ?? "")) {
    await stamp("ignored");
    return { kind: "ignored" };
  }

  const phone = textrequestPhoneToE164(o.sourceNumber);
  if (!phone) {
    await stamp("invalid_phone");
    return { kind: "invalid_phone" };
  }

  const dup = await findDuplicateTxrInbound(dbc, {
    orgId: o.orgId,
    sourceNumber: o.sourceNumber!,
    message: o.message,
    excludeEventId: o.eventId,
    anchor: o.receivedAt,
  });
  if (dup) {
    // Expected and benign — logged (not alerted) so the dedup rate stays
    // greppable in production, exactly as the Ahoi path does.
    console.warn(
      `[textrequest-optout] cross-channel duplicate opt-out caught (deduped) — org=${o.orgId} ` +
        `number=${o.sourceNumber} this_event=${o.eventId} (${o.channel}) prior_event=${dup.event_id} ` +
        `(${dup.source}); suppression already recorded, skipping second opt_out + attribution`,
    );
    await stamp("duplicate", { contactId: dup.matched_contact_id, stageSendId: dup.matched_stage_send_id });
    return { kind: "duplicate", contactId: dup.matched_contact_id };
  }

  // Upsert the contact — a suppression must stick even for a number that isn't
  // a contact yet (same rule as TextHub's and Ahoi's intake).
  const c = (await dbc.execute(sql`
    INSERT INTO contacts (org_id, phone_number)
    VALUES (${o.orgId}, ${phone})
    ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
    RETURNING id
  `)) as unknown as { id: string }[];
  const contactId = c[0]!.id;

  // NOT IN THE AHOI PATH, and the reason matters: a state-shaped signal is a
  // FLAG, not an event. `has_opted_out=true` returns a contact on every poll
  // tick for the rest of time, and contact_updated re-fires on any contact edit.
  // Writing an opt_outs row each time would inflate the opt-out counts and, far
  // worse, re-attribute a months-old opt-out to whatever send happens to be
  // recent. So a state signal acts ONCE: if this number is already suppressed,
  // stop here. Message-shaped signals keep the Ahoi/TextHub semantics (one row
  // per STOP event, deduped only by the window above), so a genuine second STOP
  // is still recorded and attributed.
  if (!isMessageShapedChannel(o.channel)) {
    const existing = (await dbc.execute(sql`
      SELECT id FROM opt_outs WHERE org_id = ${o.orgId} AND contact_id = ${contactId} LIMIT 1
    `)) as unknown as { id: number }[];
    if (existing.length > 0) {
      await stamp("already_opted_out", { contactId });
      return { kind: "already_opted_out", contactId };
    }
  }

  // created_at = when the opt-out actually happened, so report buckets and
  // attributions agree on the day (same reasoning as poll-opt-outs.ts).
  const anchorIso = o.receivedAt.toISOString();
  const oo = (await dbc.execute(sql`
    INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
    VALUES (${o.orgId}, ${contactId}, ${phone}, ${OPT_OUT_SOURCE[o.channel]}, ${anchorIso}::timestamptz)
    RETURNING id
  `)) as unknown as { id: number }[];
  const optOutId = oo[0]!.id;

  // Cascade-cancel any not-yet-sent rows for this contact so a STOP arriving
  // before a stage drains is honored immediately rather than at the drain's
  // send-time re-check. Terminal 'skipped_opted_out' + 'opt_out_cancel' is the
  // same distinct bucket TextHub's poller and the drain guard use.
  await dbc.execute(sql`
    UPDATE stage_sends
    SET status = 'skipped_opted_out', last_error = 'opt_out_cancel'
    WHERE org_id = ${o.orgId} AND contact_id = ${contactId}
      AND status = 'pending'
  `);
  // Drip Phase 6: the journey closes in the SAME breath as the cascade.
  // A lead suppressed but still 'active' would hold its one-live-per-contact
  // slot for ever -- the exact state the Phase 5 proof caught.
  await closeJourneyOnOptOut(dbc, { orgId: o.orgId, contactId });

  // Attribution: the shared cross-provider helper — one opt-out credits the
  // single most-recent matching send across all stages in the trailing window.
  // null ⇒ unattributed; the org-wide suppression still stands.
  const match = await latestSendForAttribution(dbc, o.orgId, phone, anchorIso);
  let attributed = false;
  let matchedStageSendId: string | null = null;
  let breakerTrip: { campaignId: number; result: OptOutRateCheckResult } | null = null;
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
      // Re-evaluate the campaign opt-out rate and latch the per-campaign pause
      // in-tx if it spiked. Telegram fires post-commit in the caller.
      const breaker = await checkOptOutRateBreaker(dbc, {
        orgId: o.orgId,
        campaignId: match.campaign_id,
        stageId: match.stage_id,
      });
      if (breaker.tripped) breakerTrip = { campaignId: match.campaign_id, result: breaker };
    }
  }

  await stamp("suppressed", { contactId, stageSendId: matchedStageSendId });
  return { kind: "suppressed", contactId, attributed, breakerTrip };
}

export interface CaptureTxrInboundOpts {
  orgId: string;
  credentialId: number | null;
  providerId: number | null;
  channel: TxrOptOutChannel;
  method: string;
  sourceNumber: string | null;
  destinationNumber: string | null;
  message: string | null;
  // TR's message GUID where the signal has one — the cross-channel idempotency
  // key. Pass null for contact-shaped signals.
  providerUuid: string | null;
  optedOutUtc: Date | null;
  rawBody: string | null;
  receivedAt?: Date;
}

// Append-only capture. Returns null when the row already existed (same
// provider_uuid on another channel) so the caller can skip processing — the
// suppression was already handled when that first row was processed.
export async function captureTxrInboundEvent(
  dbc: DbOrTx,
  o: CaptureTxrInboundOpts,
): Promise<{ id: string } | null> {
  const rows = (await dbc.execute(sql`
    INSERT INTO textrequest_inbound_events
      (org_id, credential_id, provider_id, source, source_number, destination_number,
       message, provider_uuid, opted_out_utc, method, raw_body, received_at)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, ${o.channel}, ${o.sourceNumber},
            ${o.destinationNumber}, ${o.message}, ${o.providerUuid},
            ${o.optedOutUtc ? o.optedOutUtc.toISOString() : null}::timestamptz, ${o.method}, ${o.rawBody},
            ${(o.receivedAt ?? new Date()).toISOString()}::timestamptz)
    ON CONFLICT (provider_id, provider_uuid) WHERE provider_uuid IS NOT NULL DO NOTHING
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows[0] ? { id: rows[0].id } : null;
}
