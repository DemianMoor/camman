import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// =============================================================================
// THE COUNTED-CLICKER DEFINITION — the single denominator behind every EPC.
//
// A counted clicker is a contact who, within the grain being displayed, has:
//     at least one click with classification = 'human'
//  OR a conversion                                            (Rule F)
// deduplicated at the grain of the row displayed.
//
// Full precedence table (docs/04-features/tracking-attribution.md). Rows 3 and 4
// are currently unreachable — clicks.classification has had zero 'unknown' rows
// across all history — and row 5 only fires for manual-mode campaigns, which
// mint no links. They stay documented because they are the definition, not an
// implementation detail:
//
//   | CamMan state              | In Keitaro? | Counted | Why                        |
//   | bot / prefetch / suspect  | either      | No      | CamMan scoring is final    |
//   | human                     | either      | Yes     | Confirmed human            |
//   | unknown (never scored)    | Yes         | Yes     | Keitaro filtering vouches  |
//   | unknown (never scored)    | No          | No      | Nothing vouches            |
//   | no CamMan row at all      | Yes         | Yes     | Missed, or manual-mode     |
//
// The consumer-relay carve-out (Apple iCloud Private Relay egress on Fastly /
// Cloudflare / Akamai, plus Google Fiber) is NOT applied here. It lives in the
// scorer (lib/links/datacenter-asns.ts), so by the time a click reaches this
// module the rule has collapsed to `classification = 'human'`. That is the point
// of having one definition of "human" in the codebase — do not re-implement the
// ASN logic at this layer.
//
// MANUAL-MODE campaigns mint no links, so they have no per-recipient click rows
// and cannot appear in this cache at all. Their denominator comes from Keitaro
// `visit_clicks_clean` instead — see countedClickersWithManualFallback below.
// The two are comparable in scale: only 11% of Keitaro landing visitors are
// CamMan-excluded, so Keitaro visits land close to CamMan counted clickers.
//
// ⚠️ NOT ADDITIVE — across grains OR over time. One person tapping two creatives
// in one campaign is ONE campaign clicker and TWO creative clickers, and both
// are correct. One person clicking on two days is ONE lifetime clicker, not two.
// Never sum counted-clicker counts; always re-aggregate from the membership.
// =============================================================================

export type ClickGrain = "campaign" | "stage" | "creative";

const GRAIN_COLUMN: Record<ClickGrain, string> = {
  campaign: "campaign_id",
  stage: "stage_id",
  creative: "creative_id",
};

// The rebuild's source-of-truth predicate, kept in one place so the cache and
// any ad-hoc verification can never drift.
const HUMAN_CLICK = sql`ck.classification = 'human'`;

export interface RebuildResult {
  rows: number;
  rescuedByConversion: number;
  durationMs: number;
}

// Rebuild the whole cache. TRUNCATE + repopulate, in one transaction.
//
// NO WATERMARK, DELIBERATELY. This is load-bearing, not laziness. The sibling
// `clickers` propagation (lib/links/propagate-clickers.ts) is watermark-
// incremental on clicks.scored_at; when the 2026-08-11 rescore backfill
// corrected `classification` WITHOUT touching `scored_at`, all 4,312 corrected
// rows fell behind the watermark and became permanently unreachable — 3,032
// (contact, brand, offer) combos are still missing from `clickers` and the fix
// could not repair them. A watermark makes a derived table silently
// un-repairable the moment its source is corrected. This table is small
// (~72K rows, seconds to rebuild), so it is rebuilt wholesale every run and any
// future correction to click classification self-heals on the next tick.
export async function rebuildCountedClickers(dbc: DbOrTx): Promise<RebuildResult> {
  const started = Date.now();
  let rows = 0;
  let rescued = 0;

  await dbc.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    await tx.execute(sql`TRUNCATE TABLE counted_clickers`);

    // Human clicks first. DISTINCT ON collapses to one row per (stage, contact)
    // carrying the EARLIEST counted click — the click-date basis for period EPC.
    // No RETURNING: shipping 72K rows back to the client dominated the runtime
    // (50s → seconds). Counts come from a cheap aggregate afterwards.
    await tx.execute(sql`
      INSERT INTO counted_clickers
        (org_id, campaign_id, stage_id, creative_id, contact_id, first_click_at, rescued_by_conversion)
      SELECT DISTINCT ON (l.stage_id, l.contact_id)
        l.org_id, l.campaign_id, l.stage_id, l.creative_id, l.contact_id,
        min(ck.clicked_at) OVER (PARTITION BY l.stage_id, l.contact_id),
        false
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      WHERE ${HUMAN_CLICK}
      ORDER BY l.stage_id, l.contact_id
    `);

    // Rule F: a converted recipient is ALWAYS counted, so the revenue numerator
    // can never sit outside the click denominator. ON CONFLICT DO NOTHING means
    // a buyer who also has a human click keeps its real click date and is not
    // relabelled as a rescue — only genuine rescues carry the flag.
    await tx.execute(sql`
      INSERT INTO counted_clickers
        (org_id, campaign_id, stage_id, creative_id, contact_id, first_click_at, rescued_by_conversion)
      SELECT ss.org_id, ss.campaign_id, ss.stage_id, l.creative_id, ss.contact_id,
             coalesce(
               (SELECT min(ck.clicked_at) FROM clicks ck WHERE ck.link_id = ss.link_id),
               ss.converted_at
             ),
             true
      FROM stage_sends ss
      LEFT JOIN links l ON l.id = ss.link_id
      WHERE ss.converted_at IS NOT NULL
      ON CONFLICT (stage_id, contact_id) DO NOTHING
    `);

    const totals = (await tx.execute(sql`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE rescued_by_conversion)::int AS rescued
      FROM counted_clickers
    `)) as unknown as { n: number; rescued: number }[];
    rows = Number(totals[0]?.n ?? 0);
    rescued = Number(totals[0]?.rescued ?? 0);

    await tx.execute(sql`ANALYZE counted_clickers`);
  });

  return { rows, rescuedByConversion: rescued, durationMs: Date.now() - started };
}

export interface CountedClickerBounds {
  // ET day bounds for PERIOD figures. Omit both for the LIFETIME figure, which
  // ignores the date filter entirely — that is the primary displayed number.
  fromUtc?: Date;
  toExclusiveUtc?: Date;
}

// Counted clickers per grain id. Returns a Map<grainId, count>.
//
// Aggregation is by COUNT(DISTINCT contact_id) at campaign/creative grain and a
// plain COUNT at stage grain (the primary key already makes it distinct there).
export async function getCountedClickers(
  dbc: DbOrTx,
  orgId: string,
  grain: ClickGrain,
  b: CountedClickerBounds = {},
): Promise<Map<number, number>> {
  const col = sql.raw(GRAIN_COLUMN[grain]);
  const dateFilter =
    b.fromUtc && b.toExclusiveUtc
      ? sql`AND first_click_at >= ${b.fromUtc.toISOString()}::timestamptz AND first_click_at < ${b.toExclusiveUtc.toISOString()}::timestamptz`
      : sql``;
  const counter =
    grain === "stage" ? sql`count(*)::int` : sql`count(DISTINCT contact_id)::int`;

  const rows = (await dbc.execute(sql`
    SELECT ${col} AS grain_id, ${counter} AS n
    FROM counted_clickers
    WHERE org_id = ${orgId}::uuid AND ${col} IS NOT NULL ${dateFilter}
    GROUP BY 1
  `)) as unknown as { grain_id: number; n: number }[];

  return new Map(rows.map((r) => [Number(r.grain_id), Number(r.n)]));
}

// Org-wide total at a given grain. NOT the sum of getCountedClickers values —
// see the non-additivity note above; a contact spanning two campaigns counts
// once here and twice there.
export async function getTotalCountedClickers(
  dbc: DbOrTx,
  orgId: string,
  b: CountedClickerBounds = {},
): Promise<number> {
  const dateFilter =
    b.fromUtc && b.toExclusiveUtc
      ? sql`AND first_click_at >= ${b.fromUtc.toISOString()}::timestamptz AND first_click_at < ${b.toExclusiveUtc.toISOString()}::timestamptz`
      : sql``;
  const rows = (await dbc.execute(sql`
    SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::int AS n
    FROM counted_clickers
    WHERE org_id = ${orgId}::uuid ${dateFilter}
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// Rule-F instrumentation. How many rows exist ONLY because the contact
// converted? A rise above the baseline (8 at build time, 2026-08-11) means
// click scoring is dropping real humans again — the exact regression this
// workstream was created to find. Alert on it; do not let Rule F silently
// paper over the next scoring bug the way the last one was papered over.
export async function getRuleFRescueCount(
  dbc: DbOrTx,
  orgId: string,
  b: CountedClickerBounds = {},
): Promise<number> {
  const dateFilter =
    b.fromUtc && b.toExclusiveUtc
      ? sql`AND first_click_at >= ${b.fromUtc.toISOString()}::timestamptz AND first_click_at < ${b.toExclusiveUtc.toISOString()}::timestamptz`
      : sql``;
  const rows = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM counted_clickers
    WHERE org_id = ${orgId}::uuid AND rescued_by_conversion ${dateFilter}
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// Counted clickers keyed `${stage_id}|${YYYY-MM-DD}` in ET, for surfaces that
// render one row per (stage, day) — the per-campaign results API. Bucketed by
// the CLICK's ET date, the same basis period EPC uses everywhere else.
//
// Note these per-day counts do NOT sum to the stage's lifetime count: a contact
// who clicks on two days appears in two buckets but is one lifetime clicker.
// That is the documented non-additivity, not a discrepancy.
export async function getCountedClickersByStageDay(
  dbc: DbOrTx,
  orgId: string,
): Promise<Map<string, number>> {
  const rows = (await dbc.execute(sql`
    SELECT stage_id,
           to_char(first_click_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS et_day,
           count(*)::int AS n
    FROM counted_clickers
    WHERE org_id = ${orgId}::uuid AND first_click_at IS NOT NULL
    GROUP BY 1, 2
  `)) as unknown as { stage_id: number; et_day: string; n: number }[];
  return new Map(rows.map((r) => [`${Number(r.stage_id)}|${r.et_day}`, Number(r.n)]));
}

// Resolve the EPC denominator for one row, given its campaign's link mode.
//
// Tracked campaigns mint a link per recipient, so their counted clickers come
// from the cache. Manual-mode campaigns mint no links and therefore can never
// appear in it — their denominator is Keitaro's clean landing-visit count.
//
// The two are comparable in scale, which is what makes mixing them defensible:
// only 11% of Keitaro landing visitors are CamMan-excluded, so a Keitaro visit
// count lands close to what a CamMan counted-clicker count would be for the
// same traffic. Manual mode is 43 campaigns and 1.60% of revenue.
export function denominatorFor(
  linkMode: string | null | undefined,
  cachedClickers: number | undefined,
  keitaroVisitsClean: number,
): number {
  return linkMode === "tracked" ? cachedClickers ?? 0 : keitaroVisitsClean;
}

// SQL fragment yielding (grain_id, clickers) for callers that need to join it
// into a larger query rather than materialize a Map (e.g. the creatives list,
// which sorts by EPC server-side across the whole filtered set).
export function countedClickersSubquery(
  orgId: string,
  grain: ClickGrain,
  b: CountedClickerBounds = {},
): SQL {
  const col = sql.raw(GRAIN_COLUMN[grain]);
  const dateFilter =
    b.fromUtc && b.toExclusiveUtc
      ? sql`AND first_click_at >= ${b.fromUtc.toISOString()}::timestamptz AND first_click_at < ${b.toExclusiveUtc.toISOString()}::timestamptz`
      : sql``;
  const counter =
    grain === "stage" ? sql`count(*)::int` : sql`count(DISTINCT contact_id)::int`;
  return sql`
    SELECT ${col} AS grain_id, ${counter} AS clickers
    FROM counted_clickers
    WHERE org_id = ${orgId}::uuid AND ${col} IS NOT NULL ${dateFilter}
    GROUP BY 1
  `;
}
