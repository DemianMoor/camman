import "server-only";

import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { withKeyedLease } from "@/lib/cron/keyed-lease";

// W2 Task 1 — contact_org_stats rollup helpers.
//
// FEATURE FLAG: set ROLLUP_CONTACT_STATS=0 in Vercel env to fall back to live
// aggregates instantly. Default is enabled (any other value, or unset).
export function isContactStatsRollupEnabled(): boolean {
  return process.env.ROLLUP_CONTACT_STATS !== "0";
}

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CarrierBreakdown {
  total: number;
  by_line_type: Record<string, number>;
  by_carrier_norm: Record<string, number>;
  by_messaging_status: { eligible: number; not_applicable: number };
}

export interface ContactBaseStats {
  total: number;
  archived: number;
  opt_out_count: number;
  opt_out_count_by_reason: {
    opt_out: number;
    scrubbed: number;
    bounced: number;
    suppressed: number;
  };
  opt_in_count: number;
  clicker_count: number;
}

// Read both stats blobs from the rollup table in one query.
export async function readContactOrgStats(
  dbc: DbOrTx,
  orgId: string,
): Promise<{ base: ContactBaseStats; carrier: CarrierBreakdown | null; updatedAt: Date | null }> {
  const rows = (await dbc.execute(sql`
    SELECT
      total_count,
      archived_count,
      opt_out_count,
      opt_out_by_reason,
      opt_in_count,
      clicker_count,
      carrier_breakdown,
      updated_at
    FROM contact_org_stats
    WHERE org_id = ${orgId}::uuid
  `)) as unknown as {
    total_count: number;
    archived_count: number;
    opt_out_count: number;
    opt_out_by_reason: { opt_out: number; scrubbed: number; bounced: number; suppressed: number };
    opt_in_count: number;
    clicker_count: number;
    carrier_breakdown: CarrierBreakdown | null;
    updated_at: string;
  }[];

  const row = rows[0];
  if (!row) {
    return {
      base: {
        total: 0, archived: 0, opt_out_count: 0,
        opt_out_count_by_reason: { opt_out: 0, scrubbed: 0, bounced: 0, suppressed: 0 },
        opt_in_count: 0, clicker_count: 0,
      },
      carrier: null,
      updatedAt: null,
    };
  }
  return {
    base: {
      total: Number(row.total_count),
      archived: Number(row.archived_count),
      opt_out_count: Number(row.opt_out_count),
      opt_out_count_by_reason: {
        opt_out: Number((row.opt_out_by_reason as { opt_out: number })?.opt_out ?? 0),
        scrubbed: Number((row.opt_out_by_reason as { scrubbed: number })?.scrubbed ?? 0),
        bounced: Number((row.opt_out_by_reason as { bounced: number })?.bounced ?? 0),
        suppressed: Number((row.opt_out_by_reason as { suppressed: number })?.suppressed ?? 0),
      },
      opt_in_count: Number(row.opt_in_count),
      clicker_count: Number(row.clicker_count),
    },
    carrier: row.carrier_breakdown ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
}

// Atomically increment a scalar counter. Used by writers (upload, opt-out poll,
// propagate-clickers) to keep the row current in real-time. Each call does one
// INSERT ... ON CONFLICT DO UPDATE — a single atomic write with no SELECT.
export async function bumpContactOrgStats(
  dbc: DbOrTx,
  orgId: string,
  delta: {
    total?: number;
    archived?: number;
    opt_out?: number;
    opt_out_by_reason?: { opt_out?: number; scrubbed?: number; bounced?: number; suppressed?: number };
    opt_in?: number;
    clicker?: number;
  },
): Promise<void> {
  const d = delta;
  const rd = d.opt_out_by_reason ?? {};

  await dbc.execute(sql`
    INSERT INTO contact_org_stats (
      org_id,
      total_count, archived_count,
      opt_out_count, opt_out_by_reason,
      opt_in_count, clicker_count,
      updated_at
    ) VALUES (
      ${orgId}::uuid,
      ${d.total ?? 0}, ${d.archived ?? 0},
      ${d.opt_out ?? 0},
      jsonb_build_object(
        'opt_out', ${rd.opt_out ?? 0},
        'scrubbed', ${rd.scrubbed ?? 0},
        'bounced', ${rd.bounced ?? 0},
        'suppressed', ${rd.suppressed ?? 0}
      ),
      ${d.opt_in ?? 0},
      ${d.clicker ?? 0},
      now()
    )
    ON CONFLICT (org_id) DO UPDATE SET
      total_count    = contact_org_stats.total_count    + EXCLUDED.total_count,
      archived_count = contact_org_stats.archived_count + EXCLUDED.archived_count,
      opt_out_count  = contact_org_stats.opt_out_count  + EXCLUDED.opt_out_count,
      opt_out_by_reason = jsonb_build_object(
        'opt_out',    coalesce((contact_org_stats.opt_out_by_reason->>'opt_out')::int,    0) + (EXCLUDED.opt_out_by_reason->>'opt_out')::int,
        'scrubbed',   coalesce((contact_org_stats.opt_out_by_reason->>'scrubbed')::int,   0) + (EXCLUDED.opt_out_by_reason->>'scrubbed')::int,
        'bounced',    coalesce((contact_org_stats.opt_out_by_reason->>'bounced')::int,    0) + (EXCLUDED.opt_out_by_reason->>'bounced')::int,
        'suppressed', coalesce((contact_org_stats.opt_out_by_reason->>'suppressed')::int, 0) + (EXCLUDED.opt_out_by_reason->>'suppressed')::int
      ),
      opt_in_count   = contact_org_stats.opt_in_count   + EXCLUDED.opt_in_count,
      clicker_count  = contact_org_stats.clicker_count  + EXCLUDED.clicker_count,
      updated_at     = now()
  `);
}

// ── Freshness: recompute on READ, not on a clock ──────────────────────────
//
// This used to be recomputed by a 1-minute cron. Measured on prod 2026-09-23:
// the cron ran 1,436x/day (verified 1.00/min over a 6-minute sample) at
// 1,441 ms and 708 blocks per run -- 20.18 h of database time, 17.9% of ALL
// time the database spent on anything, and ~272 GB read. What it served:
// contact_org_stats was SCANNED 155 times and UPDATED 50,374 times since
// 2026-05-07 (pg_stat_user_tables), i.e. ~325 recomputes per read, and only
// two endpoints read it at all (contacts/base-stats, contacts/carrier-stats).
//
// So the work now follows the reads. A reader triggers a recompute only when
// the last one is older than the documented 60-second freshness contract,
// which means the numbers a reader sees are no staler than before -- the cost
// is simply no longer paid 1,435 times over for nobody. The reader pays ~1.4 s
// when it does fire; both endpoints fetch these stats in the background, and
// neither page blocks on them.
//
// TTL basis is cron_locks.watermark, NOT contact_org_stats.updated_at:
// bumpContactOrgStats() also stamps updated_at, and a writer's increment is
// not a full recompute -- using it would skip the carrier_breakdown rebuild
// that is the whole reason this exists.
export const CONTACT_STATS_TTL_MS = 60_000;

// Long enough to cover a measured 1.4 s recompute many times over; short
// enough that a killed request cannot block the next read for long.
const CONTACT_STATS_LEASE_MS = 30_000;

export const contactStatsJobKey = (orgId: string) => `contact-stats:${orgId}`;

// Recompute contact_org_stats for this org if the last full recompute is older
// than CONTACT_STATS_TTL_MS. Concurrent callers (the contacts page fires BOTH
// endpoints at once) are collapsed by the lease: one recomputes, the other
// returns immediately and reads the row as it stands.
export async function ensureContactOrgStatsFresh(
  dbc: DbOrTx,
  orgId: string,
): Promise<void> {
  const key = contactStatsJobKey(orgId);
  const fresh = await dbc.execute(sql`
    SELECT 1 FROM cron_locks
    WHERE job_name = ${key}
      AND watermark > now() - ${CONTACT_STATS_TTL_MS} * interval '1 millisecond'
  `);
  if (fresh.length > 0) return;

  await withKeyedLease(dbc, key, CONTACT_STATS_LEASE_MS, async () => {
    await refreshContactOrgStats(dbc, orgId);
    // Stamped only after the recompute succeeds: a failed refresh must not buy
    // itself another TTL of silence.
    await dbc.execute(sql`
      UPDATE cron_locks SET watermark = now() WHERE job_name = ${key}
    `);
  });
}

// Full recompute of ALL columns from base tables. Runs inside the 1-min cron
// to repair any drift and to refresh carrier_breakdown (not maintained inline).
// Safe to run concurrently — single UPSERT.
export async function refreshContactOrgStats(
  dbc: DbOrTx,
  orgId: string,
): Promise<void> {
  // Single contacts scan: aggregate scalars + all carrier-breakdown dimensions
  // in one CTE using conditional aggregation. The planner folds lt_agg/cn_agg
  // into the same seq scan when they share the same filter predicate.
  await dbc.execute(sql`
    WITH
    contact_raw AS (
      SELECT is_archived, line_type, carrier_norm, messaging_status
      FROM contacts
      WHERE org_id = ${orgId}::uuid
    ),
    base AS (
      SELECT
        count(*) FILTER (WHERE NOT is_archived)::int AS total_count,
        count(*) FILTER (WHERE     is_archived)::int AS archived_count,
        count(*)::int                                 AS all_count
      FROM contact_raw
    ),
    lt_agg AS (
      SELECT COALESCE(line_type, 'unknown') AS k, count(*)::int AS n
      FROM contact_raw GROUP BY 1
    ),
    cn_agg AS (
      SELECT COALESCE(carrier_norm, 'unknown') AS k, count(*)::int AS n
      FROM contact_raw GROUP BY 1
    ),
    ms_agg AS (
      SELECT
        count(*) FILTER (WHERE messaging_status != 'not_applicable')::int AS eligible,
        count(*) FILTER (WHERE messaging_status  = 'not_applicable')::int AS not_applicable
      FROM contact_raw
    ),
    opt_out_c AS (
      SELECT
        count(DISTINCT contact_id)::int                                AS opt_out_count,
        count(*) FILTER (WHERE reason = 'opt_out')::int                AS r_opt_out,
        count(*) FILTER (WHERE reason = 'scrubbed')::int               AS r_scrubbed,
        count(*) FILTER (WHERE reason = 'bounced')::int                AS r_bounced,
        count(*) FILTER (WHERE reason = 'suppressed')::int             AS r_suppressed
      FROM opt_outs WHERE org_id = ${orgId}::uuid
    ),
    opt_in_c AS (
      SELECT count(DISTINCT contact_id)::int AS opt_in_count
      FROM opt_ins WHERE org_id = ${orgId}::uuid
    ),
    clicker_c AS (
      SELECT count(DISTINCT contact_id)::int AS clicker_count
      FROM clickers WHERE org_id = ${orgId}::uuid
    )
    INSERT INTO contact_org_stats (
      org_id,
      total_count, archived_count,
      opt_out_count, opt_out_by_reason,
      opt_in_count, clicker_count,
      carrier_breakdown,
      updated_at
    )
    SELECT
      ${orgId}::uuid,
      b.total_count,
      b.archived_count,
      oc.opt_out_count,
      jsonb_build_object(
        'opt_out',    oc.r_opt_out,
        'scrubbed',   oc.r_scrubbed,
        'bounced',    oc.r_bounced,
        'suppressed', oc.r_suppressed
      ),
      oi.opt_in_count,
      cl.clicker_count,
      jsonb_build_object(
        'total',               b.all_count,
        'by_line_type',        (SELECT jsonb_object_agg(k, n) FROM lt_agg),
        'by_carrier_norm',     (SELECT jsonb_object_agg(k, n) FROM cn_agg),
        'by_messaging_status', jsonb_build_object(
          'eligible',       ms.eligible,
          'not_applicable', ms.not_applicable
        )
      ),
      now()
    FROM base b, opt_out_c oc, opt_in_c oi, clicker_c cl, ms_agg ms
    ON CONFLICT (org_id) DO UPDATE SET
      total_count       = EXCLUDED.total_count,
      archived_count    = EXCLUDED.archived_count,
      opt_out_count     = EXCLUDED.opt_out_count,
      opt_out_by_reason = EXCLUDED.opt_out_by_reason,
      opt_in_count      = EXCLUDED.opt_in_count,
      clicker_count     = EXCLUDED.clicker_count,
      carrier_breakdown = EXCLUDED.carrier_breakdown,
      updated_at        = now()
  `);
}
