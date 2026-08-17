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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
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
  const auth = await requireApiMembership();
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
  const NOT_WRITABLE_HERE = new Set(["short_domain"]);
  for (const [k, v] of Object.entries(parsed.data)) {
    if (NOT_WRITABLE_HERE.has(k)) continue;
    if (v === undefined) continue;
    updates[k] = NULLABLE_OPTIONAL.has(k) ? nullIfEmpty(v as string) : v;
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
