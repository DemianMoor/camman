import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// "How many fresh leads do I have to assign?" — the rollup behind
// GET /api/audience/fresh-counts (ClickUp 869evpmbz, migration 0176).
//
// ── WHY THIS ENDPOINT EXISTS AT ALL ────────────────────────────────────────
//
// Phase 0 established that the operator role cannot answer this question from
// anything that already exists. Two independent blockers:
//
//   * GROUPS ARE INVISIBLE TO THE OPERATOR. `contact_groups.view` is not in
//     operatorPerms and every contact-groups route is null in the route map,
//     including contact-groups/list — so an operator cannot even enumerate a
//     group, let alone count one. And the groups ARE the verticals
//     (Manifestation, Weight Loss, Blood Sugar…), which is the dimension the
//     question is actually asked in.
//
//   * THE SEGMENT ANSWER IS STALE BY CONSTRUCTION. The "Not Used N Days"
//     segments do encode this, but segment_stats.rule_filtered_count is only
//     ever written by a POST and there is no cron for it — and the rule's window
//     anchors on now(), so the stored number answers a question about the week
//     it was computed in, not this one. (Measured 2026-09-04: "Not Used Last 1
//     Week" held 610,148 stamped 2026-07-16, with 682,558 distinct contacts
//     messaged since.)
//
// ── WHAT "USED" MEANS HERE, AND WHAT IT DOES NOT ───────────────────────────
//
// ⚠️ USED = SNAPSHOTTED INTO A CAMPAIGN POOL, NOT "MESSAGED". A contact counts
// as used once it lands in campaign_audience_pool for a campaign that ran
// (status active/paused/completed) inside the window. This is DELIBERATELY the
// same definition as the `in_use_in_campaign_last_period` segment rule
// (lib/segment-rules-eval.ts), for two reasons:
//
//   1. It is the operative constraint for the question being asked. A contact
//      reserved to a campaign is not assignable to another one, whether or not
//      its message has fired yet.
//   2. It makes these numbers RECONCILE with the "Not Used N Days" segments the
//      Owner already works from. A second, subtly different definition of the
//      same English phrase is how two screens end up disagreeing forever.
//
// ⚠️ AND IT INHERITS THAT RULE'S ONE WART: the window anchors on the CAMPAIGN'S
// created_at, not on when the contact was actually touched. A campaign created
// 45 days ago that sent yesterday leaves its contacts counted as "not used in
// 30d". campaign_audience_pool carries no per-row timestamp, so there is nothing
// better to anchor on without going back to stage_sends.
//
// A stage_sends-based "not messaged" variant was built and measured first. It is
// the more literal reading, and it is REJECTED on cost: stage_sends is 3,441 MB /
// 4.4M rows, the 30-day window is 1.89M rows, and the aggregate ran 26–40s
// against production — no headroom under the 60s route limit, and growing with
// send volume. Making it fast needs a covering partial index on stage_sends,
// which is write amplification on the send path. The pool formulation runs in
// ~13.5s over 302 MB and touches nothing the drain writes.
//
// ── ELIGIBILITY ────────────────────────────────────────────────────────────
//
// "Eligible" excludes archived contacts and anyone with an opt_outs row. Both
// are non-negotiable for an actionable number: a suppressed contact is not a
// lead you can assign, and reporting one as fresh would put it in front of an
// operator as available inventory. Matches excludeOptOutsFromAudience() on the
// segment pages.

/** Windows the rollup reports. Adding one is a change here and in the docs. */
export const FRESH_COUNT_WINDOWS = ["7d", "30d"] as const;
export type FreshCountWindow = (typeof FRESH_COUNT_WINDOWS)[number];

export interface FreshGroupCounts {
  /** The ONLY string in the payload. No ids, no phones, no contact fields. */
  group_name: string;
  /** Eligible contacts carrying this group. */
  total: number;
  not_used: Record<FreshCountWindow, number>;
}

export interface FreshCounts {
  /** Eligible contacts org-wide: not archived, not opted out. */
  eligible_total: number;
  not_used: Record<FreshCountWindow, number>;
  /** Every ACTIVE contact group, including empty ones (reported as zeros). */
  by_group: FreshGroupCounts[];
}

interface CountRow {
  group_name: string | null;
  total: number;
  not_used_7d: number;
  not_used_30d: number;
}

/**
 * Compute the counts for one org. Read-only; writes nothing.
 *
 * Runs as ONE statement so `scored` — the expensive part — is materialized once
 * and reused by both the org-wide row and the per-group breakdown. Splitting it
 * into two queries would pay the 13s twice.
 *
 * ⚠️ `MATERIALIZED` on the CTEs is load-bearing, not decoration. Inlined, the
 * planner pushes the group join down into the pool aggregate and re-derives the
 * used-set per group; forcing materialization gives one pass and a hash join,
 * the same reasoning as the temp table in snapshotAudience().
 *
 * ⚠️ Groups are LEFT JOINed from contact_groups so an empty group reports zeros
 * rather than vanishing. "Diets: 0" is an answer; a missing row reads as an
 * error to whoever asked.
 */
export async function computeFreshCounts(orgId: string): Promise<FreshCounts> {
  const rows = (await db.execute(sql`
    WITH used AS MATERIALIZED (
      SELECT p.contact_id, max(ca.created_at) AS last_used
      FROM campaign_audience_pool p
      JOIN campaigns ca ON ca.id = p.campaign_id
      WHERE p.org_id = ${orgId}::uuid
        AND ca.org_id = ${orgId}::uuid
        -- 'draft' has no pool rows and 'archived' has released its contacts —
        -- the same status set in_use_in_campaign_last_period uses.
        AND ca.status IN ('active', 'paused', 'completed')
        AND ca.created_at >= now() - interval '30 days'
      GROUP BY p.contact_id
    ),
    eligible AS MATERIALIZED (
      SELECT c.id
      FROM contacts c
      WHERE c.org_id = ${orgId}::uuid
        AND c.is_archived = false
        AND NOT EXISTS (
          SELECT 1 FROM opt_outs o
          WHERE o.org_id = ${orgId}::uuid AND o.contact_id = c.id
        )
    ),
    scored AS MATERIALIZED (
      SELECT
        e.id,
        -- IS TRUE rather than a bare boolean: last_used is NULL for a contact
        -- with no pool row at all, and NULL would poison the FILTER below into
        -- counting neither branch.
        (u.last_used >= now() - interval '7 days') IS TRUE AS used_7d,
        (u.last_used IS NOT NULL)                          AS used_30d
      FROM eligible e
      LEFT JOIN used u ON u.contact_id = e.id
    )
    SELECT
      NULL::text AS group_name,
      count(*)::int AS total,
      count(*) FILTER (WHERE NOT used_7d)::int  AS not_used_7d,
      count(*) FILTER (WHERE NOT used_30d)::int AS not_used_30d
    FROM scored
    UNION ALL
    SELECT
      g.name,
      count(s.id)::int,
      count(s.id) FILTER (WHERE NOT s.used_7d)::int,
      count(s.id) FILTER (WHERE NOT s.used_30d)::int
    FROM contact_groups g
    LEFT JOIN contact_contact_groups j ON j.contact_group_id = g.id
    LEFT JOIN scored s ON s.id = j.contact_id
    WHERE g.org_id = ${orgId}::uuid AND g.status = 'active'
    GROUP BY g.id, g.name
    ORDER BY 2 DESC
  `)) as unknown as CountRow[];

  const orgRow = rows.find((r) => r.group_name === null);

  return {
    eligible_total: Number(orgRow?.total ?? 0),
    not_used: {
      "7d": Number(orgRow?.not_used_7d ?? 0),
      "30d": Number(orgRow?.not_used_30d ?? 0),
    },
    by_group: rows
      .filter((r): r is CountRow & { group_name: string } => r.group_name !== null)
      .map((r) => ({
        group_name: r.group_name,
        total: Number(r.total),
        not_used: {
          "7d": Number(r.not_used_7d),
          "30d": Number(r.not_used_30d),
        },
      })),
  };
}

/**
 * Recompute and store the rollup for one org.
 *
 * Returns the duration so the cron can report it and so the trend is readable
 * from the table rather than reconstructed from logs — this is the one query in
 * this card whose cost grows with the contact base.
 */
export async function refreshFreshCounts(
  orgId: string,
): Promise<{ counts: FreshCounts; durationMs: number }> {
  const startedAt = Date.now();
  const counts = await computeFreshCounts(orgId);
  const durationMs = Date.now() - startedAt;

  await db.execute(sql`
    INSERT INTO audience_fresh_counts (org_id, counts, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${JSON.stringify(counts)}::jsonb, now(), ${durationMs}, now())
    ON CONFLICT (org_id) DO UPDATE
      SET counts = EXCLUDED.counts,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = now()
  `);

  return { counts, durationMs };
}

export interface StoredFreshCounts {
  counts: FreshCounts | null;
  computedAt: Date | null;
}

/** Read the stored rollup. `counts: null` means the cron has not run yet. */
export async function readFreshCounts(orgId: string): Promise<StoredFreshCounts> {
  const rows = (await db.execute(sql`
    SELECT counts, computed_at
    FROM audience_fresh_counts
    WHERE org_id = ${orgId}::uuid
  `)) as unknown as { counts: FreshCounts | null; computed_at: Date | null }[];

  const row = rows[0];
  return {
    counts: row?.counts ?? null,
    computedAt: row?.computed_at ?? null,
  };
}
