import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { provider_credentials, sms_providers } from "@/db/schema";
import { getDescriptor } from "@/lib/sends/providers/registry";
import type { ProviderDescriptor } from "@/lib/sends/providers/types";

// Shared ownership + connection-type resolution for the per-credential action
// routes (869egmakh P2).
//
// Before this existed each route rolled its own lookup, and two of them
// (credentials/test, register-callback) checked the provider's identity ONLY in
// the client component — the server accepted any credential and fired it at
// TextHub's API. A direct request with an Ahoi or Text Request credential would
// have sent that key to the wrong provider. One resolver means the org scope,
// the 404 shape, and the connection-type gate can't drift between routes.
//
// Returns non-secret columns only. Resolving the key stays a separate, explicit
// call (resolveCredentialKeyById) so a route never holds a plaintext secret it
// didn't ask for.

export type CredentialContext = {
  credentialId: number;
  providerId: number;
  // The provider row's sms_provider_id. This is the REGISTRY key, which for
  // `txh2` is an alias of the TextHub adapter — hence getDescriptor(), never
  // adapter.key (which reports "txh" for that row and would misattribute it).
  providerKey: string;
  providerName: string;
  descriptor: ProviderDescriptor | null;
};

// Look up a credential inside the caller's org, scoped to the given provider.
// Null when it doesn't exist, belongs to another org, or hangs off a different
// provider — all three collapse to the same 404 on purpose, so the endpoint
// can't be used to probe which credential ids exist in other orgs.
export async function loadCredentialContext(
  { orgId, providerId, credentialId }:
    { orgId: string; providerId: number; credentialId: number },
): Promise<CredentialContext | null> {
  const rows = await db
    .select({
      credentialId: provider_credentials.id,
      providerId: sms_providers.id,
      providerKey: sms_providers.sms_provider_id,
      providerName: sms_providers.name,
    })
    .from(provider_credentials)
    .innerJoin(sms_providers, eq(sms_providers.id, provider_credentials.provider_id))
    .where(
      and(
        eq(provider_credentials.id, credentialId),
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
        eq(sms_providers.org_id, orgId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { ...row, descriptor: getDescriptor(row.providerKey) };
}
