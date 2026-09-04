import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { TOKEN_REQUESTS_PER_HOUR } from "@/lib/api/token-usage";

// Per-user API usage drill-in for /settings/users (ClickUp 869evpmbz).
// Owner-only, and unreachable by any token — see the note on ../tokens/route.ts.
//
// ⚠️ TWO SOURCES, ON PURPOSE, AND THEY ANSWER DIFFERENT QUESTIONS.
//
//   api_token_usage — the COUNTERS. Cheap, exact, and the same rows the rate
//     limiter decides from, so the "requests this hour" the Owner reads is
//     literally the number that gated the last request rather than a
//     reconstruction of it.
//
//   audit_log       — the DETAIL. Which endpoints, which denials, from which IP.
//     Filtered to this member's own api.* rows.
//
// Reading endpoint breakdowns out of the counters instead would mean a row per
// (token, endpoint, hour) — a much wider table for a screen nobody loads often.

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { memberId } = await params;

  const daysRaw = Number(req.nextUrl.searchParams.get("days"));
  const days =
    Number.isFinite(daysRaw) && daysRaw > 0
      ? Math.min(MAX_DAYS, Math.floor(daysRaw))
      : DEFAULT_DAYS;

  const member = await db
    .select({ user_id: org_members.user_id, api_enabled: org_members.api_enabled })
    .from(org_members)
    .where(and(eq(org_members.id, memberId), eq(org_members.org_id, orgId)))
    .limit(1);
  if (!member[0]) {
    return apiError(404, "Member not found", API_ERROR_CODES.NOT_FOUND);
  }
  const userId = member[0].user_id;

  // Hourly request/denial series, straight off the counters. Joined through
  // api_tokens so a member's tokens are the scope — including revoked ones,
  // whose history stays readable (revoke is a stamp, not a delete).
  const series = (await db.execute(sql`
    SELECT
      u.window_start AS hour,
      sum(u.count) FILTER (WHERE u.window_kind = 'request')::int AS requests,
      sum(u.count) FILTER (WHERE u.window_kind = 'denied')::int  AS denied
    FROM api_token_usage u
    JOIN api_tokens t ON t.id = u.api_token_id
    WHERE u.org_id = ${orgId}::uuid
      AND t.org_member_id = ${memberId}::uuid
      AND u.window_start >= now() - make_interval(days => ${days})
    GROUP BY u.window_start
    ORDER BY u.window_start
  `)) as unknown as { hour: Date; requests: number | null; denied: number | null }[];

  // Endpoint / denial / IP detail from the audit trail.
  const detail = (await db.execute(sql`
    SELECT
      action,
      metadata->>'endpoint' AS endpoint,
      metadata->>'method'   AS method,
      metadata->>'reason'   AS reason,
      count(*)::int         AS n,
      max(created_at)       AS last_at,
      (array_agg(ip ORDER BY created_at DESC) FILTER (WHERE ip IS NOT NULL))[1] AS last_ip
    FROM audit_log
    WHERE org_id = ${orgId}::uuid
      AND actor_user_id = ${userId}::uuid
      AND action IN ('api.request', 'api.denied', 'api.rate_limited')
      AND created_at >= now() - make_interval(days => ${days})
    GROUP BY action, metadata->>'endpoint', metadata->>'method', metadata->>'reason'
    ORDER BY n DESC
    LIMIT 100
  `)) as unknown as {
    action: string;
    endpoint: string | null;
    method: string | null;
    reason: string | null;
    n: number;
    last_at: Date;
    last_ip: string | null;
  }[];

  const totals = { requests: 0, denied: 0, rate_limited: 0 };
  for (const row of detail) {
    if (row.action === "api.request") totals.requests += row.n;
    else if (row.action === "api.denied") totals.denied += row.n;
    else if (row.action === "api.rate_limited") totals.rate_limited += row.n;
  }

  let lastIp: string | null = null;
  let lastSeen: Date | null = null;
  for (const row of detail) {
    if (row.last_ip && (!lastSeen || row.last_at > lastSeen)) {
      lastSeen = row.last_at;
      lastIp = row.last_ip;
    }
  }

  return NextResponse.json({
    days,
    api_enabled: member[0].api_enabled,
    hourly_limit: TOKEN_REQUESTS_PER_HOUR,
    totals,
    last_ip: lastIp,
    last_seen_at: lastSeen,
    series: series.map((s) => ({
      hour: s.hour,
      requests: s.requests ?? 0,
      denied: s.denied ?? 0,
    })),
    top_endpoints: detail
      .filter((d) => d.action === "api.request" && d.endpoint)
      .slice(0, 20)
      .map((d) => ({ endpoint: d.endpoint, method: d.method, n: d.n })),
    denials: detail
      .filter((d) => d.action !== "api.request")
      .slice(0, 20)
      .map((d) => ({
        action: d.action,
        endpoint: d.endpoint,
        method: d.method,
        reason: d.reason,
        n: d.n,
        last_at: d.last_at,
      })),
  });
}
