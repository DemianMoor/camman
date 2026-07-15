// Small helpers shared by both Ahoi webhook routes (DLR + inbound) — kept
// tiny and dependency-free (no CIDR library) since the range is a single /24.
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import type { DbOrTx } from "@/lib/sends/ahoi-dlr";
import { provider_credentials, sms_providers } from "@/db/schema";

export interface AhoiWebhookCredential {
  id: number;
  org_id: string;
  provider_id: number;
}

// Resolves a webhook path token to (org, provider, credential), scoped to the
// Ahoi provider ONLY (mirrors the `sms_provider_id = 'ahi'` join
// pollAhoiCdr uses). inbound_webhook_token is a single shared column — a
// token belonging to a DIFFERENT provider (e.g. TextHub) would otherwise
// authenticate here and capture a row under the wrong provider_id, which
// matters because the DLR reject-rate breaker (ahoi-dlr.ts) is
// provider-scoped. A token that resolves to a non-Ahoi provider is treated
// exactly like an unknown token — null, no row captured, caller returns 401.
export async function resolveAhoiCredential(
  dbc: DbOrTx,
  token: string,
): Promise<AhoiWebhookCredential | null> {
  const rows = await dbc
    .select({
      id: provider_credentials.id,
      org_id: provider_credentials.org_id,
      provider_id: provider_credentials.provider_id,
    })
    .from(provider_credentials)
    .innerJoin(
      sms_providers,
      and(
        eq(sms_providers.id, provider_credentials.provider_id),
        eq(sms_providers.org_id, provider_credentials.org_id),
      ),
    )
    .where(
      and(
        eq(provider_credentials.inbound_webhook_token, token),
        eq(sms_providers.sms_provider_id, "ahi"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

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
