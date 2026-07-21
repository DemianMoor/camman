import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  affiliate_networks as _networksMarker,
  brands,
  contact_groups,
  opt_out_brands,
  opt_out_providers,
  opt_outs,
  sms_providers,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { importOptOutsWithAttribution } from "@/lib/sends/import-optout-attribution";
import {
  processAudienceUpload,
  type ResolvedContact,
} from "@/lib/upload/audience-upload";
import { optOutUploadSchema } from "@/lib/validators/opt-outs";

// Silence unused-import lint (re-export for type clarity in IDEs).
void _networksMarker;

const INSERT_CHUNK = 1000;

// The timestamped attribution path upserts contacts, inserts opt_outs, and runs
// a per-number reverse-match against stage_sends — heavier than the plain path.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "opt_outs.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = optOutUploadSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Verify all brand_ids belong to this org.
  const brandRows = await db
    .select({ id: brands.id })
    .from(brands)
    .where(
      and(eq(brands.org_id, orgId), inArray(brands.id, parsed.data.brand_ids)),
    );
  if (brandRows.length !== parsed.data.brand_ids.length) {
    return apiError(
      400,
      "One or more brand_ids don't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "brand_ids" },
    );
  }

  // Verify provider_ids if any.
  if (parsed.data.provider_ids.length > 0) {
    const providerRows = await db
      .select({ id: sms_providers.id })
      .from(sms_providers)
      .where(
        and(
          eq(sms_providers.org_id, orgId),
          inArray(sms_providers.id, parsed.data.provider_ids),
        ),
      );
    if (providerRows.length !== parsed.data.provider_ids.length) {
      return apiError(
        400,
        "One or more provider_ids don't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "provider_ids" },
      );
    }
  }

  // Timestamped attribution import: map each number to the campaign/stage that
  // sent to it, else suppress. Everything commits or rolls back in one tx.
  if (parsed.data.entries && parsed.data.entries.length > 0) {
    // This path applies groups directly, so verify ownership here. (The plain
    // path below re-checks inside processAudienceUpload.)
    const groupIds = parsed.data.assign_to_group_ids ?? [];
    if (groupIds.length > 0) {
      const ownedGroups = await db
        .select({ id: contact_groups.id })
        .from(contact_groups)
        .where(
          and(
            eq(contact_groups.org_id, orgId),
            inArray(contact_groups.id, groupIds),
          ),
        );
      if (ownedGroups.length !== groupIds.length) {
        return apiError(
          400,
          "One or more contact groups don't belong to your organization",
          API_ERROR_CODES.VALIDATION,
          { field: "assign_to_group_ids" },
        );
      }
    }

    const result = await db.transaction((tx) =>
      importOptOutsWithAttribution(tx, {
        orgId,
        entries: parsed.data.entries!,
        timezone: parsed.data.timezone!,
        brandIds: parsed.data.brand_ids,
        providerIds: parsed.data.provider_ids,
        source: parsed.data.source ?? null,
        assignToGroupIds: groupIds,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  }

  const summary = await processAudienceUpload({
    orgId,
    rawPhones: parsed.data.phones!,
    assignToGroupIds: parsed.data.assign_to_group_ids,
    insertEntities: async (rows: ResolvedContact[]) => {
      if (rows.length === 0) return 0;
      // Wrap entity inserts in a transaction so opt_out + junction rows commit
      // atomically.
      return await db.transaction(async (tx) => {
        let totalInserted = 0;
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const chunk = rows.slice(i, i + INSERT_CHUNK);
          const inserted = await tx
            .insert(opt_outs)
            .values(
              chunk.map((r) => ({
                org_id: orgId,
                contact_id: r.contact_id,
                phone_number: r.phone_number,
                source: parsed.data.source ?? null,
              })),
            )
            .returning({ id: opt_outs.id });
          totalInserted += inserted.length;

          // Build and insert junctions for this batch.
          const brandJunctions = inserted.flatMap((o) =>
            parsed.data.brand_ids.map((bid) => ({
              opt_out_id: o.id,
              brand_id: bid,
            })),
          );
          if (brandJunctions.length > 0) {
            await tx
              .insert(opt_out_brands)
              .values(brandJunctions)
              .onConflictDoNothing();
          }
          if (parsed.data.provider_ids.length > 0) {
            const providerJunctions = inserted.flatMap((o) =>
              parsed.data.provider_ids.map((pid) => ({
                opt_out_id: o.id,
                provider_id: pid,
              })),
            );
            await tx
              .insert(opt_out_providers)
              .values(providerJunctions)
              .onConflictDoNothing();
          }
        }
        return totalInserted;
      });
    },
  });

  return NextResponse.json(summary, { status: 201 });
}
