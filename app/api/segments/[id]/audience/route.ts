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
import {
  buildSegmentAudienceClause,
  excludeOptOutsFromAudience,
} from "@/lib/segment-rules-eval";

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
// W2 Task 4: evaluates the audience ONCE using a CTE + window function
// count(*) OVER () so rows and total count come from a single DB pass.
// Previously the audience clause was materialised twice (one SELECT for
// rows + one SELECT for count), doubling the work on segments whose rules
// touch the full contacts table.
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

  const audienceClause = excludeOptOutsFromAudience(
    await buildSegmentAudienceClause(segmentIdNum, orgId),
    orgId,
  );
  const searchClause = listParams.search
    ? drizzleSql`AND c.phone_number ILIKE ${`%${listParams.search}%`}`
    : drizzleSql``;
  const membershipClause =
    membership === "manual"
      ? drizzleSql`AND sc.contact_id IS NOT NULL`
      : membership === "rule-matched"
        ? drizzleSql`AND sc.contact_id IS NULL`
        : drizzleSql``;

  const limit = listParams.pageSize;
  const offset = listParams.page * listParams.pageSize;

  // Single evaluation: the audience CTE is materialised once. Window functions
  // compute all three count buckets (total, manual, rule-matched) in the same
  // pass, then LIMIT/OFFSET selects the visible page. No second round-trip.
  const rows = (await db.execute(drizzleSql`
    with audience as (${audienceClause}),
    joined as (
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
        ) as other_groups,
        -- Window-function counts over the filtered set — computed once.
        count(*) filter (where 1=1)
          over ()::int as total_count,
        count(*) filter (where sc.contact_id is not null)
          over ()::int as manual_count
      from audience a
      inner join contacts c on c.id = a.contact_id
      left join segment_contacts sc
        on sc.contact_id = a.contact_id
       and sc.segment_id = ${segmentIdNum}::int
       and sc.org_id = ${orgId}::uuid
      where 1=1
        ${searchClause}
        ${membershipClause}
    )
    select *
    from joined
    order by joined_at desc nulls last, contact_id
    limit ${limit}
    offset ${offset}
  `)) as unknown as {
    contact_id: string;
    phone_number: string;
    joined_at: string | null;
    membership_type: "manual" | "rule-matched";
    other_groups: { id: number; name: string; color: string | null }[];
    total_count: number;
    manual_count: number;
  }[];

  // The window counts come from any row (they're identical across the page).
  // Use 0 when the page is empty (no contacts match the filter).
  const total = Number(rows[0]?.total_count ?? 0);
  const manualCount = Number(rows[0]?.manual_count ?? 0);
  const ruleMatchedCount = total - manualCount;

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
