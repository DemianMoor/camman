import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { TXR_OPTOUT_ERROR_CODES } from "@/lib/sends/textrequest-dlr";
import type { OptOutRateCheckResult } from "@/lib/sends/optout-rate-breaker";
import {
  captureTxrInboundEvent,
  processTextrequestOptOut,
  type TxrOptOutChannel,
} from "@/lib/sends/textrequest-optout";

// Opt-out signal 4 — Text Request telling us mid-flight that a recipient is
// already opted out, in two places:
//
//   errorCode 2100  on a delivery status (per-message status_callback or the
//                   account msg_status_updated hook) — "Contact has previously
//                   opted out"
//   errorCode 30050 on the POST /messages response itself — the same fact,
//                   observed at send time (recorded as `filtered` by the drain)
//
// Unlike Ahoi's equivalent (lib/sends/ahoi-dlr-optout.ts), which ships with an
// EMPTY code allowlist because no real Ahoi opt-out signature was ever observed,
// both Text Request codes are DOCUMENTED and unambiguous — so this layer is live
// from day one.
//
// Meaning of a hit: our suppression list is BEHIND Text Request's. Recording the
// opt-out closes that gap so we stop paying to send to that number.
//
// The recipient's phone is not in the DLR body ({message_id, status, errorCode}),
// so it comes from the send this DLR was reconciled to. An unmatched DLR carrying
// 2100 therefore cannot be actioned — it is logged loudly rather than guessed at.

export interface RecordTxrDlrOptOutOpts {
  orgId: string;
  credentialId: number | null;
  providerId: number | null;
  errorCode: string | null;
  matchedStageSendId: string | null;
  messageId: string | null;
  rawBody: string | null;
  receivedAt: Date;
  // Test seam: override the code set.
  optOutCodes?: ReadonlySet<string>;
}

// Returns a breaker trip for the caller to alert on post-commit, or null.
// Never throws into the webhook path: a failure here must not turn into a
// non-2XX response (Text Request disconnects a hook after 10 of those).
export async function recordTxrDlrOptOut(
  database: typeof db,
  o: RecordTxrDlrOptOutOpts,
): Promise<{ campaignId: number; result: OptOutRateCheckResult } | null> {
  const codes = o.optOutCodes ?? TXR_OPTOUT_ERROR_CODES;
  const code = o.errorCode?.trim();
  if (!code || !codes.has(code)) return null;

  if (!o.matchedStageSendId) {
    console.warn(
      `[textrequest-dlr-optout] opt-out errorCode ${code} on an UNMATCHED delivery status ` +
        `(message_id=${o.messageId ?? "?"}) — no recipient to suppress. The contacts poll ` +
        `(has_opted_out=true) is the backstop for this number.`,
    );
    return null;
  }

  try {
    return await database.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT phone FROM stage_sends WHERE id = ${o.matchedStageSendId}::uuid AND org_id = ${o.orgId} LIMIT 1
      `)) as unknown as { phone: string | null }[];
      const phone = rows[0]?.phone ?? null;
      if (!phone) return null;

      // Keyed on the message GUID so the same DLR arriving on both the
      // per-message callback and the account hook captures once. Prefixed
      // because textrequest_inbound_events' uuid uniqueness is shared with the
      // message-shaped signals, and a DLR is a DIFFERENT fact about the same
      // GUID — without the prefix a 2100 DLR could collide with the inbound
      // STOP row for that message and be silently dropped.
      const captured = await captureTxrInboundEvent(tx, {
        orgId: o.orgId,
        credentialId: o.credentialId,
        providerId: o.providerId,
        channel: "dlr" satisfies TxrOptOutChannel,
        method: "dlr",
        // Stored in TR's own wire format (11-digit, no '+'), which is what the
        // processor's phone normalizer expects on every channel.
        sourceNumber: phone.replace(/^\+/, ""),
        destinationNumber: null,
        message: null,
        providerUuid: o.messageId ? `dlr:${o.messageId}` : null,
        optedOutUtc: null,
        rawBody: o.rawBody,
        receivedAt: o.receivedAt,
      });
      if (!captured) return null; // already captured on the other channel

      const res = await processTextrequestOptOut(tx, {
        eventId: captured.id,
        orgId: o.orgId,
        sourceNumber: phone.replace(/^\+/, ""),
        message: null,
        channel: "dlr",
        receivedAt: o.receivedAt,
      });
      return res.kind === "suppressed" ? res.breakerTrip : null;
    });
  } catch (e) {
    console.error("[textrequest-dlr-optout] failed to record DLR opt-out:", e);
    return null;
  }
}

export interface RecordTxrSendRejectOptOutOpts {
  orgId: string;
  credentialId: number | null;
  providerId: number | null;
  // Recipients the provider refused as opted-out, in E.164 (what stage_sends
  // stores). The drain already recorded these rows as `filtered`.
  phones: string[];
  receivedAt?: Date;
}

export interface RecordTxrSendRejectResult {
  suppressed: number;
  already: number;
  trips: { campaignId: number; result: OptOutRateCheckResult }[];
}

// Send-time flavor of the same signal: POST /messages answered with errorCode
// 30050. Best-effort and per-phone isolated — a failure to record must never
// fail the send run that just happened.
export async function recordTxrSendRejectOptOuts(
  database: typeof db,
  o: RecordTxrSendRejectOptOutOpts,
): Promise<RecordTxrSendRejectResult> {
  const out: RecordTxrSendRejectResult = { suppressed: 0, already: 0, trips: [] };
  const receivedAt = o.receivedAt ?? new Date();
  for (const phone of new Set(o.phones)) {
    const wire = phone.replace(/^\+/, "");
    try {
      const res = await database.transaction(async (tx) => {
        const captured = await captureTxrInboundEvent(tx, {
          orgId: o.orgId,
          credentialId: o.credentialId,
          providerId: o.providerId,
          channel: "send_reject" satisfies TxrOptOutChannel,
          method: "send",
          sourceNumber: wire,
          destinationNumber: null,
          message: null,
          // No GUID: a rejected send never got a message id. Idempotency here
          // rests on the processor's already-opted-out check (state-shaped
          // channel), not on the unique index.
          providerUuid: null,
          optedOutUtc: null,
          rawBody: null,
          receivedAt,
        });
        if (!captured) return null;
        return processTextrequestOptOut(tx, {
          eventId: captured.id,
          orgId: o.orgId,
          sourceNumber: wire,
          message: null,
          channel: "send_reject",
          receivedAt,
        });
      });
      if (!res) continue;
      if (res.kind === "suppressed") {
        out.suppressed++;
        if (res.breakerTrip) out.trips.push(res.breakerTrip);
      } else if (res.kind === "already_opted_out" || res.kind === "duplicate") {
        out.already++;
      }
    } catch (e) {
      console.error(`[textrequest-send-reject] failed to record opt-out for a rejected recipient:`, e);
    }
  }
  return out;
}
