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

  const rows = (await dbc.execute(sql`
    INSERT INTO contact_groups (contact_group_id, org_id, name, description, status)
    VALUES (${externalId}, ${orgId}::uuid, ${name},
            ${sandbox
              ? "Sandbox partner leads. Stored and visible, never messaged."
              : "Contacts created from real-time partner lead intake."},
            'active')
    ON CONFLICT (contact_group_id) DO UPDATE SET name = contact_groups.name
    RETURNING id
  `)) as unknown as { id: number }[];

  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`ensureDripGroup: no row for ${externalId}`);
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
  { orgId, groupId, contactIds }: { orgId: string; groupId: number; contactIds: string[] },
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const values = contactIds.map(
    (cid) => sql`(${cid}::uuid, ${groupId}, ${orgId}::uuid)`,
  );
  const rows = (await dbc.execute(sql`
    INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT DO NOTHING
    RETURNING contact_id
  `)) as unknown as { contact_id: string }[];
  return rows.length;
}
