import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/provider-credential";

// Sync provider_phones.credential_id to a credential's desired membership.
// `phoneIds` is the COMPLETE set of provider_phones ids that should belong to
// `credentialId` — this is a "make it so" sync, not an incremental add/remove.
//
// Two org-scoped statements:
//   (a) link: phones in phoneIds -> credentialId (only rows whose
//       credential_id actually changes; a phone already linked to a
//       DIFFERENT credential is moved — that's an explicit, allowed action).
//   (b) unlink: phones currently on credentialId but NOT in phoneIds ->
//       NULL. An empty phoneIds array skips (a) entirely and unlinks
//       everything on this credential via (b) — `id <> ALL(ARRAY[]::int[])`
//       is vacuously true for every row, so no special-casing is needed for
//       the SQL itself, but we still skip the no-op (a) query.
//
// Raw sql.execute (not the query builder) to match the style of
// lib/sends/provider-credential.ts, which this shares the DbOrTx type with.
export async function applyCredentialPhoneLinks(
  dbc: DbOrTx,
  { orgId, credentialId, phoneIds }: { orgId: string; credentialId: number; phoneIds: number[] },
): Promise<{ linked: number; unlinked: number }> {
  const idsLiteral = intArrayLiteral(phoneIds);

  let linked = 0;
  if (phoneIds.length > 0) {
    const linkedRows = (await dbc.execute(sql`
      UPDATE provider_phones
      SET credential_id = ${credentialId}
      WHERE id = ANY(${sql.raw(idsLiteral)})
        AND org_id = ${orgId}
        AND (credential_id IS DISTINCT FROM ${credentialId})
      RETURNING id
    `)) as unknown as { id: number }[];
    linked = linkedRows.length;
  }

  const unlinkedRows = (await dbc.execute(sql`
    UPDATE provider_phones
    SET credential_id = NULL
    WHERE credential_id = ${credentialId}
      AND org_id = ${orgId}
      AND id <> ALL(${sql.raw(idsLiteral)})
    RETURNING id
  `)) as unknown as { id: number }[];
  const unlinked = unlinkedRows.length;

  return { linked, unlinked };
}

// Ids are pre-validated positive integers (Zod, or serial PK values in
// tests) — no untrusted strings ever reach this literal.
function intArrayLiteral(values: number[]): string {
  if (values.length === 0) return "ARRAY[]::int[]";
  return `ARRAY[${values.map((v) => Math.trunc(v)).join(",")}]::int[]`;
}
