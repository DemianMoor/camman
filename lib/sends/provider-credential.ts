import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { decryptSecret } from "@/lib/crypto/secret-box";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Brand-scoped provider credentials. A key is stored per (provider, brand);
// brand_id NULL is a provider-wide default. Resolution prefers the
// brand-specific key, then falls back to the default — so a brand with its own
// account uses its own key, while brands without one share the default.
//
// Multi-account (migration 0110): a provider can now hold N credentials
// (accounts). provider_phones.credential_id binds a sender number to one of
// them (number -> account -> key). resolveKeyForStage is the number-aware
// resolver used at send time; the legacy (provider, brand)/default lookup
// below only fires as a fallback when the provider is still single-account —
// see resolveKeyForStage for why.
//
// NOTE: resolveKeyForStage / resolveProviderApiKey / resolveCredentialKeyById
// return the PLAINTEXT key — call them only at send time (the Step-3 drain),
// never in a list/response path. hasResolvableCredential never reads the
// secret; the kickoff/preflight guards use it.

// Dual-read a credential row's key: prefer the encrypted blob (migration
// 0110), else the legacy plaintext column. Keeps pre-backfill rows working
// while the encryption rollout is in progress. The single dual-read primitive
// — every other read site (pollers, test route, register-callback route)
// calls this rather than inlining `decryptSecret(...) ?? ...`.
export function decryptCredentialKey(row: { api_key_encrypted: string | null; api_key: string | null }): string | null {
  if (row.api_key_encrypted) return decryptSecret(row.api_key_encrypted);
  return row.api_key ?? null;
}

// True if a usable key is reachable for this stage: its phone's own
// credential, or — only when the provider has exactly one credential — the
// provider-scoped legacy (provider, brand)/default lookup. Mirrors
// resolveKeyForStage's reachability WITHOUT ever selecting the secret
// columns. providerPhoneId is required (pass null when the stage genuinely
// has no phone context: no phone-scoped lookup, legacy fallback only).
export async function hasResolvableCredential(
  dbc: DbOrTx,
  { orgId, providerId, brandId, providerPhoneId }:
    { orgId: string; providerId: number; brandId: number | null; providerPhoneId: number | null },
): Promise<boolean> {
  if (providerPhoneId != null) {
    const rows = (await dbc.execute(sql`
      SELECT 1 AS ok
      FROM provider_phones ph
      JOIN provider_credentials pc ON pc.id = ph.credential_id
      WHERE ph.id = ${providerPhoneId} AND ph.org_id = ${orgId} AND pc.org_id = ${orgId}
      LIMIT 1
    `)) as unknown as { ok: number }[];
    if (rows.length > 0) return true;
    // phone exists but no credential_id yet (pre-backfill) -> fall through to legacy
  }
  const count = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM provider_credentials WHERE org_id = ${orgId} AND provider_id = ${providerId}
  `)) as unknown as { n: number }[];
  if ((count[0]?.n ?? 0) !== 1) return false;
  const rows = (await dbc.execute(sql`
    SELECT 1 AS ok FROM provider_credentials
    WHERE org_id = ${orgId} AND provider_id = ${providerId}
      AND (brand_id = ${brandId} OR brand_id IS NULL)
    LIMIT 1
  `)) as unknown as { ok: number }[];
  return rows.length > 0;
}

// Resolve the plaintext key for a stage send: number -> account -> key first
// (providerPhoneId's own credential); falls back to the provider-scoped
// legacy (provider, brand)/default lookup ONLY when the provider has exactly
// one credential — a numberless stage on a multi-account provider must not
// silently guess which account to bill. Dual-reads api_key_encrypted
// (decrypt) else plaintext api_key either way.
export async function resolveKeyForStage(
  dbc: DbOrTx,
  { orgId, providerId, brandId, providerPhoneId }:
    { orgId: string; providerId: number; brandId: number | null; providerPhoneId: number | null },
): Promise<string | null> {
  // (a) number -> account -> key
  if (providerPhoneId != null) {
    const rows = (await dbc.execute(sql`
      SELECT pc.api_key_encrypted, pc.api_key
      FROM provider_phones ph
      JOIN provider_credentials pc ON pc.id = ph.credential_id
      WHERE ph.id = ${providerPhoneId} AND ph.org_id = ${orgId} AND pc.org_id = ${orgId}
      LIMIT 1
    `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];
    if (rows[0]) return decryptCredentialKey(rows[0]);
    // phone exists but no credential_id yet (pre-backfill) -> fall through to legacy
  }
  // (b) provider-scoped legacy fallback — ONLY when exactly one credential exists.
  const count = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM provider_credentials WHERE org_id = ${orgId} AND provider_id = ${providerId}
  `)) as unknown as { n: number }[];
  if ((count[0]?.n ?? 0) !== 1) return null;
  const rows = (await dbc.execute(sql`
    SELECT api_key_encrypted, api_key FROM provider_credentials
    WHERE org_id = ${orgId} AND provider_id = ${providerId}
      AND (brand_id = ${brandId} OR brand_id IS NULL)
    ORDER BY (brand_id IS NOT NULL) DESC
    LIMIT 1
  `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];
  return rows[0] ? decryptCredentialKey(rows[0]) : null;
}

// Dual-read decrypt for a specific credential id (test route / pollers).
export async function resolveCredentialKeyById(
  dbc: DbOrTx,
  { orgId, credentialId }: { orgId: string; credentialId: number },
): Promise<string | null> {
  const rows = (await dbc.execute(sql`
    SELECT api_key_encrypted, api_key FROM provider_credentials
    WHERE id = ${credentialId} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];
  return rows[0] ? decryptCredentialKey(rows[0]) : null;
}

// Resolve the api_key to use for (provider, brand): brand-specific first, then
// the provider-default. Returns null if neither exists. Plaintext — send path
// only; never logged, never returned to a client.
// DEPRECATED (pre-multi-account): superseded by resolveKeyForStage. Kept until
// the drain (Task 5) stops importing it.
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
