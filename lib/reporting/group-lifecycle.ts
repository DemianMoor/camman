import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { isDripPostureOn, inUseSetBody } from "@/lib/drip/in-use";
import {
  CLUSTERED_CODES,
  GROUP_CLUSTERS,
  type GroupCluster,
} from "@/lib/reporting/group-clusters";
import {
  DEFAULT_RECENT_DAYS,
  GROUP_LIFECYCLE_STATUSES,
  MAX_RECENT_DAYS,
  type GroupLifecycleReport,
  type GroupLifecycleRollups,
  type GroupLifecycleRow,
  type GroupLifecycleStatus,
  type StatusPair,
} from "@/lib/reporting/group-lifecycle-types";

// Re-exported so callers can keep importing everything from one place.
export {
  DEFAULT_RECENT_DAYS,
  GROUP_LIFECYCLE_STATUSES,
  MAX_RECENT_DAYS,
  type GroupLifecycleReport,
  type GroupLifecycleRollups,
  type GroupLifecycleRow,
  type GroupLifecycleStatus,
  type StatusPair,
};

// ── CONTACT GROUP × LIFECYCLE, FOR SIZING A DAILY CAMPAIGN ──────────────────
//
// Two numbers per group per status:
//
//   sendable        active, eligible, not opted out
//   available_today sendable MINUS in use by an active campaign, MINUS Freeze
//                   contacts still inside their own cadence, MINUS anyone
//                   messaged in the last N days (N editable, default 3)
//
// ⚠️ AVAILABILITY IS DECIDED ONCE PER CONTACT, THEN FANNED OUT TO MEMBERSHIPS.
// That is the whole performance design, and it was measured rather than
// guessed. Deciding it per MEMBERSHIP row instead — the obvious shape — costs
// median 2,659ms / worst 2,690ms against this shape's 1,950 / 1,957, because
// there are 1,129,787 memberships over 973,731 contacts and the anti-joins then
// run on the larger relation. Four interleaved runs each; the earlier
// single-run figures for the same shapes ranged 2.1s to 15.9s to a statement
// timeout with no code change, so only the repeated spread is meaningful.
//
// ⚠️ STATUS COMES FROM contacts.lifecycle_status, the indexed projection — not
// contact_engagement (owner, 2026-09-27). contact_engagement is still read, but
// only for the two facts the projection does not carry: the freeze cadence and
// last_sent_at.
//
// ⚠️ THIS IS A SIZING ESTIMATE, NOT THE SEND-TIME DECISION. The freeze check
// here reads contact_engagement, which a cron refreshes every 15 minutes; the
// send path re-checks freeze against stage_sends LIVE, because another campaign
// may have messaged the same contact minutes ago. So the send can drop contacts
// this table counted. Sizing tolerates that; a guarantee would not.

const emptyPairs = (): Record<GroupLifecycleStatus, StatusPair> =>
  Object.fromEntries(
    GROUP_LIFECYCLE_STATUSES.map((s) => [s, { sendable: 0, available: 0 }]),
  ) as Record<GroupLifecycleStatus, StatusPair>;

/** The cluster mapping as a VALUES list the statement can join against. */
function clusterValues(clusters: readonly GroupCluster[]): SQL {
  const rows = clusters.flatMap((c) =>
    c.codes.map((code) => sql`(${code}, ${c.key})`),
  );
  if (rows.length === 0)
    return sql`(SELECT NULL::text AS code, NULL::text AS ck WHERE false)`;
  return sql`(VALUES ${sql.join(rows, sql`, `)}) AS cm(code, ck)`;
}

/**
 * ⚠️ WHY THE CLUSTER FIGURES ARE NOT count(DISTINCT contact_id).
 *
 * The obvious form — GROUP BY cluster with count(DISTINCT) over the membership
 * rows — is correct and costs ~6s of an 8.2s statement, because it sorts 1.1M
 * uuids once per aggregation. Collapsing to ONE ROW PER CONTACT first, then
 * unnesting each contact into the clusters it belongs to, turns all of it into
 * a plain count(*) over ~667K rows. Driven entirely by the config, so a new
 * cluster stays a one-line edit.
 */

export async function getGroupLifecycleBreakdown(opts: {
  orgId: string;
  recentDays?: number;
}): Promise<GroupLifecycleReport> {
  const started = Date.now();
  const { orgId } = opts;
  const org = sql`${orgId}::uuid`;
  const recentDays = Math.min(
    Math.max(1, Math.floor(opts.recentDays ?? DEFAULT_RECENT_DAYS)),
    MAX_RECENT_DAYS,
  );
  const posture = await isDripPostureOn(orgId);

  const rows = (await db.execute(sql`
    WITH in_use AS (${inUseSetBody(orgId, posture)}),
    -- Everyone the send would skip today for a reason that is not opting out:
    -- a Freeze contact inside their own cadence, or anyone messaged recently.
    blocked AS (
      SELECT contact_id FROM contact_engagement
      WHERE org_id = ${org}
        AND (
          (status = 'freeze'
            AND last_sent_at > now() - make_interval(days => freeze_cadence_days))
          OR last_sent_at > now() - make_interval(days => ${recentDays}::int)
        )
    ),
    opted AS (
      SELECT DISTINCT contact_id FROM opt_outs
      WHERE org_id = ${org} AND contact_id IS NOT NULL
    ),
    -- ⚠️ ONE ROW PER CONTACT. Everything below joins to this; deciding
    -- availability after the fan-out to memberships is the slow shape.
    flags AS (
      SELECT c.id, c.lifecycle_status AS st,
             (u.contact_id IS NULL AND b.contact_id IS NULL) AS avail
      FROM contacts c
      LEFT JOIN opted o ON o.contact_id = c.id
      LEFT JOIN in_use u ON u.contact_id = c.id
      LEFT JOIN blocked b ON b.contact_id = c.id
      WHERE c.org_id = ${org}
        AND c.archived_at IS NULL
        AND c.messaging_status = 'eligible'
        AND o.contact_id IS NULL
    ),
    membership AS (
      SELECT ccg.contact_group_id AS gid, g.contact_group_id AS code,
             f.id AS contact_id, f.st, f.avail
      FROM contact_contact_groups ccg
      JOIN contact_groups g
        ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
      JOIN flags f ON f.id = ccg.contact_id
      WHERE ccg.org_id = ${org}
    )
    SELECT gid::text AS key, st,
           count(*)::int AS sendable,
           count(*) FILTER (WHERE avail)::int AS available
    FROM membership GROUP BY 1, 2
  `)) as unknown as {
    key: string;
    st: string;
    sendable: number;
    available: number;
  }[];

  const meta = (await db.execute(sql`
    SELECT id::text AS id, contact_group_id AS code, name
    FROM contact_groups
    WHERE org_id = ${org} AND archived_at IS NULL
    ORDER BY name`)) as unknown as { id: string; code: string; name: string }[];

  const bucket = new Map<string, Record<GroupLifecycleStatus, StatusPair>>();
  for (const r of rows) {
    const k = r.key;
    if (!bucket.has(k)) bucket.set(k, emptyPairs());
    const st = r.st as GroupLifecycleStatus;
    if (!GROUP_LIFECYCLE_STATUSES.includes(st)) continue;
    bucket.get(k)![st] = {
      sendable: Number(r.sendable),
      available: Number(r.available),
    };
  }
  const totalOf = (b: Record<GroupLifecycleStatus, StatusPair>): StatusPair => ({
    sendable: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].sendable, 0),
    available: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].available, 0),
  });

  const groups: GroupLifecycleRow[] = meta.map((g) => {
    const by = bucket.get(g.id) ?? emptyPairs();
    return {
      kind: "group",
      key: g.id,
      label: g.name,
      group_id: Number(g.id),
      code: g.code,
      clustered: CLUSTERED_CODES.has(g.code),
      by_status: by,
      total: totalOf(by),
    };
  });

  return {
    groups,
    recent_days: recentDays,
    computed_ms: Date.now() - started,
  };
}

/**
 * Cluster rollups + the distinct footer. See GroupLifecycleRollups for why this
 * is a second request rather than more columns on the first.
 */
export async function getGroupLifecycleRollups(opts: {
  orgId: string;
  recentDays?: number;
}): Promise<GroupLifecycleRollups> {
  const started = Date.now();
  const { orgId } = opts;
  const org = sql`${orgId}::uuid`;
  const recentDays = Math.min(
    Math.max(1, Math.floor(opts.recentDays ?? DEFAULT_RECENT_DAYS)),
    MAX_RECENT_DAYS,
  );
  const posture = await isDripPostureOn(orgId);

  const rows = (await db.execute(sql`
    WITH in_use AS (${inUseSetBody(orgId, posture)}),
    blocked AS (
      SELECT contact_id FROM contact_engagement
      WHERE org_id = ${org}
        AND (
          (status = 'freeze'
            AND last_sent_at > now() - make_interval(days => freeze_cadence_days))
          OR last_sent_at > now() - make_interval(days => ${recentDays}::int)
        )
    ),
    opted AS (
      SELECT DISTINCT contact_id FROM opt_outs
      WHERE org_id = ${org} AND contact_id IS NOT NULL
    ),
    flags AS (
      SELECT c.id, c.lifecycle_status AS st,
             (u.contact_id IS NULL AND b.contact_id IS NULL) AS avail
      FROM contacts c
      LEFT JOIN opted o ON o.contact_id = c.id
      LEFT JOIN in_use u ON u.contact_id = c.id
      LEFT JOIN blocked b ON b.contact_id = c.id
      WHERE c.org_id = ${org} AND c.archived_at IS NULL
        AND c.messaging_status = 'eligible' AND o.contact_id IS NULL
    ),
    membership AS (
      SELECT g.contact_group_id AS code, f.id AS contact_id, f.st, f.avail
      FROM contact_contact_groups ccg
      JOIN contact_groups g
        ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
      JOIN flags f ON f.id = ccg.contact_id
      WHERE ccg.org_id = ${org}
    ),
    -- ⚠️ DISTINCT contact per cluster, NOT the sum of the cluster's group rows.
    -- A contact in Weight Loss AND Weight Loss Y is ONE person to send to;
    -- summing would overstate the cluster by its internal overlap, which is
    -- precisely the number being used to size a campaign.
    cluster_member AS (
      SELECT DISTINCT cm.ck, m.contact_id, m.st, m.avail
      FROM membership m
      JOIN ${clusterValues(GROUP_CLUSTERS)} ON cm.code = m.code
    ),
    any_member AS (
      SELECT DISTINCT contact_id, st, avail FROM membership
    )
    SELECT ck AS key, st, count(*)::int AS sendable,
           count(*) FILTER (WHERE avail)::int AS available
    FROM cluster_member GROUP BY 1, 2
    UNION ALL
    SELECT '__all__', st, count(*)::int,
           count(*) FILTER (WHERE avail)::int
    FROM any_member GROUP BY 1, 2
  `)) as unknown as {
    key: string;
    st: string;
    sendable: number;
    available: number;
  }[];

  const bucket = new Map<string, Record<GroupLifecycleStatus, StatusPair>>();
  for (const r of rows) {
    if (!bucket.has(r.key)) bucket.set(r.key, emptyPairs());
    const st = r.st as GroupLifecycleStatus;
    if (!GROUP_LIFECYCLE_STATUSES.includes(st)) continue;
    bucket.get(r.key)![st] = {
      sendable: Number(r.sendable),
      available: Number(r.available),
    };
  }
  const totalOf = (b: Record<GroupLifecycleStatus, StatusPair>): StatusPair => ({
    sendable: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].sendable, 0),
    available: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].available, 0),
  });

  const clusters: GroupLifecycleRow[] = GROUP_CLUSTERS.map((c) => {
    const by = bucket.get(c.key) ?? emptyPairs();
    return {
      kind: "cluster" as const,
      key: c.key,
      label: c.label,
      group_id: null,
      code: null,
      clustered: true,
      by_status: by,
      total: totalOf(by),
    };
  });
  const allBy = bucket.get("__all__") ?? emptyPairs();

  return {
    clusters,
    distinct_total: {
      kind: "cluster",
      key: "__all__",
      label: "Distinct contacts (all groups)",
      group_id: null,
      code: null,
      clustered: true,
      by_status: allBy,
      total: totalOf(allBy),
    },
    recent_days: recentDays,
    computed_ms: Date.now() - started,
  };
}
