import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { invites } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";

// Revoke an open invite. This is the un-invite: once the row is gone,
// resolveAllowlist finds nothing and the address can no longer redeem itself
// into a membership.
//
// Only UNACCEPTED invites are revocable. An accepted invite has already become
// an org_members row, and deleting the historical invite would neither remove
// that access nor leave a trace — deactivate the MEMBER instead.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { inviteId } = await params;

  const deleted = await db
    .delete(invites)
    .where(
      and(
        eq(invites.id, inviteId),
        eq(invites.org_id, orgId),
        isNull(invites.accepted_at),
      ),
    )
    .returning({ email: invites.email, role: invites.role });

  if (!deleted[0]) {
    return apiError(
      404,
      "No open invite with that id.",
      API_ERROR_CODES.NOT_FOUND,
    );
  }

  await writeAuditLog({
    orgId,
    actorUserId: user.id,
    action: "user.invite_revoked",
    entityType: "invite",
    entityId: inviteId,
    summary: `Revoked the invite for ${deleted[0].email}`,
    metadata: { email: deleted[0].email, role: deleted[0].role },
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
  });

  return NextResponse.json({ ok: true });
}
