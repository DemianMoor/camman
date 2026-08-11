import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { optOutBreakerAlertText } from "@/lib/sends/optout-rate-breaker";
import {
  captureTxrDlrEvent,
  parseTxrStatusCallback,
  reconcileTxrDlrEvent,
} from "@/lib/sends/textrequest-dlr";
import {
  classifyTxrWebhookPayload,
  contactUpdateIsOptOut,
  parseTxrContactUpdated,
  parseTxrMsgReceived,
} from "@/lib/sends/textrequest-inbound";
import {
  captureTxrInboundEvent,
  processTextrequestOptOut,
  type TxrOptOutChannel,
} from "@/lib/sends/textrequest-optout";
import { parseTxrUtcTimestamp } from "@/lib/sends/textrequest-messages-poll";
import { recordTxrDlrOptOut } from "@/lib/sends/textrequest-dlr-optout";
import {
  headersToObject,
  queryToObject,
  resolveTextrequestCredential,
} from "@/lib/sends/textrequest-webhook-shared";

// Public Text Request ACCOUNT webhook receiver (Phase 4) — one route for the
// three events CamMan subscribes to: msg_received (STOP replies),
// contact_updated (TR's own opt-out bookkeeping) and msg_status_updated
// (delivery status, which can carry errorCode 2100 = "contact has previously
// opted out"). The `?e=` query hint says which; shape detection covers a hook
// created by hand in the portal.
//
// ALWAYS 200, even on a payload we don't understand or a processing failure:
// Text Request DISCONNECTS a hook after 10 consecutive non-2XX responses, and a
// disconnected opt-out hook is a silent compliance failure. So capture commits
// first, processing is best-effort inside its own transaction, and any failure
// fires a LOUD Telegram alert while still acking. The polls
// (/api/cron/textrequest-poll) are the automatic retry.
//
// Auth is the path token only, scoped to sms_provider_id='txr' — TR documents no
// source-IP range and no webhook signature, same posture as the Ahoi routes and
// the Phase 3a status route.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  const cred = await resolveTextrequestCredential(db, token);
  if (!cred) return new NextResponse("Unauthorized", { status: 401 });

  const rawBody = await req.text().catch(() => "");
  const query = queryToObject(req);
  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  const kind = classifyTxrWebhookPayload(query.e ?? null, parsedBody);
  const now = new Date();

  try {
    if (kind === "status") {
      // Same payload shape as the per-message status_callback, minus the ?ss=
      // hint — so this reuses Phase 3a's parse/capture/reconcile wholesale and
      // then drives opt-out on errorCode 2100/30050.
      const parsed = parseTxrStatusCallback(rawBody || null);
      const captured = await captureTxrDlrEvent(db, {
        orgId: cred.org_id,
        credentialId: cred.id,
        providerId: cred.provider_id,
        method: req.method,
        query,
        headers: headersToObject(req),
        rawBody: rawBody || null,
        stageSendId: null,
        parsed,
      });
      const rec = await reconcileTxrDlrEvent(db, {
        eventId: captured.id,
        orgId: cred.org_id,
        stageSendId: null,
        messageId: parsed.messageId,
      });
      const trip = await recordTxrDlrOptOut(db, {
        orgId: cred.org_id,
        credentialId: cred.id,
        providerId: cred.provider_id,
        errorCode: parsed.errorCode,
        matchedStageSendId: rec.matchedStageSendId,
        messageId: parsed.messageId,
        rawBody: rawBody || null,
        receivedAt: now,
      });
      if (trip) {
        await notifyTelegram(optOutBreakerAlertText(trip.campaignId, null, trip.result)).catch(() => {});
      }
      return NextResponse.json({ ok: true });
    }

    let channel: TxrOptOutChannel;
    let sourceNumber: string | null = null;
    let destinationNumber: string | null = null;
    let message: string | null = null;
    let providerUuid: string | null = null;
    let optedOutUtc: Date | null = null;
    let receivedAt = now;

    if (kind === "msg") {
      const p = parseTxrMsgReceived(parsedBody);
      if (!p) return NextResponse.json({ ok: true, ignored: "unparseable_msg_payload" });
      // msg_sent and msg_received share one payload schema; only 'R' is an
      // inbound reply. Our own outbound copy must never be keyword-matched
      // (a creative containing "STOP to opt out" would otherwise suppress the
      // recipient we just texted).
      if (p.direction !== "R") return NextResponse.json({ ok: true, ignored: "outbound_message" });
      channel = "webhook_msg_received";
      sourceNumber = p.contactPhone;
      destinationNumber = p.dashboardPhone;
      message = p.message;
      providerUuid = p.messageUuid;
      receivedAt = parseTxrUtcTimestamp(p.timestamp) ?? now;
    } else if (kind === "contact") {
      const p = parseTxrContactUpdated(parsedBody);
      if (!p) return NextResponse.json({ ok: true, ignored: "unparseable_contact_payload" });
      // contact_updated fires on ANY contact edit (name, note, tags). Only an
      // opt-out/suppression assertion is actionable; everything else is dropped
      // without a row, or the table would fill with no-op edits.
      if (!contactUpdateIsOptOut(p)) return NextResponse.json({ ok: true, ignored: "not_an_opt_out" });
      channel = "webhook_contact_updated";
      sourceNumber = p.contactPhone;
      optedOutUtc = parseTxrUtcTimestamp(p.optedOutUtc);
      // Date the suppression to TR's own opt-out timestamp when present, so
      // reports and attribution land on the day it really happened.
      receivedAt = optedOutUtc ?? now;
    } else {
      // An event we don't consume (msg_sent hint, contact_created, a payment or
      // location callback, or an unrecognized body). Ack without a row.
      return NextResponse.json({ ok: true, ignored: "unhandled_event" });
    }

    const captured = await captureTxrInboundEvent(db, {
      orgId: cred.org_id,
      credentialId: cred.id,
      providerId: cred.provider_id,
      channel,
      method: req.method,
      sourceNumber,
      destinationNumber,
      message,
      providerUuid,
      optedOutUtc,
      rawBody: rawBody || null,
      receivedAt,
    });
    // null ⇒ this message GUID was already captured (the poll saw it first);
    // its suppression is already recorded, so there is nothing to process.
    if (!captured) return NextResponse.json({ ok: true, duplicate: true });

    // processTextrequestOptOut performs several writes (contact upsert →
    // opt_outs → cascade-cancel → attribution → counters → stamp) that must
    // commit or roll back together: a partial failure could otherwise leave an
    // opt_out written with the event stuck unprocessed, which the poll backstop
    // (it only dedups against result='suppressed') would then double-write.
    const res = await db.transaction((tx) =>
      processTextrequestOptOut(tx, {
        eventId: captured.id,
        orgId: cred.org_id,
        sourceNumber,
        message,
        channel,
        receivedAt,
      }),
    );
    if (res.kind === "suppressed" && res.breakerTrip) {
      await notifyTelegram(
        optOutBreakerAlertText(res.breakerTrip.campaignId, null, res.breakerTrip.result),
      ).catch(() => {});
    }
    return NextResponse.json({ ok: true, result: res.kind });
  } catch (e) {
    console.error("[textrequest-events-webhook] processing failed:", e);
    await notifyTelegram(
      `⚠️ Text Request webhook processing FAILED (opt-out may not be suppressed yet)\n` +
        `org ${cred.org_id} · credential ${cred.id} · kind ${kind}\n` +
        `error: ${e instanceof Error ? e.message : String(e)}\n` +
        `The messages/contacts polls (every 15 min) are the backstop — verify they recover.`,
    ).catch(() => {});
    // Still 200: a non-2XX here counts toward TR's 10-strike disconnect.
    return NextResponse.json({ ok: true, error: "processing_failed" });
  }
}
