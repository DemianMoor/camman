import { randomBytes } from "crypto";

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { invites, org_members } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";
import { inviteUserSchema } from "@/lib/validators/users";
import { createAdminClient } from "@/lib/supabase/admin";

// Invite = ALLOW-LIST ENTRY, not an emailed link.
//
// Under Google Workspace sign-in there is no password to set and no token for
// the invitee to carry: they simply sign in with Google, and the callback
// looks for an open `invites` row matching their verified address. The row IS
// the authorization. `invites.token` is still populated because the column is
// NOT NULL UNIQUE, and keeping it real leaves the door open to an emailed-link
// flow later without a migration.
//
const INVITE_TTL_DAYS = 30;

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = inviteUserSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
      { field: parsed.error.issues[0]?.path[0] ?? null },
    );
  }
  const { email, role: invitedRole } = parsed.data;

  // Already a member? Say so plainly instead of creating an invite that the
  // callback would ignore (resolveAllowlist checks membership first).
  const emailById = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const u of data?.users ?? []) {
      if (u.email) emailById.set(u.email.toLowerCase(), u.id);
    }
  } catch {
    // Non-fatal: worst case we create an invite that resolveAllowlist will
    // never reach because the membership branch wins. Nothing breaks.
  }
  const existingUserId = emailById.get(email);
  if (existingUserId) {
    const already = await db
      .select({ id: org_members.id })
      .from(org_members)
      .where(
        and(
          eq(org_members.org_id, orgId),
          eq(org_members.user_id, existingUserId),
        ),
      )
      .limit(1);
    if (already[0]) {
      return apiError(
        409,
        "That person is already a member.",
        API_ERROR_CODES.CONFLICT,
        { reason: "already_member" },
      );
    }
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

  // Re-inviting replaces the open invite rather than stacking a second one, so
  // "invite again with a different role" does the obvious thing and
  // resolveAllowlist can never find two rows to choose between.
  const row = await db.transaction(async (tx) => {
    await tx
      .delete(invites)
      .where(
        and(
          eq(invites.org_id, orgId),
          eq(invites.email, email),
          isNull(invites.accepted_at),
        ),
      );

    const inserted = await tx
      .insert(invites)
      .values({
        org_id: orgId,
        email,
        role: invitedRole,
        token: randomBytes(32).toString("base64url"),
        created_by: user.id,
        expires_at: expiresAt,
      })
      .returning({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        expires_at: invites.expires_at,
        created_at: invites.created_at,
      });
    return inserted[0];
  });

  await writeAuditLog({
    orgId,
    actorUserId: user.id,
    action: "user.invited",
    entityType: "invite",
    entityId: row.id,
    summary: `Invited ${email} as ${invitedRole}`,
    metadata: { email, role: invitedRole, expires_at: expiresAt.toISOString() },
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
  });

  return NextResponse.json({ invite: { ...row, expired: false } });
}
