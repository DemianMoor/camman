import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { notification_settings } from "@/db/schema";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotifSettings,
} from "@/lib/reporting/telegram-report-format";

// Read/write for the per-org Telegram notification settings row (migration
// 0173). Extracted from the API route so the persistence path is reachable
// from a test — a route handler can only be exercised through HTTP, and this
// is the half that broke.
//
// ⭐ THE UPSERT GOES THROUGH THE QUERY BUILDER, NOT A `sql` TEMPLATE, and that
// is not a style preference. `active_weekdays` is smallint[], and interpolating
// a JS array into a Drizzle sql template FLATTENS it into positional params:
// `VALUES (${orgId}, ${[1,2,3,4,5,6]}, ${1})` sends eight params for three
// placeholders, the array column receives the scalar 1, and Postgres rejects
// it with 42804 "column is of type smallint[] but expression is of type
// integer". It type-checks, it builds, and it throws on the first save. The
// builder knows the column is an array and binds it as one.

export type NotificationSettingsRow = NotifSettings & { updated_at: string | null };

type Executor = Pick<typeof db, "select" | "insert">;

export async function loadNotificationSettings(
  orgId: string,
  exec: Executor = db,
): Promise<NotificationSettingsRow> {
  const rows = await exec
    .select()
    .from(notification_settings)
    .where(eq(notification_settings.org_id, orgId))
    .limit(1);
  const r = rows[0];
  if (!r) return { ...DEFAULT_NOTIFICATION_SETTINGS, updated_at: null };
  return {
    daily_report_enabled: r.daily_report_enabled,
    hourly_report_enabled: r.hourly_report_enabled,
    stall_alert_enabled: r.stall_alert_enabled,
    unjoinable_alert_enabled: r.unjoinable_alert_enabled,
    daily_report_hour: r.daily_report_hour,
    hourly_window_from: r.hourly_window_from,
    hourly_window_to: r.hourly_window_to,
    hourly_interval_hours: r.hourly_interval_hours as 1 | 2 | 3,
    active_weekdays: r.active_weekdays,
    updated_at: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

export async function saveNotificationSettings(
  orgId: string,
  patch: Partial<NotifSettings>,
  exec: Executor = db,
): Promise<NotifSettings> {
  const current = await loadNotificationSettings(orgId, exec);
  const next: NotifSettings = {
    daily_report_enabled: patch.daily_report_enabled ?? current.daily_report_enabled,
    hourly_report_enabled: patch.hourly_report_enabled ?? current.hourly_report_enabled,
    stall_alert_enabled: patch.stall_alert_enabled ?? current.stall_alert_enabled,
    unjoinable_alert_enabled: patch.unjoinable_alert_enabled ?? current.unjoinable_alert_enabled,
    daily_report_hour: patch.daily_report_hour ?? current.daily_report_hour,
    hourly_window_from: patch.hourly_window_from ?? current.hourly_window_from,
    hourly_window_to: patch.hourly_window_to ?? current.hourly_window_to,
    hourly_interval_hours: patch.hourly_interval_hours ?? current.hourly_interval_hours,
    active_weekdays: patch.active_weekdays ?? current.active_weekdays,
  };

  await exec
    .insert(notification_settings)
    .values({ org_id: orgId, ...next, updated_at: new Date() })
    .onConflictDoUpdate({
      target: notification_settings.org_id,
      set: { ...next, updated_at: new Date() },
    });

  return next;
}
