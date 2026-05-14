import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_audience_pool, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { snapshotAudience } from "@/lib/audience-snapshot";
import { can, type Permission } from "@/lib/permissions";
import { campaignStatusChangeSchema } from "@/lib/validators/campaigns";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// State machine. Archive is handled via its own endpoint, but we accept
// 'archived' here too so a UI can route everything through one path if it
// chooses to. The route's required-permission lookup uses the transition
// key.
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["active"]),
  active: new Set(["paused", "completed"]),
  paused: new Set(["active", "completed"]),
  completed: new Set<string>(), // terminal except via restore
  archived: new Set<string>(),
};

function permissionFor(from: string, to: string): Permission | null {
  if (to === "archived") return "campaigns.archive";
  if (from === "draft" && to === "active") return "campaigns.activate";
  if (
    (from === "active" && to === "paused") ||
    (from === "paused" && to === "active")
  )
    return "campaigns.pause";
  if (to === "completed") return "campaigns.complete";
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  const { campaignId: cIdParam } = await params;
  const campaignId = parseId(cIdParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = campaignStatusChangeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const next = parsed.data.status;

  const current = await db
    .select({
      status: campaigns.status,
      name: campaigns.name,
      brand_id: campaigns.brand_id,
      offer_id: campaigns.offer_id,
      audience_segment_ids: campaigns.audience_segment_ids,
      audience_contact_group_ids: campaigns.audience_contact_group_ids,
      audience_filters: campaigns.audience_filters,
      audience_cap: campaigns.audience_cap,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  const c = current[0];
  const from = c.status;
  const allowed = TRANSITIONS[from] ?? new Set<string>();
  if (!allowed.has(next)) {
    return apiError(
      409,
      `Cannot transition from "${from}" to "${next}"`,
      API_ERROR_CODES.CONFLICT,
      { reason: "invalid_transition", from, to: next },
    );
  }

  const requiredPerm = permissionFor(from, next);
  if (!requiredPerm || !can(role, requiredPerm)) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // ============ draft → active: complete the campaign + snapshot audience
  // Drafts may have been saved empty. Enforce the launch invariants here
  // (name, brand, offer, ≥1 segment) so a stale draft can't slip through
  // without the data needed to actually send. Compute the audience pool
  // now if it wasn't computed at create time, and freeze the count.
  if (from === "draft" && next === "active") {
    const missing: string[] = [];
    if (!c.name || c.name.trim().length === 0) missing.push("name");
    if (c.brand_id == null) missing.push("brand_id");
    if (c.offer_id == null) missing.push("offer_id");
    const segmentIds = c.audience_segment_ids ?? [];
    const contactGroupIds = c.audience_contact_group_ids ?? [];
    if (segmentIds.length === 0 && contactGroupIds.length === 0) {
      missing.push("audience_segment_ids");
    }
    if (missing.length > 0) {
      return apiError(
        400,
        "Draft is missing fields required to activate",
        API_ERROR_CODES.VALIDATION,
        { reason: "incomplete_draft", missing },
      );
    }

    try {
      const updated = await db.transaction(async (tx) => {
        // Check whether the pool was already snapshotted (defensive — the
        // create path zeroes it for drafts, but a future flow might
        // populate it earlier).
        const existing = await tx
          .select({ contact_id: campaign_audience_pool.contact_id })
          .from(campaign_audience_pool)
          .where(eq(campaign_audience_pool.campaign_id, campaignId))
          .limit(1);

        let count: number;
        if (existing.length === 0) {
          const snap = await snapshotAudience(
            {
              campaignId,
              orgId,
              segmentIds,
              contactGroupIds,
              filters: c.audience_filters ?? {},
              cap: c.audience_cap ?? null,
            },
            tx,
          );
          if (snap.count === 0) throw new EmptyAudienceError();
          count = snap.count;
        } else {
          // Pool already exists — count its rows to set the snapshot count.
          const all = await tx
            .select({ contact_id: campaign_audience_pool.contact_id })
            .from(campaign_audience_pool)
            .where(eq(campaign_audience_pool.campaign_id, campaignId));
          count = all.length;
          if (count === 0) throw new EmptyAudienceError();
        }

        const [row] = await tx
          .update(campaigns)
          .set({
            status: "active",
            previous_status: from,
            status_changed_at: drizzleSql`now()`,
            audience_snapshot_count: count,
          })
          .where(
            and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)),
          )
          .returning();
        return row;
      });
      return NextResponse.json(updated);
    } catch (err) {
      if (err instanceof EmptyAudienceError) {
        return apiError(
          400,
          "The current filters yield zero contacts in the chosen segments",
          API_ERROR_CODES.VALIDATION,
          { reason: "empty_audience" },
        );
      }
      throw err;
    }
  }

  // ============ All other transitions
  const [updated] = await db
    .update(campaigns)
    .set({
      status: next,
      previous_status: from,
      status_changed_at: drizzleSql`now()`,
      archived_at: next === "archived" ? drizzleSql`now()` : null,
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .returning();
  return NextResponse.json(updated);
}

class EmptyAudienceError extends Error {
  constructor() {
    super("empty audience");
    this.name = "EmptyAudienceError";
  }
}
