import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Org-level "Live SMS sending" master switch (Workstream 1). This is the DB-backed
// daily on/off (org_settings.sends_enabled) that, together with the SEND_ENABLED
// env backstop, gates the real-send drain. Reading state is open to any member;
// flipping it is manager+ (same bar as campaigns.drain — the money-spending
// action) and every flip is audited in org_setting_events.

// GET — current state + the effective env backstop + who/when last changed it.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = (await db.execute(sql`
    SELECT os.sends_enabled,
           os.sends_enabled_updated_at AS updated_at,
           os.sends_enabled_updated_by AS updated_by,
           u.email AS updated_by_email,
           u.raw_user_meta_data->>'display_name' AS updated_by_name
    FROM org_settings os
    LEFT JOIN auth.users u ON u.id = os.sends_enabled_updated_by
    WHERE os.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as {
    sends_enabled: boolean;
    updated_at: string | null;
    updated_by: string | null;
    updated_by_email: string | null;
    updated_by_name: string | null;
  }[];

  const r = rows[0];
  return NextResponse.json({
    // No row yet ⇒ never enabled (a fresh org defaults OFF).
    sends_enabled: r?.sends_enabled === true,
    env_enabled: process.env.SEND_ENABLED === "true",
    updated_at: r?.updated_at ?? null,
    updated_by: r?.updated_by
      ? {
          id: r.updated_by,
          name: r.updated_by_name,
          email: r.updated_by_email,
        }
      : null,
  });
}

const putSchema = z.object({ enabled: z.boolean() });

// PUT — flip the switch (manager+). Upserts the singleton, stamps who/when, and
// appends an audit row. No-op (no audit) when the value is unchanged.
export async function PUT(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  // Manager+ — same bar as triggering the real-send drain.
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
  const { enabled } = parsed.data;

  const changed = await db.transaction(async (tx) => {
    // Read current value (default false if no row), inside the tx, to detect a
    // no-op and to record the old value in the audit row.
    const cur = (await tx.execute(sql`
      SELECT sends_enabled FROM org_settings WHERE org_id = ${orgId} LIMIT 1
    `)) as unknown as { sends_enabled: boolean }[];
    const oldValue = cur[0]?.sends_enabled === true;
    if (oldValue === enabled) return false;

    await tx.execute(sql`
      INSERT INTO org_settings (org_id, sends_enabled, sends_enabled_updated_by, sends_enabled_updated_at, updated_at)
      VALUES (${orgId}, ${enabled}, ${user.id}, now(), now())
      ON CONFLICT (org_id) DO UPDATE
        SET sends_enabled = ${enabled},
            sends_enabled_updated_by = ${user.id},
            sends_enabled_updated_at = now(),
            updated_at = now()
    `);

    await tx.execute(sql`
      INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
      VALUES (${orgId}, 'sends_enabled', ${String(oldValue)}, ${String(enabled)}, ${user.id})
    `);
    return true;
  });

  return NextResponse.json({ ok: true, sends_enabled: enabled, changed });
}
