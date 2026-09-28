import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { GROUP_CLUSTERS } from "@/lib/reporting/group-clusters";
import {
  getGroupLifecycleBreakdown,
  getGroupLifecycleRollups,
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
// and waited 15-36s for them. The engagement job already runs every 15 minutes
// over the same tables, so it computes the whole thing there and stores ~126
// rows; the page reads those.
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
  /** true when these numbers were computed for this request, not read. */
  live: boolean;
  computed_ms: number;
}

const emptyPairs = (): Record<GroupLifecycleStatus, StatusPair> =>
  Object.fromEntries(
    GROUP_LIFECYCLE_STATUSES.map((s) => [s, { sendable: 0, available: 0 }]),
  ) as Record<GroupLifecycleStatus, StatusPair>;

const totalOf = (b: Record<GroupLifecycleStatus, StatusPair>): StatusPair => ({
  sendable: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].sendable, 0),
  available: GROUP_LIFECYCLE_STATUSES.reduce((a, s) => a + b[s].available, 0),
});

type DbOrTx = Pick<typeof db, "execute">;

/**
 * Recompute the whole table and store it. Called by the engagement job every
 * 15 minutes, and by the page's "Refresh now" button.
 *
 * ⚠️ DELETE-then-INSERT for the org, in one transaction. An upsert cannot
 * remove a row that should no longer exist — an archived contact group, or a
 * (group, status) pair that has emptied — and those would sit in the table
 * forever, reported as real.
 */
export async function refreshGroupLifecycleRollup(
  dbc: DbOrTx,
  opts: { orgId: string; recentDays?: number },
): Promise<{ rows: number; durationMs: number; recentDays: number }> {
  const started = Date.now();
  const recentDays = opts.recentDays ?? DEFAULT_RECENT_DAYS;
  const org = sql`${opts.orgId}::uuid`;

  const [table, rollups] = await Promise.all([
    getGroupLifecycleBreakdown({ orgId: opts.orgId, recentDays }),
    getGroupLifecycleRollups({ orgId: opts.orgId, recentDays }),
  ]);

  const values: ReturnType<typeof sql>[] = [];
  const push = (kind: string, key: string, r: GroupLifecycleRow) => {
    for (const st of GROUP_LIFECYCLE_STATUSES) {
      const p = r.by_status[st];
      values.push(
        sql`(${org}, ${kind}, ${key}, ${st}, ${p.sendable}, ${p.available}, ${recentDays}, now())`,
      );
    }
  };
  for (const g of table.groups) push("group", String(g.group_id), g);
  for (const c of rollups.clusters) push("cluster", c.key, c);
  push("all", "__all__", rollups.distinct_total);

  await dbc.execute(
    sql`DELETE FROM group_lifecycle_rollup WHERE org_id = ${org}`,
  );
  if (values.length > 0) {
    await dbc.execute(sql`
      INSERT INTO group_lifecycle_rollup
        (org_id, row_kind, row_key, status, sendable, available, recent_days, computed_at)
      VALUES ${sql.join(values, sql`, `)}`);
  }
  return { rows: values.length, durationMs: Date.now() - started, recentDays };
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

/** Shared shaping, so the stored and live paths return the same object. */
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
 * Compute now and return it, storing the result only when it answers the
 * question the store is for (N = 3). "Refresh now" and any other N both land
 * here; the difference is whether it is worth keeping.
 */
export async function computeGroupLifecycleNow(opts: {
  orgId: string;
  recentDays: number;
}): Promise<StoredGroupLifecycle> {
  const started = Date.now();
  const storeIt = opts.recentDays === DEFAULT_RECENT_DAYS;

  if (storeIt) {
    await refreshGroupLifecycleRollup(db, opts);
    const read = await readStoredGroupLifecycle({ orgId: opts.orgId });
    return { ...read, live: true, computed_ms: Date.now() - started };
  }

  // ⚠️ NOT WRITTEN. The store answers for N = 3; writing an N = 7 result into
  // it would leave the next page load showing a number for a question nobody
  // asked, with a timestamp that looked fresh.
  const [table, rollups, meta] = await Promise.all([
    getGroupLifecycleBreakdown({ orgId: opts.orgId, recentDays: opts.recentDays }),
    getGroupLifecycleRollups({ orgId: opts.orgId, recentDays: opts.recentDays }),
    db.execute(sql`
      SELECT id::text AS id, contact_group_id AS code, name
      FROM contact_groups
      WHERE org_id = ${opts.orgId}::uuid AND archived_at IS NULL
      ORDER BY name`) as unknown as Promise<
      { id: string; code: string; name: string }[]
    >,
  ]);
  void meta;
  return {
    groups: table.groups,
    clusters: rollups.clusters,
    distinct_total: rollups.distinct_total,
    recent_days: opts.recentDays,
    computed_at: new Date().toISOString(),
    live: true,
    computed_ms: Date.now() - started,
  };
}
