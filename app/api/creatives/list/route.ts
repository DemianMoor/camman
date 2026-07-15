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
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;

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
  if (sortBy in RATIO_SQL) {
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
    orderByClause = [orderFn(sortColumn)];
  }

  const [rows, countRows] = await Promise.all([
    db
      .select({
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
        // Direct columns: filled in by the scoring step on save. The
        // cache lookup below is the legacy path; we still consult it so
        // pre-migration creatives (which have NULLs in the columns)
        // still surface their cached score.
        row_spam_score: creatives.spam_score,
        row_spam_label: creatives.spam_label,
        row_spam_scored_at: creatives.spam_scored_at,
        row_spam_model_id: creatives.spam_model_id,
        row_spam_score_error: creatives.spam_score_error,
        status: creatives.status,
        archived_at: creatives.archived_at,
        created_at: creatives.created_at,
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
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(creatives)
      .where(where),
  ]);

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
    // their tooltips); ratios are NULL when their denominator is 0.
    const delivered = Number(r.m_delivered ?? 0);
    const checkouts = Number(r.m_checkouts ?? 0);
    const sales = Number(r.m_sales ?? 0);
    const payout = Number(r.m_payout ?? 0);
    const cleanClicks =
      Number(r.m_manual_clean ?? 0) + Number(r.m_tracked_clean ?? 0);
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

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
