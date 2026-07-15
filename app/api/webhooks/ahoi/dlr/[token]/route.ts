import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials } from "@/db/schema";
import { captureAhoiDlrEvent, reconcileAhoiDlrEvent } from "@/lib/sends/ahoi-dlr";
import {
  extractClientIp,
  headersToObject,
  isKnownAhoiIp,
  queryToObject,
} from "@/lib/sends/ahoi-webhook-shared";
import { ahoiAdapter, extractAhoiWebhookFields } from "@/lib/sends/providers/ahoi";

// Public inbound Ahoi DLR (delivery receipt) callback receiver.
//
// G1: auth is the path token ONLY, resolved to (org, provider, credential)
// via provider_credentials.inbound_webhook_token — the SAME column/token
// Ahoi's inbound (STOP) webhook uses (see ../inbound/[token]/route.ts); the
// URL PATH distinguishes which handler runs. The 207.181.190.0/24 IP check
// below is defense-in-depth ONLY (logged, never blocking).
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

  const cred = await db
    .select({
      id: provider_credentials.id,
      org_id: provider_credentials.org_id,
      provider_id: provider_credentials.provider_id,
    })
    .from(provider_credentials)
    .where(eq(provider_credentials.inbound_webhook_token, token))
    .limit(1);

  if (!cred[0]) return new NextResponse("Unauthorized", { status: 401 });
  if (cred[0].provider_id == null) return new NextResponse("Unauthorized", { status: 401 });

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
    orgId: cred[0].org_id,
    credentialId: cred[0].id,
    providerId: cred[0].provider_id,
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
      orgId: cred[0].org_id,
      providerId: cred[0].provider_id,
      providerUuid: parsed.providerUuid,
      sendStatus: parsed.sendStatus,
    });
  }

  return NextResponse.json({ ok: true });
}
