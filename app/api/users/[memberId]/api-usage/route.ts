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
// ⚠️ ONE SOURCE: audit_log. THE HEADLINE NUMBERS AND THE HOURLY SERIES MUST
// AGREE, AND THE ONLY WAY TO GUARANTEE THAT IS TO DERIVE THEM FROM THE SAME
// ROWS WITH THE SAME PREDICATE.
//
// The first cut read the series from `api_token_usage` (the rate limiter's own
// counters) and the totals from audit_log. Both were correct, and they still
// disagreed, because they count different things:
//
//   * the counter increments BEFORE the route allowlist is applied — that is
//     deliberate, so hammering a forbidden route still burns quota — so it
//     includes calls that audit_log records as `api.denied`, never as
//     `api.request`;
//   * and any denial written without an actor (fixed, but historical rows
//     remain) is counted by the token-keyed counter and invisible to an
//     actor-filtered audit query.
//
// Measured on production: audit denied 8 = counter denied 8, but audit requests
// 7 vs counter requests 9 — the gap being exactly the two 403s. Two defensible
// numbers that do not add up are worse on a screen than one slightly narrower
// number, because the reader cannot tell which to trust.
//
// ⚠️ WHAT THIS DELIBERATELY NO LONGER REPORTS: quota consumption. `api_token_usage`
// remains the limiter's authority and is untouched; this screen now answers
// "what did they do", not "how much of the hour's budget is left". If the latter
// is wanted it needs its OWN clearly-named field sourced from the counter —
// never a reused one, which is how the two got conflated in the first place.
//
// SHARED_WHERE below is a single fragment used by both queries so the predicate
// cannot drift between them.

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

  // The ONE predicate both queries below run against. Written once so the
  // headline totals and the hourly series cannot drift apart.
  const SHARED_WHERE = sql`
    org_id = ${orgId}::uuid
      AND actor_user_id = ${userId}::uuid
      AND action IN ('api.request', 'api.denied', 'api.rate_limited')
      AND created_at >= now() - make_interval(days => ${days})
  `;

  // Hourly series. Carries the SAME three buckets the totals do, so
  // sum(series.requests) === totals.requests and likewise for the other two —
  // an identity a reader can check on the screen itself.
  const series = (await db.execute(sql`
    SELECT
      date_trunc('hour', created_at) AS hour,
      count(*) FILTER (WHERE action = 'api.request')::int      AS requests,
      count(*) FILTER (WHERE action = 'api.denied')::int       AS denied,
      count(*) FILTER (WHERE action = 'api.rate_limited')::int AS rate_limited
    FROM audit_log
    WHERE ${SHARED_WHERE}
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as {
    hour: Date;
    requests: number | null;
    denied: number | null;
    rate_limited: number | null;
  }[];

  // Endpoint / denial / IP detail, same rows grouped a different way.
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
    WHERE ${SHARED_WHERE}
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
      rate_limited: s.rate_limited ?? 0,
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
