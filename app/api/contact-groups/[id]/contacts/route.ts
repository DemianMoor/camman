import { and, asc, desc, eq, ilike, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  contact_contact_groups,
  contact_groups,
  contacts,
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
  created_at: contacts.created_at,
  joined_at: contact_contact_groups.created_at,
} as const;

// List contacts in this contact group. Paginated, searchable by phone,
// sortable. Each row also surfaces the contact's OTHER group memberships
// for the "Other Groups" column on the detail page.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contact_groups.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const groupId = parseId(id);
  if (groupId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // Verify the group belongs to this org.
  const groupRows = await db
    .select({ id: contact_groups.id })
    .from(contact_groups)
    .where(
      and(eq(contact_groups.id, groupId), eq(contact_groups.org_id, orgId)),
    )
    .limit(1);
  if (!groupRows[0]) {
    return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact_group",
    });
  }

  const listParams = parseListParams(req);

  const conditions = [
    eq(contact_contact_groups.contact_group_id, groupId),
    eq(contact_contact_groups.org_id, orgId),
  ];
  if (listParams.search) {
    conditions.push(ilike(contacts.phone_number, `%${listParams.search}%`));
  }
  const where = and(...conditions);

  const sortKey = (listParams.sortBy ??
    "joined_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? contact_contact_groups.created_at;
  const orderFn = listParams.sortDir === "asc" ? asc : desc;

  // Aggregate the contact's OTHER groups (excluding the current one).
  const otherGroupsAgg = drizzleSql<
    { id: number; name: string; color: string | null }[]
  >`(
    select coalesce(json_agg(json_build_object(
      'id', cg2."id",
      'name', cg2."name",
      'color', cg2."color"
    ) order by cg2."name"), '[]'::json)
    from "contact_contact_groups" ccg2
    inner join "contact_groups" cg2 on cg2."id" = ccg2."contact_group_id"
    where ccg2."contact_id" = "contacts"."id"
      and ccg2."contact_group_id" <> ${groupId}
  )`;

  const [data, countRows] = await Promise.all([
    db
      .select({
        id: contacts.id,
        phone_number: contacts.phone_number,
        is_archived: contacts.is_archived,
        created_at: contacts.created_at,
        joined_at: contact_contact_groups.created_at,
        other_groups: otherGroupsAgg,
      })
      .from(contact_contact_groups)
      .innerJoin(contacts, eq(contacts.id, contact_contact_groups.contact_id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(listParams.pageSize)
      .offset(listParams.page * listParams.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(contact_contact_groups)
      .innerJoin(contacts, eq(contacts.id, contact_contact_groups.contact_id))
      .where(where),
  ]);

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: listParams.page,
    pageSize: listParams.pageSize,
  });
}
