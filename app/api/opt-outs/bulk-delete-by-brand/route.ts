import { and, eq, inArray, notInArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, opt_out_brands, opt_outs } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { optOutBulkDeleteByBrandSchema } from "@/lib/validators/opt-outs";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "opt_outs.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = optOutBulkDeleteByBrandSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const targetBrandId = parsed.data.brand_id;

  // Verify the brand belongs to this org.
  const brandCheck = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.id, targetBrandId), eq(brands.org_id, orgId)))
    .limit(1);
  if (!brandCheck[0]) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "brand",
    });
  }

  // Transaction: delete junction rows for this brand, then delete any opt_outs
  // that have no remaining brand junctions (orphan cleanup).
  const result = await db.transaction(async (tx) => {
    // Capture opt_out_ids that have this brand AND belong to this org.
    const candidates = await tx
      .select({ opt_out_id: opt_out_brands.opt_out_id })
      .from(opt_out_brands)
      .innerJoin(opt_outs, eq(opt_outs.id, opt_out_brands.opt_out_id))
      .where(
        and(
          eq(opt_out_brands.brand_id, targetBrandId),
          eq(opt_outs.org_id, orgId),
        ),
      );
    const candidateIds = candidates.map((c) => c.opt_out_id);

    if (candidateIds.length === 0) {
      return { deleted_junctions: 0, deleted_opt_outs: 0 };
    }

    // Delete the brand junctions for these opt_outs.
    const deletedJunctions = await tx
      .delete(opt_out_brands)
      .where(
        and(
          eq(opt_out_brands.brand_id, targetBrandId),
          inArray(opt_out_brands.opt_out_id, candidateIds),
        ),
      )
      .returning({ opt_out_id: opt_out_brands.opt_out_id });

    // Among the affected opt_outs, find ones with ZERO remaining brand
    // junctions and delete them (FK cascade will clean opt_out_providers).
    const stillScoped = await tx
      .select({ opt_out_id: opt_out_brands.opt_out_id })
      .from(opt_out_brands)
      .where(inArray(opt_out_brands.opt_out_id, candidateIds));
    const stillScopedSet = new Set(stillScoped.map((r) => r.opt_out_id));
    const orphanIds = candidateIds.filter((id) => !stillScopedSet.has(id));

    let deletedOptOuts = 0;
    if (orphanIds.length > 0) {
      const removed = await tx
        .delete(opt_outs)
        .where(
          and(eq(opt_outs.org_id, orgId), inArray(opt_outs.id, orphanIds)),
        )
        .returning({ id: opt_outs.id });
      deletedOptOuts = removed.length;
    }

    return {
      deleted_junctions: deletedJunctions.length,
      deleted_opt_outs: deletedOptOuts,
    };
  });

  return NextResponse.json(result);
}
