import { sql, type SQL } from "drizzle-orm";

import {
  DEFAULT_LIFECYCLE_THRESHOLDS as D,
  type LifecycleThresholds,
} from "@/lib/engagement/constants";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// EFFECTIVE THRESHOLDS (spec §3.3) — ONE resolution, shared by the job
// (lib/engagement/refresh.ts) and the settings preview (lib/engagement/preview.ts).
//
//   org value = the org's lifecycle_settings row, else the code defaults
//   contact   = the STRICTEST value across the contact's ACTIVE groups:
//               lowest freeze_after_messages, LONGEST freeze_cadence_days,
//               shortest suppress_after_days, lowest suppress_min_freeze_messages.
//               A group with a blank override contributes the org value, so a
//               contact in one overriding group and one plain group gets the org
//               value wherever the plain group is stricter.
//   hot_days / warm_days are org-wide; no per-group column exists.
//
// Only contacts in at least one active group CARRYING an override land in
// eng_grp_thr; everyone else reads the org row, so this costs nothing until
// somebody sets an override.
// =============================================================================

export type GroupOverrideKey =
  | "freeze_after_messages"
  | "freeze_cadence_days"
  | "suppress_after_days"
  | "suppress_min_freeze_messages";

export const GROUP_OVERRIDE_KEYS: readonly GroupOverrideKey[] = [
  "freeze_after_messages",
  "freeze_cadence_days",
  "suppress_after_days",
  "suppress_min_freeze_messages",
] as const;

export interface ThresholdSourceOptions {
  /** Proposed org values (the settings preview). Omitted ⇒ the saved row. */
  proposedOrg?: LifecycleThresholds;
  /** Proposed override for ONE group (the group form's preview). null ⇒ cleared. */
  proposedGroup?: {
    groupId: number;
    overrides: Partial<Record<GroupOverrideKey, number | null>>;
  };
}

/** `g.<key>`, or the proposed value when this row is the group being previewed. */
function groupValue(key: GroupOverrideKey, opts?: ThresholdSourceOptions): SQL {
  const col = sql.raw(`g.${key}`);
  const p = opts?.proposedGroup;
  if (!p || !(key in p.overrides)) return col;
  const v = p.overrides[key] ?? null;
  return sql`CASE WHEN g.id = ${p.groupId} THEN ${v}::smallint ELSE ${col} END`;
}

/**
 * Creates `eng_org_thr` (one row) and `eng_grp_thr` (one row per contact whose
 * groups put an override in force). Both are ON COMMIT DROP, so the CALLER owns
 * the transaction.
 */
export async function createThresholdTempTables(
  dbc: DbOrTx,
  orgId: string,
  opts?: ThresholdSourceOptions,
): Promise<void> {
  const org = sql`${orgId}::uuid`;
  const p = opts?.proposedOrg;
  await dbc.execute(
    p
      ? sql`
        CREATE TEMP TABLE eng_org_thr ON COMMIT DROP AS
        SELECT ${p.hot_days}::int AS hot_days,
               ${p.warm_days}::int AS warm_days,
               ${p.freeze_after_messages}::int AS freeze_after_messages,
               ${p.freeze_cadence_days}::int AS freeze_cadence_days,
               ${p.suppress_after_days}::int AS suppress_after_days,
               ${p.suppress_min_freeze_messages}::int AS suppress_min_freeze_messages`
      : sql`
        CREATE TEMP TABLE eng_org_thr ON COMMIT DROP AS
        SELECT coalesce(ls.hot_days, ${D.hot_days})::int AS hot_days,
               coalesce(ls.warm_days, ${D.warm_days})::int AS warm_days,
               coalesce(ls.freeze_after_messages, ${D.freeze_after_messages})::int AS freeze_after_messages,
               coalesce(ls.freeze_cadence_days, ${D.freeze_cadence_days})::int AS freeze_cadence_days,
               coalesce(ls.suppress_after_days, ${D.suppress_after_days})::int AS suppress_after_days,
               coalesce(ls.suppress_min_freeze_messages, ${D.suppress_min_freeze_messages})::int AS suppress_min_freeze_messages
        FROM (SELECT 1) one
        LEFT JOIN lifecycle_settings ls ON ls.org_id = ${org}`,
  );

  const fam = groupValue("freeze_after_messages", opts);
  const fcd = groupValue("freeze_cadence_days", opts);
  const sad = groupValue("suppress_after_days", opts);
  const smm = groupValue("suppress_min_freeze_messages", opts);
  // Membership of the aggregate is judged on the SAVED overrides, plus the group
  // being previewed: a preview that adds this org's FIRST override still has to
  // reach that group's contacts.
  const hasSavedOverride = sql`(g2.freeze_after_messages IS NOT NULL OR g2.freeze_cadence_days IS NOT NULL
                                OR g2.suppress_after_days IS NOT NULL OR g2.suppress_min_freeze_messages IS NOT NULL)`;
  const previewedGroup = opts?.proposedGroup
    ? sql` OR g2.id = ${opts.proposedGroup.groupId}`
    : sql``;
  await dbc.execute(sql`
    CREATE TEMP TABLE eng_grp_thr ON COMMIT DROP AS
    SELECT ccg.contact_id,
           min(coalesce(${fam}, o.freeze_after_messages))::int AS freeze_after_messages,
           max(coalesce(${fcd}, o.freeze_cadence_days))::int AS freeze_cadence_days,
           min(coalesce(${sad}, o.suppress_after_days))::int AS suppress_after_days,
           min(coalesce(${smm}, o.suppress_min_freeze_messages))::int AS suppress_min_freeze_messages,
           coalesce(array_agg(g.id ORDER BY g.id) FILTER (
             WHERE g.freeze_after_messages IS NOT NULL OR g.freeze_cadence_days IS NOT NULL
                OR g.suppress_after_days IS NOT NULL OR g.suppress_min_freeze_messages IS NOT NULL
           ), '{}')::int[] AS override_group_ids
    FROM contact_contact_groups ccg
    JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
    CROSS JOIN eng_org_thr o
    WHERE ccg.org_id = ${org}
      AND ccg.contact_id IN (
        SELECT ccg2.contact_id FROM contact_contact_groups ccg2
        JOIN contact_groups g2 ON g2.id = ccg2.contact_group_id AND g2.status = 'active' AND g2.org_id = ${org}
        WHERE ccg2.org_id = ${org} AND (${hasSavedOverride}${previewedGroup}))
    GROUP BY ccg.contact_id`);
  await dbc.execute(sql`ANALYZE eng_grp_thr`);
}
