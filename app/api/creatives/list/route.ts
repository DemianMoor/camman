import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  clicks,
  creative_offers,
  creatives,
  keitaro_stage_results,
  links,
  offers,
  spam_scores,
} from "@/db/schema";
import { hashText } from "@/lib/spam/normalize";
import { deriveVerdict } from "@/lib/spam/types";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { buildCreativeListWhere } from "@/lib/creatives/list-filters";
import { can } from "@/lib/permissions";

// NOTE: there is deliberately NO `preferredRegion` export here.
//
// This route would benefit from running next to the eu-central-1 Supabase DB —
// it makes ~5 sequential round-trips per request (auth, membership, rows+count,
// offers, spam cache), each ~90ms from the US. A `preferredRegion = "fra1"` was
// added on 2026-07-30 and then removed the same day after measuring that it does
// nothing on this project: **Fluid Compute is enabled** (`defaultResourceConfig
// .fluid: true`), so function placement comes from the PROJECT-level
// `functionDefaultRegions` (currently `["iad1"]`) and per-route segment exports
// are ignored. Verified against prod by reading the compute region out of
// `x-vercel-id` (`<edge-pop>::<compute-region>::<id>`): /api/clicks/score-pending
// and /api/opt-outs/poll — pinned to fra1 since 2026-07-13 — also report `iad1`.
//
// The only lever that actually moves this is the project-level region setting,
// which affects EVERY function including /r/[code] (the SMS click redirect, hit
// by US handsets and carrier prefetchers). That's an infra decision, not a code
// one. Don't re-add a per-route pin here expecting it to work.

const SORT_COLUMNS = {
  created_at: creatives.created_at,
  status: creatives.status,
  text: creatives.text,
  quality: creatives.quality,
  sequence_placement: creatives.sequence_placement,
  funnel_stage: creatives.funnel_stage,
  // Sorts by the per-row column directly. Unscored rows (NULL) bubble to
  // the end of the asc/desc range courtesy of Postgres's NULLS LAST
  // default. We append a stable tiebreaker on id so ordering is
  // deterministic across paginated requests.
  spam_score: creatives.spam_score,
} as const;

export async function GET(req: NextRequest) {
  // Timing marks: Vercel does not retain runtime logs without a log drain, so
  // per-request server-side attribution is otherwise unrecoverable after the
  // fact. These separate "the DB is slow" from "the function/round-trip
  // overhead is slow" with no extra tooling — read them in DevTools -> Network
  // -> Headers on the `x-camman-timing` response header.
  //
  // NOT the standard `Server-Timing` header: that was tried first and is
  // STRIPPED by Vercel's edge before it reaches the client (present locally,
  // absent in prod — confirmed by dumping response headers against
  // camman.vercel.app). A custom `x-…` header passes through untouched. The
  // trade-off is losing DevTools' native Timing-tab rendering.
  const t0 = performance.now();
  let tAuth = 0;
  let tRows = 0;

  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  tAuth = performance.now() - t0;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // The stage creative picker fetches every eligible creative for the selected
  // offers and filters client-side, so it needs more than the default 100 cap.
  // The set is small and bounded (low hundreds per org) and the rows are tiny —
  // all active creatives in this org total ~15kB of text.
  const params = parseListParams(req, { maxPageSize: 500 });
  const sp = req.nextUrl.searchParams;

  // The 30-day metrics below cost an org-wide aggregate over the whole `links`
  // table (~1.8M rows / 319MB heap, seq-scanned because `links.creative_id` has
  // no index) plus 30 days of `clicks`. That is ~2.5s and ~240MB of physical
  // reads on EVERY call, independent of how many creatives come back — the
  // aggregate is not restricted to the result page, so LIMIT can't help it.
  //
  // Consumers that only need id/text/status/spam (the stage form's creative
  // dropdown) pass include_metrics=false and skip it entirely (~2.5s -> ~3ms).
  // Defaults to TRUE so the creatives list page and the picker — which sort and
  // render EPC/CTR — are unaffected.
  const includeMetrics = sp.get("include_metrics") !== "false";

  const where = buildCreativeListWhere({
    orgId,
    search: params.search,
    showArchived: params.showArchived,
    searchParams: sp,
  });

  // ---- 30-day performance metrics (per creative) ----
  // Two aggregates joined into the main query so the four derived ratios are
  // sortable server-side across the whole filtered set, not just one page.
  // Stage counters are anchored on the stage's created_at; tracked clean
  // clicks are anchored on the click's clicked_at (two distinct time bases,
  // by design). Clean clicks = manual-mode stage clicks (click_count) +
  // tracked-mode clean clicks (human + unknown, i.e. bot/prefetch/suspect
  // excluded — same definition as the click report).
  const WINDOW = drizzleSql`now() - interval '30 days'`;

  const stageAgg = db
    .select({
      creative_id: campaign_stages.creative_id,
      delivered:
        drizzleSql<number>`coalesce(sum(${campaign_stages.delivered_count}), 0)::int`.as(
          "delivered",
        ),
      checkouts:
        drizzleSql<number>`coalesce(sum(${campaign_stages.checkout_click_count}), 0)::int`.as(
          "checkouts",
        ),
      sales:
        drizzleSql<number>`coalesce(sum(${campaign_stages.sales_count}), 0)::int`.as(
          "sales",
        ),
      // Revenue is the real per-conversion payout from Keitaro
      // (keitaro_stage_results.revenue), NOT sales × the offer's current CPA —
      // a mid-flight CPA change would retro-misprice prior sales. Powers EPC.
      payout:
        drizzleSql<string>`coalesce(sum(
          (SELECT coalesce(sum(ksr.revenue), 0)
             FROM ${keitaro_stage_results} ksr
            WHERE ksr.stage_id = ${campaign_stages.id})
        ), 0)`.as("payout"),
      manual_clean:
        drizzleSql<number>`coalesce(sum(${campaign_stages.click_count}) filter (where ${campaigns.link_mode} = 'manual'), 0)::int`.as(
          "manual_clean",
        ),
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        isNotNull(campaign_stages.creative_id),
        gte(campaign_stages.created_at, WINDOW),
      ),
    )
    .groupBy(campaign_stages.creative_id)
    .as("stage_agg");

  const clickAgg = db
    .select({
      creative_id: links.creative_id,
      tracked_clean:
        drizzleSql<number>`count(${clicks.id}) filter (where ${clicks.classification} not in ('bot', 'prefetch', 'suspect'))::int`.as(
          "tracked_clean",
        ),
    })
    .from(clicks)
    .innerJoin(links, eq(links.id, clicks.link_id))
    .where(
      and(
        eq(clicks.org_id, orgId),
        isNotNull(links.creative_id),
        gte(clicks.clicked_at, WINDOW),
      ),
    )
    .groupBy(links.creative_id)
    .as("click_agg");

  const cleanExpr = drizzleSql`(coalesce(${stageAgg.manual_clean}, 0) + coalesce(${clickAgg.tracked_clean}, 0))`;
  const deliveredExpr = drizzleSql`coalesce(${stageAgg.delivered}, 0)`;
  // CASE without ELSE yields NULL when the denominator is 0, so "no data"
  // sorts/renders as "—" rather than a misleading 0%.
  const RATIO_SQL = {
    ctr: drizzleSql`CASE WHEN ${deliveredExpr} > 0 THEN ${cleanExpr}::numeric / ${deliveredExpr} END`,
    checkout_rate: drizzleSql`CASE WHEN ${cleanExpr} > 0 THEN coalesce(${stageAgg.checkouts}, 0)::numeric / ${cleanExpr} END`,
    sales_cr: drizzleSql`CASE WHEN ${cleanExpr} > 0 THEN coalesce(${stageAgg.sales}, 0)::numeric / ${cleanExpr} END`,
    epc: drizzleSql`CASE WHEN ${cleanExpr} > 0 THEN coalesce(${stageAgg.payout}, 0)::numeric / ${cleanExpr} END`,
  } as const;

  const sortBy = params.sortBy ?? "created_at";
  const sortDirSql = params.sortDir === "asc" ? "ASC" : "DESC";
  const orderFn = params.sortDir === "asc" ? asc : desc;
  // Postgres defaults NULLs LAST for asc and NULLs FIRST for desc. For
  // spam_score and the metric ratios we always want empty rows at the end.
  // Tiebreaker on id keeps pagination deterministic.
  let orderByClause;
  // A ratio sort needs the aggregates joined in. When the caller opted out of
  // metrics there is nothing to sort on, so fall through to the default
  // created_at ordering rather than emitting a reference to an absent join.
  if (includeMetrics && sortBy in RATIO_SQL) {
    orderByClause = [
      drizzleSql`${RATIO_SQL[sortBy as keyof typeof RATIO_SQL]} ${drizzleSql.raw(sortDirSql)} NULLS LAST`,
      asc(creatives.id),
    ];
  } else if (sortBy === "spam_score") {
    orderByClause = [
      drizzleSql`${creatives.spam_score} ${drizzleSql.raw(sortDirSql)} NULLS LAST`,
      asc(creatives.id),
    ];
  } else {
    const sortColumn =
      SORT_COLUMNS[sortBy as keyof typeof SORT_COLUMNS] ?? creatives.created_at;
    // Same id tiebreaker as the two branches above — it was missing here, which
    // made the DEFAULT ordering non-deterministic. Bulk-create commits a whole
    // batch in one transaction, so up to 7 active creatives in this org share a
    // created_at to the microsecond; without a tiebreaker Postgres is free to
    // order within a tie group differently per plan, and a paginated list can
    // then show the same creative on two pages or skip one entirely.
    orderByClause = [orderFn(sortColumn), asc(creatives.id)];
  }

  // Direct spam columns: filled in by the scoring step on save. The cache
  // lookup below is the legacy path; we still consult it so pre-migration
  // creatives (which have NULLs in the columns) still surface their score.
  const baseColumns = {
    id: creatives.id,
    creative_id: creatives.creative_id,
    slug: creatives.slug,
    org_id: creatives.org_id,
    text: creatives.text,
    quality: creatives.quality,
    sequence_placement: creatives.sequence_placement,
    funnel_stage: creatives.funnel_stage,
    applies_to_all_offers: creatives.applies_to_all_offers,
    allow_multi_segment: creatives.allow_multi_segment,
    row_spam_score: creatives.spam_score,
    row_spam_label: creatives.spam_label,
    row_spam_scored_at: creatives.spam_scored_at,
    row_spam_model_id: creatives.spam_model_id,
    row_spam_score_error: creatives.spam_score_error,
    status: creatives.status,
    archived_at: creatives.archived_at,
    created_at: creatives.created_at,
  } as const;

  const rowsQuery = includeMetrics
    ? db
        .select({
          ...baseColumns,
          m_delivered: stageAgg.delivered,
          m_checkouts: stageAgg.checkouts,
          m_sales: stageAgg.sales,
          m_payout: stageAgg.payout,
          m_manual_clean: stageAgg.manual_clean,
          m_tracked_clean: clickAgg.tracked_clean,
        })
        .from(creatives)
        .leftJoin(stageAgg, eq(stageAgg.creative_id, creatives.id))
        .leftJoin(clickAgg, eq(clickAgg.creative_id, creatives.id))
        .where(where)
        .orderBy(...orderByClause)
        .limit(params.pageSize)
        .offset(params.page * params.pageSize)
    : db
        .select(baseColumns)
        .from(creatives)
        .where(where)
        .orderBy(...orderByClause)
        .limit(params.pageSize)
        .offset(params.page * params.pageSize);

  const tRowsStart = performance.now();
  const [rows, countRows] = await Promise.all([
    rowsQuery,
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(creatives)
      .where(where),
  ]);
  tRows = performance.now() - tRowsStart;

  // Bulk-fetch associated offers (one round-trip via inArray).
  const ids = rows.map((r) => r.id);
  type OfferInfo = {
    id: number;
    name: string;
    color: string | null;
    avatar_url: string | null;
  };
  const offersByCreative = new Map<number, OfferInfo[]>();
  if (ids.length > 0) {
    const joined = await db
      .select({
        creative_id: creative_offers.creative_id,
        id: offers.id,
        name: offers.name,
        color: offers.color,
        avatar_url: offers.avatar_url,
      })
      .from(creative_offers)
      .innerJoin(offers, eq(offers.id, creative_offers.offer_id))
      .where(inArray(creative_offers.creative_id, ids));
    for (const j of joined) {
      const arr = offersByCreative.get(j.creative_id) ?? [];
      arr.push({
        id: j.id,
        name: j.name,
        color: j.color,
        avatar_url: j.avatar_url,
      });
      offersByCreative.set(j.creative_id, arr);
    }
  }

  // Look up cached spam scores by text hash. We only surface scores that
  // already exist — listing does NOT trigger scoring (which costs money).
  // The provider name is kept in sync with SelfHostedClassifierProvider.name;
  // when we add more providers this'll need to read from the registry.
  const CURRENT_PROVIDER =
    (process.env.SPAM_PROVIDER ?? "classifier") === "classifier"
      ? "classifier-v1"
      : (process.env.SPAM_PROVIDER ?? "classifier");

  const hashByRowId = new Map<number, string>();
  for (const r of rows) hashByRowId.set(r.id, hashText(r.text));
  const uniqueHashes = Array.from(new Set(hashByRowId.values()));

  type SpamCache = {
    text_hash: string;
    score: number;
    label: "ham" | "suspicious" | "spam";
  };
  const spamByHash = new Map<string, SpamCache>();
  if (uniqueHashes.length > 0) {
    const found = await db
      .select({
        text_hash: spam_scores.text_hash,
        score: spam_scores.score,
        label: spam_scores.label,
      })
      .from(spam_scores)
      .where(
        and(
          eq(spam_scores.org_id, orgId),
          eq(spam_scores.provider, CURRENT_PROVIDER),
          inArray(spam_scores.text_hash, uniqueHashes),
        ),
      );
    for (const f of found) {
      spamByHash.set(f.text_hash, {
        text_hash: f.text_hash,
        score: f.score,
        label: f.label as "ham" | "suspicious" | "spam",
      });
    }
  }

  const data = rows.map((r) => {
    const hash = hashByRowId.get(r.id);
    const spam = hash ? spamByHash.get(hash) ?? null : null;
    // Prefer the per-row columns (always up-to-date for new creatives);
    // fall back to the cache for pre-migration rows. Score takes
    // precedence; spam_label on the row is binary, on the cache it's
    // 3-bucket — we expose the cache label when only the cache has a
    // hit, otherwise the binary one from the row.
    const rowHasScore = r.row_spam_score !== null;
    const score = rowHasScore ? r.row_spam_score : spam?.score ?? null;
    const label = rowHasScore
      ? r.row_spam_label
      : spam?.label ?? null;
    // 30-day performance metrics. Base counts power the ratio columns (and
    // their tooltips); ratios are NULL when their denominator is 0. When the
    // caller opted out, the `metrics` key is omitted entirely rather than
    // zero-filled — a 0% CTR is a claim, "absent" is the truth.
    const m = includeMetrics
      ? (() => {
          const row = r as typeof r & {
            m_delivered: number | null;
            m_checkouts: number | null;
            m_sales: number | null;
            m_payout: string | null;
            m_manual_clean: number | null;
            m_tracked_clean: number | null;
          };
          const delivered = Number(row.m_delivered ?? 0);
          const checkouts = Number(row.m_checkouts ?? 0);
          const sales = Number(row.m_sales ?? 0);
          const payout = Number(row.m_payout ?? 0);
          const cleanClicks =
            Number(row.m_manual_clean ?? 0) + Number(row.m_tracked_clean ?? 0);
          return {
            metrics: {
              delivered,
              clean_clicks: cleanClicks,
              checkouts,
              sales,
              payout,
              ctr: delivered > 0 ? cleanClicks / delivered : null,
              checkout_rate: cleanClicks > 0 ? checkouts / cleanClicks : null,
              sales_cr: cleanClicks > 0 ? sales / cleanClicks : null,
              epc: cleanClicks > 0 ? payout / cleanClicks : null,
            },
          };
        })()
      : {};
    return {
      id: r.id,
      creative_id: r.creative_id,
      slug: r.slug,
      org_id: r.org_id,
      text: r.text,
      quality: r.quality,
      sequence_placement: r.sequence_placement,
      funnel_stage: r.funnel_stage,
      applies_to_all_offers: r.applies_to_all_offers,
      allow_multi_segment: r.allow_multi_segment,
      status: r.status,
      archived_at: r.archived_at,
      created_at: r.created_at,
      offers: offersByCreative.get(r.id) ?? [],
      ...m,
      spam_score: score,
      spam_label: label,
      spam_verdict:
        score !== null ? deriveVerdict(score) : null,
      spam_text_hash: spam ? spam.text_hash : null,
      spam_scored_at: r.row_spam_scored_at,
      spam_model_id: r.row_spam_model_id,
      spam_score_error: r.row_spam_score_error,
    };
  });

  const total = performance.now() - t0;
  return NextResponse.json(
    {
      data,
      totalCount: countRows[0]?.count ?? 0,
      page: params.page,
      pageSize: params.pageSize,
    },
    {
      headers: {
        // `enrich` = the offers + spam-cache round-trips; `total` minus the
        // parts is serialization. metrics=1/0 records which mode ran, so a slow
        // sample can be attributed without guessing at the query string.
        "x-camman-timing": [
          `auth;dur=${tAuth.toFixed(1)}`,
          `rows;dur=${tRows.toFixed(1)}`,
          `enrich;dur=${(total - tAuth - tRows).toFixed(1)}`,
          `total;dur=${total.toFixed(1)}`,
          `metrics;desc="${includeMetrics ? 1 : 0}"`,
        ].join(", "),
      },
    },
  );
}
