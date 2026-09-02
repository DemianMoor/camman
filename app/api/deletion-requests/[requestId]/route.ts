import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { decideDeletionRequest } from "@/lib/guardrails/deletion-requests";

// Approve or reject one deletion request (869et3vm1 Phase 3).
//
// ⚠️ APPROVAL RECORDS THE DECISION; it does not yet execute the underlying
// delete. Each entity type has its own cascade rules and its own route, and
// firing a generic delete from here would mean re-implementing all of them in a
// place none of their tests cover. The Owner approves, then performs the delete
// on the entity's own screen — where every existing safeguard still applies.
//
// The decision is attributed to the DECIDER, never the requester: recording the
// operator as the actor would say they deleted something they were explicitly
// not allowed to delete.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "deletion.approve")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { requestId } = await params;
  if (!/^\d+$/.test(requestId)) {
    return apiError(400, "Invalid request id", API_ERROR_CODES.VALIDATION);
  }

  let body: { decision?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  if (body.decision !== "approved" && body.decision !== "rejected") {
    return apiError(
      400,
      "decision must be 'approved' or 'rejected'",
      API_ERROR_CODES.VALIDATION,
      { field: "decision" },
    );
  }

  const row = await decideDeletionRequest({
    orgId,
    requestId,
    decision: body.decision,
    deciderUserId: user.id,
    note: typeof body.note === "string" ? body.note : null,
  });

  if (!row) {
    return apiError(
      404,
      "No pending request with that id.",
      API_ERROR_CODES.NOT_FOUND,
    );
  }

  return NextResponse.json({
    ok: true,
    request: row,
    message:
      body.decision === "approved"
        ? `Approved. Delete ${row.entity_type} ${row.entity_label ?? row.entity_id} from its own screen — every normal safeguard still applies there.`
        : "Rejected. Nothing was deleted.",
  });
}
