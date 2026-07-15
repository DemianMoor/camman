// Small helpers shared by both Ahoi webhook routes (DLR + inbound) — kept
// tiny and dependency-free (no CIDR library) since the range is a single /24.
import type { NextRequest } from "next/server";

export function headersToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function queryToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// G1: this is DEFENSE-IN-DEPTH ONLY, never the auth gate (the path token is).
// Ahoi's documented callback source range is 207.181.190.0/24 (Phase 0
// recon: DLR from .156, inbound from .161, both in that /24). An
// out-of-range request is still PROCESSED — only logged — so an infra change
// on Ahoi's end (or a Vercel header quirk) can never silently brick the real
// webhook.
export function extractClientIp(forwardedFor: string | null): string | null {
  if (!forwardedFor) return null;
  return forwardedFor.split(",")[0]?.trim() || null;
}

export function isKnownAhoiIp(ip: string | null): boolean {
  if (!ip) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim());
  if (!m) return false;
  return m[1] === "207" && m[2] === "181" && m[3] === "190";
}
