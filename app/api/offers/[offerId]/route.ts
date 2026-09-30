import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  affiliate_networks,
  campaigns,
  offer_brands,
  offer_exposure_counts,
  offer_payouts,
  offers,
} from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { buildUpdates } from "@/lib/api/build-updates";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { brandsBelongToOrg, replaceOfferBrands } from "@/lib/api/offer-brands";
import { can } from "@/lib/permissions";
import { nullIfEmpty, offerUpdateSchema } from "@/lib/validators/offers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  const auth = await requireApiMembership({
    route: "offers/[offerId]",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { offerId: id } = await params;
  const offerId = parseId(id);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: offers.id,
      offer_id: offers.offer_id,
      org_id: offers.org_id,
      name: offers.name,
      postfix: offers.postfix,
      base_url: offers.base_url,
      network_id: offers.network_id,
      payout_model: offers.payout_model,
      payout_cpa: offers.payout_cpa,
      payout_revshare: offers.payout_revshare,
      sales_pages: offers.sales_pages,
      avatar_url: offers.avatar_url,
      color: offers.color,
      status: offers.status,
      archived_at: offers.archived_at,
      created_at: offers.created_at,
      // Distinct leads already used for this offer (content-dedup counter,
      // migration 0086). Precomputed single-row read, never COUNT(DISTINCT).
      distinct_contacts_used: sql<number>`coalesce(${offer_exposure_counts.distinct_contacts}, 0)::int`,
      network: {
        id: affiliate_networks.id,
        name: affiliate_networks.name,
        avatar_url: affiliate_networks.avatar_url,
        color: affiliate_networks.color,
      },
    })
    .from(offers)
    .leftJoin(affiliate_networks, eq(offers.network_id, affiliate_networks.id))
    .leftJoin(
      offer_exposure_counts,
      and(
        eq(offer_exposure_counts.offer_id, offers.id),
        eq(offer_exposure_counts.org_id, orgId),
      ),
    )
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "offer",
    });
  }
  // Brand assignment (0194) + per-brand ACTIVE campaign counts on this offer,
  // which drive the offer form's non-blocking "used by N active campaigns
  // under Brand X — they will keep running" warning when a brand is unchecked.
  const [brandRows, activeByBrand] = await Promise.all([
    db
      .select({ brand_id: offer_brands.brand_id })
      .from(offer_brands)
      .where(
        and(eq(offer_brands.org_id, orgId), eq(offer_brands.offer_id, offerId)),
      ),
    db
      .select({
        brand_id: campaigns.brand_id,
        count: sql<number>`count(*)::int`,
      })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.org_id, orgId),
          eq(campaigns.offer_id, offerId),
          eq(campaigns.status, "active"),
        ),
      )
      .groupBy(campaigns.brand_id),
  ]);
  const out = {
    ...row,
    network: row.network && row.network.id !== null ? row.network : null,
    brand_ids: brandRows.map((r) => r.brand_id),
    active_campaigns_by_brand: activeByBrand.filter(
      (r): r is { brand_id: number; count: number } => r.brand_id !== null,
    ),
  };
  return NextResponse.json(out);
}

const NULLABLE_OPTIONAL_STRING = new Set([
  "postfix",
  "base_url",
  "avatar_url",
  "color",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  const auth = await requireApiMembership({
    route: "offers/[offerId]",
    method: "PATCH",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { offerId: id } = await params;
  const offerId = parseId(id);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const rawBody = (json ?? {}) as Record<string, unknown>;
  const parsed = offerUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const { brand_ids: brandIds, ...columnInput } = parsed.data;
  if (brandIds !== undefined && !(await brandsBelongToOrg(orgId, brandIds))) {
    return apiError(400, "Brand not found", API_ERROR_CODES.VALIDATION, {
      field: "brand_ids",
    });
  }

  // rawBody, not the parsed data: offerUpdateSchema injects sales_pages = []
  // for an absent key, which would empty the stored sales pages on any PATCH.
  const updates = buildUpdates(columnInput as Record<string, unknown>, rawBody, {
    coerce: (k, v) => {
      if (NULLABLE_OPTIONAL_STRING.has(k)) return nullIfEmpty(v as string);
      // Drizzle accepts string for numeric columns; preserve precision.
      if (k === "payout_cpa" || k === "payout_revshare")
        return v == null ? null : String(v);
      return v;
    },
  });

  // If network_id is being changed, verify the new network belongs to the
  // caller's org. DB-level FK + RLS aren't enough — the Drizzle connection
  // uses the privileged role.
  if (typeof updates.network_id === "number") {
    const networkRows = await db
      .select({ id: affiliate_networks.id })
      .from(affiliate_networks)
      .where(
        and(
          eq(affiliate_networks.id, updates.network_id),
          eq(affiliate_networks.org_id, orgId),
        ),
      )
      .limit(1);
    if (networkRows.length === 0) {
      return apiError(400, "Network not found", API_ERROR_CODES.VALIDATION, {
        field: "network_id",
      });
    }
  }

  // If payout_model is being changed, clear the unused payout column so we don't
  // leave a stale value behind.
  if (typeof updates.payout_model === "string") {
    if (updates.payout_model === "cpa") {
      if (updates.payout_revshare === undefined) updates.payout_revshare = null;
    } else if (updates.payout_model === "revshare") {
      if (updates.payout_cpa === undefined) updates.payout_cpa = null;
    }
  }

  // Read the current CPA so we can tell whether this PATCH actually changes it.
  // A real change is recorded as offer_payouts history (close current row, open a
  // new one) rather than silently overwriting — offers.payout_cpa is only a cache.
  const currentRows = await db
    .select({ payout_cpa: offers.payout_cpa })
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);
  if (!currentRows[0]) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "offer",
    });
  }
  const oldCpa = currentRows[0].payout_cpa;
  const cpaInUpdate = Object.prototype.hasOwnProperty.call(
    updates,
    "payout_cpa",
  );
  const newCpa = cpaInUpdate ? (updates.payout_cpa as string | null) : oldCpa;
  // Compare numerically so "60" vs "60.0000" isn't seen as a change.
  const cpaChanged =
    cpaInUpdate &&
    (oldCpa == null || newCpa == null
      ? oldCpa !== newCpa
      : Number(oldCpa) !== Number(newCpa));

  try {
    const updated = await db.transaction(async (tx) => {
      const offerWhere = and(eq(offers.id, offerId), eq(offers.org_id, orgId));
      // A brands-only PATCH has no column updates (Drizzle rejects an empty set).
      const [row] =
        Object.keys(updates).length > 0
          ? await tx.update(offers).set(updates).where(offerWhere).returning()
          : await tx.select().from(offers).where(offerWhere);
      if (!row) return null;

      if (brandIds !== undefined) {
        await replaceOfferBrands(tx, orgId, offerId, brandIds);
      }

      if (cpaChanged) {
        // Close the current open history row...
        await tx
          .update(offer_payouts)
          .set({ effective_to: sql`now()` })
          .where(
            and(
              eq(offer_payouts.offer_id, offerId),
              isNull(offer_payouts.effective_to),
            ),
          );
        // ...and open a new current row when there's still a CPA (a switch to
        // revshare clears it — close the old row, open none).
        if (newCpa != null) {
          await tx.insert(offer_payouts).values({
            org_id: orgId,
            offer_id: offerId,
            payout_cpa: newCpa,
            effective_from: sql`now()`,
            effective_to: null,
          });
        }
      }
      return row;
    });

    if (!updated) {
      return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "offer",
      });
    }
    return NextResponse.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "An offer with this offer_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "offer_id" },
      );
    }
    throw err;
  }
}
