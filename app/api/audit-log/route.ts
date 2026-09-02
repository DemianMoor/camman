import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { audit_log } from "@/db/schema";
import { apiError, parseListParams, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";

// Owner-only audit feed (869et3vm1 Phase 4).
//
// Newest first, paged, filterable by actor / action / date range. No export —
// the brief says none is needed, and an export of this table is precisely the
// kind of thing that would need its own access decision.
//
// Emails come from the Supabase Admin API, not a join: auth.users is
// Supabase-managed and not in the Drizzle schema. Best-effort, so a slow or
// unavailable admin API degrades the actor column to a raw id rather than
// failing the whole screen.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "audit.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { page, pageSize } = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const actor = sp.get("actor");
  const action = sp.get("action");
  const from = sp.get("from");
  const to = sp.get("to");

  const filters = [eq(audit_log.org_id, orgId)];
  if (actor) filters.push(eq(audit_log.actor_user_id, actor));
  // Prefix match so "guardrail." selects the whole family, which is how an
  // owner actually thinks about these ("show me every guardrail event").
  if (action) filters.push(sql`${audit_log.action} LIKE ${action + "%"}`);
  if (from) filters.push(gte(audit_log.created_at, new Date(from)));
  if (to) filters.push(lte(audit_log.created_at, new Date(to)));

  const where = and(...filters);

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(audit_log)
      .where(where)
      .orderBy(desc(audit_log.created_at))
      .limit(pageSize)
      .offset(page * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(audit_log).where(where),
  ]);

  // Distinct actions present, so the filter dropdown lists what actually
  // exists rather than a hardcoded union that drifts from reality.
  const actions = await db
    .selectDistinct({ action: audit_log.action })
    .from(audit_log)
    .where(eq(audit_log.org_id, orgId))
    .orderBy(audit_log.action);

  const emailById = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const u of data?.users ?? []) if (u.email) emailById.set(u.id, u.email);
  } catch (err) {
    console.error("[audit-log] could not resolve actor emails", err);
  }

  return NextResponse.json({
    data: rows.map((r) => ({
      id: String(r.id),
      created_at: r.created_at,
      actor_user_id: r.actor_user_id,
      actor_email: r.actor_user_id ? (emailById.get(r.actor_user_id) ?? null) : null,
      action: r.action,
      summary: r.summary,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      ip: r.ip,
      metadata: r.metadata,
    })),
    totalCount: counted[0]?.n ?? 0,
    page,
    pageSize,
    actions: actions.map((a) => a.action),
    actors: [...emailById.entries()].map(([id, email]) => ({ id, email })),
  });
}
