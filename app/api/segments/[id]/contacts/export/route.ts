import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  sql as drizzleSql,
} from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  clickers,
  contacts,
  opt_ins,
  opt_outs,
  segment_contacts,
  segments,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const SORT_COLUMNS = {
  phone_number: contacts.phone_number,
  created_at: segment_contacts.created_at,
} as const;

export async function GET(
  req: NextRequest,
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

  // Confirm the segment is in this org; also grab its slug for the filename.
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

  const listParams = parseListParams(req);

  const conditions = [
    eq(segment_contacts.segment_id, segmentIdNum),
    eq(segment_contacts.org_id, orgId),
  ];
  if (listParams.search) {
    conditions.push(ilike(contacts.phone_number, `%${listParams.search}%`));
  }
  const where = and(...conditions);

  const sortKey = (listParams.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? segment_contacts.created_at;
  const orderFn = listParams.sortDir === "asc" ? asc : desc;

  const rowSource = chunkedQuery({
    fetchChunk: (offset, limit) =>
      db
        .select({
          phone_number: contacts.phone_number,
          joined_at: segment_contacts.created_at,
          is_opt_out: exists(
            db
              .select({ x: drizzleSql`1` })
              .from(opt_outs)
              .where(
                and(
                  eq(opt_outs.contact_id, contacts.id),
                  eq(opt_outs.org_id, orgId),
                ),
              ),
          ),
          is_opt_in: exists(
            db
              .select({ x: drizzleSql`1` })
              .from(opt_ins)
              .where(
                and(
                  eq(opt_ins.contact_id, contacts.id),
                  eq(opt_ins.org_id, orgId),
                ),
              ),
          ),
          is_clicker: exists(
            db
              .select({ x: drizzleSql`1` })
              .from(clickers)
              .where(
                and(
                  eq(clickers.contact_id, contacts.id),
                  eq(clickers.org_id, orgId),
                ),
              ),
          ),
        })
        .from(segment_contacts)
        .innerJoin(contacts, eq(contacts.id, segment_contacts.contact_id))
        .where(where)
        .orderBy(orderFn(sortColumn))
        .limit(limit)
        .offset(offset),
  });

  return streamCsvResponse({
    filename: buildExportFilename(`segment-${segRow[0].segment_id}-contacts`),
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "country", label: "Country" },
      { key: "joined_at", label: "Joined Segment At" },
      { key: "is_opt_out", label: "Is Opt-Out" },
      { key: "is_opt_in", label: "Is Opt-In" },
      { key: "is_clicker", label: "Is Clicker" },
    ],
    rowSource,
    rowMapper: (row) => {
      const parsed = parsePhoneNumberFromString(row.phone_number);
      return {
        phone_number: formatPhoneForExport(row.phone_number),
        country: parsed?.country ?? "",
        joined_at: row.joined_at,
        is_opt_out: row.is_opt_out ? "Yes" : "No",
        is_opt_in: row.is_opt_in ? "Yes" : "No",
        is_clicker: row.is_clicker ? "Yes" : "No",
      };
    },
  });
}
