import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { captureAhoiInboundEvent } from "@/lib/sends/ahoi-inbound";
import { processAhoiInboundOptOut } from "@/lib/sends/ahoi-optout";
import {
  extractClientIp,
  headersToObject,
  isKnownAhoiIp,
  queryToObject,
  resolveAhoiCredential,
} from "@/lib/sends/ahoi-webhook-shared";
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";

// Public inbound Ahoi message (STOP / general reply) callback receiver.
//
// Capture (Section 3) always commits first and we always 200-ack Ahoi;
// opt-out processing (Section 4, processAhoiInboundOptOut — keyword match,
// contact upsert/match, opt_outs write, attribution) runs right after in the
// SAME request, best-effort. Processing runs inside its OWN transaction:
// processAhoiInboundOptOut performs several non-atomic writes (contact
// upsert -> opt_outs insert -> attribution -> mark result='suppressed') that
// must commit or roll back together — without the wrap, a throw partway
// through could leave opt_outs already written but the event stuck at
// result=NULL, and the CDR backstop (which only dedupes against
// result='suppressed' rows) would then double-write on retry. A processing
// failure never throws back to Ahoi (we don't rely on an unconfirmed Ahoi
// retry-on-non-2xx) but fires a LOUD Telegram alert and is backstopped by
// the CDR poll's independent re-capture of the same event (Layer 2). Auth
// (G1) mirrors the DLR route: path token only, resolved via the SAME
// provider_credentials row/token the DLR webhook uses (the URL path
// distinguishes the two). resolveAhoiCredential scopes the lookup to
// sms_provider_id = 'ahi' so a token belonging to a different provider
// can't authenticate here.
//
// force-dynamic: every callback must run and be recorded, never cached.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  const cred = await resolveAhoiCredential(db, token);
  if (!cred) return new NextResponse("Unauthorized", { status: 401 });

  const ip = extractClientIp(req.headers.get("x-forwarded-for"));
  if (!isKnownAhoiIp(ip)) {
    console.warn(
      `[ahoi-inbound-webhook] request from unexpected IP ${ip ?? "unknown"} (expected 207.181.190.0/24) — processing anyway (G1: token is the auth gate)`,
    );
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const raw = { query: queryToObject(req), body: rawBody, headers: headersToObject(req) };
  const parsed = ahoiAdapter.parseInbound(raw);

  const captured = await captureAhoiInboundEvent(db, {
    orgId: cred.org_id,
    credentialId: cred.id,
    providerId: cred.provider_id,
    method: req.method,
    rawBody: rawBody || null,
    parsed,
  });

  // Layer 1 (spec §6): capture ALWAYS commits first (above), independent of
  // processing, and we ALWAYS 200-ack Ahoi (never return a non-2xx) — Phase 0
  // never confirmed whether Ahoi retries a webhook on a non-2xx, so we don't
  // rely on that behavior (see the plan's "Processing model & Ahoi retry"
  // note). Processing is best-effort here, but a FAILURE is LOUD, not silent:
  // it fires a Telegram alert (compliance-critical — a stuck STOP must be
  // noticed), and the CDR poll's independent capture of the SAME physical
  // event (Layer 2, ≤45min window) is the automatic safety-net retry. The
  // call itself is wrapped in db.transaction so processAhoiInboundOptOut's
  // several writes commit or roll back atomically (see the header comment).
  if (parsed) {
    try {
      await db.transaction((tx) =>
        processAhoiInboundOptOut(tx, {
          eventId: captured.id,
          orgId: cred.org_id,
          sourceNumber: parsed.source,
          message: parsed.message,
          optOutSource: "ahoi_inbound_webhook",
          receivedAt: new Date(),
        }),
      );
    } catch (e) {
      console.error("[ahoi-inbound-webhook] opt-out processing failed:", e);
      // Best-effort loud alert — never throws back to Ahoi (we still 200 below).
      await notifyTelegram(
        `⚠️ Ahoi inbound opt-out processing FAILED (STOP not yet suppressed via webhook)\n` +
          `event: ${captured.id} · org ${cred.org_id} · source ${parsed.source}\n` +
          `error: ${e instanceof Error ? e.message : String(e)}\n` +
          `CDR poll (≤45min) is the backstop — verify it recovers.`,
      ).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}
