import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can, type Permission } from "@/lib/permissions";
import { campaignStatusChangeSchema } from "@/lib/validators/campaigns";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// State machine. Archive is handled via its own endpoint, but we accept
// 'archived' here too so a UI can route everything through one path if it
// chooses to. The route's required-permission lookup uses the transition
// key.
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["active"]),
  active: new Set(["paused", "completed"]),
  paused: new Set(["active", "completed"]),
  completed: new Set<string>(), // terminal except via restore
  archived: new Set<string>(),
};

function permissionFor(
  from: string,
  to: string,
): Permission | null {
  if (to === "archived") return "campaigns.archive";
  if (from === "draft" && to === "active") return "campaigns.activate";
  if (
    (from === "active" && to === "paused") ||
    (from === "paused" && to === "active")
  )
    return "campaigns.pause";
  if (to === "completed") return "campaigns.complete";
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  const { campaignId: cIdParam } = await params;
  const campaignId = parseId(cIdParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = campaignStatusChangeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const next = parsed.data.status;

  const current = await db
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  const from = current[0].status;
  const allowed = TRANSITIONS[from] ?? new Set<string>();
  if (!allowed.has(next)) {
    return apiError(
      409,
      `Cannot transition from "${from}" to "${next}"`,
      API_ERROR_CODES.CONFLICT,
      { reason: "invalid_transition", from, to: next },
    );
  }

  const requiredPerm = permissionFor(from, next);
  if (!requiredPerm || !can(role, requiredPerm)) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const [updated] = await db
    .update(campaigns)
    .set({
      status: next,
      previous_status: from,
      status_changed_at: drizzleSql`now()`,
      archived_at: next === "archived" ? drizzleSql`now()` : null,
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .returning();
  return NextResponse.json(updated);
}
