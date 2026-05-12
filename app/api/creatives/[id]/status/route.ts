import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { creativeStatusChangeSchema } from "@/lib/validators/creatives";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// State machine. The keys are current statuses, the values are the legal
// next statuses from each. Archive + restore are handled by their own
// endpoints, so they're not in this map.
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["pending"]),
  pending: new Set(["draft", "ready"]),
  ready: new Set(["paused"]),
  paused: new Set(["ready"]),
  // archived → terminal until restore endpoint moves it back to draft
  archived: new Set<string>(),
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = creativeStatusChangeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const nextStatus = parsed.data.status;

  const current = await db
    .select({ status: creatives.status })
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  const currentStatus = current[0].status;
  const allowed = TRANSITIONS[currentStatus] ?? new Set<string>();
  if (!allowed.has(nextStatus)) {
    return apiError(
      409,
      `Cannot transition from "${currentStatus}" to "${nextStatus}"`,
      API_ERROR_CODES.CONFLICT,
      {
        reason: "invalid_transition",
        from: currentStatus,
        to: nextStatus,
      },
    );
  }

  // The pending → ready approval is the only transition that needs the
  // manager-level creatives.approve permission. All others require the
  // operator-level creatives.update.
  const requiredPermission =
    currentStatus === "pending" && nextStatus === "ready"
      ? "creatives.approve"
      : "creatives.update";
  if (!can(role, requiredPermission)) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const [updated] = await db
    .update(creatives)
    .set({ status: nextStatus })
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .returning();

  return NextResponse.json(updated);
}
