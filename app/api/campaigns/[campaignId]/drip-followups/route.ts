import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { syncCampaignFollowupChildren } from "@/lib/drip/children";
import { can } from "@/lib/permissions";

function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Behavioural follow-up children for a drip campaign (Drip Phase 6).
//
// GET  — the first-send stages with their three children, for the editor.
// POST — turn campaign-level behavioural on/off, creating any missing children.
//
// ⚠️ TURNING IT OFF DELETES NOTHING. The spec asks for toggle-without-delete,
// and that has to hold at campaign level too: an operator who switches it off,
// changes their mind and switches it back on gets their copy and timers back
// rather than three blank lanes. "Off" is enforced at SEND time.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const cid = parseId((await params).campaignId);
  if (cid === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);

  const cfg = (await db.execute(drizzleSql`
    SELECT behavioral_enabled FROM drip_campaign_configs
    WHERE campaign_id = ${cid} AND org_id = ${orgId}::uuid
  `)) as unknown as { behavioral_enabled: boolean }[];

  const rows = (await db.execute(drizzleSql`
    SELECT p.id AS parent_id, p.window_start_min, p.window_end_min, p.drip_active AS parent_active,
           ch.id AS child_id, ch.behavioral_tier, ch.drip_followup_minutes,
           ch.drip_active AS child_active, ch.creative_id, cr.text AS creative_text
    FROM campaign_stages p
    LEFT JOIN campaign_stages ch
           ON ch.parent_stage_id = p.id AND ch.org_id = p.org_id
          AND ch.archived_at IS NULL AND ch.drip_followup_minutes IS NOT NULL
    LEFT JOIN creatives cr ON cr.id = ch.creative_id
    WHERE p.campaign_id = ${cid} AND p.org_id = ${orgId}::uuid
      AND p.archived_at IS NULL AND p.window_start_min IS NOT NULL
      AND p.parent_stage_id IS NULL
    ORDER BY p.window_start_min, ch.behavioral_tier
  `)) as unknown as Record<string, unknown>[];

  const parents = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    const pid = r.parent_id as number;
    if (!parents.has(pid)) {
      parents.set(pid, {
        parent_id: pid,
        window_start_min: r.window_start_min,
        window_end_min: r.window_end_min,
        parent_active: r.parent_active,
        children: [],
      });
    }
    if (r.child_id != null) {
      (parents.get(pid)!.children as unknown[]).push({
        id: r.child_id,
        behavioral_tier: r.behavioral_tier,
        drip_followup_minutes: r.drip_followup_minutes,
        drip_active: r.child_active,
        creative_id: r.creative_id,
        creative_text: r.creative_text,
      });
    }
  }

  return NextResponse.json({
    behavioral_enabled: cfg[0]?.behavioral_enabled ?? false,
    parents: Array.from(parents.values()),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const cid = parseId((await params).campaignId);
  if (cid === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const enabled = (body as { behavioral_enabled?: unknown })?.behavioral_enabled;
  if (typeof enabled !== "boolean") {
    return apiError(400, "behavioral_enabled must be a boolean", API_ERROR_CODES.VALIDATION, {
      field: "behavioral_enabled",
    });
  }

  const updated = (await db.execute(drizzleSql`
    UPDATE drip_campaign_configs SET behavioral_enabled = ${enabled}, updated_at = now()
    WHERE campaign_id = ${cid} AND org_id = ${orgId}::uuid
    RETURNING campaign_id
  `)) as unknown as { campaign_id: number }[];
  if (updated.length === 0) {
    return apiError(404, "This campaign has no drip config", API_ERROR_CODES.NOT_FOUND, {
      entity: "drip_campaign_config",
    });
  }

  // Creating children is only ever ADDITIVE, and they arrive INACTIVE — turning
  // behavioural on must not silently schedule three extra messages per lead.
  const synced = enabled
    ? await syncCampaignFollowupChildren(db, { orgId, campaignId: cid })
    : { parents: 0, created: 0 };

  return NextResponse.json({ ok: true, behavioral_enabled: enabled, ...synced });
}
