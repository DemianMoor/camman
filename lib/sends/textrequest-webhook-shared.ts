// Shared helpers for the Text Request webhook routes (status_callback DLR now;
// account webhooks in Phase 4). Mirrors lib/sends/ahoi-webhook-shared.ts.
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import type { DbOrTx } from "@/lib/sends/textrequest-dlr";
import { provider_credentials, sms_providers } from "@/db/schema";

export interface TextrequestWebhookCredential {
  id: number;
  org_id: string;
  provider_id: number;
}

// Resolve a webhook path token to (org, provider, credential), scoped to the
// Text Request provider ONLY (sms_provider_id = 'txr'). inbound_webhook_token
// is a shared column across providers, so a token belonging to a different
// provider must NOT authenticate here — it's treated exactly like an unknown
// token (null → caller returns 401).
export async function resolveTextrequestCredential(
  dbc: DbOrTx,
  token: string,
): Promise<TextrequestWebhookCredential | null> {
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
        eq(sms_providers.sms_provider_id, "txr"),
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
