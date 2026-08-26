import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  loadNotificationSettings,
  saveNotificationSettings,
} from "@/lib/reporting/notification-settings";

// Per-org Telegram notification settings (migration 0173). The read/write
// itself lives in lib/reporting/notification-settings.ts so it can be tested
// directly — see scripts/test-notification-settings-persistence.ts.

// GET — current notification settings for the org (or defaults if no row yet).
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  return NextResponse.json(await loadNotificationSettings(orgId));
}

const putSchema = z.object({
  daily_report_enabled: z.boolean().optional(),
  hourly_report_enabled: z.boolean().optional(),
  stall_alert_enabled: z.boolean().optional(),
  unjoinable_alert_enabled: z.boolean().optional(),
  daily_report_hour: z.number().int().min(0).max(23).optional(),
  hourly_window_from: z.number().int().min(0).max(23).optional(),
  hourly_window_to: z.number().int().min(0).max(23).optional(),
  hourly_interval_hours: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  active_weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
});

// PUT — upsert notification settings (manager+).
export async function PUT(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.drain")) {
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
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }

  await saveNotificationSettings(orgId, parsed.data);
  return NextResponse.json({ ok: true });
}
