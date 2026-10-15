import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/api/landing-page-guard";
import type { BrandLandingPair } from "@/lib/stage-url";

/**
 * The org's (landing_host, landing_path) pairs — the same rows the database
 * trigger `link_destinations_landing_url_shape` (0212, landing_url_ok) reads.
 * Feed them to validateBrandLpShape / isBrandLpUrl so the app refuses at Save
 * exactly what the database would refuse at mint.
 *
 * Every brand with a host counts, archived ones included — the trigger does not
 * look at status either, so an archived brand's live links stay valid.
 */
export async function loadBrandLandingPairs(
  dbc: DbOrTx,
  orgId: string,
): Promise<BrandLandingPair[]> {
  const rows = (await dbc.execute(sql`
    SELECT lower(landing_host) AS host, landing_path AS path
    FROM brands
    WHERE org_id = ${orgId}::uuid AND landing_host IS NOT NULL
    ORDER BY id
  `)) as unknown as BrandLandingPair[];
  return rows.map((r) => ({ host: r.host, path: r.path }));
}
