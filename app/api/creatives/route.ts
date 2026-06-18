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
import { generateCreativeSlug } from "@/lib/creative-helpers";
import { can } from "@/lib/permissions";
import { scoreAndPersistCreative } from "@/lib/spam/score-creative";
import {
  BULK_CREATE_MAX,
  creativeBulkCreateSchema,
  creativeCreateSchema,
  nullIfEmpty,
} from "@/lib/validators/creatives";

// Scoring is gated by SPAM_PROVIDER. When the env var is unset the
// existing scoreMessage() still works (defaults to the classifier
// provider), but we want a single explicit kill switch the operator can
// flip without redeploying. Setting SPAM_PROVIDER=off skips scoring on
// save entirely; existing scores on rows are preserved.
function spamScoringEnabled(): boolean {
  const v = process.env.SPAM_PROVIDER;
  if (v === undefined) return true;
  return v.toLowerCase() !== "off" && v.trim().length > 0;
}

const SLUG_RETRY_LIMIT = 5;

// Discriminated POST: the body is either a single-creative payload OR a
// bulk payload (detected by presence of `creatives` array). Both are
// transactional — the bulk one rolls back all rows on any error.
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const isBulk =
    typeof json === "object" &&
    json !== null &&
    Array.isArray((json as { creatives?: unknown }).creatives);

  return isBulk
    ? handleBulk(json, orgId)
    : handleSingle(json, orgId);
}

// Verify every offer id belongs to the org. Returns null on success, or
// an apiError response on first mismatch.
async function verifyOffers(orgId: string, offerIds: number[]) {
  if (offerIds.length === 0) return null;
  const found = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.org_id, orgId), inArray(offers.id, offerIds)));
  if (found.length !== new Set(offerIds).size) {
    return apiError(
      400,
      "One or more offer_ids don't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "offer_ids" },
    );
  }
  return null;
}

async function handleSingle(json: unknown, orgId: string) {
  const parsed = creativeCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  const offerErr = await verifyOffers(orgId, input.offer_ids);
  if (offerErr) return offerErr;

  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
    try {
      const slug = generateCreativeSlug();
      const result = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(creatives)
          .values({
            org_id: orgId,
            text: input.text,
            creative_id: nullIfEmpty(input.creative_id),
            slug,
            quality: input.quality,
            sequence_placement: input.sequence_placement,
            funnel_stage: input.funnel_stage,
            applies_to_all_offers: input.applies_to_all_offers,
            status: "active",
          })
          .returning();
        if (input.offer_ids.length > 0) {
          await tx.insert(creative_offers).values(
            input.offer_ids.map((offer_id) => ({
              creative_id: created.id,
              offer_id,
              org_id: orgId,
            })),
          );
        }
        return created;
      });

      // Auto-score on save. Awaited so the response carries the score —
      // the call is fast (~100-500ms typical) and the inline strip in
      // the UI no longer needs a follow-up click. Errors are non-fatal:
      // a failed score is persisted as spam_score_error on the row and
      // the creative is still returned 201.
      if (spamScoringEnabled()) {
        await scoreAndPersistCreative({
          creativeId: result.id,
          orgId,
          text: input.text,
        });
      }

      const populated = await loadCreativeWithOffers(result.id);
      return NextResponse.json(populated, { status: 201 });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Could be the slug or the user-supplied creative_id. Retry; if it
      // persists past the loop, surface as a 409 on creative_id (most
      // likely culprit).
      if (attempt === SLUG_RETRY_LIMIT - 1) {
        return apiError(
          409,
          "A creative with this creative_id already exists",
          API_ERROR_CODES.DUPLICATE,
          { field: "creative_id" },
        );
      }
    }
  }
  // Unreachable: the catch above either rethrows or returns.
  return apiError(500, "Slug retry exhausted", API_ERROR_CODES.INTERNAL);
}

async function handleBulk(json: unknown, orgId: string) {
  const parsed = creativeBulkCreateSchema.safeParse(json);
  if (!parsed.success) {
    // Surface the cap separately so the client gets a sharp error.
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    return apiError(400, msg, API_ERROR_CODES.VALIDATION);
  }
  const input = parsed.data;

  if (input.creatives.length > BULK_CREATE_MAX) {
    return apiError(
      400,
      `At most ${BULK_CREATE_MAX} creatives per batch`,
      API_ERROR_CODES.VALIDATION,
    );
  }

  const offerErr = await verifyOffers(orgId, input.offer_ids);
  if (offerErr) return offerErr;

  // Single transaction for the whole batch. If any row's slug collides
  // even after retries, OR a creative_id collides with an existing one,
  // OR a creative_id duplicates within the batch — the WHOLE transaction
  // rolls back.
  try {
    const createdIds = await db.transaction(async (tx) => {
      const ids: number[] = [];
      for (const row of input.creatives) {
        let inserted = false;
        for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
          try {
            const slug = generateCreativeSlug();
            const [created] = await tx
              .insert(creatives)
              .values({
                org_id: orgId,
                text: row.text,
                creative_id: nullIfEmpty(row.creative_id),
                slug,
                quality: input.quality,
                sequence_placement: input.sequence_placement,
                funnel_stage: input.funnel_stage,
                applies_to_all_offers: input.applies_to_all_offers,
                status: "active",
              })
              .returning({ id: creatives.id });
            ids.push(created.id);
            if (input.offer_ids.length > 0) {
              await tx.insert(creative_offers).values(
                input.offer_ids.map((offer_id) => ({
                  creative_id: created.id,
                  offer_id,
                  org_id: orgId,
                })),
              );
            }
            inserted = true;
            break;
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            if (attempt === SLUG_RETRY_LIMIT - 1) throw err;
          }
        }
        if (!inserted) {
          // Should not reach here — the catch above either retries or throws.
          throw new Error("creative insert failed after retries");
        }
      }
      return ids;
    });

    // Score each created creative in parallel. allSettled so one failure
    // doesn't block the others — failed scores land on the row as
    // spam_score_error and the batch still returns 201.
    if (spamScoringEnabled()) {
      await Promise.allSettled(
        createdIds.map((id, i) =>
          scoreAndPersistCreative({
            creativeId: id,
            orgId,
            text: input.creatives[i].text,
          }),
        ),
      );
    }

    const populated = await Promise.all(
      createdIds.map((id) => loadCreativeWithOffers(id)),
    );
    return NextResponse.json(
      { created: populated.filter((p) => p !== null) },
      { status: 201 },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A creative_id in this batch conflicts with an existing creative",
        API_ERROR_CODES.DUPLICATE,
        { field: "creative_id" },
      );
    }
    throw err;
  }
}

// Reload one creative with its joined offers array. Used by both single
// and bulk POST to return populated rows.
async function loadCreativeWithOffers(id: number) {
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
    .where(eq(creatives.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const offerRows = await db
    .select({
      id: offers.id,
      name: offers.name,
      color: offers.color,
      avatar_url: offers.avatar_url,
    })
    .from(creative_offers)
    .innerJoin(offers, eq(offers.id, creative_offers.offer_id))
    .where(eq(creative_offers.creative_id, id));
  return { ...rows[0], offers: offerRows };
}
