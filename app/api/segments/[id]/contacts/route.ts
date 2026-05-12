import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

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
import { can } from "@/lib/permissions";

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

  if (!can(role, "segment_contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // Confirm segment is in this org.
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

  const params2 = parseListParams(req);

  const conditions = [
    eq(segment_contacts.segment_id, segmentId),
    eq(segment_contacts.org_id, orgId),
  ];
  if (params2.search) {
    conditions.push(ilike(contacts.phone_number, `%${params2.search}%`));
  }
  const where = and(...conditions);

  const sortKey = (params2.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? segment_contacts.created_at;
  const orderFn = params2.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        contact_id: contacts.id,
        phone_number: contacts.phone_number,
        is_archived: contacts.is_archived,
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
      .limit(params2.pageSize)
      .offset(params2.page * params2.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(segment_contacts)
      .innerJoin(contacts, eq(contacts.id, segment_contacts.contact_id))
      .where(where),
  ]);

  // last_sent_at always null in 6.3 — campaigns/messages don't exist yet.
  const data = rows.map((r) => ({ ...r, last_sent_at: null }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params2.page,
    pageSize: params2.pageSize,
  });
}
