import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Per-creative 30-day performance metrics, cached in memory.
//
// WHY THIS EXISTS. The aggregate behind these numbers is org-wide and cannot be
// restricted to the page being returned: it maps every click in the last 30 days
// to a creative via `links`, and there is no selective predicate to index. It
// costs ~1.0-2.5s and ~240MB of physical reads, and it never stays in Postgres's
// cache (the `links` heap is 319MB against a 512MB shared_buffers, and Postgres
// ring-buffers large seq scans). Measured 2026-07-30: 2,567ms with the aggregate
// vs 2.9ms without.
//
// Indexing was evaluated first and REJECTED ON MEASUREMENT, not assumption —
// `links(creative_id)` came out at 1,592ms vs a 1,394ms baseline (worse), and the
// best covering variant only reached 990ms for a 58MB index that every link
// insert would have to maintain. There is no selective predicate to exploit, so
// no index can help; the only real lever is not recomputing it per request.
//
// WHY IN MEMORY rather than a cache table + refresh cron. A cron that refreshes
// on a timer burns DB time whether or not anyone is looking — that is exactly how
// `report_stage_hour` became the #1 consumer of DB time in this database while
// having zero readers (retired 2026-07-30). This cache is REFRESHED BY READS: if
// nothing asks for metrics, nothing is ever computed. It structurally cannot
// become a dead rollup. It also needs no migration, which matters because the
// unmerged textrequest branch already claims migrations 0121-0124.
//
// Trade-off accepted: the cache is per-instance and does not survive a deploy or
// an instance recycle, so a cold instance pays one recompute. That is strictly
// better than today, where EVERY request pays it.
export interface CreativeMetricsRow {
  creative_id: number;
  delivered: number;
  checkouts: number;
  sales: number;
  payout: number;
  manual_clean: number;
  tracked_clean: number;
}

const TTL_MS = 15 * 60 * 1000;

type Entry = { at: number; rows: CreativeMetricsRow[] };

// Keyed by org_id — NEVER serve one org's metrics to another. The compute query
// is itself org-scoped; this key is the second half of that guarantee.
const cache = new Map<string, Entry>();
// In-flight computes, so N concurrent requests on one instance trigger ONE query
// instead of N. Cleared in a finally so a failure can be retried immediately.
const inFlight = new Map<string, Promise<CreativeMetricsRow[]>>();

// The two aggregates the list endpoint used to LEFT JOIN inline, combined into a
// single round trip. FULL OUTER JOIN because a creative can have stage activity
// with no tracked clicks (manual link mode) or tracked clicks with no stage rows
// in the window — dropping either side would silently zero a real number.
export async function computeCreativeMetrics(
  orgId: string,
): Promise<CreativeMetricsRow[]> {
  const rows = (await db.execute(sql`
    WITH stage_agg AS (
      SELECT cs.creative_id,
             coalesce(sum(cs.delivered_count), 0)::int AS delivered,
             coalesce(sum(cs.checkout_click_count), 0)::int AS checkouts,
             coalesce(sum(cs.sales_count), 0)::int AS sales,
             coalesce(sum(
               (SELECT coalesce(sum(ksr.revenue), 0)
                  FROM keitaro_stage_results ksr
                 WHERE ksr.stage_id = cs.id)
             ), 0)::numeric AS payout,
             coalesce(sum(cs.click_count) FILTER (WHERE c.link_mode = 'manual'), 0)::int AS manual_clean
        FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id
       WHERE cs.org_id = ${orgId}
         AND cs.creative_id IS NOT NULL
         AND cs.created_at >= now() - interval '30 days'
       GROUP BY cs.creative_id
    ),
    click_agg AS (
      SELECT l.creative_id,
             count(cl.id) FILTER (
               WHERE cl.classification NOT IN ('bot', 'prefetch', 'suspect')
             )::int AS tracked_clean
        FROM clicks cl
        JOIN links l ON l.id = cl.link_id
       WHERE cl.org_id = ${orgId}
         AND l.creative_id IS NOT NULL
         AND cl.clicked_at >= now() - interval '30 days'
       GROUP BY l.creative_id
    )
    SELECT coalesce(s.creative_id, k.creative_id) AS creative_id,
           coalesce(s.delivered, 0)      AS delivered,
           coalesce(s.checkouts, 0)      AS checkouts,
           coalesce(s.sales, 0)          AS sales,
           coalesce(s.payout, 0)         AS payout,
           coalesce(s.manual_clean, 0)   AS manual_clean,
           coalesce(k.tracked_clean, 0)  AS tracked_clean
      FROM stage_agg s
      FULL OUTER JOIN click_agg k ON k.creative_id = s.creative_id
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    creative_id: Number(r.creative_id),
    delivered: Number(r.delivered ?? 0),
    checkouts: Number(r.checkouts ?? 0),
    sales: Number(r.sales ?? 0),
    payout: Number(r.payout ?? 0),
    manual_clean: Number(r.manual_clean ?? 0),
    tracked_clean: Number(r.tracked_clean ?? 0),
  }));
}

// Read path. Serves the cached rows when fresh, otherwise computes once and
// shares that single promise with any concurrent caller on this instance.
export async function getCreativeMetrics(
  orgId: string,
): Promise<CreativeMetricsRow[]> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  const pending = inFlight.get(orgId);
  if (pending) return pending;

  const p = computeCreativeMetrics(orgId)
    .then((rows) => {
      cache.set(orgId, { at: Date.now(), rows });
      return rows;
    })
    .finally(() => {
      inFlight.delete(orgId);
    });
  inFlight.set(orgId, p);

  // A failed compute must not blank the page: fall back to whatever we last had
  // (even if stale) and only surface empty metrics when there is nothing cached.
  try {
    return await p;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("getCreativeMetrics: compute failed", err);
    return hit?.rows ?? [];
  }
}

// Test/introspection helper — lets the verification script prove the cache is
// actually being consulted rather than recomputed per request.
export function __cacheStateForTests(orgId: string) {
  const e = cache.get(orgId);
  return e ? { ageMs: Date.now() - e.at, rows: e.rows.length } : null;
}
