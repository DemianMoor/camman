import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts, segment_contacts, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { validatePhonesBatch } from "@/lib/phone-validation";
import { segmentContactsRemoveSchema } from "@/lib/validators/segments";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const REMOVE_CHUNK = 1000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_contacts.remove")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const segRow = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  if (!segRow[0]) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = segmentContactsRemoveSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Parse + normalize. Mirror the upload pipeline's parsing rules.
  const rawLines = parsed.data.phones
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const submitted = rawLines.length;
  const { valid } = validatePhonesBatch(rawLines);
  const normalized = Array.from(new Set(valid.map((v) => v.normalized)));

  if (normalized.length === 0) {
    return NextResponse.json({
      submitted,
      removed: 0,
      not_found: submitted,
    });
  }

  // Resolve phones → contact_ids in this org.
  const contactRows = await db
    .select({ id: contacts.id, phone_number: contacts.phone_number })
    .from(contacts)
    .where(
      and(
        eq(contacts.org_id, orgId),
        inArray(contacts.phone_number, normalized),
      ),
    );
  const contactIds = contactRows.map((r) => r.id);

  if (contactIds.length === 0) {
    return NextResponse.json({
      submitted,
      removed: 0,
      not_found: submitted,
    });
  }

  // Bulk delete in chunks.
  let removed = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < contactIds.length; i += REMOVE_CHUNK) {
      const chunk = contactIds.slice(i, i + REMOVE_CHUNK);
      const del = await tx
        .delete(segment_contacts)
        .where(
          and(
            eq(segment_contacts.segment_id, segmentId),
            eq(segment_contacts.org_id, orgId),
            inArray(segment_contacts.contact_id, chunk),
          ),
        )
        .returning({ contact_id: segment_contacts.contact_id });
      removed += del.length;
    }
  });

  return NextResponse.json({
    submitted,
    removed,
    not_found: submitted - removed,
  });
}
