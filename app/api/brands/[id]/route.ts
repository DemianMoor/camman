import { and, eq, sql as drizzleSql } from "drizzle-orm";
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
  BRAND_LANDING_IN_USE_CODE,
  checkBrandLandingPair,
  computeBrandLandingImpact,
  LANDING_PAIR_TAKEN_CODE,
  normalizeLandingHost,
} from "@/lib/api/brand-landing";
import { can } from "@/lib/permissions";
import { brandUpdateSchema, nullIfEmpty } from "@/lib/validators/brands";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// The brand's EFFECTIVE short domain, for response shaping only (the list
// column). Mirrors the send path's brand-level precedence — explicit default
// first, then oldest active — so the brands list shows the host that would
// actually be minted under rather than an arbitrary row. Pending rows are
// excluded because they are not mintable.
async function brandShortDomain(
  dbc: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  brandId: number,
): Promise<string | null> {
  const rows = (await dbc.execute(drizzleSql`
    SELECT domain FROM short_domains
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND status = 'active'
    ORDER BY is_default DESC, created_at ASC, id ASC
    LIMIT 1
  `)) as unknown as { domain: string }[];
  return rows[0]?.domain ?? null;
}

// The landing (host, path) pair is unique per org (brands_landing_pair_uniq);
// the pre-check reports it with the brand's name, this is the race backstop.
function isLandingPairViolation(err: unknown): boolean {
  const e = err as { constraint_name?: unknown; cause?: { constraint_name?: unknown } };
  return (
    e?.constraint_name === "brands_landing_pair_uniq" ||
    e?.cause?.constraint_name === "brands_landing_pair_uniq"
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({
    route: "brands/[id]",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const brandId = parseId(id);
  if (brandId === null) {
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "brand",
    });
  }
  return NextResponse.json({
    ...rows[0],
    short_domain: await brandShortDomain(db, orgId, brandId),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({
    route: "brands/[id]",
    method: "PATCH",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const brandId = parseId(id);
  if (brandId === null) {
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = brandUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Drizzle's .set rejects entirely-empty objects, but the schema already
  // refuses those. Strip undefined keys so we don't overwrite with NULL.
  // For the three optional string fields, empty string means "clear it" → NULL.
  const updates: Record<string, unknown> = {};
  const NULLABLE_OPTIONAL = new Set([
    "short_link_base",
    "website",
    "avatar_url",
    "color",
  ]);
  // ⚠️ short_domain is NO LONGER WRITABLE HERE — it is DROPPED, not applied, so
  // a stale client that still sends the key cannot reach a second write path.
  // Brand domains are list-shaped since migration 0136 and are managed through
  // their own surface (/api/brands/[id]/short-domains). The old in-line upsert
  // was broken outright by 0136 (ON CONFLICT against an index it had dropped)
  // and its clear branch deleted EVERY domain of the brand.
  // landing_host / landing_path / confirm are handled below, not copied blindly.
  const NOT_WRITABLE_HERE = new Set(["short_domain", "landing_host", "landing_path", "confirm"]);
  for (const [k, v] of Object.entries(parsed.data)) {
    if (NOT_WRITABLE_HERE.has(k)) continue;
    if (v === undefined) continue;
    updates[k] = NULLABLE_OPTIONAL.has(k) ? nullIfEmpty(v as string) : v;
  }

  // ── Landing host/path (0211/0212) ─────────────────────────────────────────
  // Gated on an ACTUAL change, so a manager re-saving the form with the values
  // untouched is not refused. A change re-points every future minted link for
  // the brand's slug pages, hence admin-only + confirm with the counts.
  if (parsed.data.landing_host !== undefined || parsed.data.landing_path !== undefined) {
    const [current] = await db
      .select({ host: brands.landing_host, path: brands.landing_path })
      .from(brands)
      .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
      .limit(1);
    if (!current) {
      return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, { entity: "brand" });
    }
    let nextHost = current.host;
    if (parsed.data.landing_host !== undefined) {
      const h = normalizeLandingHost(parsed.data.landing_host);
      if (!h.ok) return apiError(400, h.error, API_ERROR_CODES.VALIDATION, { field: "landing_host" });
      nextHost = h.host;
    }
    const nextPath = parsed.data.landing_path ?? current.path;
    const changed = nextHost !== current.host || nextPath !== current.path;
    if (changed) {
      if (!can(role, "brands.landing.update")) {
        return apiError(403, "Only an admin can change a brand's landing host or path", API_ERROR_CODES.FORBIDDEN, {
          field: "landing_host",
        });
      }
      const refusal = await checkBrandLandingPair(db, { orgId, brandId, nextHost, nextPath });
      if (refusal) return apiError(refusal.status, refusal.message, refusal.code, refusal.details);
      if (parsed.data.confirm !== true) {
        const impact = await computeBrandLandingImpact(db, { orgId, brandId });
        return apiError(
          409,
          `${impact.stages} stage(s) in ${impact.campaigns} campaign(s) use slug landing pages under this brand ` +
            `and will link to the new host/path. Confirm to change it.`,
          BRAND_LANDING_IN_USE_CODE,
          { ...impact, from: { host: current.host, path: current.path }, to: { host: nextHost, path: nextPath } },
        );
      }
      updates.landing_host = nextHost;
      updates.landing_path = nextPath;
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Apply brand-column updates if any; otherwise confirm the brand exists
      // (and is org-owned) so a short_domain-only change still 404s correctly.
      let row;
      if (Object.keys(updates).length > 0) {
        [row] = await tx
          .update(brands)
          .set(updates)
          .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
          .returning();
      } else {
        [row] = await tx
          .select()
          .from(brands)
          .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
          .limit(1);
      }
      if (!row) return null;

      return { ...row, short_domain: await brandShortDomain(tx, orgId, brandId) };
    });

    if (!result) {
      return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "brand",
      });
    }
    return NextResponse.json(result);
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
