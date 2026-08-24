import { NextResponse, type NextRequest } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { issueReportToken, revokeReportToken } from "@/lib/reporting/partner-report-token";

// Issue / rotate / revoke a partner's signed report link (Drip Phase 7).
//
// ⚠️ partner_keys.manage, not a view permission: a report link exposes that
// partner's aggregates to anyone holding the URL, so creating one is a
// credential-issuing action.
export const dynamic = "force-dynamic";

function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).keyId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);

  let body: { expires_at?: unknown } = {};
  try {
    body = (await req.json()) as { expires_at?: unknown };
  } catch {
    /* an empty body means "no expiry" */
  }
  const raw = body?.expires_at;
  let expiresAt: Date | null = null;
  if (typeof raw === "string" && raw.trim()) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return apiError(400, "expires_at must be an ISO datetime", API_ERROR_CODES.VALIDATION, {
        field: "expires_at",
      });
    }
    expiresAt = d;
  }

  const token = await issueReportToken(orgId, id, expiresAt);
  if (!token) {
    return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "partner_key",
    });
  }
  // ⚠️ SHOWN ONCE. Only the SHA-256 is stored, so this response is the single
  // opportunity to copy the link — the same contract as the intake secret.
  return NextResponse.json({ ok: true, token, shown_once: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).keyId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);

  const ok = await revokeReportToken(orgId, id);
  if (!ok) {
    return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "partner_key",
    });
  }
  return NextResponse.json({ ok: true, revoked: true });
}
