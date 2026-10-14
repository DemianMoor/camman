import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  checkBrandLandingPair,
  LANDING_PAIR_TAKEN_CODE,
  normalizeLandingHost,
} from "@/lib/api/brand-landing";
import { can } from "@/lib/permissions";
import { brandCreateSchema, nullIfEmpty } from "@/lib/validators/brands";

// ⚠️ Brand creation NO LONGER WRITES A SHORT DOMAIN.
//
// It used to call applyBrandShortDomain, a one-row upsert that migration 0136
// broke outright (`ON CONFLICT (brand_id)` against an index 0136 had dropped ⇒
// Postgres 42P10, so creating a brand WITH a short domain 500'd). Since 0136 a
// brand may hold several domains, so a single field on the create form cannot
// express the shape at all.
//
// Domains are now managed through their own surface —
// POST /api/brands/[id]/short-domains — which adds them as `pending` and leaves
// activation as a deliberate act. There is exactly ONE write path; this route is
// not a second one.

// The landing (host, path) pair is unique per org (brands_landing_pair_uniq);
// the pre-check reports it with the brand's name, this is the race backstop.
function isLandingPairViolation(err: unknown): boolean {
  const e = err as { constraint_name?: unknown; cause?: { constraint_name?: unknown } };
  return (
    e?.constraint_name === "brands_landing_pair_uniq" ||
    e?.cause?.constraint_name === "brands_landing_pair_uniq"
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "brands",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = brandCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Landing host/path (0211/0212). Admin+ only — but only when the request
  // actually SETS one: an empty host with the default path is "not touching it",
  // so a manager can still create a brand.
  const host = normalizeLandingHost(parsed.data.landing_host);
  if (!host.ok) {
    return apiError(400, host.error, API_ERROR_CODES.VALIDATION, { field: "landing_host" });
  }
  const landingPath = parsed.data.landing_path ?? "lp";
  if ((host.host !== null || landingPath !== "lp") && !can(role, "brands.landing.update")) {
    return apiError(403, "Only an admin can set a brand's landing host or path", API_ERROR_CODES.FORBIDDEN, {
      field: "landing_host",
    });
  }
  const refusal = await checkBrandLandingPair(db, {
    orgId,
    brandId: null,
    nextHost: host.host,
    nextPath: landingPath,
  });
  if (refusal) return apiError(refusal.status, refusal.message, refusal.code, refusal.details);

  try {
    const created = await db.transaction(async (tx) => {
      const [b] = await tx
        .insert(brands)
        .values({
          org_id: orgId,
          name: parsed.data.name,
          brand_id: parsed.data.brand_id,
          short_link_base: nullIfEmpty(parsed.data.short_link_base),
          website: nullIfEmpty(parsed.data.website),
          avatar_url: nullIfEmpty(parsed.data.avatar_url),
          color: nullIfEmpty(parsed.data.color),
          landing_host: host.host,
          landing_path: landingPath,
          status: "active",
        })
        .returning();

      // A new brand starts with no short domain. Add one from the brand's
      // Short domains section afterwards; it lands `pending` until activated.
      return { ...b, short_domain: null };
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isLandingPairViolation(err)) {
      return apiError(409, "Another brand already uses this landing host and path", LANDING_PAIR_TAKEN_CODE, {
        field: "landing_host",
      });
    }
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A brand with this brand_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "brand_id" },
      );
    }
    throw err;
  }
}
