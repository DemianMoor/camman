import {
  and,
  eq,
  exists,
  ilike,
  inArray,
  or,
  sql as drizzleSql,
  type SQL,
} from "drizzle-orm";

import { db } from "@/db/client";
import { creative_offers, creatives } from "@/db/schema";
import {
  CREATIVE_STATUSES,
  FUNNEL_STAGE_VALUES,
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
} from "@/lib/validators/creatives";

const VALID_STATUSES = new Set<string>(CREATIVE_STATUSES);
const VALID_QUALITIES = new Set<string>(QUALITY_VALUES);
const VALID_SEQUENCES = new Set<string>(SEQUENCE_PLACEMENT_VALUES);
const VALID_FUNNEL_STAGES = new Set<string>(FUNNEL_STAGE_VALUES);

function splitFilter(raw: string | null, valid: Set<string>): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => valid.has(s));
}

// Build the WHERE clause shared by the creatives list endpoint and the
// "all matching ids" endpoint. Keeping this in one place guarantees the
// select-all-across-filter ids exactly match what the paginated list
// shows for the same filter. Pulls search/showArchived from the parsed
// list params and the entity-specific filters straight off the query
// string.
export function buildCreativeListWhere(opts: {
  orgId: string;
  search: string | null;
  showArchived: boolean;
  searchParams: URLSearchParams;
}): SQL {
  const { orgId, search, showArchived, searchParams: sp } = opts;

  const qualityFilter = splitFilter(sp.get("quality"), VALID_QUALITIES);
  const sequenceFilter = splitFilter(
    sp.get("sequence_placement"),
    VALID_SEQUENCES,
  );
  const funnelStageFilter = splitFilter(
    sp.get("funnel_stage"),
    VALID_FUNNEL_STAGES,
  );
  const statusFilter = splitFilter(sp.get("status"), VALID_STATUSES);
  const offerFilter = sp.get("offer_id");
  // Multi-offer variant (creative picker's "show more creatives" panel): a
  // comma-separated list of offer ids. When present it supersedes the single
  // offer_id — a creative is eligible if it applies to all offers OR is linked
  // to ANY of the selected offers.
  const offerIds = (sp.get("offer_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);

  const conditions = [eq(creatives.org_id, orgId)];

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(creatives.text, pattern),
        ilike(creatives.creative_id, pattern),
        ilike(creatives.slug, pattern),
      )!,
    );
  }

  // Status filter: explicit list overrides; otherwise hide archived unless
  // showArchived is set.
  if (statusFilter.length > 0) {
    conditions.push(inArray(creatives.status, statusFilter));
  } else if (!showArchived) {
    conditions.push(drizzleSql`${creatives.status} <> 'archived'`);
  }

  if (qualityFilter.length > 0) {
    conditions.push(inArray(creatives.quality, qualityFilter));
  }
  if (sequenceFilter.length > 0) {
    conditions.push(inArray(creatives.sequence_placement, sequenceFilter));
  }
  if (funnelStageFilter.length > 0) {
    conditions.push(inArray(creatives.funnel_stage, funnelStageFilter));
  }

  // offer_ids filter (multi): eligible if a junction row to ANY of the selected
  // offers — and, when include_all_offers is not "false" (the default), also any
  // creative flagged applies_to_all_offers. The picker's "ALL" toggle sends
  // include_all_offers=false to hide those until the operator opts in.
  if (offerIds.length > 0) {
    const includeAllOffers = sp.get("include_all_offers") !== "false";
    const junctionMatch = exists(
      db
        .select({ x: drizzleSql`1` })
        .from(creative_offers)
        .where(
          and(
            eq(creative_offers.creative_id, creatives.id),
            inArray(creative_offers.offer_id, offerIds),
          ),
        ),
    );
    conditions.push(
      includeAllOffers
        ? or(eq(creatives.applies_to_all_offers, true), junctionMatch)!
        : junctionMatch,
    );
  } else if (offerFilter !== null && /^\d+$/.test(offerFilter)) {
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

  return and(...conditions)!;
}
