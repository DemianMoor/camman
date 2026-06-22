import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";

// Emergency hard-stop for live SMS sending (org_settings.sends_paused). The
// "Today's sends" screen flips this for an instant org-wide pause: the real-send
// drain re-reads it every batch, so engaging it halts any in-flight send at the
// next batch boundary and refuses to start new ones — no further message is
// submitted via the provider API until it's cleared ("Proceed"). Distinct from
// the daily on/off (PUT /api/settings/sending). Manager+ (campaigns.drain — the
// same bar as triggering the drain) and every flip is audited in
// org_setting_events. Current state is read via GET /api/sends/state.

const postSchema = z.object({ paused: z.boolean() });

export async function POST(req: NextRequest) {
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
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { paused } = parsed.data;

  const changed = await db.transaction(async (tx) => {
    // Read current value (default false if no row) inside the tx — detects a
    // no-op and records the old value in the audit row.
    const cur = (await tx.execute(sql`
      SELECT sends_paused FROM org_settings WHERE org_id = ${orgId} LIMIT 1
    `)) as unknown as { sends_paused: boolean }[];
    const oldValue = cur[0]?.sends_paused === true;
    if (oldValue === paused) return false;

    await tx.execute(sql`
      INSERT INTO org_settings (org_id, sends_paused, sends_paused_by, sends_paused_at, updated_at)
      VALUES (${orgId}, ${paused}, ${user.id}, now(), now())
      ON CONFLICT (org_id) DO UPDATE
        SET sends_paused = ${paused},
            sends_paused_by = ${user.id},
            sends_paused_at = now(),
            updated_at = now()
    `);

    await tx.execute(sql`
      INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
      VALUES (${orgId}, 'sends_paused', ${String(oldValue)}, ${String(paused)}, ${user.id})
    `);
    return true;
  });

  return NextResponse.json({ ok: true, sends_paused: paused, changed });
}
