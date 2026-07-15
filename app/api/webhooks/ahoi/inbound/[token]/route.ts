import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { captureAhoiInboundEvent } from "@/lib/sends/ahoi-inbound";
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
// CAPTURE ONLY — this route does NOT match STOP keywords, does NOT upsert a
// contact, does NOT write opt_outs. That is Section 4 (spec §6), built
// against the rows this route captures. Auth (G1) mirrors the DLR route:
// path token only, resolved via the SAME provider_credentials row/token the
// DLR webhook uses (the URL path distinguishes the two). resolveAhoiCredential
// scopes the lookup to sms_provider_id = 'ahoi' so a token belonging to a
// different provider can't authenticate here.
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

  await captureAhoiInboundEvent(db, {
    orgId: cred.org_id,
    credentialId: cred.id,
    providerId: cred.provider_id,
    method: req.method,
    rawBody: rawBody || null,
    parsed,
  });

  return NextResponse.json({ ok: true });
}
