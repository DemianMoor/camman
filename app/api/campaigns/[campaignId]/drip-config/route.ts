import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { dripConfigSchema } from "@/lib/validators/drip-campaigns";

// Drip campaign config (Drip Phase 4).
//
// Separate from the campaign PATCH on purpose: this writes a different table,
// only applies to type='drip', and its validation rules are drip-specific.
// Folding it into the campaign PATCH would put drip-only branches into the
// endpoint every regular campaign edit goes through — the exact coupling
// migration 0159 was kept to one column to avoid.

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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
  const { campaignId: raw } = await params;
  const cid = parseId(raw);
  if (cid === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);

  const rows = await db.execute(drizzleSql`
    SELECT c.id AS campaign_id, c.type, c.name,
           (c.audience_filters -> 'carrier_filter') AS carrier_filter,
           cfg.interest_tag, cfg.partner_key_id, cfg.start_at, cfg.end_at,
           cfg.daily_cap, cfg.campaign_cap, cfg.routing_daily_admission_cap,
           cfg.priority, cfg.filters,
           COALESCE((SELECT count(*)::int FROM drip_journeys j
                     WHERE j.campaign_id = c.id AND j.state <> 'unroutable'), 0) AS journeys_total
    FROM campaigns c
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    WHERE c.id = ${cid} AND c.org_id = ${orgId}::uuid
  `);
  if (!rows[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }
  return NextResponse.json(rows[0]);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { campaignId: raw } = await params;
  const cid = parseId(raw);
  if (cid === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = dripConfigSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION, { field: parsed.error.issues[0]?.path.join(".") });
  }
  const input = parsed.data;

  const camp = await db
    .select({ id: campaigns.id, type: campaigns.type })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!camp[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }
  if (camp[0].type !== "drip") {
    return apiError(400, "This campaign is not a drip campaign", API_ERROR_CODES.VALIDATION, {
      field: "type",
    });
  }

  await db.transaction(async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO drip_campaign_configs
        (campaign_id, org_id, interest_tag, partner_key_id, start_at, end_at,
         daily_cap, campaign_cap, routing_daily_admission_cap, priority, filters, updated_at)
      VALUES (${cid}, ${orgId}::uuid, ${input.interest_tag}, ${input.partner_key_id ?? null},
              ${input.start_at ?? null}::timestamptz, ${input.end_at ?? null}::timestamptz,
              ${input.daily_cap ?? null}, ${input.campaign_cap ?? null},
              ${input.routing_daily_admission_cap ?? null}, ${input.priority ?? 100},
              ${JSON.stringify(input.filters ?? {})}::jsonb, now())
      ON CONFLICT (campaign_id) DO UPDATE SET
        interest_tag = EXCLUDED.interest_tag,
        partner_key_id = EXCLUDED.partner_key_id,
        start_at = EXCLUDED.start_at,
        end_at = EXCLUDED.end_at,
        daily_cap = EXCLUDED.daily_cap,
        campaign_cap = EXCLUDED.campaign_cap,
        routing_daily_admission_cap = EXCLUDED.routing_daily_admission_cap,
        priority = EXCLUDED.priority,
        filters = EXCLUDED.filters,
        updated_at = now()
    `);

    // The carrier filter lives on the campaign, shared with regular campaigns.
    // Merged rather than replaced so the other audience_filters keys survive.
    if (input.carrier_filter !== undefined) {
      await tx.execute(drizzleSql`
        UPDATE campaigns
        SET audience_filters =
          COALESCE(audience_filters, '{}'::jsonb)
          || jsonb_build_object('carrier_filter', ${JSON.stringify(input.carrier_filter)}::jsonb)
        WHERE id = ${cid} AND org_id = ${orgId}::uuid
      `);
    }
  });

  return NextResponse.json({ ok: true, campaign_id: cid });
}
