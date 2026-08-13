import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/textrequest-dlr";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import {
  checkOptOutRateBreaker,
  type OptOutRateCheckResult,
} from "@/lib/sends/optout-rate-breaker";
import { latestSendForAttribution } from "@/lib/sends/poll-opt-outs";
import { tellsPhoneToE164 } from "@/lib/sends/providers/tells";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

// Tells opt-out intake (Phase 3) — the ONLY automated STOP path for this
// provider. Deliberately a mirror of processTextrequestOptOut
// (lib/sends/textrequest-optout.ts): same keyword gate, same contact upsert,
// same opt_outs insert, same cascade-cancel, same shared attribution helper,
// same stage counters, same campaign opt-out-rate breaker.
//
// Two structural simplifications vs Text Request, both because Tells has
// exactly ONE inbound channel (its webhook) rather than six:
//
//   1. No channel discriminator. Every Tells inbound signal is MESSAGE-shaped —
//      an SMS whose text we classify ourselves. Tells has no "contact is opted
//      out" state signal and no poll, so the state-shaped branch (and its
//      "act once" guard) has no analogue here.
//   2. No cross-channel dedup. There is no second channel to collide with.
//
// ⚠️ But it keeps a WINDOW GUARD anyway, and that is a deliberate divergence:
// the capture-level dedup index for inbound keys on
// (From, To, sha256(Body), Date) — and unlike the DLR key, it HAS to include
// `Date`, or two genuinely separate STOPs from the same number would collapse
// into one. Phase 0 proved `Date` advances on retry for DLRs; whether an
// inbound redelivery re-stamps it was never observed. If it does, a retried
// STOP lands as a second row with a different dedup_key, and without this guard
// that becomes a second opt_out row, a second attribution, an inflated stage
// counter, and a nudge toward the opt-out-rate breaker. Suppression itself is
// idempotent, so the guard costs nothing when the index already did its job.

// opt_outs.source tag — the suppression's provenance. (opt_outs.source is free
// text; `reason` is the CHECK-constrained column.)
const TELLS_OPT_OUT_SOURCE = "tells_inbound_webhook";

// Same 45 minutes as the Ahoi and Text Request paths, for the same reason:
// wide enough to absorb a retry storm (Tells retries 4× over ~3 minutes),
// nowhere near wide enough to conflate two genuinely separate STOP replies.
export const TELLS_OPTOUT_DEDUP_WINDOW_MINUTES = 45;

function normalizeTellsMessage(msg: string | null): string {
  return (msg ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DuplicateTellsInbound {
  event_id: string;
  matched_contact_id: string;
  matched_stage_send_id: string | null;
}

// A prior SUPPRESSED inbound from the same number with the same text inside the
// window ⇒ this is a redelivery of that STOP, not a new one.
export async function findDuplicateTellsInbound(
  dbc: DbOrTx,
  opts: {
    orgId: string;
    fromNumber: string;
    body: string | null;
    excludeEventId: string;
    anchor: Date;
    windowMinutes?: number;
  },
): Promise<DuplicateTellsInbound | null> {
  const windowMin = opts.windowMinutes ?? TELLS_OPTOUT_DEDUP_WINDOW_MINUTES;
  const anchorIso = opts.anchor.toISOString();
  const rows = (await dbc.execute(sql`
    SELECT id, body, matched_contact_id, matched_stage_send_id
    FROM tells_webhook_events
    WHERE org_id = ${opts.orgId}
      AND kind = 'inbound'
      AND from_number = ${opts.fromNumber}
      AND result = 'suppressed'
      AND matched_contact_id IS NOT NULL
      AND id != ${opts.excludeEventId}
      AND received_at BETWEEN ${anchorIso}::timestamptz - (${windowMin} * interval '1 minute')
                           AND ${anchorIso}::timestamptz + (${windowMin} * interval '1 minute')
    ORDER BY received_at ASC
  `)) as unknown as {
    id: string;
    body: string | null;
    matched_contact_id: string;
    matched_stage_send_id: string | null;
  }[];
  const target = normalizeTellsMessage(opts.body);
  const hit = rows.find((r) => normalizeTellsMessage(r.body) === target);
  return hit
    ? {
        event_id: hit.id,
        matched_contact_id: hit.matched_contact_id,
        matched_stage_send_id: hit.matched_stage_send_id,
      }
    : null;
}

export interface ProcessTellsOptOutOpts {
  eventId: string;
  orgId: string;
  // The CONTACT's number, verbatim from the payload (`From`, an 11-digit value
  // that arrives as a JSON NUMBER — already coerced to text at extraction).
  fromNumber: string | null;
  body: string | null;
  receivedAt: Date;
}

export type ProcessTellsOptOutOutcome =
  | { kind: "ignored" }
  | { kind: "invalid_phone" }
  | { kind: "duplicate"; contactId: string }
  | {
      kind: "suppressed";
      contactId: string;
      attributed: boolean;
      breakerTrip: { campaignId: number; result: OptOutRateCheckResult } | null;
    };

export async function processTellsOptOut(
  dbc: DbOrTx,
  o: ProcessTellsOptOutOpts,
): Promise<ProcessTellsOptOutOutcome> {
  const stamp = (result: string, extra?: { contactId?: string; stageSendId?: string | null }) =>
    dbc.execute(sql`
      UPDATE tells_webhook_events
      SET result = ${result},
          processed_at = now(),
          process_attempts = process_attempts + 1,
          matched_contact_id = COALESCE(${extra?.contactId ?? null}::uuid, matched_contact_id),
          matched_stage_send_id = COALESCE(${extra?.stageSendId ?? null}::uuid, matched_stage_send_id)
      WHERE id = ${o.eventId} AND org_id = ${o.orgId}
    `);

  // THE KEYWORD GATE. Every Tells inbound is message-shaped, so everything runs
  // through the SHARED isOptOutKeyword (lib/sends/opt-out-keywords.ts) — the
  // same function TextHub, Ahoi and Text Request use. No Tells-specific keyword
  // list, so the definition of "this is a STOP" cannot drift per provider.
  //
  // It matches on the FIRST TOKEN, uppercased with non-letters stripped, against
  // STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/OPTOUT/OPT-OUT/REVOKE. That is what
  // makes decorated variants work: Phase 0 captured Tells sending `"Stop"`
  // (capitalized, undecorated) and it matches unchanged; so do "STOP.",
  // "stop please", "Stop ✋️", and "QUIT!" — punctuation and emoji are stripped
  // from the token, trailing words are ignored. A non-opt-out reply ("thanks",
  // "yes") does not match and is stamped `ignored`.
  if (!isOptOutKeyword(o.body ?? "")) {
    await stamp("ignored");
    return { kind: "ignored" };
  }

  const phone = tellsPhoneToE164(o.fromNumber);
  if (!phone) {
    await stamp("invalid_phone");
    return { kind: "invalid_phone" };
  }

  const dup = await findDuplicateTellsInbound(dbc, {
    orgId: o.orgId,
    fromNumber: o.fromNumber!,
    body: o.body,
    excludeEventId: o.eventId,
    anchor: o.receivedAt,
  });
  if (dup) {
    // Expected and benign — logged, never alerted, so the rate stays greppable.
    console.warn(
      `[tells-optout] duplicate STOP caught (deduped) — org=${o.orgId} number=${o.fromNumber} ` +
        `this_event=${o.eventId} prior_event=${dup.event_id}; suppression already recorded, ` +
        `skipping second opt_out + attribution`,
    );
    await stamp("duplicate", { contactId: dup.matched_contact_id, stageSendId: dup.matched_stage_send_id });
    return { kind: "duplicate", contactId: dup.matched_contact_id };
  }

  // Upsert the contact — a suppression must stick even for a number that is not
  // a contact yet. Same rule as every other intake path; this is why
  // tellsPhoneToE164 exists and why it returns null rather than guessing.
  const c = (await dbc.execute(sql`
    INSERT INTO contacts (org_id, phone_number)
    VALUES (${o.orgId}, ${phone})
    ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
    RETURNING id
  `)) as unknown as { id: string }[];
  const contactId = c[0]!.id;

  // created_at = when the opt-out actually happened, so report buckets and
  // attributions agree on the day.
  const anchorIso = o.receivedAt.toISOString();
  const oo = (await dbc.execute(sql`
    INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
    VALUES (${o.orgId}, ${contactId}, ${phone}, ${TELLS_OPT_OUT_SOURCE}, ${anchorIso}::timestamptz)
    RETURNING id
  `)) as unknown as { id: number }[];
  const optOutId = oo[0]!.id;

  // Cascade-cancel not-yet-sent rows for this contact so a STOP arriving before
  // a stage drains is honored immediately rather than at the drain's send-time
  // re-check. Terminal 'skipped_opted_out' + 'opt_out_cancel' is the same
  // bucket every other intake path uses.
  await dbc.execute(sql`
    UPDATE stage_sends
    SET status = 'skipped_opted_out', last_error = 'opt_out_cancel'
    WHERE org_id = ${o.orgId} AND contact_id = ${contactId}
      AND status = 'pending'
  `);

  // Attribution: the shared cross-provider helper — one opt-out credits the
  // single most-recent matching send across all stages in the trailing window.
  // null ⇒ unattributed; the ORG-WIDE SUPPRESSION STILL STANDS either way.
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
