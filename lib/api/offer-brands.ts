import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { brands, offer_brands } from "@/db/schema";

// Offer ↔ brand assignment (offer_brands, migration 0194). Read only by the
// offer pickers and the campaign save-time check — never by the send path.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** True when every id is a brand in `orgId`. */
export async function brandsBelongToOrg(
  orgId: string,
  brandIds: number[],
): Promise<boolean> {
  const unique = [...new Set(brandIds)];
  const rows = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.org_id, orgId), inArray(brands.id, unique)));
  return rows.length === unique.length;
}

/** Replace-all: the offer ends up assigned to exactly `brandIds`. */
export async function replaceOfferBrands(
  tx: Tx,
  orgId: string,
  offerId: number,
  brandIds: number[],
): Promise<void> {
  await tx
    .delete(offer_brands)
    .where(
      and(eq(offer_brands.org_id, orgId), eq(offer_brands.offer_id, offerId)),
    );
  await tx
    .insert(offer_brands)
    .values(
      [...new Set(brandIds)].map((brand_id) => ({
        org_id: orgId,
        offer_id: offerId,
        brand_id,
      })),
    );
}

export async function isOfferAssignedToBrand(
  orgId: string,
  offerId: number,
  brandId: number,
): Promise<boolean> {
  const rows = await db
    .select({ offer_id: offer_brands.offer_id })
    .from(offer_brands)
    .where(
      and(
        eq(offer_brands.org_id, orgId),
        eq(offer_brands.offer_id, offerId),
        eq(offer_brands.brand_id, brandId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
