import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  contact_contact_groups,
  contact_groups,
  contacts,
  segment_contacts,
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
  groups_applied: number;
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

  // Resolve which segment (if any) the uploaded contacts will be added to.
  // The old "assign to all segments in a group" branch is gone — groups
  // are now applied directly to contacts via `assign_to_group_ids`.
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
  }

  // Verify any requested contact-group IDs belong to this org BEFORE the
  // upload, so we don't insert contacts then fail on a bad group.
  const requestedGroupIds = Array.from(
    new Set(parsed.data.assign_to_group_ids ?? []),
  );
  if (requestedGroupIds.length > 0) {
    const validGroups = await db
      .select({ id: contact_groups.id })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          inArray(contact_groups.id, requestedGroupIds),
        ),
      );
    if (validGroups.length !== requestedGroupIds.length) {
      return apiError(
        400,
        "One or more assign_to_group_ids do not belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "assign_to_group_ids" },
      );
    }
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

  // If we need contact_ids back (for segment assignment or group tagging),
  // upsert so every row resolves to an id. Otherwise the existing
  // insert-and-ignore path is faster for the common bare-upload case.
  const needsResolvedIds =
    targetSegmentIds.length > 0 || requestedGroupIds.length > 0;

  let inserted_count = 0;
  const resolvedContactIds: string[] = [];

  if (needsResolvedIds) {
    for (let i = 0; i < dedupedValid.length; i += CHUNK_SIZE) {
      const chunk = dedupedValid.slice(i, i + CHUNK_SIZE).map((v) => ({
        org_id: orgId,
        phone_number: v.normalized,
      }));
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

  // Assign to a segment if requested.
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

  // Apply contact groups (tags) to every uploaded contact. Idempotent via
  // the (contact_id, contact_group_id) primary key + ON CONFLICT DO NOTHING.
  if (requestedGroupIds.length > 0 && resolvedContactIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const groupId of requestedGroupIds) {
        for (let i = 0; i < resolvedContactIds.length; i += CHUNK_SIZE) {
          const chunk = resolvedContactIds.slice(i, i + CHUNK_SIZE);
          await tx
            .insert(contact_contact_groups)
            .values(
              chunk.map((cid) => ({
                contact_id: cid,
                contact_group_id: groupId,
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
    groups_applied: requestedGroupIds.length,
  };

  return NextResponse.json(summary, { status: 201 });
}
