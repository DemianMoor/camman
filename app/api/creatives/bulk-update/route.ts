import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
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
import { creativeBulkUpdateSchema } from "@/lib/validators/creatives";

// Apply one set of metadata changes to many creatives in a single
// transaction. Fields:
//   quality / sequence_placement — scalar metadata, requires creatives.update
//   status                       — bulk archive/restore, requires the
//                                  corresponding archive/restore permission
//   add_offer_ids                — ADDITIVE offer assignment (union); never
//                                  removes existing junction rows. Requires
//                                  creatives.update.
// Unlike the single-creative PATCH, metadata changes here are applied
// regardless of a creative's current status — bulk edit is a deliberate
// management action across the explicit selection.
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = creativeBulkUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  const addOffers = input.add_offer_ids ?? [];
  const needsUpdate =
    input.quality !== undefined ||
    input.sequence_placement !== undefined ||
    input.funnel_stage !== undefined ||
    addOffers.length > 0;

  // Permission gating, per field group.
  if (needsUpdate && !can(role, "creatives.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  if (input.status === "archived" && !can(role, "creatives.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  if (input.status === "active" && !can(role, "creatives.restore")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const uniqueIds = Array.from(new Set(input.creative_ids));
  const uniqueOffers = Array.from(new Set(addOffers));

  // Ownership: every creative (and every offer being added) must belong to
  // the caller's org.
  const validCreatives = await db
    .select({ id: creatives.id })
    .from(creatives)
    .where(and(eq(creatives.org_id, orgId), inArray(creatives.id, uniqueIds)));
  if (validCreatives.length !== uniqueIds.length) {
    return apiError(
      400,
      "One or more creatives do not belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "creative_ids" },
    );
  }

  if (uniqueOffers.length > 0) {
    const validOffers = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.org_id, orgId), inArray(offers.id, uniqueOffers)));
    if (validOffers.length !== uniqueOffers.length) {
      return apiError(
        400,
        "One or more offer_ids do not belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "add_offer_ids" },
      );
    }
  }

  try {
    await db.transaction(async (tx) => {
      const scalar: Record<string, unknown> = {};
      if (input.quality !== undefined) scalar.quality = input.quality;
      if (input.sequence_placement !== undefined)
        scalar.sequence_placement = input.sequence_placement;
      if (input.funnel_stage !== undefined)
        scalar.funnel_stage = input.funnel_stage;
      if (input.status !== undefined) {
        scalar.status = input.status;
        scalar.archived_at =
          input.status === "archived" ? drizzleSql`now()` : null;
      }
      if (Object.keys(scalar).length > 0) {
        await tx
          .update(creatives)
          .set(scalar)
          .where(
            and(eq(creatives.org_id, orgId), inArray(creatives.id, uniqueIds)),
          );
      }

      // Additive offer assignment: one row per (creative, offer) pair,
      // conflict-skipping existing junction rows.
      if (uniqueOffers.length > 0) {
        const rows: {
          creative_id: number;
          offer_id: number;
          org_id: string;
        }[] = [];
        for (const cid of uniqueIds) {
          for (const oid of uniqueOffers) {
            rows.push({ creative_id: cid, offer_id: oid, org_id: orgId });
          }
        }
        await tx.insert(creative_offers).values(rows).onConflictDoNothing();
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "Conflict while applying bulk changes",
        API_ERROR_CODES.DUPLICATE,
      );
    }
    throw err;
  }

  return NextResponse.json({ updated: uniqueIds.length });
}
