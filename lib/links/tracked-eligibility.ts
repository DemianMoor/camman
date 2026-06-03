import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { short_domains } from "@/db/schema";

// A campaign may only be switched to link_mode='tracked' when its brand has
// at least one active short_domains row. (The second original guard
// condition — "configured for API/TextHub send" — is deferred until the
// send pipeline exists.) Used by the campaign PATCH route to block the
// toggle server-side; the UI mirrors it by disabling the switch.
export async function brandHasActiveShortDomain(
  orgId: string,
  brandId: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: short_domains.id })
    .from(short_domains)
    .where(
      and(
        eq(short_domains.org_id, orgId),
        eq(short_domains.brand_id, brandId),
        eq(short_domains.status, "active"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
