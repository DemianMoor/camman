import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials, texthub_inbound_events } from "@/db/schema";

// Public inbound TextHub opt-out (STOP) callback receiver.
//
// STAGE A — CAPTURE ONLY. This route authenticates the caller via the
// per-credential token in the path, then records the RAW payload (method,
// query, headers, body) verbatim so the TextHub callback contract can be read
// off real data. It does NOT parse STOP and does NOT suppress any contact yet
// — that is Stage B, built against the captured shape.
//
// No Supabase session here (the proxy matcher excludes /api/webhooks/). The
// token IS the auth: it maps the inbound call to exactly one (org, provider,
// brand) credential. An unknown/missing token is rejected (401) and nothing is
// written. Writes use the privileged Drizzle role (bypasses RLS).
//
// force-dynamic + no caching: every callback must run and be recorded.
export const dynamic = "force-dynamic";

function headersToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function queryToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function handle(
  req: NextRequest,
  token: string,
): Promise<NextResponse> {
  if (!token) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Resolve the token -> credential (org/provider). Unknown token = forged or
  // stale registration: reject without recording anything.
  const cred = await db
    .select({
      id: provider_credentials.id,
      org_id: provider_credentials.org_id,
      provider_id: provider_credentials.provider_id,
    })
    .from(provider_credentials)
    .where(eq(provider_credentials.inbound_webhook_token, token))
    .limit(1);

  if (!cred[0]) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Read the raw body once (may be empty for a GET callback).
  let rawBody: string | null = null;
  try {
    rawBody = await req.text();
  } catch {
    rawBody = null;
  }

  await db.insert(texthub_inbound_events).values({
    org_id: cred[0].org_id,
    credential_id: cred[0].id,
    provider_id: cred[0].provider_id,
    method: req.method,
    query: queryToObject(req),
    headers: headersToObject(req),
    raw_body: rawBody && rawBody.length > 0 ? rawBody : null,
  });

  // Acknowledge. TextHub's expected ack shape is undocumented (swagger absent);
  // a 200 is the safe default and the live capture will confirm if it needs
  // something specific.
  return NextResponse.json({ ok: true });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return handle(req, token);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return handle(req, token);
}
