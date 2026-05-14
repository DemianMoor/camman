import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { creative_offers, creatives, offers, spam_scores } from "@/db/schema";
import { hashText } from "@/lib/spam/normalize";
import { deriveVerdict } from "@/lib/spam/types";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  CREATIVE_STATUSES,
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
} from "@/lib/validators/creatives";

const SORT_COLUMNS = {
  created_at: creatives.created_at,
  status: creatives.status,
  text: creatives.text,
  quality: creatives.quality,
  sequence_placement: creatives.sequence_placement,
} as const;

const VALID_STATUSES = new Set<string>(CREATIVE_STATUSES);
const VALID_QUALITIES = new Set<string>(QUALITY_VALUES);
const VALID_SEQUENCES = new Set<string>(SEQUENCE_PLACEMENT_VALUES);

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const offerFilter = sp.get("offer_id");
  const qualityFilterRaw = sp.get("quality");
  const sequenceFilterRaw = sp.get("sequence_placement");
  const statusFilterRaw = sp.get("status");

  const qualityFilter = qualityFilterRaw
    ? qualityFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_QUALITIES.has(s))
    : [];
  const sequenceFilter = sequenceFilterRaw
    ? sequenceFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_SEQUENCES.has(s))
    : [];
  const statusFilter = statusFilterRaw
    ? statusFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.has(s))
    : [];

  const conditions = [eq(creatives.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(creatives.text, pattern),
        ilike(creatives.creative_id, pattern),
      )!,
    );
  }

  // Status filter: explicit list overrides; otherwise hide archived unless
  // showArchived is set.
  if (statusFilter.length > 0) {
    conditions.push(inArray(creatives.status, statusFilter));
  } else if (!params.showArchived) {
    conditions.push(drizzleSql`${creatives.status} <> 'archived'`);
  }

  if (qualityFilter.length > 0) {
    conditions.push(inArray(creatives.quality, qualityFilter));
  }
  if (sequenceFilter.length > 0) {
    conditions.push(inArray(creatives.sequence_placement, sequenceFilter));
  }

  // offer_id filter: a creative is eligible if applies_to_all_offers=true
  // OR there's a junction row to this offer. This is the same query the
  // stage form's creative picker uses to find creatives valid for its
  // campaign's offer.
  if (offerFilter !== null && /^\d+$/.test(offerFilter)) {
    const offerIdNum = Number(offerFilter);
    conditions.push(
      or(
        eq(creatives.applies_to_all_offers, true),
        exists(
          db
            .select({ x: drizzleSql`1` })
            .from(creative_offers)
            .where(
              and(
                eq(creative_offers.creative_id, creatives.id),
                eq(creative_offers.offer_id, offerIdNum),
              ),
            ),
        ),
      )!,
    );
  }

  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? creatives.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

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
        applies_to_all_offers: creatives.applies_to_all_offers,
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
      })
      .from(creatives)
      .where(where)
      .orderBy(orderFn(sortColumn))
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
    return {
      id: r.id,
      creative_id: r.creative_id,
      slug: r.slug,
      org_id: r.org_id,
      text: r.text,
      quality: r.quality,
      sequence_placement: r.sequence_placement,
      applies_to_all_offers: r.applies_to_all_offers,
      status: r.status,
      archived_at: r.archived_at,
      created_at: r.created_at,
      offers: offersByCreative.get(r.id) ?? [],
      campaign_count: 0, // TODO: wire to real campaign references once those exist
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
