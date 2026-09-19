import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { readCreativeCtr } from "@/lib/creatives/ctr-rollup";
import type { DbOrTx, EventCountMap } from "@/lib/reporting/event-columns";

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
  // LIFETIME pair — no 30-day bound. Shown alongside the 30-day figure so a
  // creative's full history is visible when choosing one, WITHOUT changing the
  // picker's sort (which stays on the 30-day number — see the header note).
  lifetime_payout: number;
  lifetime_clean: number;
  // All-time sales: per stage max(manual sales_count, Keitaro conversions).
  lifetime_sales: number;
  // CTR counters — messages sent and counted clickers per window — from the
  // hourly snapshot in lib/creatives/ctr-rollup.ts, NOT from the statement below.
  // Zero until that snapshot's first refresh.
  ctr_sent_7d: number;
  ctr_clicks_7d: number;
  ctr_sent_30d: number;
  ctr_clicks_30d: number;
  ctr_sent_lifetime: number;
  ctr_clicks_lifetime: number;
  // Phase 5. The SAME 30-day conversions as `checkouts` / `sales`, split per
  // event_types.key — so the registry-driven counts on /creatives describe the
  // same window as the "Checkout Rate" they sit beside.
  //
  // ⚠️ COUNTS ONLY, and the TYPE is what keeps it that way. The stage-day column
  // this is rolled up from carries revenue and pending figures per key too, and
  // a four-field object here would invite a later reader to render a per-event
  // revenue column off a number that was never summed at this grain. `n`, and
  // nothing else, crosses this boundary.
  events: EventCountMap;
  // The residual those counts do NOT explain: conversions on this creative's
  // stages in the same window that the org-scoped event_types join could not
  // place (keitaro_stage_results.unmapped_conversions). They count as NOTHING —
  // not a sale, not revenue, not in `events` — so a screen that renders the
  // breakdown without this number silently under-explains its own Sales column.
  unmapped: number;
}

// ⭐ A FUNCTION, NOT A SHARED CONSTANT, BECAUSE IT NOW CARRIES AN OBJECT.
// It used to be a module-level `NO_ACTIVITY` spread into every row; with
// `events` on it, every zero row would alias the SAME map and one consumer's
// mutation would silently become everyone's (exactly the aliasing bug
// EMPTY_TALLY's freeze exists to stop — lib/reporting/event-columns.ts).
const noActivity = (creative_id: number): CreativeMetricsRow => ({
  creative_id,
  delivered: 0,
  checkouts: 0,
  sales: 0,
  payout: 0,
  manual_clean: 0,
  tracked_clean: 0,
  lifetime_payout: 0,
  lifetime_clean: 0,
  lifetime_sales: 0,
  ctr_sent_7d: 0,
  ctr_clicks_7d: 0,
  ctr_sent_30d: 0,
  ctr_clicks_30d: 0,
  ctr_sent_lifetime: 0,
  ctr_clicks_lifetime: 0,
  events: {},
  unmapped: 0,
});

/**
 * One creative's `events` jsonb, coerced to bare counts.
 *
 * Never throws and never invents a key: a NULL column, a hand-edited value and a
 * non-numeric entry all yield 0 for that key rather than NaN on a screen.
 * postgres-js JSON.parses a jsonb column, so `jsonb_object_agg(k, <int>)` hands
 * this numbers — but a `#>>` text extraction or a fixture hands it strings, and
 * both have to read alike.
 */
function toCountMap(v: unknown): EventCountMap {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: EventCountMap = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    out[k] = Number.isFinite(n) ? n : 0;
  }
  return out;
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
  dbc: DbOrTx = db,
): Promise<CreativeMetricsRow[]> {
  const rows = (await dbc.execute(sql`
    WITH k_stage AS (
      -- Keitaro totals per stage, aggregated ONCE and joined into both stage CTEs.
      -- They were per-stage correlated subqueries (an index scan of
      -- keitaro_stage_results per stage, twice): 1,535 ms / 343,794 buffers for
      -- the stage part vs 17 ms / 991 buffers joined (prod, 2026-09-15).
      SELECT stage_id,
             sum(sales)::int   AS sales,
             sum(revenue)      AS revenue,
             -- The conversions the org-scoped event_types join could not place.
             -- It rides k_stage rather than a CTE of its own so it is bounded by
             -- whichever window the consuming CTE applies — the residual can
             -- never describe a different period from the counts it qualifies.
             sum(unmapped_conversions)::int AS unmapped
        FROM keitaro_stage_results
       WHERE org_id = ${orgId}
       GROUP BY stage_id
    ),
    -- Phase 5: the same conversions, split per event_types.key. SEPARATE from
    -- k_stage because jsonb_each on '{}' yields no rows, and a stage with sales
    -- and an empty breakdown must keep its k_stage row.
    --
    -- ⚠️ jsonb_typeof(...) = 'object' IS LOAD-BEARING, NOT BELT-AND-BRACES.
    -- jsonb_each RAISES 22023 ("cannot call jsonb_each on a non-object") on a
    -- jsonb scalar or array, and that error is not scoped to the offending row:
    -- it kills the WHOLE statement, so ONE malformed stage-day row would blank
    -- every number on /creatives for the entire org. The column is
    -- jsonb NOT NULL DEFAULT the empty object, with NO CHECK constraint
    -- (migration 0185), so object-ness is a convention of stage-day-conversions,
    -- not a guarantee of the database — which is exactly why parseEventMap()
    -- defends against the same shapes on the JS side. Found the hard way: a
    -- hand-written fixture stored a JSON STRING and the whole query 22023'd.
    -- A malformed row contributes nothing rather than taking the page with it.
    -- Bar C11.
    k_stage_ev AS (
      SELECT ksr.stage_id, e.key AS event_key, sum((e.value ->> 'n')::numeric)::int AS n
        FROM keitaro_stage_results ksr
        CROSS JOIN LATERAL jsonb_each(ksr.events) AS e(key, value)
       WHERE ksr.org_id = ${orgId}
         AND jsonb_typeof(ksr.events) = 'object'
       GROUP BY 1, 2
    ),
    -- …rolled up to the creative and emitted as ONE object per creative. Nothing
    -- aggregates jsonb (there is no min/max for it): the counts are summed as
    -- ordinary integers and only the last step builds the object.
    --
    -- ⚠️ THE 30-DAY BOUND IS stage_agg's, COPIED DELIBERATELY. These counts sit
    -- immediately beside "Checkout Rate", whose numerator is stage_agg's
    -- checkouts. If the two windows differ the columns describe different
    -- periods and the comparison they exist to enable is meaningless. Bar C3.
    creative_ev AS (
      SELECT x.creative_id, jsonb_object_agg(x.event_key, x.n) AS events
        FROM (
          SELECT cs.creative_id, ke.event_key, sum(ke.n)::int AS n
            FROM k_stage_ev ke
            JOIN campaign_stages cs ON cs.id = ke.stage_id
           WHERE cs.org_id = ${orgId}
             AND cs.creative_id IS NOT NULL
             AND cs.created_at >= now() - interval '30 days'
           GROUP BY 1, 2
        ) x
       GROUP BY x.creative_id
    ),
    stage_agg AS (
      SELECT cs.creative_id,
             coalesce(sum(cs.delivered_count), 0)::int AS delivered,
             coalesce(sum(cs.checkout_click_count), 0)::int AS checkouts,
             -- A stage's sales = max(manual tally, Keitaro conversions): the
             -- combineSales rule (lib/stage-results.ts). sales_count ALONE is only
             -- the manual tally — the Keitaro poll never writes it — so summing it
             -- read 0 and Sales CR showed 0.0% on every creative (fixed 2026-09-15).
             coalesce(sum(greatest(cs.sales_count, coalesce(ks.sales, 0))), 0)::int AS sales,
             coalesce(sum(ks.revenue), 0)::numeric AS payout,
             -- Same CTE, same window, same rows as checkouts above: the
             -- residual is bounded by the very aggregate it qualifies.
             coalesce(sum(ks.unmapped), 0)::int AS unmapped,
             coalesce(sum(cs.click_count) FILTER (WHERE c.link_mode = 'manual'), 0)::int AS manual_clean
        FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id
        LEFT JOIN k_stage ks ON ks.stage_id = cs.id
       WHERE cs.org_id = ${orgId}
         AND cs.creative_id IS NOT NULL
         AND cs.created_at >= now() - interval '30 days'
       GROUP BY cs.creative_id
    ),
    -- The EPC denominator: counted clickers at CREATIVE grain, from the shared
    -- cache (lib/reporting/counted-clickers.ts) - the same definition every
    -- other surface divides by.
    --
    -- This replaces RAW tracked taps (count of click ROWS, not deduplicated by
    -- contact) which, added to manual-mode click_count (Keitaro landing
    -- VISITS), summed two different funnel events into one denominator. It was
    -- the single largest EPC inconsistency in the platform. Deduplicating
    -- shrinks this denominator, so creative EPC moves UP while the reports
    -- screens move DOWN — the two converge on the same number.
    -- LIFETIME counterparts, deliberately unbounded. The picker still SORTS by
    -- the 30-day figure (recency predicts what to send next: offers change,
    -- audiences fatigue, creative performance decays), but the lifetime pair is
    -- displayed so an operator can see the full history and override
    -- deliberately. Sort by recent, show both.
    stage_life AS (
      SELECT cs.creative_id,
             coalesce(sum(ks.revenue), 0)::numeric AS lifetime_payout,
             coalesce(sum(greatest(cs.sales_count, coalesce(ks.sales, 0))), 0)::int AS lifetime_sales,
             coalesce(sum(cs.click_count) FILTER (WHERE c.link_mode = 'manual'), 0)::int AS lifetime_manual
        FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id
        LEFT JOIN k_stage ks ON ks.stage_id = cs.id
       WHERE cs.org_id = ${orgId} AND cs.creative_id IS NOT NULL
       GROUP BY cs.creative_id
    ),
    click_life AS (
      SELECT cc.creative_id, count(DISTINCT cc.contact_id)::int AS lifetime_tracked
        FROM counted_clickers cc
       WHERE cc.org_id = ${orgId} AND cc.creative_id IS NOT NULL
       GROUP BY cc.creative_id
    ),
    click_agg AS (
      SELECT cc.creative_id,
             count(DISTINCT cc.contact_id)::int AS tracked_clean
        FROM counted_clickers cc
       WHERE cc.org_id = ${orgId}
         AND cc.creative_id IS NOT NULL
         AND cc.first_click_at >= now() - interval '30 days'
       GROUP BY cc.creative_id
    )
    -- Driven by the LIFETIME aggregates, with the 30-day ones LEFT JOINed (each is
    -- a subset of its lifetime counterpart). It used to be driven by the 30-day
    -- aggregates, so a creative with no activity in the last 30 days got no row
    -- and its all-time columns read 0 or a dash (60 of 405 creatives, 2026-09-15).
    SELECT coalesce(sl.creative_id, kl.creative_id) AS creative_id,
           coalesce(s.delivered, 0)      AS delivered,
           coalesce(s.checkouts, 0)      AS checkouts,
           coalesce(s.sales, 0)          AS sales,
           coalesce(s.payout, 0)         AS payout,
           coalesce(s.manual_clean, 0)   AS manual_clean,
           coalesce(k.tracked_clean, 0)  AS tracked_clean,
           coalesce(sl.lifetime_payout, 0) AS lifetime_payout,
           (coalesce(sl.lifetime_manual, 0) + coalesce(kl.lifetime_tracked, 0)) AS lifetime_clean,
           coalesce(sl.lifetime_sales, 0) AS lifetime_sales,
           coalesce(s.unmapped, 0)       AS unmapped,
           -- ⚠️ LEFT, not INNER. A creative with conversions and an EMPTY
           -- breakdown — every stage-day row reading '{}' — has no creative_ev
           -- row at all, and an inner join would drop it off the screen
           -- entirely rather than reading 0. Bar C2.
           coalesce(ce.events, '{}'::jsonb) AS events
      FROM stage_life sl
      FULL OUTER JOIN click_life kl ON kl.creative_id = sl.creative_id
      LEFT JOIN stage_agg s ON s.creative_id = coalesce(sl.creative_id, kl.creative_id)
      LEFT JOIN click_agg k ON k.creative_id = coalesce(sl.creative_id, kl.creative_id)
      LEFT JOIN creative_ev ce ON ce.creative_id = coalesce(sl.creative_id, kl.creative_id)
  `)) as unknown as Record<string, unknown>[];

  const byId = new Map<number, CreativeMetricsRow>();
  for (const r of rows) {
    byId.set(Number(r.creative_id), {
      ...noActivity(Number(r.creative_id)),
      creative_id: Number(r.creative_id),
      delivered: Number(r.delivered ?? 0),
      checkouts: Number(r.checkouts ?? 0),
      sales: Number(r.sales ?? 0),
      payout: Number(r.payout ?? 0),
      manual_clean: Number(r.manual_clean ?? 0),
      tracked_clean: Number(r.tracked_clean ?? 0),
      lifetime_payout: Number(r.lifetime_payout ?? 0),
      lifetime_clean: Number(r.lifetime_clean ?? 0),
      lifetime_sales: Number(r.lifetime_sales ?? 0),
      events: toCountMap(r.events),
      unmapped: Number(r.unmapped ?? 0),
    });
  }
  // A creative can have sends in the CTR snapshot but no row above (nothing in
  // the 30-day stage/click windows) — it gets a zeroed row rather than losing
  // its all-time and 7-day CTR.
  for (const c of await readCreativeCtr(orgId, dbc)) {
    byId.set(c.creative_id, {
      ...(byId.get(c.creative_id) ?? noActivity(c.creative_id)),
      ctr_sent_7d: c.sent_7d,
      ctr_clicks_7d: c.clicks_7d,
      ctr_sent_30d: c.sent_30d,
      ctr_clicks_30d: c.clicks_30d,
      ctr_sent_lifetime: c.sent_lifetime,
      ctr_clicks_lifetime: c.clicks_lifetime,
    });
  }
  return [...byId.values()];
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
