import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { captureAhoiDlrEvent, reconcileAhoiDlrEvent } from "@/lib/sends/ahoi-dlr";
import { processAhoiDlrOptOut } from "@/lib/sends/ahoi-dlr-optout";
import {
  extractClientIp,
  headersToObject,
  isKnownAhoiIp,
  queryToObject,
  resolveAhoiCredential,
} from "@/lib/sends/ahoi-webhook-shared";
import { ahoiAdapter, extractAhoiWebhookFields } from "@/lib/sends/providers/ahoi";

// Public inbound Ahoi DLR (delivery receipt) callback receiver.
//
// G1: auth is the path token ONLY, resolved to (org, provider, credential)
// via provider_credentials.inbound_webhook_token — the SAME column/token
// Ahoi's inbound (STOP) webhook uses (see ../inbound/[token]/route.ts); the
// URL PATH distinguishes which handler runs. resolveAhoiCredential additionally
// scopes the lookup to sms_provider_id = 'ahi' so a token belonging to a
// different provider (e.g. TextHub) can't authenticate here. The
// 207.181.190.0/24 IP check below is defense-in-depth ONLY (logged, never
// blocking).
//
// Capture + parse + reconcile all happen in this one request (unlike
// TextHub's historical Stage A/B split) — reconcile is a cheap single-row
// lookup, so there's no reason to defer it (reconcileAhoiDlrEvent, Task 5).
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
      `[ahoi-dlr-webhook] request from unexpected IP ${ip ?? "unknown"} (expected 207.181.190.0/24) — processing anyway (G1: token is the auth gate)`,
    );
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const query = queryToObject(req);
  const headers = headersToObject(req);
  const raw = { query, body: rawBody, headers };
  const fields = extractAhoiWebhookFields(raw);
  const parsed = ahoiAdapter.parseDlr(raw);

  const captured = await captureAhoiDlrEvent(db, {
    orgId: cred.org_id,
    credentialId: cred.id,
    providerId: cred.provider_id,
    method: req.method,
    query,
    headers,
    rawBody: rawBody || null,
    fields,
    parsed,
  });

  if (parsed) {
    await reconcileAhoiDlrEvent(db, {
      eventId: captured.id,
      orgId: cred.org_id,
      providerId: cred.provider_id,
      providerUuid: parsed.providerUuid,
      sendStatus: parsed.sendStatus,
    });

    // Layer 3 (spec §6), best-effort — never throws back to Ahoi. See
    // processAhoiDlrOptOut's own comment for why CARRY 1's cross-channel
    // dedup doesn't apply here.
    try {
      await processAhoiDlrOptOut(db, {
        orgId: cred.org_id,
        destinationNumber: fields.destination ?? null,
        sendStatus: parsed.sendStatus,
        error: parsed.error,
        smppCode: parsed.smppCode,
        receivedAt: new Date(),
      });
    } catch (e) {
      console.error("[ahoi-dlr-webhook] opt-out processing failed (non-fatal):", e);
    }
  }

  return NextResponse.json({ ok: true });
}
