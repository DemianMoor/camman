import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
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
  type GroupLifecycleRow,
  type GroupLifecycleStatus,
  type StatusPair,
} from "@/lib/reporting/group-lifecycle-types";

// Re-exported so callers can keep importing everything from one place.
export {
  DEFAULT_RECENT_DAYS,
  GROUP_LIFECYCLE_STATUSES,
  MAX_RECENT_DAYS,
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
// ⚠️ THE FLAGS ARE COMPUTED ONCE, INTO A TEMP TABLE, AND EVERYTHING ELSE IS
// DERIVED FROM IT (2026-11-13). Until then the group grid and the cluster /
// distinct rows were two statements, run in parallel, that each re-derived the
// same per-contact flags (in use / blocked / opted out) over ~1M contacts —
// ~30-43 s EACH on production — each with its own now() and in-use set, so the
// two halves of one stored table could describe different instants. Now: one
// transaction, the flags materialized once into an ON COMMIT DROP temp table
// and ANALYZEd (real row counts for the planner — the same reason as the
// snapshot's temp table in lib/audience-snapshot.ts), then ONE statement
// derives the grid, the clusters and the distinct total from it. The stored
// rows are identical to the two-pass ones: scripts/test-group-lifecycle.ts
// PART M diffs them against a frozen copy (scripts/_legacy-group-lifecycle.ts)
// inside one REPEATABLE READ snapshot.
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const emptyPairs = (): Record<GroupLifecycleStatus, StatusPair> =>
  Object.fromEntries(
    GROUP_LIFECYCLE_STATUSES.map((s) => [s, { sendable: 0, available: 0 }]),
  ) as Record<GroupLifecycleStatus, StatusPair>;

const totalOf = (b: Record<GroupLifecycleStatus, StatusPair>): StatusPair => ({
  sendable: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].sendable, 0),
  available: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].available, 0),
});

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
 * Give the next statement whatever is left of the caller's budget. Applied
 * before EVERY heavy statement, not once: statement_timeout is per statement,
 * so one fixed value would let several statements together run past the
 * route's maxDuration — and a Vercel kill is a bare 504 while the SQL keeps
 * running. SET LOCAL only: a session SET leaks onto the pooler's shared
 * backends (2026-10-22).
 */
export async function spendBudget(tx: Tx, deadline: number): Promise<void> {
  const ms = Math.max(1, Math.floor(deadline - Date.now()));
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${ms}ms'`));
}

export interface GroupLifecycleComputed {
  groups: GroupLifecycleRow[];
  clusters: GroupLifecycleRow[];
  distinct_total: GroupLifecycleRow;
  recent_days: number;
}

/**
 * The whole table — group grid, cluster rows, distinct total — from ONE pass
 * over the per-contact flags.
 *
 * MUST run inside a transaction (the temp table is ON COMMIT DROP). Writes
 * nothing persistent. `deadline` is an absolute Date.now() value: every
 * statement gets SET LOCAL statement_timeout = what is left of it, so the
 * compute stops before the caller's limit with a 57014 rather than a 504.
 *
 * ⚠️ WHY THE CLUSTER FIGURES ARE NOT count(DISTINCT contact_id). The obvious
 * form — GROUP BY cluster with count(DISTINCT) over the membership rows — is
 * correct and costs ~6s of an 8.2s statement, because it sorts 1.1M uuids once
 * per aggregation. Collapsing to ONE ROW PER (cluster, contact) first turns it
 * into a plain count(*). Driven entirely by the config, so a new cluster stays
 * a one-line edit.
 */
export async function computeGroupLifecycle(
  tx: Tx,
  opts: { orgId: string; recentDays: number; deadline: number },
): Promise<GroupLifecycleComputed> {
  const { orgId, deadline } = opts;
  const org = sql`${orgId}::uuid`;
  const recentDays = Math.min(
    Math.max(1, Math.floor(opts.recentDays)),
    MAX_RECENT_DAYS,
  );
  const posture = await isDripPostureOn(orgId);

  // Re-runnable inside one transaction (the identity bar computes twice).
  // client_min_messages only silences the "does not exist, skipping" NOTICE.
  await tx.execute(sql.raw("SET LOCAL client_min_messages = warning"));
  await tx.execute(sql`DROP TABLE IF EXISTS gl_flags`);
  await spendBudget(tx, deadline);
  await tx.execute(sql`
    CREATE TEMP TABLE gl_flags ON COMMIT DROP AS
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
    )
    -- ⚠️ ONE ROW PER CONTACT. Deciding availability after the fan-out to
    -- memberships is the slow shape.
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
  `);
  await spendBudget(tx, deadline);
  await tx.execute(sql`ANALYZE gl_flags`);

  await spendBudget(tx, deadline);
  const rows = (await tx.execute(sql`
    WITH membership AS (
      SELECT ccg.contact_group_id AS gid, g.contact_group_id AS code,
             f.id AS contact_id, f.st, f.avail
      FROM contact_contact_groups ccg
      JOIN contact_groups g
        ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
      JOIN gl_flags f ON f.id = ccg.contact_id
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
    SELECT 'group' AS kind, gid::text AS key, st,
           count(*)::int AS sendable,
           count(*) FILTER (WHERE avail)::int AS available
    FROM membership GROUP BY gid, st
    UNION ALL
    SELECT 'cluster', ck, st, count(*)::int,
           count(*) FILTER (WHERE avail)::int
    FROM cluster_member GROUP BY ck, st
    UNION ALL
    SELECT 'all', '__all__', st, count(*)::int,
           count(*) FILTER (WHERE avail)::int
    FROM any_member GROUP BY st
  `)) as unknown as {
    kind: "group" | "cluster" | "all";
    key: string;
    st: string;
    sendable: number;
    available: number;
  }[];

  await spendBudget(tx, deadline);
  const meta = (await tx.execute(sql`
    SELECT id::text AS id, contact_group_id AS code, name
    FROM contact_groups
    WHERE org_id = ${org} AND archived_at IS NULL
    ORDER BY name`)) as unknown as { id: string; code: string; name: string }[];

  const bucket = new Map<string, Record<GroupLifecycleStatus, StatusPair>>();
  for (const r of rows) {
    const k = `${r.kind}:${r.key}`;
    if (!bucket.has(k)) bucket.set(k, emptyPairs());
    const st = r.st as GroupLifecycleStatus;
    if (!GROUP_LIFECYCLE_STATUSES.includes(st)) continue;
    bucket.get(k)![st] = {
      sendable: Number(r.sendable),
      available: Number(r.available),
    };
  }

  const groups: GroupLifecycleRow[] = meta.map((g) => {
    const by = bucket.get(`group:${g.id}`) ?? emptyPairs();
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
  const clusters: GroupLifecycleRow[] = GROUP_CLUSTERS.map((c) => {
    const by = bucket.get(`cluster:${c.key}`) ?? emptyPairs();
    return {
      kind: "cluster",
      key: c.key,
      label: c.label,
      group_id: null,
      code: null,
      clustered: true,
      by_status: by,
      total: totalOf(by),
    };
  });
  const allBy = bucket.get("all:__all__") ?? emptyPairs();

  return {
    groups,
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
  };
}
