import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can, type Permission } from "@/lib/permissions";

// Bulk campaign status changes. Best-effort: each campaign is processed
// independently and a failure on one doesn't stop the batch. Activation
// from draft is explicitly NOT supported here because it requires the
// audience snapshot path which is non-trivial under bulk semantics —
// operators still activate one campaign at a time.

// Supported target statuses. 'draft' is the restore target (archived →
// draft), mirroring the single /restore endpoint. 'active' here means
// resume (paused → active), NOT activate (draft → active).
const BULK_TARGETS = [
  "paused",
  "active",
  "completed",
  "archived",
  "draft",
] as const;
type BulkTarget = (typeof BULK_TARGETS)[number];

const bulkStatusSchema = z.object({
  campaign_ids: z.array(z.number().int().positive()).min(1).max(500),
  target_status: z.enum(BULK_TARGETS),
  confirm: z.literal(true),
});

// Transitions allowed in bulk. Note: 'draft → active' is intentionally
// missing — see header comment.
function isAllowed(from: string, to: BulkTarget): boolean {
  if (to === "paused") return from === "active";
  if (to === "active") return from === "paused";
  if (to === "completed") return from === "active" || from === "paused";
  if (to === "archived") return from !== "archived";
  if (to === "draft") return from === "archived"; // restore
  return false;
}

function permissionFor(to: BulkTarget): Permission {
  switch (to) {
    case "paused":
    case "active":
      return "campaigns.pause";
    case "completed":
      return "campaigns.complete";
    case "archived":
      return "campaigns.archive";
    case "draft":
      return "campaigns.restore";
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = bulkStatusSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { campaign_ids, target_status } = parsed.data;

  if (!can(role, permissionFor(target_status))) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Fetch current state for all requested campaigns in one round trip.
  // We then iterate and apply transitions one at a time so a single
  // invalid transition doesn't roll back the others.
  const rows = await db
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.org_id, orgId),
        inArray(campaigns.id, campaign_ids),
      ),
    );
  const byId = new Map<number, string>();
  for (const r of rows) byId.set(r.id, r.status);

  const succeeded: number[] = [];
  const failed: { id: number; reason: string }[] = [];

  for (const id of campaign_ids) {
    const from = byId.get(id);
    if (!from) {
      failed.push({ id, reason: "not_found" });
      continue;
    }
    if (!isAllowed(from, target_status)) {
      failed.push({ id, reason: `invalid_transition_from_${from}` });
      continue;
    }
    try {
      if (target_status === "archived") {
        await db
          .update(campaigns)
          .set({
            previous_status: drizzleSql`${campaigns.status}`,
            status: "archived",
            status_changed_at: drizzleSql`now()`,
            archived_at: drizzleSql`now()`,
          })
          .where(and(eq(campaigns.id, id), eq(campaigns.org_id, orgId)));
      } else if (target_status === "draft") {
        // Restore. Matches /restore — archived → draft so any subsequent
        // activation is an explicit operator action.
        await db
          .update(campaigns)
          .set({
            status: "draft",
            previous_status: "archived",
            status_changed_at: drizzleSql`now()`,
            archived_at: null,
          })
          .where(and(eq(campaigns.id, id), eq(campaigns.org_id, orgId)));
      } else {
        await db
          .update(campaigns)
          .set({
            status: target_status,
            previous_status: from,
            status_changed_at: drizzleSql`now()`,
          })
          .where(and(eq(campaigns.id, id), eq(campaigns.org_id, orgId)));
      }
      succeeded.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      failed.push({ id, reason: msg.slice(0, 200) });
    }
  }

  return NextResponse.json({ succeeded, failed });
}
