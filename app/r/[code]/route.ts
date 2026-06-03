import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { resolveAndLogClick } from "@/lib/links/resolve-click";

// Public short-link redirect. No auth (the recipient isn't signed in); it
// writes the click via the privileged Drizzle role, which bypasses RLS. The
// proxy/middleware matcher excludes /r/ so this path doesn't pay an
// auth round-trip per click.
//
// force-dynamic + no caching: every hit must run so every click is logged and
// the redirect is never served stale.
export const dynamic = "force-dynamic";

function firstForwardedIp(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  if (!code) {
    return new NextResponse("Not found", { status: 404 });
  }

  const h = req.headers;
  // Client IP priority: CF-Connecting-IP (set/overwritten by Cloudflare when
  // proxied) → x-real-ip (Vercel) → first hop of X-Forwarded-For. Correct
  // either way: DNS-only Cloudflare won't send CF-Connecting-IP, so this
  // falls through to today's behavior; proxied, it's the spoof-proof source.
  //
  // ⚠️ ORIGIN-LOCK DEPENDENCY: CF-Connecting-IP is only trustworthy if the
  // Vercel origin CANNOT be reached except through Cloudflare. If a client
  // can hit the origin directly, it can forge CF-Connecting-IP just like
  // X-Forwarded-For. When the proxy is turned on, the origin MUST be locked
  // to Cloudflare (IP-range allowlist or Cloudflare Tunnel). The Phase 3 ASN
  // bot filter rests entirely on this IP being real — see the Cloudflare
  // setup checklist + Phase 3 brief.
  const result = await resolveAndLogClick(db, {
    code,
    ip:
      h.get("cf-connecting-ip") ??
      h.get("x-real-ip") ??
      firstForwardedIp(h.get("x-forwarded-for")),
    userAgent: h.get("user-agent"),
    referer: h.get("referer"),
    prefetch: {
      purpose: h.get("purpose"),
      xPurpose: h.get("x-purpose"),
      xMoz: h.get("x-moz"),
      secPurpose: h.get("sec-purpose"),
    },
  });

  if (!result) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Destinations are set by our own mint and are trusted, but guard against a
  // malformed/non-http value rather than emitting an open or broken redirect.
  if (!isHttpUrl(result.destinationUrl)) {
    return new NextResponse("Invalid destination", { status: 500 });
  }

  return NextResponse.redirect(result.destinationUrl, 302);
}
