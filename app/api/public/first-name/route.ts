import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { consume } from "@/lib/api/rate-limit";
import {
  lookupPageFirstName,
  lookupPageFirstNameFailOpen,
  PAGE_FIRST_NAME_ORIGINS,
} from "@/lib/links/page-first-name";

// Public landing-page lookup (0230): GET /api/public/first-name?t=<sub_id1>
// → {"first_name":"Maria"} or {"first_name":null}. No session — the token is the
// key (see lib/links/page-first-name.ts). Every failure, including the rate
// limit, is the same 200 + null body: the response never says why.
//
// Separate from /r/ and the send pipeline by construction; nothing here runs
// on a redirect or a send.
export const dynamic = "force-dynamic";

// Per-IP, per-instance (owner ruling 11-03, option a): a page asks once per
// view, so 20 in a burst refilling 1 every 3 s leaves real visitors untouched.
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_SECOND = 1 / 3;

function clientIp(req: NextRequest): string {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function headers(req: NextRequest): Headers {
  const out = new Headers({
    "Cache-Control": "no-store, private, max-age=0",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  const origin = req.headers.get("origin");
  if (origin && PAGE_FIRST_NAME_ORIGINS.has(origin)) {
    out.set("Access-Control-Allow-Origin", origin);
    out.set("Access-Control-Allow-Methods", "GET");
    out.set("Access-Control-Max-Age", "600");
  }
  return out;
}

export async function GET(req: NextRequest) {
  const limited = !consume({
    key: `page-first-name:${clientIp(req)}`,
    capacity: RATE_CAPACITY,
    refillPerSecond: RATE_REFILL_PER_SECOND,
  }).allowed;
  const firstName = limited
    ? null
    : await lookupPageFirstNameFailOpen(() =>
        lookupPageFirstName(db, req.nextUrl.searchParams.get("t")),
      );
  return NextResponse.json({ first_name: firstName }, { headers: headers(req) });
}

// A plain GET needs no preflight; answer one anyway so a page that adds a
// header doesn't break.
export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: headers(req) });
}
