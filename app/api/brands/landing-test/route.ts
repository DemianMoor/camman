import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { LANDING_PATH_RE, normalizeLandingHost } from "@/lib/api/brand-landing";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { probeLandingUrl } from "@/lib/brand-landing-probe";
import { can } from "@/lib/permissions";

// POST /api/brands/landing-test { host, path, brand_id? }
//
// The brand form's "Test" button. Tests the values IN THE FORM (possibly
// unsaved) against a slug that brand actually uses, so an admin can check a
// host/path before committing a change that re-points live links. The fetch
// itself is in lib/brand-landing-probe.ts: https only, private/reserved
// addresses refused at connect time, redirects reported but never followed.
//
// Admin-only (brands.landing.update): it makes our server fetch a URL.

const bodySchema = z.object({
  host: z.string().trim().min(1).max(253),
  path: z.string().trim().regex(LANDING_PATH_RE, "Invalid landing path"),
  brand_id: z.number().int().positive().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership({ route: "brands/landing-test", method: "POST" });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "brands.landing.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const host = normalizeLandingHost(parsed.data.host);
  if (!host.ok || !host.host) {
    return apiError(400, host.ok ? "Landing host is required" : host.error, API_ERROR_CODES.VALIDATION, {
      field: "landing_host",
    });
  }

  // A slug this brand really uses: a slug page on an offer linked to the brand,
  // else one its campaigns' stages point at. No brand (create form) or nothing
  // found ⇒ the org's most recently created active slug page.
  const brandId = parsed.data.brand_id ?? null;
  const rows = (await db.execute(sql`
    SELECT slug FROM (
      SELECT lp.slug, 1 AS rank, lp.id
      FROM offer_landing_pages lp
      JOIN offer_brands ob ON ob.offer_id = lp.offer_id
      JOIN brands b ON b.id = ob.brand_id AND b.org_id = lp.org_id
      WHERE ${brandId}::int IS NOT NULL AND ob.brand_id = ${brandId}::int
        AND lp.org_id = ${orgId}::uuid AND lp.kind = 'slug' AND lp.status = 'active'
      UNION ALL
      SELECT lp.slug, 2, lp.id
      FROM campaign_stages s
      JOIN campaigns c ON c.id = s.campaign_id AND c.org_id = s.org_id
      JOIN offer_landing_pages lp ON lp.id = s.landing_page_id AND lp.kind = 'slug'
      WHERE ${brandId}::int IS NOT NULL AND c.brand_id = ${brandId}::int AND s.org_id = ${orgId}::uuid
      UNION ALL
      SELECT lp.slug, 3, lp.id
      FROM offer_landing_pages lp
      WHERE lp.org_id = ${orgId}::uuid AND lp.kind = 'slug' AND lp.status = 'active'
    ) x
    ORDER BY rank, id DESC
    LIMIT 1
  `)) as unknown as { slug: string }[];
  const slug = rows[0]?.slug;
  if (!slug) {
    return apiError(400, "No slug landing page exists yet to test with", API_ERROR_CODES.VALIDATION);
  }

  const result = await probeLandingUrl(`https://${host.host}/${parsed.data.path}/${slug}`);
  return NextResponse.json({ ...result, slug });
}
