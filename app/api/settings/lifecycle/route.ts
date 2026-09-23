import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { DEFAULT_LIFECYCLE_THRESHOLDS } from "@/lib/engagement/constants";
import { loadLifecycleSettings, saveLifecycleSettings } from "@/lib/engagement/settings-io";
import { can } from "@/lib/permissions";

// Org-level lifecycle thresholds and the engine switch (migration 0187).
//
// Read: any member who can see campaigns — the values explain the statuses on
// screen. Write: lifecycle.configure (manager+), audited one org_setting_events
// row per changed field, and it stamps reevaluate_requested_at so the change
// reaches every contact on the next run.
export const dynamic = "force-dynamic";

// Ranges mirror lifecycle_settings_ranges_check. The cross-field rule
// (warm_days > hot_days) is checked against the MERGED row below, because either
// side can be the one being edited; the DB CHECK is the backstop.
const putSchema = z
  .object({
    hot_days: z.number().int().min(1).max(365).optional(),
    warm_days: z.number().int().min(2).max(730).optional(),
    freeze_after_messages: z.number().int().min(1).max(1000).optional(),
    freeze_cadence_days: z.number().int().min(1).max(365).optional(),
    suppress_after_days: z.number().int().min(1).max(730).optional(),
    suppress_min_freeze_messages: z.number().int().min(1).max(100).optional(),
    engine_mode: z.enum(["off", "write"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  return NextResponse.json({
    ...(await loadLifecycleSettings(db, orgId)),
    defaults: DEFAULT_LIFECYCLE_THRESHOLDS,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  if (!can(role, "lifecycle.configure")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = putSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid body",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const current = await loadLifecycleSettings(db, orgId);
  const merged = { ...current, ...parsed.data };
  if (merged.warm_days <= merged.hot_days) {
    return apiError(
      400,
      "The warm window must be longer than the hot window.",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { row, changed } = await db.transaction((tx) =>
    saveLifecycleSettings(tx, orgId, parsed.data, user.id),
  );
  return NextResponse.json({ ...row, defaults: DEFAULT_LIFECYCLE_THRESHOLDS, changed });
}
