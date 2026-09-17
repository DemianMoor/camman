import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/api/landing-page-guard";

export interface LandingPageImpact {
  /** Stages whose FUTURE messages would link to an edited destination. */
  affected: number;
  /** Of those, the ones an operator already signed off: approved, scheduled or dripping. */
  committed: number;
  /** Distinct brands among affected stages with no landing_host ("(no brand)" when unset). */
  brandsWithoutLandingHost: string[];
}

/**
 * Who would a destination edit (kind / slug / external_url) reach?
 *
 * The destination is built from the page's CURRENT columns, so an edit reaches:
 *
 *   • a regular stage until it is fully MATERIALIZED — kickoffStageSend freezes
 *     the URL into each recipient's minted link, then stamps materialized_at;
 *   • a drip stage (drip_active) on every send — it never freezes.
 *
 * Stages on completed / archived campaigns do not send, so they are not counted.
 *
 * Read-only. The PATCH uses this ONE query both to warn (409 with the counts)
 * and to gate the write, so the warning cannot disagree with what is enforced —
 * the lib/api/campaign-brand-change.ts pattern.
 */
export async function computeLandingPageImpact(
  dbc: DbOrTx,
  { orgId, pageId }: { orgId: string; pageId: number },
): Promise<LandingPageImpact> {
  const rows = (await dbc.execute(sql`
    SELECT
      count(*)::int AS affected,
      count(*) FILTER (
        WHERE s.send_approved OR s.scheduled_at IS NOT NULL OR s.drip_active IS TRUE
      )::int AS committed,
      coalesce(
        array_agg(DISTINCT coalesce(b.name, '(no brand)'))
          FILTER (WHERE coalesce(trim(b.landing_host), '') = ''),
        '{}'
      ) AS brands_without_landing_host
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id AND c.org_id = s.org_id
    LEFT JOIN brands b ON b.id = c.brand_id
    WHERE s.landing_page_id = ${pageId}
      AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL
      AND c.status IN ('draft', 'active', 'paused')
      AND (s.materialized_at IS NULL OR s.drip_active IS TRUE)
  `)) as unknown as {
    affected: number;
    committed: number;
    brands_without_landing_host: string[];
  }[];

  const r = rows[0];
  return {
    affected: r?.affected ?? 0,
    committed: r?.committed ?? 0,
    brandsWithoutLandingHost: r?.brands_without_landing_host ?? [],
  };
}
