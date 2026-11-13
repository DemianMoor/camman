import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import { GROUP_CLUSTERS } from "@/lib/reporting/group-clusters";
import {
  computeGroupLifecycle,
  spendBudget,
  type GroupLifecycleComputed,
} from "@/lib/reporting/group-lifecycle";
import {
  DEFAULT_RECENT_DAYS,
  GROUP_LIFECYCLE_STATUSES,
  type GroupLifecycleRow,
  type GroupLifecycleStatus,
  type StatusPair,
} from "@/lib/reporting/group-lifecycle-types";

// ── THE STORED GROUP × LIFECYCLE TABLE (migration 0193) ─────────────────────
//
// The report used to compute everything on read: the page issued two requests
// and waited 15-36s for them. Now an HOURLY cron
// (/api/cron/refresh-group-lifecycle, :13) computes the whole thing and stores
// ~126 rows; the page reads those. The "Refresh now" button recomputes on
// demand through refreshGroupLifecycleOnDemand below, under the SAME lease as
// the cron, so the two can never run at once.
//
// ⚠️ WHY THIS IS STORED RATHER THAN TUNED. The cost is the availability
// computation over contact_engagement plus the rollups' DISTINCT across ~1.1M
// membership rows — and attribution between those two moved by 5x between
// measurement runs on the live database (the engagement join measured 13,720ms
// in one run and 2,532ms in the next; rewriting its OR as an indexable UNION
// measured WORSE on median and its range overlapped everything). A query whose
// cost cannot be attributed reliably is one to move off the read path, not one
// to keep tuning.
//
// ⚠️ ONLY N = 3 IS STORED. Any other N is computed on demand and never written.
// Each row carries the `recent_days` it answers for, so a stored number can
// never be mistaken for an answer to a different question.

export interface StoredGroupLifecycle {
  groups: GroupLifecycleRow[];
  clusters: GroupLifecycleRow[];
  distinct_total: GroupLifecycleRow;
  recent_days: number;
  /** null when the job has never run for this org — the page says so. */
  computed_at: string | null;
  /** true when these numbers were computed for this request (any N ≠ 3), not read. */
  live: boolean;
  computed_ms: number;
}

/** POST /api/reports/group-lifecycle/refresh — what the button gets back. */
export type GroupLifecycleRefreshResult =
  /** recomputed now, or a run finished < REUSE_WINDOW_MS ago and was reused */
  | ({ outcome: "recomputed" | "reused" } & StoredGroupLifecycle)
  /**
   * Another run (the hourly cron, or another click) holds the lease. Nothing
   * was started; the client polls the cheap GET until computed_at moves past
   * this value.
   */
  | { outcome: "in_progress"; computed_at: string | null };

/**
 * One lease per org, shared by the hourly cron and the button. A cron_locks
 * ROW (lib/cron/keyed-lease.ts), never an advisory lock — those are unsafe
 * through the transaction pooler.
 */
export const groupLifecycleLeaseKey = (orgId: string) =>
  `group-lifecycle-rollup:${orgId}`;

/** A run that finished this recently is returned as-is instead of recomputed. */
export const REUSE_WINDOW_MS = 2 * 60 * 1000;

// The button's route has maxDuration = 120. The compute's statement budget sits
// well under it so a slow run ends in a 57014 the route turns into a clear JSON
// error, not a Vercel 504; the lease outlives both because a killed function's
// SQL keeps running until its statement_timeout.
export const ON_DEMAND_BUDGET_MS = 100_000;
const ON_DEMAND_LEASE_MS = 3 * 60 * 1000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const emptyPairs = (): Record<GroupLifecycleStatus, StatusPair> =>
  Object.fromEntries(
    GROUP_LIFECYCLE_STATUSES.map((s) => [s, { sendable: 0, available: 0 }]),
  ) as Record<GroupLifecycleStatus, StatusPair>;

const totalOf = (b: Record<GroupLifecycleStatus, StatusPair>): StatusPair => ({
  sendable: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].sendable, 0),
  available: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].available, 0),
});

export interface RollupRow {
  row_kind: "group" | "cluster" | "all";
  row_key: string;
  status: GroupLifecycleStatus;
  sendable: number;
  available: number;
}

/**
 * The rows the store holds for one computed table: every active group, every
 * cluster and the distinct total, each with EVERY status (zeros included).
 * Pure — the identity bars diff exactly this list.
 */
export function rollupRowsOf(t: GroupLifecycleComputed): RollupRow[] {
  const out: RollupRow[] = [];
  const push = (kind: RollupRow["row_kind"], key: string, r: GroupLifecycleRow) => {
    for (const st of GROUP_LIFECYCLE_STATUSES) {
      const p = r.by_status[st];
      out.push({ row_kind: kind, row_key: key, status: st, sendable: p.sendable, available: p.available });
    }
  };
  for (const g of t.groups) push("group", String(g.group_id), g);
  for (const c of t.clusters) push("cluster", c.key, c);
  push("all", "__all__", t.distinct_total);
  return out;
}

/**
 * Recompute the whole table and store it, INSIDE the caller's transaction:
 * the flags temp table, the derivation, the DELETE and the INSERT all commit
 * together. Readers therefore see the old rows or the new rows, never an empty
 * table between the two — and two writers serialize on the DELETE's row locks
 * instead of colliding on the primary key.
 *
 * ⚠️ DELETE-then-INSERT, not upsert. An upsert cannot remove a row that should
 * no longer exist — an archived contact group, or a (group, status) pair that
 * has emptied — and those would sit in the table forever, reported as real.
 *
 * Callers: the hourly cron and refreshGroupLifecycleOnDemand, both under
 * groupLifecycleLeaseKey(orgId).
 */
export async function refreshGroupLifecycleRollup(
  tx: Tx,
  opts: { orgId: string; deadline: number },
): Promise<{ rows: number; durationMs: number }> {
  const started = Date.now();
  const org = sql`${opts.orgId}::uuid`;
  const recentDays = DEFAULT_RECENT_DAYS;

  const table = await computeGroupLifecycle(tx, {
    orgId: opts.orgId,
    recentDays,
    deadline: opts.deadline,
  });
  const rows = rollupRowsOf(table);

  await spendBudget(tx, opts.deadline);
  await tx.execute(sql`DELETE FROM group_lifecycle_rollup WHERE org_id = ${org}`);
  if (rows.length > 0) {
    // statement_timestamp(), not now(): computed_at says when the numbers
    // LANDED (as it did before, when the INSERT autocommitted after the
    // compute), and it is one value for every row of the statement.
    await tx.execute(sql`
      INSERT INTO group_lifecycle_rollup
        (org_id, row_kind, row_key, status, sendable, available, recent_days, computed_at)
      VALUES ${sql.join(
        rows.map(
          (r) =>
            sql`(${org}, ${r.row_kind}, ${r.row_key}, ${r.status}, ${r.sendable}, ${r.available}, ${recentDays}, statement_timestamp())`,
        ),
        sql`, `,
      )}`);
  }
  return { rows: rows.length, durationMs: Date.now() - started };
}

/**
 * The button. Never two recomputes at once, never a recompute that would
 * repeat one that just finished:
 *
 *   - a run finished < REUSE_WINDOW_MS ago  → return it ("reused")
 *   - the lease is held (cron or a click)   → start nothing ("in_progress");
 *                                             the client waits for that run
 *   - otherwise                             → recompute + store ("recomputed")
 */
export async function refreshGroupLifecycleOnDemand(opts: {
  orgId: string;
}): Promise<GroupLifecycleRefreshResult> {
  const before = await readStoredGroupLifecycle({ orgId: opts.orgId });
  if (
    before.computed_at &&
    Date.now() - new Date(before.computed_at).getTime() < REUSE_WINDOW_MS
  ) {
    return { outcome: "reused", ...before };
  }

  const started = Date.now();
  const run = await withCronLease(
    groupLifecycleLeaseKey(opts.orgId),
    () =>
      db.transaction((tx) =>
        refreshGroupLifecycleRollup(tx, {
          orgId: opts.orgId,
          deadline: started + ON_DEMAND_BUDGET_MS,
        }),
      ),
    ON_DEMAND_LEASE_MS,
  );
  if (!run.ran) return { outcome: "in_progress", computed_at: before.computed_at };

  const after = await readStoredGroupLifecycle({ orgId: opts.orgId });
  return { outcome: "recomputed", ...after, computed_ms: Date.now() - started };
}

/**
 * Read the stored table. This is the page's normal path and must be fast: it
 * reads ~126 rows plus the group names.
 */
export async function readStoredGroupLifecycle(opts: {
  orgId: string;
}): Promise<StoredGroupLifecycle> {
  const started = Date.now();
  const org = sql`${opts.orgId}::uuid`;

  const [stored, meta] = await Promise.all([
    db.execute(sql`
      SELECT row_kind, row_key, status, sendable, available, recent_days,
             computed_at::text AS computed_at
      FROM group_lifecycle_rollup WHERE org_id = ${org}`) as unknown as Promise<
      {
        row_kind: string;
        row_key: string;
        status: string;
        sendable: number;
        available: number;
        recent_days: number;
        computed_at: string;
      }[]
    >,
    db.execute(sql`
      SELECT id::text AS id, contact_group_id AS code, name
      FROM contact_groups
      WHERE org_id = ${org} AND archived_at IS NULL
      ORDER BY name`) as unknown as Promise<
      { id: string; code: string; name: string }[]
    >,
  ]);

  return {
    ...shapeRows(stored, meta),
    computed_at: stored[0]?.computed_at ?? null,
    recent_days: stored[0]?.recent_days ?? DEFAULT_RECENT_DAYS,
    live: false,
    computed_ms: Date.now() - started,
  };
}

/** Shapes stored rows into the same object the live path returns. */
function shapeRows(
  stored: {
    row_kind: string;
    row_key: string;
    status: string;
    sendable: number;
    available: number;
  }[],
  meta: { id: string; code: string; name: string }[],
): Pick<StoredGroupLifecycle, "groups" | "clusters" | "distinct_total"> {
  const bucket = new Map<string, Record<GroupLifecycleStatus, StatusPair>>();
  for (const r of stored) {
    const k = `${r.row_kind}:${r.row_key}`;
    if (!bucket.has(k)) bucket.set(k, emptyPairs());
    const st = r.status as GroupLifecycleStatus;
    if (!GROUP_LIFECYCLE_STATUSES.includes(st)) continue;
    bucket.get(k)![st] = {
      sendable: Number(r.sendable),
      available: Number(r.available),
    };
  }
  const clusteredCodes = new Set(GROUP_CLUSTERS.flatMap((c) => c.codes));

  const groups: GroupLifecycleRow[] = meta.map((g) => {
    const by = bucket.get(`group:${g.id}`) ?? emptyPairs();
    return {
      kind: "group",
      key: g.id,
      label: g.name,
      group_id: Number(g.id),
      code: g.code,
      clustered: clusteredCodes.has(g.code),
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
  };
}

/**
 * Any N other than the stored 3: computed for this request and NEVER written.
 * The store answers for N = 3; writing an N = 7 result into it would leave the
 * next page load showing a number for a question nobody asked, with a
 * timestamp that looked fresh. Its own transaction only because the compute's
 * temp table needs one; it commits nothing persistent.
 */
export async function computeGroupLifecycleLive(opts: {
  orgId: string;
  recentDays: number;
  budgetMs: number;
}): Promise<StoredGroupLifecycle> {
  const started = Date.now();
  const t = await db.transaction((tx) =>
    computeGroupLifecycle(tx, {
      orgId: opts.orgId,
      recentDays: opts.recentDays,
      deadline: started + opts.budgetMs,
    }),
  );
  return {
    groups: t.groups,
    clusters: t.clusters,
    distinct_total: t.distinct_total,
    recent_days: t.recent_days,
    computed_at: new Date().toISOString(),
    live: true,
    computed_ms: Date.now() - started,
  };
}
