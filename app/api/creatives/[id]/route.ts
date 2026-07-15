import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creative_offers, creatives, offers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { scoreAndPersistCreative } from "@/lib/spam/score-creative";
import {
  creativeUpdateSchema,
  nullIfEmpty,
} from "@/lib/validators/creatives";

function spamScoringEnabled(): boolean {
  const v = process.env.SPAM_PROVIDER;
  if (v === undefined) return true;
  return v.toLowerCase() !== "off" && v.trim().length > 0;
}

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["creative_id"]);

async function loadOffersFor(creativeId: number) {
  return db
    .select({
      id: offers.id,
      name: offers.name,
      color: offers.color,
      avatar_url: offers.avatar_url,
    })
    .from(creative_offers)
    .innerJoin(offers, eq(offers.id, creative_offers.offer_id))
    .where(eq(creative_offers.creative_id, creativeId));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
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
      spam_score: creatives.spam_score,
      spam_label: creatives.spam_label,
      spam_scored_at: creatives.spam_scored_at,
      spam_model_id: creatives.spam_model_id,
      spam_score_error: creatives.spam_score_error,
      status: creatives.status,
      archived_at: creatives.archived_at,
      created_at: creatives.created_at,
    })
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  const offersArr = await loadOffersFor(creativeId);
  return NextResponse.json({
    ...rows[0],
    offers: offersArr,
    campaign_count: 0,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = creativeUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  const current = await db
    .select({
      id: creatives.id,
      text: creatives.text,
      status: creatives.status,
      applies_to_all_offers: creatives.applies_to_all_offers,
    })
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  if (current[0].status === "archived") {
    return apiError(
      409,
      "Archived creatives can't be edited — restore first",
      API_ERROR_CODES.CONFLICT,
      { reason: "archived" },
    );
  }

  // Verify any new offer_ids belong to the org.
  if (input.offer_ids !== undefined && input.offer_ids.length > 0) {
    const found = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(eq(offers.org_id, orgId), inArray(offers.id, input.offer_ids)),
      );
    if (found.length !== new Set(input.offer_ids).size) {
      return apiError(
        400,
        "One or more offer_ids don't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "offer_ids" },
      );
    }
  }

  // Compute the resulting state for the at-least-one-association rule.
  // The rule applies only when offer_ids OR applies_to_all_offers is in the
  // patch. We need to fetch current offer associations only when that's
  // relevant and offer_ids is NOT being updated (it'd be replaced anyway).
  const resultingAppliesToAll =
    input.applies_to_all_offers !== undefined
      ? input.applies_to_all_offers
      : current[0].applies_to_all_offers;

  let resultingOfferCount: number;
  if (input.offer_ids !== undefined) {
    resultingOfferCount = input.offer_ids.length;
  } else if (input.applies_to_all_offers !== undefined) {
    // applies_to_all is being toggled; fetch current junction count.
    const rows = await db
      .select({ x: creative_offers.creative_id })
      .from(creative_offers)
      .where(eq(creative_offers.creative_id, creativeId));
    resultingOfferCount = rows.length;
  } else {
    // Neither field is in the patch — no need to recheck.
    resultingOfferCount = -1;
  }
  if (
    (input.offer_ids !== undefined ||
      input.applies_to_all_offers !== undefined) &&
    !resultingAppliesToAll &&
    resultingOfferCount === 0
  ) {
    return apiError(
      400,
      "Must apply to at least one offer (or select 'All offers').",
      API_ERROR_CODES.VALIDATION,
      { field: "offer_ids" },
    );
  }

  // Build scalar field updates.
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (k === "offer_ids") continue; // handled in transaction below
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    await db.transaction(async (tx) => {
      if (Object.keys(updates).length > 0) {
        await tx
          .update(creatives)
          .set(updates)
          .where(
            and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)),
          );
      }
      if (input.offer_ids !== undefined) {
        // Replace semantics: drop all existing junction rows then insert
        // the new set. Even with applies_to_all_offers=true the user may
        // want a fallback junction list (junction rows aren't auto-cleared
        // when applies_to_all_offers toggles on — see the spec note).
        await tx
          .delete(creative_offers)
          .where(eq(creative_offers.creative_id, creativeId));
        if (input.offer_ids.length > 0) {
          await tx.insert(creative_offers).values(
            input.offer_ids.map((offer_id) => ({
              creative_id: creativeId,
              offer_id,
              org_id: orgId,
            })),
          );
        }
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A creative with this creative_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "creative_id" },
      );
    }
    throw err;
  }

  // Re-score whenever text actually changed. Same-text PATCHes are
  // common (quality/sequence updates) — skip the score call for those
  // since the cached score is still accurate.
  const textChanged =
    typeof input.text === "string" && input.text !== current[0].text;
  if (textChanged && spamScoringEnabled()) {
    await scoreAndPersistCreative({
      creativeId,
      orgId,
      text: input.text as string,
    });
  }

  const [updated] = await db
    .select()
    .from(creatives)
    .where(eq(creatives.id, creativeId))
    .limit(1);
  const offersArr = await loadOffersFor(creativeId);
  return NextResponse.json({ ...updated, offers: offersArr });
}
