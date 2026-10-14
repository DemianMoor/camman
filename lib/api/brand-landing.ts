import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/api/landing-page-guard";
import { normalizeShortDomain } from "@/lib/sends/short-domain";

// A brand's landing host + path (0211/0212) — the write-side rules.
//
// Changing either one re-points EVERY future link minted for the brand's slug
// landing pages, and the link_destinations trigger (0212) validates against
// these exact rows. So a save is guarded three ways, all here so the create and
// edit routes cannot drift:
//
//   1. landing_pair_taken      — another brand in the org already has the pair
//                                (also backstopped by brands_landing_pair_uniq).
//   2. landing_path_collides   — the path is NEW to the org's in-scope set and
//                                existing link/stage URLs already contain
//                                /<path>/ on a different host. Adding it would
//                                pull them into scope and they would be refused
//                                at mint. A path already in scope (always 'lp',
//                                or another brand's path) changes nothing, so it
//                                is not checked.
//   3. brand_landing_in_use    — (edit only) the change needs confirm:true; the
//                                response carries the campaigns/stages counts.

import {
  BRAND_LANDING_IN_USE_CODE,
  LANDING_PAIR_TAKEN_CODE,
  LANDING_PATH_COLLIDES_CODE,
  LANDING_PATH_RE,
} from "@/lib/brand-landing-codes";

export { BRAND_LANDING_IN_USE_CODE, LANDING_PAIR_TAKEN_CODE, LANDING_PATH_COLLIDES_CODE, LANDING_PATH_RE };

export type NormalizeHostResult = { ok: true; host: string | null } | { ok: false; error: string };

/** Lowercase, strip scheme/path/port/trailing slash, validate. "" ⇒ null (cleared). */
export function normalizeLandingHost(raw: string | null | undefined): NormalizeHostResult {
  const r = normalizeShortDomain(raw);
  if (!r.ok) return { ok: false, error: "Enter a valid landing host like www.brand.com (no path)" };
  return r;
}

export interface LandingRefusal {
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Rules 1 and 2 for a brand about to hold (nextHost, nextPath). `brandId` is
 * null on create. A brand with no host is outside validation, so it is never
 * refused here.
 */
export async function checkBrandLandingPair(
  dbc: DbOrTx,
  input: { orgId: string; brandId: number | null; nextHost: string | null; nextPath: string },
): Promise<LandingRefusal | null> {
  const { orgId, brandId, nextHost, nextPath } = input;
  if (!nextHost) return null;

  // Every brand in the org that has a host — INCLUDING the saving brand's
  // current pair: its current path is already in scope, so keeping it (e.g. a
  // host-only change) must not be collision-checked against its own URLs.
  const withHost = (await dbc.execute(sql`
    SELECT id, name, lower(landing_host) AS host, landing_path AS path
    FROM brands
    WHERE org_id = ${orgId}::uuid AND landing_host IS NOT NULL
  `)) as unknown as { id: number; name: string; host: string; path: string }[];
  const others = withHost.filter((o) => o.id !== brandId);

  const taken = others.find((o) => o.host === nextHost && o.path === nextPath);
  if (taken) {
    return {
      status: 409,
      code: LANDING_PAIR_TAKEN_CODE,
      message: `Brand "${taken.name}" already uses ${nextHost}/${nextPath}/.`,
      details: { field: "landing_host", brand_id: taken.id },
    };
  }

  const inScope = new Set(["lp", ...withHost.map((o) => o.path)]);
  if (inScope.has(nextPath)) return null;

  const rows = (await dbc.execute(sql`
    SELECT n::int AS n, examples FROM landing_path_collisions(${orgId}::uuid, ${nextPath}, ${nextHost}, 5)
  `)) as unknown as { n: number; examples: string[] }[];
  const n = rows[0]?.n ?? 0;
  if (n === 0) return null;
  return {
    status: 409,
    code: LANDING_PATH_COLLIDES_CODE,
    message:
      `${n} existing link or stage URL(s) already use /${nextPath}/ on another host. ` +
      `Making it a brand landing path would refuse them at send time. Pick a different path.`,
    details: { field: "landing_path", count: n, examples: rows[0]?.examples ?? [] },
  };
}

export interface BrandLandingImpact {
  campaigns: number;
  stages: number;
}

/**
 * Who would a host/path change reach? Stages under the brand's campaigns that
 * use a SLUG landing page and still mint: not yet materialized, or dripping, on
 * a draft/active/paused campaign, with no hand-edited Full URL (a hand edit
 * wins at mint and does not follow the brand). Same filter as
 * computeLandingPageImpact.
 */
export async function computeBrandLandingImpact(
  dbc: DbOrTx,
  { orgId, brandId }: { orgId: string; brandId: number },
): Promise<BrandLandingImpact> {
  const rows = (await dbc.execute(sql`
    SELECT count(DISTINCT c.id)::int AS campaigns, count(*)::int AS stages
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id AND c.org_id = s.org_id
    JOIN offer_landing_pages lp ON lp.id = s.landing_page_id AND lp.kind = 'slug'
    WHERE c.brand_id = ${brandId}
      AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL
      AND c.status IN ('draft', 'active', 'paused')
      AND (s.materialized_at IS NULL OR s.drip_active IS TRUE)
      AND coalesce(trim(s.full_url), '') = ''
  `)) as unknown as BrandLandingImpact[];
  return { campaigns: rows[0]?.campaigns ?? 0, stages: rows[0]?.stages ?? 0 };
}
