import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Bare-hostname of the app's own origin (from NEXT_PUBLIC_SITE_URL), port
// stripped. Used to tell the app host apart from short-link hosts so the app
// host's "/" is left exactly as-is.
export function appHostname(siteUrl: string | undefined | null): string | null {
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// The brand website for a short-link host, or null if the host isn't a known
// ACTIVE short domain or the brand has no website set. Lookup is by domain
// (LIMIT 1 — a real host belongs to one org despite (org_id, domain) allowing
// the same string across orgs in theory).
export async function lookupBrandWebsiteByHost(
  dbc: DbOrTx,
  host: string,
): Promise<string | null> {
  const rows = (await dbc.execute(sql`
    SELECT b.website AS website
    FROM short_domains sd
    JOIN brands b ON b.id = sd.brand_id
    WHERE sd.domain = ${host} AND sd.status = 'active' AND b.website IS NOT NULL
    LIMIT 1
  `)) as unknown as { website: string }[];
  return rows[0]?.website ?? null;
}

// Decide where the bare root path "/" goes. Returns an external website URL
// for a matching short-link host, else the app's internal home. The lookup is
// injected so it's unit-testable and only runs for non-app hosts (the app
// host short-circuits to home with no DB call). `host` must be lowercased +
// port-stripped by the caller.
export async function resolveRootTarget(opts: {
  host: string;
  appHost: string | null;
  lookupWebsite: (host: string) => Promise<string | null>;
  appHome?: string;
}): Promise<string> {
  const home = opts.appHome ?? "/dashboard";
  if (opts.host && opts.host !== opts.appHost) {
    const website = await opts.lookupWebsite(opts.host);
    if (website) return website;
  }
  return home;
}
