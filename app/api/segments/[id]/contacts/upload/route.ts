import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_contacts, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  processAudienceUpload,
  type ResolvedContact,
} from "@/lib/upload/audience-upload";
import { segmentContactsUploadSchema } from "@/lib/validators/segments";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const INSERT_CHUNK = 1000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_contacts.upload")) {
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

  const parsed = segmentContactsUploadSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const summary = await processAudienceUpload({
    orgId,
    rawPhones: parsed.data.phones,
    insertEntities: async (rows: ResolvedContact[]) => {
      if (rows.length === 0) return 0;
      // Inserted-count semantics: how many new (segment_id, contact_id) rows
      // landed. ON CONFLICT DO NOTHING handles already-in-segment phones.
      return await db.transaction(async (tx) => {
        let total = 0;
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const chunk = rows.slice(i, i + INSERT_CHUNK);
          const ins = await tx
            .insert(segment_contacts)
            .values(
              chunk.map((r) => ({
                segment_id: segmentId,
                contact_id: r.contact_id,
                org_id: orgId,
              })),
            )
            .onConflictDoNothing()
            .returning({ contact_id: segment_contacts.contact_id });
          total += ins.length;
        }
        return total;
      });
    },
  });

  return NextResponse.json(summary, { status: 201 });
}
