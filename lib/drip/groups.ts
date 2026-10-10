import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// The two drip contact groups (Drip Phase 3).
//
// ⚠️ THE SANDBOX GROUP IS THE SAFETY BOUNDARY, not a label. Sandbox leads run
// the whole pipeline — contact, attributes, lead event — so the integration is
// genuinely proven end to end. What keeps them from ever being messaged is that
// they land in a DIFFERENT group, and a drip campaign's audience is built from
// the real one. A shared group with a boolean flag would put the entire
// guarantee on every future query remembering to filter.
export const DRIP_INTAKE_GROUP = "Drip intake";
export const DRIP_SANDBOX_GROUP = "Drip sandbox";

/**
 * Resolve (creating if absent) one of the drip groups for an org.
 *
 * Idempotent under concurrency: two sweeper runs racing on a fresh org both end
 * up with the same row rather than one erroring. `contact_group_id` is the
 * table's external text key and is derived from the name so the conflict target
 * is stable.
 */
export async function ensureDripGroup(
  dbc: DbOrTx,
  { orgId, sandbox }: { orgId: string; sandbox: boolean },
): Promise<number> {
  const name = sandbox ? DRIP_SANDBOX_GROUP : DRIP_INTAKE_GROUP;
  const externalId = sandbox ? "drip-sandbox" : "drip-intake";
  // Ruling C4 (migration 0201): the system groups carry an explicit marker so
  // the attribution resolver exempts them from R3 without hard-coded ids. The
  // ON CONFLICT branch heals a row created before 0201.
  const systemRole = sandbox ? "drip_sandbox" : "drip_intake";

  const rows = (await dbc.execute(sql`
    INSERT INTO contact_groups (contact_group_id, org_id, name, description, status, system_role)
    VALUES (${externalId}, ${orgId}::uuid, ${name},
            ${sandbox
              ? "Sandbox partner leads. Stored and visible, never messaged."
              : "Contacts created from real-time partner lead intake."},
            'active', ${systemRole})
    ON CONFLICT (contact_group_id) DO UPDATE SET system_role = EXCLUDED.system_role
    RETURNING id
  `)) as unknown as { id: number }[];

  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`ensureDripGroup: no row for ${externalId}`);
  return id;
}

/** Display name of a partner x tag group, e.g. "pml-aca". */
export function partnerTagGroupName(partnerSlug: string, interestTag: string | null): string {
  const tag = (interestTag ?? "").trim().toLowerCase();
  return `${partnerSlug.trim().toLowerCase()}-${tag || "untagged"}`;
}

/**
 * Resolve (creating if absent) the per-partner x tag group, e.g. "pml-aca".
 * Real leads only — a sandbox lead must never join a group a campaign could
 * target (see the sandbox note above).
 *
 * ⚠️ The external key carries the ORG ID. `contact_group_id` is unique across
 * ALL orgs, and the upsert below returns whichever row owns the key — so a bare
 * "drip-pml-aca" would hand org B the id of org A's group the day two orgs share
 * a partner slug, and its contacts would be written into another org's group.
 */
export async function ensurePartnerTagGroup(
  dbc: DbOrTx,
  {
    orgId,
    partnerSlug,
    interestTag,
    partnerId,
  }: {
    orgId: string;
    partnerSlug: string;
    interestTag: string | null;
    /**
     * The partner the group is credited to (ruling Q6, migration 0201). NOT
     * optional: an optional field hides the call sites nobody updated. On
     * conflict an existing link is kept (COALESCE) — the pipeline never moves
     * a group between partners.
     */
    partnerId: number;
  },
): Promise<number> {
  const name = partnerTagGroupName(partnerSlug, interestTag);
  const externalId = `drip:${orgId}:${name}`;

  const rows = (await dbc.execute(sql`
    INSERT INTO contact_groups (contact_group_id, org_id, name, description, status, partner_id)
    VALUES (${externalId}, ${orgId}::uuid, ${name},
            ${`Partner leads from "${partnerSlug}" tagged "${(interestTag ?? "").trim() || "(none)"}". Added automatically by drip intake.`},
            'active', ${partnerId})
    ON CONFLICT (contact_group_id) DO UPDATE
      SET partner_id = COALESCE(contact_groups.partner_id, EXCLUDED.partner_id)
    RETURNING id
  `)) as unknown as { id: number }[];

  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`ensurePartnerTagGroup: no row for ${externalId}`);
  return id;
}

/**
 * Idempotent membership. Mirrors /api/contacts/bulk-apply-groups.
 *
 * A contact arriving twice from a partner must not error, and must not create a
 * second membership row.
 */
export async function addContactsToGroup(
  dbc: DbOrTx,
  {
    orgId,
    groupId,
    contactIds,
    createdAt,
  }: {
    orgId: string;
    groupId: number;
    contactIds: string[];
    /**
     * The membership's stamp (ruling Q2): for a drip partner×tag group this is
     * the lead's DELIVERY time (`lead_inbox.received_at`), because
     * `contact_contact_groups.created_at` means "appeared" to the attribution
     * resolver. Omitted ⇒ `now()` (the system groups, every other writer).
     * ON CONFLICT DO NOTHING keeps the first delivery.
     */
    createdAt?: Date | string;
  },
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const stamp =
    createdAt === undefined
      ? sql`now()`
      : sql`${createdAt instanceof Date ? createdAt.toISOString() : createdAt}::timestamptz`;
  const values = contactIds.map(
    (cid) => sql`(${cid}::uuid, ${groupId}, ${orgId}::uuid, ${stamp})`,
  );
  const rows = (await dbc.execute(sql`
    INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id, created_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT DO NOTHING
    RETURNING contact_id
  `)) as unknown as { contact_id: string }[];
  return rows.length;
}
