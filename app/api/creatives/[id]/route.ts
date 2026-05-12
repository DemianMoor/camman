import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, creatives, offers, sms_providers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  creativeUpdateSchema,
  nullIfEmpty,
} from "@/lib/validators/creatives";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["creative_id"]);
// Statuses where editing the SMS text is allowed. Once approved, the text
// is locked — operators must duplicate to iterate on copy.
const TEXT_EDITABLE_STATUSES = new Set(["draft", "pending"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: creatives.id,
      creative_id: creatives.creative_id,
      slug: creatives.slug,
      org_id: creatives.org_id,
      offer_id: creatives.offer_id,
      sms_provider_id: creatives.sms_provider_id,
      brand_id: creatives.brand_id,
      text: creatives.text,
      status: creatives.status,
      archived_at: creatives.archived_at,
      created_at: creatives.created_at,
      offer: { id: offers.id, name: offers.name, color: offers.color },
      provider: {
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      },
      brand: { id: brands.id, name: brands.name, color: brands.color },
    })
    .from(creatives)
    .leftJoin(offers, eq(offers.id, creatives.offer_id))
    .leftJoin(sms_providers, eq(sms_providers.id, creatives.sms_provider_id))
    .leftJoin(brands, eq(brands.id, creatives.brand_id))
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  const r = rows[0];
  return NextResponse.json({
    ...r,
    offer: r.offer && r.offer.id !== null ? r.offer : null,
    provider: r.provider && r.provider.id !== null ? r.provider : null,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
    campaign_count: 0,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = creativeUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Pull the current row so we can enforce text-editability against the
  // current status and verify the FK changes still belong to this org.
  const current = await db
    .select({ id: creatives.id, status: creatives.status })
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  if (current[0].status === "archived") {
    return apiError(
      409,
      "Archived creatives can't be edited — restore first",
      API_ERROR_CODES.CONFLICT,
      { reason: "archived" },
    );
  }
  if (
    parsed.data.text !== undefined &&
    !TEXT_EDITABLE_STATUSES.has(current[0].status)
  ) {
    return apiError(
      400,
      "SMS text can only be edited while the creative is in draft or pending status",
      API_ERROR_CODES.VALIDATION,
      { field: "text", reason: "text_locked" },
    );
  }

  if (parsed.data.offer_id !== undefined) {
    const r = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(eq(offers.id, parsed.data.offer_id), eq(offers.org_id, orgId)),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "offer_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "offer_id" },
      );
    }
  }
  if (parsed.data.sms_provider_id != null) {
    const r = await db
      .select({ id: sms_providers.id })
      .from(sms_providers)
      .where(
        and(
          eq(sms_providers.id, parsed.data.sms_provider_id),
          eq(sms_providers.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "sms_provider_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "sms_provider_id" },
      );
    }
  }
  if (parsed.data.brand_id != null) {
    const r = await db
      .select({ id: brands.id })
      .from(brands)
      .where(
        and(eq(brands.id, parsed.data.brand_id), eq(brands.org_id, orgId)),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "brand_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "brand_id" },
      );
    }
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    const updated = await db
      .update(creatives)
      .set(updates)
      .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
      .returning();
    if (!updated[0]) {
      return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "creative",
      });
    }
    return NextResponse.json(updated[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A creative with this creative_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "creative_id" },
      );
    }
    throw err;
  }
}
