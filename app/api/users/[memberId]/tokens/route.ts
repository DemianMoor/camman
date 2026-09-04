import { and, desc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { api_tokens, org_members } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";
import { generateApiToken } from "@/lib/api/tokens";
import { createApiTokenSchema } from "@/lib/validators/users";

// Owner-only token issuance for one member (ClickUp 869evpmbz).
//
// ⚠️ THE OPERATOR CANNOT REACH THIS, AND NOT BECAUSE OF can(). Neither this
// route nor its child passes { route, method } to requireApiMembership(), so
// the operator default-deny refuses them structurally — before any handler body
// runs and without either route appearing in an allowlist. The users.manage
// check below is the second, explicit statement of the same intent.
//
// ⚠️ AND NO TOKEN CAN REACH IT EITHER, for the same structural reason: the
// token gate also requires an explicit { route, method }, and these routes are
// absent from the map's `token` field. A token can never mint another token.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "users.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { memberId } = await params;

  const rows = await db
    .select({
      id: api_tokens.id,
      name: api_tokens.name,
      token_prefix: api_tokens.token_prefix,
      read_only: api_tokens.read_only,
      expires_at: api_tokens.expires_at,
      last_used_at: api_tokens.last_used_at,
      revoked_at: api_tokens.revoked_at,
      created_at: api_tokens.created_at,
    })
    .from(api_tokens)
    .where(
      and(
        eq(api_tokens.org_id, orgId),
        eq(api_tokens.org_member_id, memberId),
      ),
    )
    .orderBy(desc(api_tokens.created_at));

  const now = Date.now();
  return NextResponse.json({
    // No token_hash, and obviously no plaintext — there is no code path in this
    // codebase that can return a token's secret after creation.
    tokens: rows.map((t) => ({
      ...t,
      expired:
        t.expires_at !== null && t.expires_at.getTime() <= now,
    })),
  });
}

export async function POST(
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

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = createApiTokenSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
      { field: parsed.error.issues[0]?.path.join(".") ?? null },
    );
  }

  // Ownership check in the same shape every other member route uses: the member
  // must belong to the CALLER's org. Without it a memberId from another org
  // would mint a token against that org's data.
  const target = await db
    .select({
      id: org_members.id,
      user_id: org_members.user_id,
      role: org_members.role,
      invited_email: org_members.invited_email,
      api_enabled: org_members.api_enabled,
    })
    .from(org_members)
    .where(and(eq(org_members.id, memberId), eq(org_members.org_id, orgId)))
    .limit(1);

  if (!target[0]) {
    return apiError(404, "Member not found", API_ERROR_CODES.NOT_FOUND);
  }
  const member = target[0];
  const label = member.invited_email ?? member.user_id;

  const token = generateApiToken();

  const inserted = await db
    .insert(api_tokens)
    .values({
      org_id: orgId,
      org_member_id: memberId,
      token_hash: token.hash,
      token_prefix: token.prefix,
      name: parsed.data.name,
      expires_at: parsed.data.expires_at
        ? new Date(parsed.data.expires_at)
        : null,
      created_by_user_id: user.id,
    })
    .returning({
      id: api_tokens.id,
      name: api_tokens.name,
      token_prefix: api_tokens.token_prefix,
      read_only: api_tokens.read_only,
      expires_at: api_tokens.expires_at,
      created_at: api_tokens.created_at,
    });

  await writeAuditLog({
    orgId,
    actorUserId: user.id,
    action: "token.created",
    entityType: "api_token",
    entityId: inserted[0].id,
    // The NAME and PREFIX, never the token. Audit rows render in an Owner-facing
    // table and are read by the daily digest; a secret written here would be a
    // secret in three more places.
    summary: `Issued API token "${parsed.data.name}" (${token.prefix}…) for ${label}`,
    metadata: {
      member_id: memberId,
      member_role: member.role,
      token_prefix: token.prefix,
      expires_at: parsed.data.expires_at ?? null,
    },
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
  });

  return NextResponse.json(
    {
      token: inserted[0],
      // ⚠️ THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE CALLER'S MEMORY. Not
      // stored, not recoverable, not logged. If it is lost the Owner revokes and
      // issues another.
      plaintext: token.plaintext,
      // Surfaced so the UI can warn rather than let the Owner hand over a token
      // that will 401 on first use.
      api_enabled: member.api_enabled,
    },
    { status: 201 },
  );
}
