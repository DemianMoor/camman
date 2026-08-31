import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, invites, org_members } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";

// Owner-facing member roster for /settings/users (ClickUp 869et3vm1 Phase 1).
//
// Deliberately NOT an extension of /api/members, which is the campaign
// assignee picker: that one is readable by anyone with campaigns.view and
// returns just id + role. This one is gated on users.manage and exposes email,
// last login, last IP and pending invites — a strictly more sensitive
// projection that must not inherit the picker's audience.
//
// Emails live in auth.users, which is Supabase-managed and not in our Drizzle
// schema, so they come from the Admin API rather than a join.
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const members = await db
    .select({
      id: org_members.id,
      user_id: org_members.user_id,
      role: org_members.role,
      is_active: org_members.is_active,
      last_login_at: org_members.last_login_at,
      last_login_ip: org_members.last_login_ip,
      invited_email: org_members.invited_email,
      joined_at: org_members.joined_at,
    })
    .from(org_members)
    .where(eq(org_members.org_id, orgId))
    .orderBy(desc(org_members.joined_at));

  // How many approved-but-unsent stages each member would have auto-paused if
  // deactivated right now. Shown as a warning on the deactivate confirmation,
  // so the Owner sees the blast radius BEFORE confirming rather than in the
  // result toast afterwards.
  const pendingByCreator = await db
    .select({
      user_id: campaign_stages.created_by_user_id,
      n: sql<number>`count(*)::int`,
    })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        eq(campaign_stages.send_approved, true),
        isNull(campaign_stages.sent_at),
      ),
    )
    .groupBy(campaign_stages.created_by_user_id);

  const pendingMap = new Map<string, number>();
  for (const row of pendingByCreator) {
    if (row.user_id) pendingMap.set(row.user_id, row.n);
  }

  // Resolve emails. Best-effort: if the Admin API is unavailable the roster
  // still renders with the address we recorded at invite time, because a
  // screen that fails entirely is worse than one missing a column.
  const emailById = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const u of data?.users ?? []) {
      if (u.email) emailById.set(u.id, u.email);
    }
  } catch (err) {
    console.error("[users/list] could not resolve emails from Supabase Admin", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const pending = await db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      expires_at: invites.expires_at,
      created_at: invites.created_at,
    })
    .from(invites)
    .where(and(eq(invites.org_id, orgId), isNull(invites.accepted_at)))
    .orderBy(desc(invites.created_at));

  const now = Date.now();

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      user_id: m.user_id,
      email: emailById.get(m.user_id) ?? m.invited_email ?? null,
      role: m.role,
      is_active: m.is_active,
      last_login_at: m.last_login_at,
      last_login_ip: m.last_login_ip,
      joined_at: m.joined_at,
      pending_stages: pendingMap.get(m.user_id) ?? 0,
    })),
    invites: pending.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expires_at: i.expires_at,
      created_at: i.created_at,
      // Expired invites are kept and shown as expired rather than hidden: an
      // invite that silently vanished looks like it was never sent, and the
      // Owner needs to see it to re-send.
      expired: i.expires_at.getTime() < now,
    })),
  });
}
