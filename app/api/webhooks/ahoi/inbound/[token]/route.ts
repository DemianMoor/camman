import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials } from "@/db/schema";
import { captureAhoiInboundEvent } from "@/lib/sends/ahoi-inbound";
import {
  extractClientIp,
  headersToObject,
  isKnownAhoiIp,
  queryToObject,
} from "@/lib/sends/ahoi-webhook-shared";
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";

// Public inbound Ahoi message (STOP / general reply) callback receiver.
//
// CAPTURE ONLY — this route does NOT match STOP keywords, does NOT upsert a
// contact, does NOT write opt_outs. That is Section 4 (spec §6), built
// against the rows this route captures. Auth (G1) mirrors the DLR route:
// path token only, resolved via the SAME provider_credentials row/token the
// DLR webhook uses (the URL path distinguishes the two).
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
    orgId: cred[0].org_id,
    credentialId: cred[0].id,
    providerId: cred[0].provider_id,
    method: req.method,
    rawBody: rawBody || null,
    parsed,
  });

  return NextResponse.json({ ok: true });
}
