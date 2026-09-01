import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { deletion_requests } from "@/db/schema";
import { apiError } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can, type Role } from "@/lib/permissions";
import { notifyGuardrail } from "@/lib/guardrails/notify";

// Deletion approval queue (ClickUp 869et3vm1, Phase 3).
//
// For an operator, DELETE on anything except a stage becomes a REQUEST. The
// Owner approves or rejects at /settings/deletion-requests, and approval
// executes the original delete under the OWNER's actor id — the Owner is the one
// who decided, so the audit trail must say so.
//
// ⚠️ THE INTERCEPT RETURNS 202, NOT 403. A 403 would tell the operator "you may
// not do this", which is wrong: they may, it just needs a decision first. The
// distinction matters because it changes what the UI says and whether the
// operator goes looking for a workaround.
//
// Stages are excluded because the matrix grants the operator stage deletion
// outright, and campaigns because campaigns have no hard delete in this
// codebase — "delete a campaign" is archive, which they may do.

export type DeletionOutcome =
  | { intercepted: false }
  | { intercepted: true; response: NextResponse };

/**
 * Call at the top of a DELETE handler, after auth.
 *
 * When it returns `intercepted: true`, return the enclosed response and do NOT
 * perform the delete.
 */
export async function interceptDeletion(opts: {
  orgId: string;
  role: Role;
  actorUserId: string;
  entityType: string;
  entityId: string | number;
  entityLabel?: string | null;
  reason?: string | null;
}): Promise<DeletionOutcome> {
  // Anyone who may approve a deletion may also just do it.
  if (can(opts.role, "deletion.approve")) return { intercepted: false };
  // A role with no request permission is denied by its route permission
  // already; this helper only diverts roles that hold deletion.request.
  if (!can(opts.role, "deletion.request")) return { intercepted: false };

  const entityId = String(opts.entityId);

  // One OPEN request per entity, enforced by a partial unique index. A second
  // click must read as "already pending", not as an error.
  const existing = await db
    .select({ id: deletion_requests.id })
    .from(deletion_requests)
    .where(
      and(
        eq(deletion_requests.org_id, opts.orgId),
        eq(deletion_requests.entity_type, opts.entityType),
        eq(deletion_requests.entity_id, entityId),
        eq(deletion_requests.status, "pending"),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return {
      intercepted: true,
      response: NextResponse.json(
        {
          requested: true,
          already_pending: true,
          request_id: String(existing[0].id),
          message: "A deletion request for this is already waiting for owner approval.",
        },
        { status: 202 },
      ),
    };
  }

  const [row] = await db
    .insert(deletion_requests)
    .values({
      org_id: opts.orgId,
      entity_type: opts.entityType,
      entity_id: entityId,
      entity_label: opts.entityLabel ?? null,
      reason: opts.reason ?? null,
      requested_by: opts.actorUserId,
      status: "pending",
    })
    .returning({ id: deletion_requests.id });

  await notifyGuardrail({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    event: "guardrail.deletion_requested",
    headline: `Deletion requested: ${opts.entityType} ${opts.entityLabel ?? entityId}`,
    detail: [
      `Type: ${opts.entityType}`,
      `Id: ${entityId}`,
      opts.reason ? `Reason: ${opts.reason}` : "No reason given",
      "Approve or reject at /settings/deletion-requests",
    ],
    entityType: opts.entityType,
    entityId,
    metadata: { request_id: String(row.id) },
  });

  return {
    intercepted: true,
    response: NextResponse.json(
      {
        requested: true,
        request_id: String(row.id),
        message:
          "Deletion requested. An owner needs to approve it before anything is removed.",
      },
      { status: 202 },
    ),
  };
}

export interface DeletionRequestRow {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  reason: string | null;
  requested_by: string | null;
  status: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
}

export async function listDeletionRequests(
  orgId: string,
  status?: string,
): Promise<DeletionRequestRow[]> {
  const rows = await db
    .select()
    .from(deletion_requests)
    .where(
      status
        ? and(
            eq(deletion_requests.org_id, orgId),
            eq(deletion_requests.status, status),
          )
        : eq(deletion_requests.org_id, orgId),
    )
    .orderBy(desc(deletion_requests.created_at))
    .limit(200);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/**
 * Record a decision. Returns the row so the caller can execute the underlying
 * delete for an approval.
 *
 * ⚠️ The DECIDER's id goes in `decided_by`, and the eventual delete runs under
 * that id too. Attributing the delete to the requester would say the operator
 * deleted something they were explicitly not allowed to delete.
 */
export async function decideDeletionRequest(opts: {
  orgId: string;
  requestId: string;
  decision: "approved" | "rejected";
  deciderUserId: string;
  note?: string | null;
}): Promise<DeletionRequestRow | null> {
  const [row] = await db
    .update(deletion_requests)
    .set({
      status: opts.decision,
      decided_by: opts.deciderUserId,
      decided_at: new Date(),
      decision_note: opts.note ?? null,
    })
    .where(
      and(
        eq(deletion_requests.org_id, opts.orgId),
        eq(deletion_requests.id, sql`${opts.requestId}::bigint`),
        eq(deletion_requests.status, "pending"),
      ),
    )
    .returning();

  if (!row) return null;

  await notifyGuardrail({
    orgId: opts.orgId,
    actorUserId: opts.deciderUserId,
    event: "guardrail.deletion_decided",
    headline: `Deletion ${opts.decision}: ${row.entity_type} ${row.entity_label ?? row.entity_id}`,
    detail: [opts.note ? `Note: ${opts.note}` : "No note"],
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: { request_id: String(row.id), decision: opts.decision },
  });

  return { ...row, id: String(row.id) };
}

/** Shared 403 for a role that may neither delete nor request. */
export function deletionForbidden() {
  return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
}
