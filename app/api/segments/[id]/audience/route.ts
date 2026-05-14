import { and, eq, ilike, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segments } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { buildSegmentAudienceClause } from "@/lib/segment-rules-eval";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

type Membership = "all" | "manual" | "rule-matched";

function parseMembership(raw: string | null): Membership {
  if (raw === "manual" || raw === "rule-matched") return raw;
  return "all";
}

// Paginated view of the FULL UNION audience for a segment: manual
// segment_contacts membership ∪ contacts matching all active rules.
// Used by the Audience tab on /segments/[id]. Read-only — manual
// add/remove still goes through the existing /contacts endpoints, and
// rule-matched membership is changed by editing the rules.
//
// Returns one row per contact with phone_number, joined_at,
// membership_type, and the contact's other group memberships so the UI
// can show context badges without an N+1 fan-out.
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

  const segRow = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentIdNum), eq(segments.org_id, orgId)))
    .limit(1);
  if (!segRow[0]) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  const listParams = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const membership = parseMembership(sp.get("membership_type"));

  // The membership filter is enforced in the SQL: 'manual' restricts to
  // rows where segment_contacts has the contact; 'rule-matched' is the
  // complement. 'all' is the unrestricted UNION.
  const audienceClause = await buildSegmentAudienceClause(segmentIdNum, orgId);
  const searchClause = listParams.search
    ? drizzleSql`AND c.phone_number ILIKE ${`%${listParams.search}%`}`
    : drizzleSql``;
  const membershipClause =
    membership === "manual"
      ? drizzleSql`AND sc.contact_id IS NOT NULL`
      : membership === "rule-matched"
        ? drizzleSql`AND sc.contact_id IS NULL`
        : drizzleSql``;

  // Inline LIMIT/OFFSET for paging. Numbers are bounded by parseListParams
  // (capped at 200 by default).
  const limit = listParams.pageSize;
  const offset = listParams.page * listParams.pageSize;

  // The CTE materializes the UNION audience once, then the outer query
  // joins it back to contacts + segment_contacts + the other-groups
  // aggregate. We use json_agg for the other_groups so each contact
  // returns one row with a json array — cheaper than a separate fan-out
  // query.
  const rows = (await db.execute(drizzleSql`
    with audience as (${audienceClause})
    select
      c.id as contact_id,
      c.phone_number,
      sc.created_at as joined_at,
      case when sc.contact_id is not null then 'manual' else 'rule-matched' end as membership_type,
      coalesce(
        (
          select json_agg(json_build_object(
            'id', cg.id,
            'name', cg.name,
            'color', cg.color
          ))
          from contact_contact_groups ccg
          inner join contact_groups cg on cg.id = ccg.contact_group_id
          where ccg.contact_id = c.id and ccg.org_id = ${orgId}::uuid
        ),
        '[]'::json
      ) as other_groups
    from audience a
    inner join contacts c on c.id = a.contact_id
    left join segment_contacts sc
      on sc.contact_id = a.contact_id
     and sc.segment_id = ${segmentIdNum}::int
     and sc.org_id = ${orgId}::uuid
    where 1=1
      ${searchClause}
      ${membershipClause}
    order by sc.created_at desc nulls last, c.id
    limit ${limit}
    offset ${offset}
  `)) as unknown as {
    contact_id: string;
    phone_number: string;
    joined_at: string | null;
    membership_type: "manual" | "rule-matched";
    other_groups: { id: number; name: string; color: string | null }[];
  }[];

  // Total count of the FULL audience under the same filters. Wrap the
  // CTE result in a count() — Postgres optimizes this fine for pools
  // under ~1M.
  const countRows = (await db.execute(drizzleSql`
    with audience as (${audienceClause})
    select count(*)::int as total,
      count(*) filter (
        where exists (
          select 1 from segment_contacts sc
          where sc.contact_id = audience.contact_id
            and sc.segment_id = ${segmentIdNum}::int
            and sc.org_id = ${orgId}::uuid
        )
      )::int as manual_count
    from audience
    inner join contacts c on c.id = audience.contact_id
    where 1=1
      ${searchClause}
  `)) as unknown as { total: number; manual_count: number }[];

  const total = countRows[0]?.total ?? 0;
  const manualCount = countRows[0]?.manual_count ?? 0;
  const ruleMatchedCount = total - manualCount;

  // After applying the membership filter, surface the matching slice's
  // count so the UI can show "N of M". When filter is 'all', this equals
  // total.
  const filteredTotal =
    membership === "manual"
      ? manualCount
      : membership === "rule-matched"
        ? ruleMatchedCount
        : total;

  return NextResponse.json({
    data: rows.map((r) => ({
      contact_id: r.contact_id,
      phone: r.phone_number,
      joined_at: r.joined_at,
      membership_type: r.membership_type,
      other_groups: r.other_groups ?? [],
    })),
    totalCount: filteredTotal,
    page: listParams.page,
    pageSize: listParams.pageSize,
    counts: {
      manual: manualCount,
      rule_matched: ruleMatchedCount,
      total,
    },
  });
}
