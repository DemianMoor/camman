import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  contacts,
  segment_contacts,
  segment_groups,
  segment_segment_groups,
  segments,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { validatePhonesBatch } from "@/lib/phone-validation";
import { contactBulkUploadSchema } from "@/lib/validators/contacts";

const CHUNK_SIZE = 1000;
const INVALID_SAMPLE_LIMIT = 20;

export type UploadResultSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
  segments_assigned: number;
};

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = contactBulkUploadSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Resolve which segments (if any) we'll assign the uploaded contacts to.
  // Branches: nothing, single segment, or all active segments in a group.
  let targetSegmentIds: number[] = [];
  if (parsed.data.assign_to_segment_id != null) {
    const segRow = await db
      .select({ id: segments.id })
      .from(segments)
      .where(
        and(
          eq(segments.id, parsed.data.assign_to_segment_id),
          eq(segments.org_id, orgId),
        ),
      )
      .limit(1);
    if (!segRow[0]) {
      return apiError(
        400,
        "assign_to_segment_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "assign_to_segment_id" },
      );
    }
    targetSegmentIds = [segRow[0].id];
  } else if (parsed.data.assign_to_segment_group_id != null) {
    // Verify the group is in this org, then resolve its active segments
    // through the junction table.
    const grpRow = await db
      .select({ id: segment_groups.id })
      .from(segment_groups)
      .where(
        and(
          eq(segment_groups.id, parsed.data.assign_to_segment_group_id),
          eq(segment_groups.org_id, orgId),
        ),
      )
      .limit(1);
    if (!grpRow[0]) {
      return apiError(
        400,
        "assign_to_segment_group_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "assign_to_segment_group_id" },
      );
    }
    const segRows = await db
      .select({ id: segments.id })
      .from(segment_segment_groups)
      .innerJoin(segments, eq(segments.id, segment_segment_groups.segment_id))
      .where(
        and(
          eq(
            segment_segment_groups.segment_group_id,
            parsed.data.assign_to_segment_group_id,
          ),
          eq(segments.org_id, orgId),
          eq(segments.status, "active"),
        ),
      );
    targetSegmentIds = segRows.map((r) => r.id);
  }

  // Split by newline / comma / semicolon, trim, drop empties.
  const rawLines = parsed.data.phones
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const submitted = rawLines.length;

  const { valid, invalid } = validatePhonesBatch(rawLines);

  // Dedup valid by normalized E.164, preserving first occurrence.
  const seen = new Set<string>();
  const dedupedValid: typeof valid = [];
  let duplicates_in_input = 0;
  for (const v of valid) {
    if (seen.has(v.normalized)) {
      duplicates_in_input++;
    } else {
      seen.add(v.normalized);
      dedupedValid.push(v);
    }
  }

  // Insert/upsert path depends on whether we need contact_ids for junction
  // rows. If assigning to segments, upsert so we get IDs back for all rows
  // (existing + new). Otherwise the existing insert-and-ignore path is faster
  // for the common no-assignment case.
  let inserted_count = 0;
  const resolvedContactIds: string[] = [];

  if (targetSegmentIds.length > 0) {
    for (let i = 0; i < dedupedValid.length; i += CHUNK_SIZE) {
      const chunk = dedupedValid.slice(i, i + CHUNK_SIZE).map((v) => ({
        org_id: orgId,
        phone_number: v.normalized,
      }));
      // ON CONFLICT … DO UPDATE so we always get the row back, whether it was
      // newly inserted or pre-existing. We only count actually-new rows as
      // "inserted" — Postgres exposes this via xmax in older versions, but
      // simpler: count rows where created_at = updated_at (after the upsert).
      // To avoid that ambiguity, do a separate pre-check.
      const chunkPhones = chunk.map((c) => c.phone_number);
      const existing = await db
        .select({ phone_number: contacts.phone_number })
        .from(contacts)
        .where(
          and(
            eq(contacts.org_id, orgId),
            inArray(contacts.phone_number, chunkPhones),
          ),
        );
      const existingSet = new Set(existing.map((e) => e.phone_number));

      const upserted = await db
        .insert(contacts)
        .values(chunk)
        .onConflictDoUpdate({
          target: [contacts.org_id, contacts.phone_number],
          set: { updated_at: drizzleSql`now()` },
        })
        .returning({
          id: contacts.id,
          phone_number: contacts.phone_number,
        });

      for (const row of upserted) {
        resolvedContactIds.push(row.id);
        if (!existingSet.has(row.phone_number)) inserted_count++;
      }
    }
  } else {
    for (let i = 0; i < dedupedValid.length; i += CHUNK_SIZE) {
      const chunk = dedupedValid.slice(i, i + CHUNK_SIZE).map((v) => ({
        org_id: orgId,
        phone_number: v.normalized,
      }));
      const result = await db
        .insert(contacts)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      inserted_count += result.length;
    }
  }

  // Assign to segments if requested.
  if (targetSegmentIds.length > 0 && resolvedContactIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const segId of targetSegmentIds) {
        for (let i = 0; i < resolvedContactIds.length; i += CHUNK_SIZE) {
          const chunk = resolvedContactIds.slice(i, i + CHUNK_SIZE);
          await tx
            .insert(segment_contacts)
            .values(
              chunk.map((cid) => ({
                segment_id: segId,
                contact_id: cid,
                org_id: orgId,
              })),
            )
            .onConflictDoNothing();
        }
      }
    });
  }

  const summary: UploadResultSummary = {
    submitted,
    valid: valid.length,
    invalid: invalid.length,
    duplicates_in_input,
    duplicates_in_db: dedupedValid.length - inserted_count,
    inserted: inserted_count,
    invalid_samples: invalid.slice(0, INVALID_SAMPLE_LIMIT),
    segments_assigned: targetSegmentIds.length,
  };

  return NextResponse.json(summary, { status: 201 });
}
