import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { CARRIER_REJECTION_CODES } from "@/lib/carrier-rejection/codes";
import { CARRIER_REJECTION_DEFAULTS, refreshFlaggedPhones } from "@/lib/carrier-rejection/ledger";
import { can } from "@/lib/permissions";

// Settings > Sending: carrier-rejected numbers (ClickUp 1amdve2850v, PR 3).
// The toggle and the three thresholds live on the org_settings singleton
// (migration 0225). Reading is open to any member; changing is manager+ (the
// same bar as the live-sending switch, campaigns.drain). Every changed value is
// audited in org_setting_events. A threshold change recomputes the flagged set
// in the same transaction (owner, 2026-10-23), so the live count is current
// the moment the save returns.

// The flagged-set recompute reads the whole ledger for the org.
export const maxDuration = 60;

// GET — the setting, the live count (shown whether or not the toggle is on),
// and the code map for the read-only table.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = (await db.execute(sql`
    SELECT
      (SELECT row_to_json(s) FROM (
         SELECT carrier_rejection_suppression_enabled AS enabled,
                carrier_rejection_hard_threshold AS hard_threshold,
                carrier_rejection_soft_threshold AS soft_threshold,
                carrier_rejection_soft_window_days AS soft_window_days
         FROM org_settings WHERE org_id = ${orgId}::uuid) s) AS settings,
      (SELECT count(*)::int FROM carrier_rejected_phones WHERE org_id = ${orgId}::uuid) AS flagged_count,
      (SELECT max(evaluated_at) FROM carrier_rejected_phones WHERE org_id = ${orgId}::uuid) AS evaluated_at
  `)) as unknown as {
    settings: { enabled: boolean; hard_threshold: number; soft_threshold: number; soft_window_days: number } | null;
    flagged_count: number;
    evaluated_at: string | null;
  }[];
  const r = rows[0];
  const D = CARRIER_REJECTION_DEFAULTS;
  return NextResponse.json({
    // No row yet ⇒ the column defaults.
    enabled: r.settings?.enabled === true,
    hard_threshold: r.settings?.hard_threshold ?? D.hardThreshold,
    soft_threshold: r.settings?.soft_threshold ?? D.softThreshold,
    soft_window_days: r.settings?.soft_window_days ?? D.softWindowDays,
    flagged_count: Number(r.flagged_count),
    evaluated_at: r.evaluated_at,
    codes: CARRIER_REJECTION_CODES,
  });
}

// Bounds mirror CHECK org_settings_carrier_rejection_thresholds_check.
const putSchema = z
  .object({
    enabled: z.boolean().optional(),
    hard_threshold: z.number().int().min(1).max(100).optional(),
    soft_threshold: z.number().int().min(1).max(100).optional(),
    soft_window_days: z.number().int().min(1).max(365).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update" });

const COLUMNS = {
  enabled: "carrier_rejection_suppression_enabled",
  hard_threshold: "carrier_rejection_hard_threshold",
  soft_threshold: "carrier_rejection_soft_threshold",
  soft_window_days: "carrier_rejection_soft_window_days",
} as const;
type Key = keyof typeof COLUMNS;

// PUT — change any subset (manager+). Unchanged values are not audited; a
// changed threshold recomputes carrier_rejected_phones before commit.
export async function PUT(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
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
  const next = parsed.data;

  const result = await db.transaction(async (tx) => {
    // The org_settings row exists for every org that has ever saved a setting;
    // create it with the defaults if not, then lock it for the read-compare.
    await tx.execute(sql`INSERT INTO org_settings (org_id) VALUES (${orgId}::uuid) ON CONFLICT (org_id) DO NOTHING`);
    const cur = ((await tx.execute(sql`
      SELECT carrier_rejection_suppression_enabled AS enabled,
             carrier_rejection_hard_threshold AS hard_threshold,
             carrier_rejection_soft_threshold AS soft_threshold,
             carrier_rejection_soft_window_days AS soft_window_days
      FROM org_settings WHERE org_id = ${orgId}::uuid FOR UPDATE
    `)) as unknown as Record<Key, boolean | number>[])[0];

    const changed = (Object.keys(COLUMNS) as Key[]).filter(
      (k) => next[k] !== undefined && next[k] !== cur[k],
    );
    for (const k of changed) {
      await tx.execute(sql`
        UPDATE org_settings SET ${sql.raw(COLUMNS[k])} = ${next[k]}, updated_at = now()
        WHERE org_id = ${orgId}::uuid`);
      await tx.execute(sql`
        INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
        VALUES (${orgId}::uuid, ${COLUMNS[k]}, ${String(cur[k])}, ${String(next[k])}, ${user.id})`);
    }
    const thresholdsChanged = changed.some((k) => k !== "enabled");
    const refresh = thresholdsChanged ? await refreshFlaggedPhones(tx, orgId) : null;
    return { changed, refresh };
  });

  return NextResponse.json({ ok: true, changed: result.changed, refresh: result.refresh });
}
