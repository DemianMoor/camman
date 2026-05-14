import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";
import { buildSegmentAudienceClause } from "@/lib/segment-rules-eval";

// Full-audience export for a segment: UNION of manual segment_contacts
// membership and contacts matching all active rules. Distinct from
// /api/segments/[id]/contacts/export (which exports manual-only with
// richer per-contact engagement columns).
//
// Columns kept tight on purpose: phone_number, joined_at, membership_type.
// joined_at is the segment_contacts.created_at when the contact has a
// manual row; NULL for rule-matched-only contacts.

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentIdNum = parseId(id);
  if (segmentIdNum === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const segRow = await db
    .select({ id: segments.id, segment_id: segments.segment_id })
    .from(segments)
    .where(and(eq(segments.id, segmentIdNum), eq(segments.org_id, orgId)))
    .limit(1);
  if (!segRow[0]) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  // We don't reuse buildSegmentAudienceClause directly — it returns just
  // contact_id rows, and we need joined_at + membership_type alongside.
  // Instead we replicate its UNION shape with the per-row columns inline.
  // Keep this query in lockstep with buildSegmentAudienceClause: any rule
  // shape change must update both. (It already gates correctly on
  // active=true via that helper; we just call it for its side effect of
  // assembling the rule predicate fragment when there are rules.)
  const ruleClause = await buildSegmentAudienceClause(segmentIdNum, orgId);

  type Row = {
    phone_number: string;
    joined_at: string | null;
    membership_type: "manual" | "rule-matched";
  };

  const rowSource = chunkedQuery<Row>({
    fetchChunk: async (offset, chunkLimit) => {
      // ruleClause yields a UNION of distinct contact_ids. We join those
      // back to contacts + LEFT JOIN segment_contacts to recover the
      // joined_at and derive the membership_type. The LEFT JOIN ensures
      // rule-matched-only contacts still get a row (with null joined_at).
      const result = (await db.execute(drizzleSql`
        select
          c.phone_number,
          sc.created_at as joined_at,
          case when sc.contact_id is not null then 'manual' else 'rule-matched' end as membership_type
        from (${ruleClause}) audience
        inner join contacts c on c.id = audience.contact_id
        left join segment_contacts sc
          on sc.contact_id = audience.contact_id
         and sc.segment_id = ${segmentIdNum}::int
         and sc.org_id = ${orgId}::uuid
        order by sc.created_at desc nulls last, audience.contact_id
        limit ${chunkLimit}
        offset ${offset}
      `)) as unknown as Row[];
      return Array.isArray(result) ? result : [];
    },
  });

  return streamCsvResponse({
    filename: buildExportFilename(
      `segment-${segRow[0].segment_id}-audience`,
    ),
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "country", label: "Country" },
      { key: "joined_at", label: "Joined Segment At" },
      { key: "membership_type", label: "Membership Type" },
    ],
    rowSource,
    rowMapper: (row) => {
      const parsed = parsePhoneNumberFromString(row.phone_number);
      return {
        phone_number: formatPhoneForExport(row.phone_number),
        country: parsed?.country ?? "",
        joined_at: row.joined_at ?? "",
        membership_type: row.membership_type,
      };
    },
  });
}
