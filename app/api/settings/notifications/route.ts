import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@/lib/reporting/telegram-report-format";

// GET — current notification settings for the org (or defaults if no row yet).
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = (await db.execute(sql`
    SELECT
      daily_report_enabled, hourly_report_enabled,
      stall_alert_enabled, unjoinable_alert_enabled,
      daily_report_hour,
      hourly_window_from, hourly_window_to, hourly_interval_hours,
      active_weekdays,
      updated_at
    FROM notification_settings
    WHERE org_id = ${orgId}
    LIMIT 1
  `)) as unknown as {
    daily_report_enabled: boolean;
    hourly_report_enabled: boolean;
    stall_alert_enabled: boolean;
    unjoinable_alert_enabled: boolean;
    daily_report_hour: number;
    hourly_window_from: number;
    hourly_window_to: number;
    hourly_interval_hours: number;
    active_weekdays: number[];
    updated_at: string | null;
  }[];

  const r = rows[0];
  return NextResponse.json({
    daily_report_enabled: r?.daily_report_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.daily_report_enabled,
    hourly_report_enabled: r?.hourly_report_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_report_enabled,
    stall_alert_enabled: r?.stall_alert_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.stall_alert_enabled,
    unjoinable_alert_enabled: r?.unjoinable_alert_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.unjoinable_alert_enabled,
    daily_report_hour: r?.daily_report_hour ?? DEFAULT_NOTIFICATION_SETTINGS.daily_report_hour,
    hourly_window_from: r?.hourly_window_from ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_window_from,
    hourly_window_to: r?.hourly_window_to ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_window_to,
    hourly_interval_hours: r?.hourly_interval_hours ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_interval_hours,
    active_weekdays: r?.active_weekdays ?? DEFAULT_NOTIFICATION_SETTINGS.active_weekdays,
    updated_at: r?.updated_at ?? null,
  });
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
  const patch = parsed.data;

  // Build a full settings object by reading current (or defaults) then merging.
  const curRows = (await db.execute(sql`
    SELECT
      daily_report_enabled, hourly_report_enabled,
      stall_alert_enabled, unjoinable_alert_enabled,
      daily_report_hour, hourly_window_from, hourly_window_to, hourly_interval_hours,
      active_weekdays
    FROM notification_settings
    WHERE org_id = ${orgId}
    LIMIT 1
  `)) as unknown as {
    daily_report_enabled: boolean;
    hourly_report_enabled: boolean;
    stall_alert_enabled: boolean;
    unjoinable_alert_enabled: boolean;
    daily_report_hour: number;
    hourly_window_from: number;
    hourly_window_to: number;
    hourly_interval_hours: number;
    active_weekdays: number[];
  }[];

  const cur = curRows[0] ?? DEFAULT_NOTIFICATION_SETTINGS;
  const next = { ...cur, ...patch };

  await db.execute(sql`
    INSERT INTO notification_settings (
      org_id,
      daily_report_enabled, hourly_report_enabled,
      stall_alert_enabled, unjoinable_alert_enabled,
      daily_report_hour,
      hourly_window_from, hourly_window_to, hourly_interval_hours,
      active_weekdays,
      updated_at
    ) VALUES (
      ${orgId},
      ${next.daily_report_enabled}, ${next.hourly_report_enabled},
      ${next.stall_alert_enabled}, ${next.unjoinable_alert_enabled},
      ${next.daily_report_hour},
      ${next.hourly_window_from}, ${next.hourly_window_to}, ${next.hourly_interval_hours},
      ${next.active_weekdays},
      now()
    )
    ON CONFLICT (org_id) DO UPDATE SET
      daily_report_enabled = EXCLUDED.daily_report_enabled,
      hourly_report_enabled = EXCLUDED.hourly_report_enabled,
      stall_alert_enabled = EXCLUDED.stall_alert_enabled,
      unjoinable_alert_enabled = EXCLUDED.unjoinable_alert_enabled,
      daily_report_hour = EXCLUDED.daily_report_hour,
      hourly_window_from = EXCLUDED.hourly_window_from,
      hourly_window_to = EXCLUDED.hourly_window_to,
      hourly_interval_hours = EXCLUDED.hourly_interval_hours,
      active_weekdays = EXCLUDED.active_weekdays,
      updated_at = now()
  `);

  return NextResponse.json({ ok: true });
}
