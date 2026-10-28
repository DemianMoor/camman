import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";

// CARRIER-REJECTION ELIGIBILITY (PR 2, ClickUp 1amdve2850v).
//
// The ONE definition of "this contact's number is carrier-rejected", read by
// every eligibility path while org_settings.carrier_rejection_suppression_enabled
// is on: the campaign audience source (preview, snapshot, draft counts — see
// excludeCarrierRejected), stage materialization (the `carrier_rejected` layer
// in lib/sends/eligibility.ts) and drip routing (lib/drip/routing-eval.ts, the
// same join inline for one contact).
//
// NOT an opt-out. Nothing here writes; turning the toggle off makes these
// numbers eligible again. Rows already materialized as pending are left alone —
// the drain does not re-check this (spec, owner 2026-10-23).

/** org_settings.carrier_rejection_suppression_enabled. No row ⇒ off (the column default). */
export async function isCarrierRejectionSuppressionOn(orgId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT carrier_rejection_suppression_enabled AS enabled FROM org_settings
    WHERE org_id = ${orgId}::uuid
  `)) as unknown as { enabled: boolean }[];
  return rows[0]?.enabled === true;
}

/**
 * The contacts whose phone is in carrier_rejected_phones, as `SELECT contact_id`.
 * Keyed by phone, so every contact row on a flagged number is caught. Served by
 * contacts' unique (org_id, phone_number).
 */
export function carrierRejectedContactsSql(orgId: string): SQL {
  return sql`
    SELECT c.id AS contact_id
    FROM carrier_rejected_phones crp
    JOIN contacts c ON c.org_id = crp.org_id AND c.phone_number = crp.phone
    WHERE crp.org_id = ${orgId}::uuid
  `;
}

/**
 * `relation` (any SELECT exposing contact_id) minus carrier-rejected contacts.
 * Returned UNCHANGED when `on` is false, so every flag-off statement is
 * byte-identical to before this feature. An anti-join, not `NOT IN`: a NOT IN
 * subquery only hashes while it fits work_mem, and degrades to a per-row
 * rescan once the flagged set outgrows it.
 */
export function excludeCarrierRejected(relation: SQL, orgId: string, on: boolean): SQL {
  if (!on) return relation;
  return sql`
    SELECT cr_rel.* FROM (${relation}) cr_rel
    WHERE NOT EXISTS (
      SELECT 1 FROM contacts cr_c
      JOIN carrier_rejected_phones cr_p
        ON cr_p.org_id = cr_c.org_id AND cr_p.phone = cr_c.phone_number
      WHERE cr_c.id = cr_rel.contact_id AND cr_c.org_id = ${orgId}::uuid
    )
  `;
}
