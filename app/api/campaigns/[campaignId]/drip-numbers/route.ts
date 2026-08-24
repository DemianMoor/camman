import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { checkPhoneBrandMatch } from "@/lib/api/brand-number-guard";
import { can } from "@/lib/permissions";

// Per-drip-campaign number selection with daily limits (Drip Phase 5).
//
// ⚠️ THE BRAND RULE IS NOT RE-IMPLEMENTED HERE. Every number goes through
// checkPhoneBrandMatch — the same Phase 1 guard the stage save uses — so there
// is exactly one definition of "may this campaign send from this number". Two
// copies of an authorization rule is how the two in-use definitions drifted
// apart before Phase 4 unified them.
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  numbers: z
    .array(
      z.object({
        provider_phone_id: z.number().int().positive(),
        daily_limit: z.number().int().positive().nullable().optional(),
        position: z.number().int().min(0).optional(),
      }),
    )
    .max(50),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  const { campaignId: raw } = await params;
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Selected numbers, plus every number the campaign's brand COULD use, so the
  // picker never offers something the brand guard would then reject.
  const selected = await db.execute(drizzleSql`
    SELECT n.provider_phone_id, n.daily_limit, n.position, pp.phone_number,
           sp.sms_provider_id AS provider
    FROM drip_campaign_numbers n
    JOIN provider_phones pp ON pp.id = n.provider_phone_id
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    WHERE n.campaign_id = ${cid} AND n.org_id = ${orgId}::uuid
    ORDER BY n.position, n.provider_phone_id
  `);
  const available = await db.execute(drizzleSql`
    SELECT pp.id AS provider_phone_id, pp.phone_number, sp.sms_provider_id AS provider
    FROM provider_phones pp
    JOIN campaigns c ON c.id = ${cid} AND c.org_id = ${orgId}::uuid
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    WHERE pp.org_id = ${orgId}::uuid
      AND pp.status = 'active'
      AND (pp.brand_id IS NULL OR pp.brand_id = c.brand_id)
    ORDER BY pp.id
  `);
  return NextResponse.json({ selected, available });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.update")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  const { campaignId: raw } = await params;
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION, { field: parsed.error.issues[0]?.path.join(".") });
  }

  const camp = await db.execute(drizzleSql`
    SELECT id, type, brand_id FROM campaigns WHERE id = ${cid} AND org_id = ${orgId}::uuid LIMIT 1
  `);
  const c = camp[0] as { id: number; type: string; brand_id: number | null } | undefined;
  if (!c) return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND);
  if (c.type !== "drip") {
    return apiError(400, "This campaign is not a drip campaign", API_ERROR_CODES.VALIDATION);
  }

  // Every number must pass the SAME brand guard a stage save uses.
  for (const n of parsed.data.numbers) {
    const refusal = await checkPhoneBrandMatch(db, {
      orgId,
      providerPhoneId: n.provider_phone_id,
      campaignBrandId: c.brand_id,
    });
    if (refusal) {
      return apiError(400, refusal.message, API_ERROR_CODES.VALIDATION, {
        field: "provider_phone_id",
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(drizzleSql`
      DELETE FROM drip_campaign_numbers WHERE campaign_id = ${cid} AND org_id = ${orgId}::uuid
    `);
    for (const [i, n] of parsed.data.numbers.entries()) {
      await tx.execute(drizzleSql`
        INSERT INTO drip_campaign_numbers
          (campaign_id, provider_phone_id, org_id, daily_limit, position)
        VALUES (${cid}, ${n.provider_phone_id}, ${orgId}::uuid,
                ${n.daily_limit ?? null}, ${n.position ?? i})
      `);
    }
  });

  return NextResponse.json({ ok: true, count: parsed.data.numbers.length });
}
