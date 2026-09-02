import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { listDeletionRequests } from "@/lib/guardrails/deletion-requests";

// The Owner approval queue (869et3vm1 Phase 3).
//
// Gated on deletion.approve, which is owner-only — an operator can create
// requests but must never see or decide the queue.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "deletion.approve")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const rows = await listDeletionRequests(orgId, status);
  return NextResponse.json({ requests: rows, totalCount: rows.length });
}
