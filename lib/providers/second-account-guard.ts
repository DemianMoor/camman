import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/provider-credential";

// Guardrail for adding a 2nd+ credential (account) to a provider. A stage in
// a send-eligible state ('draft' | 'pending' | 'sent') resolves its key via
// the single-credential legacy fallback (see resolveKeyForStage) whenever its
// phone can't resolve an account directly — either because it has NO
// provider_phone_id, or because it has a provider_phone_id whose
// provider_phones.credential_id is still NULL (unlinked). Both cases go
// ambiguous the moment the provider gains a 2nd credential, since the
// resolver can no longer guess which account to bill. The POST route calls
// this before inserting a 2nd+ credential and blocks (409) when it returns
// > 0.
//
// NOTE: the export name is narrower than the behavior above (it also counts
// unlinked-phone stages, not just numberless ones) — kept as-is since callers
// already depend on this name.
export async function countNumberlessSendEligibleStages(
  dbc: DbOrTx,
  { orgId, providerId }: { orgId: string; providerId: number },
): Promise<number> {
  const rows = (await dbc.execute(sql`
    SELECT count(*)::int AS n
    FROM campaign_stages s
    LEFT JOIN provider_phones ph ON ph.id = s.provider_phone_id
    WHERE s.org_id = ${orgId}
      AND s.sms_provider_id = ${providerId}
      AND (s.provider_phone_id IS NULL OR ph.credential_id IS NULL)
      AND s.status IN ('draft', 'pending', 'sent')
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}
