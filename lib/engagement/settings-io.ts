import { sql } from "drizzle-orm";

import {
  DEFAULT_LIFECYCLE_THRESHOLDS,
  type LifecycleThresholds,
} from "@/lib/engagement/constants";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// Load / save for lifecycle_settings, following the notification-settings
// pattern: a missing row reads as the code defaults, and a save is a
// read-merge-upsert.
//
// EVERY changed field writes an org_setting_events row — the audit trail the
// owner asked for, in the same key space the one-off backfill writes
// ('lifecycle.engine_mode'). A save that changes nothing writes nothing.
//
// A save also stamps reevaluate_requested_at, which makes the next 15-minute
// run evaluate every stored row (lib/engagement/refresh.ts `evaluateAll`) rather
// than only the contacts something else touched.

export type EngineMode = "off" | "write";

export interface LifecycleSettingsRow extends LifecycleThresholds {
  engine_mode: EngineMode;
  updated_at: string | null;
  /** false ⇒ the org has no row and is running on the code defaults. */
  has_row: boolean;
}

const THRESHOLD_KEYS = Object.keys(DEFAULT_LIFECYCLE_THRESHOLDS) as (keyof LifecycleThresholds)[];

export async function loadLifecycleSettings(
  dbc: DbOrTx,
  orgId: string,
): Promise<LifecycleSettingsRow> {
  const rows = (await dbc.execute(sql`
    SELECT hot_days, warm_days, freeze_after_messages, freeze_cadence_days,
           suppress_after_days, suppress_min_freeze_messages, engine_mode,
           updated_at::text AS updated_at
    FROM lifecycle_settings WHERE org_id = ${orgId}::uuid
  `)) as unknown as (Record<string, unknown> | undefined)[];
  const r = rows[0];
  if (!r) {
    return {
      ...DEFAULT_LIFECYCLE_THRESHOLDS,
      engine_mode: "off",
      updated_at: null,
      has_row: false,
    };
  }
  return {
    hot_days: Number(r.hot_days),
    warm_days: Number(r.warm_days),
    freeze_after_messages: Number(r.freeze_after_messages),
    freeze_cadence_days: Number(r.freeze_cadence_days),
    suppress_after_days: Number(r.suppress_after_days),
    suppress_min_freeze_messages: Number(r.suppress_min_freeze_messages),
    engine_mode: r.engine_mode === "write" ? "write" : "off",
    updated_at: (r.updated_at as string | null) ?? null,
    has_row: true,
  };
}

export async function saveLifecycleSettings(
  dbc: DbOrTx,
  orgId: string,
  patch: Partial<LifecycleThresholds & { engine_mode: EngineMode }>,
  actorUserId: string,
): Promise<{ row: LifecycleSettingsRow; changed: string[] }> {
  const before = await loadLifecycleSettings(dbc, orgId);
  const next = { ...before, ...patch };
  const changed = [...THRESHOLD_KEYS, "engine_mode" as const].filter(
    (k) => String(before[k]) !== String(next[k]),
  );
  if (changed.length === 0) return { row: before, changed };

  await dbc.execute(sql`
    INSERT INTO lifecycle_settings (org_id, hot_days, warm_days, freeze_after_messages,
      freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages,
      engine_mode, reevaluate_requested_at, updated_at, updated_by)
    VALUES (${orgId}::uuid, ${next.hot_days}, ${next.warm_days}, ${next.freeze_after_messages},
      ${next.freeze_cadence_days}, ${next.suppress_after_days}, ${next.suppress_min_freeze_messages},
      ${next.engine_mode}, now(), now(), ${actorUserId}::uuid)
    ON CONFLICT (org_id) DO UPDATE SET
      hot_days = EXCLUDED.hot_days,
      warm_days = EXCLUDED.warm_days,
      freeze_after_messages = EXCLUDED.freeze_after_messages,
      freeze_cadence_days = EXCLUDED.freeze_cadence_days,
      suppress_after_days = EXCLUDED.suppress_after_days,
      suppress_min_freeze_messages = EXCLUDED.suppress_min_freeze_messages,
      engine_mode = EXCLUDED.engine_mode,
      reevaluate_requested_at = EXCLUDED.reevaluate_requested_at,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by
  `);
  for (const key of changed) {
    await dbc.execute(sql`
      INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
      VALUES (${orgId}::uuid, ${`lifecycle.${key}`}, ${String(before[key])}, ${String(next[key])},
              ${actorUserId}::uuid)
    `);
  }
  return { row: await loadLifecycleSettings(dbc, orgId), changed };
}
