import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Brand-scoped provider credentials. A key is stored per (provider, brand);
// brand_id NULL is a provider-wide default. Resolution prefers the
// brand-specific key, then falls back to the default — so a brand with its own
// account uses its own key, while brands without one share the default.
//
// NOTE: resolveProviderApiKey returns the PLAINTEXT key — call it only at send
// time (the Step-3 drain), never in a list/response path. The kickoff GUARD
// uses hasResolvableCredential, which never reads the secret.

// True if a usable key exists for (provider, brand) or the provider-default.
export async function hasResolvableCredential(
  dbc: DbOrTx,
  { orgId, providerId, brandId }: { orgId: string; providerId: number; brandId: number | null },
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    SELECT 1 AS ok FROM provider_credentials
    WHERE org_id = ${orgId} AND provider_id = ${providerId}
      AND (brand_id = ${brandId} OR brand_id IS NULL)
    LIMIT 1
  `)) as unknown as { ok: number }[];
  return rows.length > 0;
}

// Resolve the api_key to use for (provider, brand): brand-specific first, then
// the provider-default. Returns null if neither exists. Plaintext — send path
// only; never logged, never returned to a client.
export async function resolveProviderApiKey(
  dbc: DbOrTx,
  { orgId, providerId, brandId }: { orgId: string; providerId: number; brandId: number | null },
): Promise<string | null> {
  const rows = (await dbc.execute(sql`
    SELECT api_key FROM provider_credentials
    WHERE org_id = ${orgId} AND provider_id = ${providerId}
      AND (brand_id = ${brandId} OR brand_id IS NULL)
    ORDER BY (brand_id IS NOT NULL) DESC
    LIMIT 1
  `)) as unknown as { api_key: string }[];
  return rows[0]?.api_key ?? null;
}

// Mask a key for display — last 4 only, never the full value.
export function maskApiKey(key: string): { last4: string; masked: string } {
  const last4 = key.slice(-4);
  return { last4, masked: `••••${last4}` };
}
