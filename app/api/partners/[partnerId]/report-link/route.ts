import { NextResponse, type NextRequest } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { appOrigin, partnerOrigin } from "@/lib/app-origin";
import { loadPartner } from "@/lib/partners/queries";
import { can } from "@/lib/permissions";
import { issueReportToken, revokeReportToken } from "@/lib/reporting/partner-report-token";

// Issue / rotate / revoke a partner's signed report link (Drip Phase 7; on the
// PARTNER since 0200 — moved here from /api/partner-keys/[keyId]/report-link).
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
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).partnerId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "partnerId" });

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

  // The preconditions issueReportToken enforces in SQL, told apart here so the
  // operator learns WHY rather than seeing a dead URL (ruling Q7).
  const partner = await loadPartner(orgId, id);
  if (!partner) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  if (partner.status !== "active") {
    return apiError(409, "An archived partner cannot have a report link", API_ERROR_CODES.CONFLICT, {
      code: "archived",
    });
  }
  if (!partner.can_have_link) {
    return apiError(
      409,
      "Report links work for partners with a live key, or with no keys at all. Switch one key out of sandbox first.",
      API_ERROR_CODES.CONFLICT,
      { code: "sandbox_only" },
    );
  }

  const token = await issueReportToken(orgId, id, expiresAt);
  if (!token) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  // ⚠️ SHOWN ONCE. Only the SHA-256 is stored, so this response is the single
  // opportunity to copy the link — the same contract as the intake secret.
  // ⚠️ THE FULL URL IS BUILT SERVER-SIDE, from env, never from the request Host
  // (lib/app-origin.ts). An operator browsing a preview deployment would
  // otherwise be handed a link on that preview's hostname, which 404s for the
  // partner the moment the deployment is superseded. Partner-facing host first,
  // primary host as the single-hostname fallback.
  const origin = partnerOrigin() ?? appOrigin();
  return NextResponse.json({
    ok: true,
    token,
    url: origin ? `${origin}/partner-report/${token}` : null,
    shown_once: true,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).partnerId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "partnerId" });

  const ok = await revokeReportToken(orgId, id);
  if (!ok) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  return NextResponse.json({ ok: true, revoked: true });
}
