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
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  phone_number: contacts.phone_number,
  created_at: contacts.created_at,
} as const;

// Views are mutually exclusive filters driven by the stat tiles in the UI.
// active / archived map to is_archived; opt_outs / opt_ins / clickers filter
// to contacts that appear in the respective tables.
const VALID_VIEWS = new Set([
  "active",
  "archived",
  "opt_outs",
  "opt_ins",
  "clickers",
] as const);

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const rawView = sp.get("view") ?? "active";
  const view = (VALID_VIEWS as Set<string>).has(rawView) ? rawView : "active";
  const segmentIdRaw = sp.get("segment_id");
  const segmentId =
    segmentIdRaw && /^\d+$/.test(segmentIdRaw) ? Number(segmentIdRaw) : null;
  // group_ids=12,34 — comma-separated. OR semantics across groups (any-of).
  const groupIdsRaw = sp.get("group_ids");
  const groupIds = groupIdsRaw
    ? groupIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map((s) => Number(s))
    : [];

  const conditions = [eq(contacts.org_id, orgId)];
  if (groupIds.length > 0) {
    // Inline the IDs as a literal int[] — group_ids has already been
    // sanitized to integers above, so this is safe against injection.
    const idsLiteral = groupIds.join(",");
    conditions.push(
      drizzleSql`exists (
        select 1 from contact_contact_groups ccg
        where ccg.contact_id = ${contacts.id}
          and ccg.org_id = ${orgId}
          and ccg.contact_group_id = ANY(ARRAY[${drizzleSql.raw(idsLiteral)}]::int[])
      )`,
    );
  }
  if (segmentId !== null) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(segment_contacts)
          .where(
            and(
              eq(segment_contacts.contact_id, contacts.id),
              eq(segment_contacts.segment_id, segmentId),
              eq(segment_contacts.org_id, orgId),
            ),
          ),
      ),
    );
  }
  if (params.search) {
    conditions.push(ilike(contacts.phone_number, `%${params.search}%`));
  }
  if (view === "active") {
    conditions.push(eq(contacts.is_archived, false));
  } else if (view === "archived") {
    conditions.push(eq(contacts.is_archived, true));
  } else if (view === "opt_outs") {
    // Active contacts that have at least one opt_out record.
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
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
    );
  } else if (view === "opt_ins") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
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
    );
  } else if (view === "clickers") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
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
    );
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? contacts.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  // JSON aggregate of contact_groups joined to each contact. Returns `[]`
  // when the contact has no groups. Same shape as the segment_groups agg
  // used elsewhere — literal SQL aliases avoid column-name ambiguity.
  const groupsAggSql = drizzleSql<
    { id: number; name: string; color: string | null }[]
  >`(
    select coalesce(json_agg(json_build_object(
      'id', cg."id",
      'name', cg."name",
      'color', cg."color"
    ) order by cg."name"), '[]'::json)
    from "contact_contact_groups" ccg
    inner join "contact_groups" cg on cg."id" = ccg."contact_group_id"
    where ccg."contact_id" = "contacts"."id"
  )`;

  // Distinct opt_outs reasons per contact, driving the "Status indicators"
  // column. Empty array when the contact has no suppressions.
  const statusesAggSql = drizzleSql<string[]>`(
    select coalesce(array_agg(distinct oo."reason"), array[]::text[])
    from "opt_outs" oo
    where oo."contact_id" = "contacts"."id" and oo."org_id" = ${orgId}
  )`;

  // Exact count(*) over an org's contacts is inherently O(rows) — ~670ms on a
  // 752K-row org (an index can't help; measured). Cap the scan: count at most
  // COUNT_CAP+1 rows, so the count stays cheap. Under the cap it's the exact
  // total; at the cap we report a capped total + countApprox=true and the UI
  // shows "N+". Navigation correctness no longer depends on the total — we fetch
  // pageSize+1 rows and return hasMore, so Next/Prev works past the cap too.
  const COUNT_CAP = 10000;
  const capSub = db
    .select({ one: drizzleSql`1` })
    .from(contacts)
    .where(where)
    .limit(COUNT_CAP + 1)
    .as("cap_sub");

  const [pageRows, countRows] = await Promise.all([
    db
      .select({
        id: contacts.id,
        org_id: contacts.org_id,
        phone_number: contacts.phone_number,
        is_archived: contacts.is_archived,
        archived_at: contacts.archived_at,
        created_at: contacts.created_at,
        updated_at: contacts.updated_at,
        groups: groupsAggSql,
        statuses: statusesAggSql,
      })
      .from(contacts)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize + 1)
      .offset(params.page * params.pageSize),
    db.select({ count: drizzleSql<number>`count(*)::int` }).from(capSub),
  ]);

  const hasMore = pageRows.length > params.pageSize;
  const data = hasMore ? pageRows.slice(0, params.pageSize) : pageRows;
  const rawCount = countRows[0]?.count ?? 0;
  const countApprox = rawCount > COUNT_CAP;
  const totalCount = countApprox ? COUNT_CAP : rawCount;

  return NextResponse.json({
    data,
    totalCount,
    countApprox,
    hasMore,
    page: params.page,
    pageSize: params.pageSize,
    view,
  });
}
