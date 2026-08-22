import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const LANDING_PAGE_INVALID_CODE = "landing_page_invalid";

export interface LandingPageRefusal {
  message: string;
  field: string;
}

/**
 * Write-time guard for `campaign_stages.landing_page_id` (Drip P1 1b).
 *
 * Returns `null` when the pairing is allowed. Checks, in order:
 *
 *   1. the page exists in this org AND belongs to the campaign's offer — a page
 *      from another offer would send people to an unrelated product;
 *   2. the page is `active` — a disabled page is disabled for a reason, and the
 *      send path refuses one, so accepting it at save time would only defer the
 *      failure to dispatch;
 *   3. for `kind='slug'`, the campaign's brand HAS a `landing_host`. Ruled:
 *      a brand with NULL landing_host cannot save a slug stage. Refusing here
 *      is the point — guessing a host (prefixing `www.`, say) ships a 404 that
 *      silently kills attribution, the exact failure 0094 exists to prevent.
 *
 * `kind='external_url'` needs no brand at all: the stored URL is used verbatim
 * for any brand.
 */
export async function checkStageLandingPage(
  dbc: DbOrTx,
  {
    orgId,
    campaignId,
    landingPageId,
  }: { orgId: string; campaignId: number; landingPageId: number | null | undefined },
): Promise<LandingPageRefusal | null> {
  if (landingPageId == null) return null; // legacy path — nothing to check

  const rows = (await dbc.execute(sql`
    SELECT lp.id, lp.kind, lp.status, lp.title,
           lp.offer_id        AS page_offer_id,
           c.offer_id         AS campaign_offer_id,
           c.brand_id         AS campaign_brand_id,
           b.name             AS brand_name,
           b.landing_host     AS brand_landing_host
    FROM offer_landing_pages lp
    CROSS JOIN campaigns c
    LEFT JOIN brands b ON b.id = c.brand_id
    WHERE lp.id = ${landingPageId} AND lp.org_id = ${orgId}::uuid
      AND c.id = ${campaignId} AND c.org_id = ${orgId}::uuid
    LIMIT 1
  `)) as unknown as {
    id: number;
    kind: string;
    status: string;
    title: string;
    page_offer_id: number;
    campaign_offer_id: number | null;
    campaign_brand_id: number | null;
    brand_name: string | null;
    brand_landing_host: string | null;
  }[];

  const r = rows[0];
  if (!r) {
    return {
      message: "That landing page doesn't belong to your organization",
      field: "landing_page_id",
    };
  }
  if (r.campaign_offer_id !== r.page_offer_id) {
    return {
      message:
        `Landing page "${r.title}" belongs to a different offer than this campaign. ` +
        `Pick a landing page from the campaign's own offer.`,
      field: "landing_page_id",
    };
  }
  if (r.status !== "active") {
    return {
      message: `Landing page "${r.title}" is disabled and cannot be used on a stage.`,
      field: "landing_page_id",
    };
  }
  if (r.kind === "slug" && !(r.brand_landing_host ?? "").trim()) {
    return {
      message:
        `Brand ${r.brand_name ?? "(none set)"} has no landing host, so the slug-based landing page ` +
        `"${r.title}" cannot be used. Set the brand's landing host, or pick an external-URL landing page.`,
      field: "landing_page_id",
    };
  }
  return null;
}
