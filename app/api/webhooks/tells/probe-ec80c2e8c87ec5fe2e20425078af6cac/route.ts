import { NextResponse, type NextRequest } from "next/server";

// ============================================================================
// TEMPORARY — Tells.co Phase 0 capture bin. DELETE THIS ENTIRE DIRECTORY when
// the real routes land in Phase 3.
// ============================================================================
//
// This is NOT the Phase 3 handler and must never grow into it. It does exactly
// one thing: write what arrived to the console, verbatim, so the payloads can
// be read out of Vercel runtime logs. No database, no parsing, no reconcile, no
// suppression, no auth beyond the unguessable path segment.
//
// Why a route instead of webhook.site: the Tells INBOUND payload carries our
// Tells API key in its `Key` field, so captured payloads must stay on our own
// infrastructure. See docs/superpowers/specs/2026-08-12-tells-provider-design.md §5.
//
// The random path segment is the only gate. It is unguessable to a scanner,
// which is all it needs to be for a short-lived probe — it is NOT a secret from
// anyone who can read this repo, and it grants nothing but the ability to write
// a log line. It stops working the moment this directory is deleted.
//
// NOTE: the log output is deliberately UNREDACTED — verbatim capture is the
// entire point of Phase 0. That means Vercel runtime logs will contain the
// Tells API key (from the inbound payload's `Key` field). Rotate the key after
// Phase 0 if we want to be strict; see the spec §5 for the ordering constraint
// that rotation carries.
//
// Point BOTH Tells config fields (Status Webhook URL and Inbound Message URL)
// at this same URL. The payload shape distinguishes them: a DLR carries
// Id/Status, an inbound message carries Key/Body. If Tells accepts a query
// string in those fields, adding `?src=dlr` / `?src=inbound` makes the logs
// trivially filterable — the full URL is logged, so it costs nothing here.

export const dynamic = "force-dynamic";
// Probe B9 holds the response past Tells's 12s webhook timeout, so the function
// must be allowed to outlive the platform default.
export const maxDuration = 60;

// Ceiling for the ?delay= test so a typo can't wedge the function until the
// platform kills it (which would look like a route bug rather than a slow ack).
const MAX_DELAY_MS = 55_000;

function headersToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// Two lines per event, both carrying the [tells-probe] prefix and a shared
// eventId. Split deliberately: Vercel truncates long log lines, and an MMS
// inbound payload carries base64 media that would blow the limit — keeping the
// metadata on its own line means a truncated body can never cost us the
// headers, timing, or URL too.
function logEvent(req: NextRequest, eventId: string, rawBody: string, note?: string) {
  const meta = {
    eventId,
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: headersToObject(req),
    bodyBytes: Buffer.byteLength(rawBody, "utf8"),
    ...(note ? { note } : {}),
  };
  console.log(`[tells-probe] meta ${JSON.stringify(meta)}`);
  console.log(`[tells-probe] body ${eventId} ${rawBody}`);
}

export async function POST(req: NextRequest) {
  const eventId = crypto.randomUUID();

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  // Log BEFORE any delay, so probe B9 still captures the payload even if the
  // function is killed while holding the response open.
  logEvent(req, eventId, rawBody);

  // Probe B9 (slow-ack test): `?delay=20000` holds the response ~20s, past
  // Tells's documented 12s webhook timeout, to find out whether a slow ack is
  // treated differently from the error ack in probe B7. One-off and manual —
  // Tells is never configured with a delay in the URL.
  const delayRaw = req.nextUrl.searchParams.get("delay");
  const delayMs = delayRaw ? Math.min(Number(delayRaw) || 0, MAX_DELAY_MS) : 0;
  if (delayMs > 0) {
    console.log(`[tells-probe] delaying ack ${delayMs}ms for ${eventId}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Tells asks for a success response in JSON. Their expected shape is
  // unconfirmed, so send both a `status` and an `ok` field — a probe bin that
  // gets its ack rejected would corrupt the B7/B9 results it exists to measure.
  return NextResponse.json({ status: "success", ok: true });
}

// Reachability check only — paste the URL in a browser to confirm the route is
// live before pointing Tells at it. Tells itself always POSTs.
export async function GET(req: NextRequest) {
  const eventId = crypto.randomUUID();
  logEvent(req, eventId, "", "GET reachability check — not a Tells callback");
  return NextResponse.json({ status: "success", ok: true, probe: "tells-phase0" });
}
