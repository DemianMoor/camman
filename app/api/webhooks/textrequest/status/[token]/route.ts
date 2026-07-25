import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  captureTxrDlrEvent,
  parseTxrStatusCallback,
  reconcileTxrDlrEvent,
} from "@/lib/sends/textrequest-dlr";
import {
  headersToObject,
  queryToObject,
  resolveTextrequestCredential,
} from "@/lib/sends/textrequest-webhook-shared";

// Public Text Request per-message status_callback (DLR) receiver.
//
// Auth is the path token ONLY, resolved to (org, provider, credential) via
// provider_credentials.inbound_webhook_token scoped to sms_provider_id='txr'
// (resolveTextrequestCredential). TR documents no source-IP range and no
// webhook signature (brief §9), so — like Ahoi — the unguessable token in the
// URL is the auth gate. The drain sets this URL per send with ?ss=<stage_send_id>,
// so reconcile is a direct id lookup.
//
// force-dynamic: every callback must run and be recorded, never cached.
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  const cred = await resolveTextrequestCredential(db, token);
  if (!cred) return new NextResponse("Unauthorized", { status: 401 });

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const query = queryToObject(req);
  const headers = headersToObject(req);
  // Only trust a well-formed UUID from ?ss= (guards the ::uuid cast downstream).
  const stageSendId = query.ss && UUID_RE.test(query.ss) ? query.ss : null;
  const parsed = parseTxrStatusCallback(rawBody || null);

  const captured = await captureTxrDlrEvent(db, {
    orgId: cred.org_id,
    credentialId: cred.id,
    providerId: cred.provider_id,
    method: req.method,
    query,
    headers,
    rawBody: rawBody || null,
    stageSendId,
    parsed,
  });

  await reconcileTxrDlrEvent(db, {
    eventId: captured.id,
    orgId: cred.org_id,
    stageSendId,
    messageId: parsed.messageId,
  });

  // Opt-out drive on parsed.errorCode (2100/30050) is wired in Phase 4 alongside
  // the other opt-out signals; capture above already records the code.

  return NextResponse.json({ ok: true });
}
