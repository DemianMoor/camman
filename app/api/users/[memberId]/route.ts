import { and, eq, ne, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";
import { deactivateMember, reactivateMember } from "@/lib/auth/deactivate";
import { changeRoleSchema, setActiveSchema } from "@/lib/validators/users";

// Member mutations for the Owner-only Users screen (ClickUp 869et3vm1 Phase 1).
//
// PATCH takes EITHER { role } OR { is_active }, never both. They are different
// kinds of act with different consequences — a role change is reversible and
// local, a deactivation revokes sessions and disarms scheduled sends — and
// merging them into one body would make the audit trail ambiguous about which
// one the Owner actually intended.

type Body = { role?: unknown; is_active?: unknown };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { memberId } = await params;

  let json: Body;
  try {
    json = (await req.json()) as Body;
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const wantsRole = "role" in json;
  const wantsActive = "is_active" in json;
  if (wantsRole === wantsActive) {
    return apiError(
      400,
      "Send exactly one of `role` or `is_active`.",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const target = await db
    .select({
      id: org_members.id,
      user_id: org_members.user_id,
      role: org_members.role,
      is_active: org_members.is_active,
      invited_email: org_members.invited_email,
    })
    .from(org_members)
    .where(and(eq(org_members.id, memberId), eq(org_members.org_id, orgId)))
    .limit(1);

  if (!target[0]) {
    return apiError(404, "Member not found", API_ERROR_CODES.NOT_FOUND);
  }
  const member = target[0];
  const label = member.invited_email ?? member.user_id;

  // ── Never let the org lock itself out ────────────────────────────────────
  //
  // Two distinct footguns, both of which end with nobody able to administer
  // the org:
  //   a) demoting or deactivating the LAST active owner,
  //   b) an owner deactivating themselves, which would take effect on their
  //      very next request — they could not undo it.
  //
  // The count is taken in the same statement family as the write below rather
  // than remembered from a page render, because "how many owners are there"
  // is exactly the kind of fact that changes between a render and a click.
  const isTargetOwner = member.role === "owner";
  if (isTargetOwner) {
    const others = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(org_members)
      .where(
        and(
          eq(org_members.org_id, orgId),
          eq(org_members.role, "owner"),
          eq(org_members.is_active, true),
          ne(org_members.id, memberId),
        ),
      );
    if ((others[0]?.n ?? 0) === 0) {
      return apiError(
        409,
        "This is the last active owner. Promote another owner first.",
        API_ERROR_CODES.CONFLICT,
        { reason: "last_active_owner" },
      );
    }
  }

  if (member.user_id === user.id) {
    return apiError(
      409,
      "You can't change your own role or access.",
      API_ERROR_CODES.CONFLICT,
      { reason: "self_modification" },
    );
  }

  const ip = requestIp(req);
  const userAgent = requestUserAgent(req);

  if (wantsRole) {
    const parsed = changeRoleSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(
        400,
        parsed.error.issues[0]?.message ?? "Invalid role",
        API_ERROR_CODES.VALIDATION,
        { field: "role" },
      );
    }
    const nextRole = parsed.data.role;
    if (nextRole === member.role) {
      return NextResponse.json({ ok: true, unchanged: true });
    }

    await db
      .update(org_members)
      .set({ role: nextRole })
      .where(and(eq(org_members.id, memberId), eq(org_members.org_id, orgId)));

    await writeAuditLog({
      orgId,
      actorUserId: user.id,
      action: "user.role_changed",
      entityType: "org_member",
      entityId: member.user_id,
      summary: `Changed ${label} from ${member.role} to ${nextRole}`,
      metadata: { from: member.role, to: nextRole },
      ip,
      userAgent,
    });

    return NextResponse.json({ ok: true, role: nextRole });
  }

  const parsedActive = setActiveSchema.safeParse(json);
  if (!parsedActive.success) {
    return apiError(
      400,
      parsedActive.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
      { field: "is_active" },
    );
  }
  const nextActive = parsedActive.data.is_active;
  if (nextActive === member.is_active) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  if (!nextActive) {
    const result = await deactivateMember({
      orgId,
      targetUserId: member.user_id,
      actorUserId: user.id,
      targetLabel: label,
      ip,
      userAgent,
    });
    return NextResponse.json({
      ok: true,
      is_active: false,
      stages_paused: result.stagesPaused,
      sessions_revoked: result.sessionsRevoked,
    });
  }

  await reactivateMember({
    orgId,
    targetUserId: member.user_id,
    actorUserId: user.id,
    targetLabel: label,
    ip,
    userAgent,
  });
  return NextResponse.json({ ok: true, is_active: true });
}
