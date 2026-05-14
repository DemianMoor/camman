import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_stages } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can, type Permission } from "@/lib/permissions";

// Bulk stage status changes. Same shape as campaign bulk-status: each
// stage is processed independently, failures don't stop the batch.

const BULK_STAGE_TARGETS = [
  "success",
  "failed",
  "cancelled",
  "archived",
] as const;
type StageBulkTarget = (typeof BULK_STAGE_TARGETS)[number];

const bulkStageStatusSchema = z.object({
  stage_ids: z.array(z.number().int().positive()).min(1).max(500),
  target_status: z.enum(BULK_STAGE_TARGETS),
  confirm: z.literal(true),
});

// Per-target permission. Archive uses stages.archive; the rest use
// stages.send (matching the single /status endpoint).
function permissionFor(to: StageBulkTarget): Permission {
  if (to === "archived") return "stages.archive";
  return "stages.send";
}

// Allowed source states per target. Mirrors TRANSITIONS in
// app/api/campaigns/[campaignId]/stages/[stageId]/status/route.ts plus
// 'archive (any non-archived)'.
function allowedFrom(to: StageBulkTarget): ReadonlySet<string> {
  switch (to) {
    case "success":
      return new Set(["sent"]);
    case "failed":
      return new Set(["sent"]);
    case "cancelled":
      return new Set(["draft", "pending"]);
    case "archived":
      return new Set([
        "draft",
        "pending",
        "sent",
        "success",
        "cancelled",
        "failed",
      ]);
  }
}

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = bulkStageStatusSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { stage_ids, target_status } = parsed.data;

  if (!can(role, permissionFor(target_status))) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Fetch current state. The (campaign_id, id, org_id) filter prevents
  // operators from flipping stages outside their org or in a sibling
  // campaign via the URL path parameter.
  const rows = await db
    .select({ id: campaign_stages.id, status: campaign_stages.status })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        eq(campaign_stages.campaign_id, cid),
        inArray(campaign_stages.id, stage_ids),
      ),
    );
  const byId = new Map<number, string>();
  for (const r of rows) byId.set(r.id, r.status);
  const allowed = allowedFrom(target_status);

  const succeeded: number[] = [];
  const failed: { id: number; reason: string }[] = [];

  for (const id of stage_ids) {
    const from = byId.get(id);
    if (!from) {
      failed.push({ id, reason: "not_found" });
      continue;
    }
    if (!allowed.has(from)) {
      failed.push({ id, reason: `invalid_transition_from_${from}` });
      continue;
    }
    try {
      if (target_status === "archived") {
        await db
          .update(campaign_stages)
          .set({
            previous_status: drizzleSql`${campaign_stages.status}`,
            status: "archived",
            status_changed_at: drizzleSql`now()`,
            archived_at: drizzleSql`now()`,
          })
          .where(
            and(
              eq(campaign_stages.id, id),
              eq(campaign_stages.campaign_id, cid),
              eq(campaign_stages.org_id, orgId),
            ),
          );
      } else {
        await db
          .update(campaign_stages)
          .set({
            status: target_status,
            previous_status: from,
            status_changed_at: drizzleSql`now()`,
          })
          .where(
            and(
              eq(campaign_stages.id, id),
              eq(campaign_stages.campaign_id, cid),
              eq(campaign_stages.org_id, orgId),
            ),
          );
      }
      succeeded.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      failed.push({ id, reason: msg.slice(0, 200) });
    }
  }

  return NextResponse.json({ succeeded, failed });
}
