import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { api_tokens, org_members } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";

// Revoke one token (ClickUp 869evpmbz). Owner-only; see the note on the parent
// route for why neither an operator session nor any token can reach this.
//
// ⚠️ REVOKE IS A STAMP, NOT A DELETE. The row stays forever as the record that
// this token existed, who issued it, and when it was cut — which is the whole
// point of having an audit trail. It also keeps api_token_usage's FK intact, so
// the usage history of a revoked token remains readable in the drill-in.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string; tokenId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { memberId, tokenId } = await params;

  // org_id AND org_member_id are both in the predicate: the org scope is the
  // tenancy guarantee, and the member scope stops a token id from one member
  // being revoked through another member's URL.
  const revoked = await db
    .update(api_tokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(api_tokens.id, tokenId),
        eq(api_tokens.org_id, orgId),
        eq(api_tokens.org_member_id, memberId),
        // Idempotent: revoking twice is a no-op that reports unchanged rather
        // than moving the timestamp and implying a second act.
        isNull(api_tokens.revoked_at),
      ),
    )
    .returning({
      id: api_tokens.id,
      name: api_tokens.name,
      token_prefix: api_tokens.token_prefix,
    });

  if (!revoked[0]) {
    // Either it does not exist, is not this member's, or was already revoked.
    // One answer for all three: distinguishing them tells a caller which token
    // ids exist in an org they may not have reached.
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const member = await db
    .select({ user_id: org_members.user_id, invited_email: org_members.invited_email })
    .from(org_members)
    .where(and(eq(org_members.id, memberId), eq(org_members.org_id, orgId)))
    .limit(1);
  const label = member[0]?.invited_email ?? member[0]?.user_id ?? memberId;

  await writeAuditLog({
    orgId,
    actorUserId: user.id,
    action: "token.revoked",
    entityType: "api_token",
    entityId: revoked[0].id,
    summary: `Revoked API token "${revoked[0].name}" (${revoked[0].token_prefix}…) for ${label}`,
    metadata: {
      member_id: memberId,
      token_prefix: revoked[0].token_prefix,
    },
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
  });

  return NextResponse.json({ ok: true, revoked: revoked[0].id });
}
