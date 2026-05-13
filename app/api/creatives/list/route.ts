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
import { creative_offers, creatives, offers } from "@/db/schema";
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

  const data = rows.map((r) => ({
    ...r,
    offers: offersByCreative.get(r.id) ?? [],
    campaign_count: 0, // TODO: wire to real campaign references once those exist
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
