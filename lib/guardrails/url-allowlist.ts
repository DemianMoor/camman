import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { brands, short_domains } from "@/db/schema";

// Creative body link policy (ClickUp 869et3vm1, Phase 3).
//
// Two rules, and the first one does most of the work:
//
//   1. A creative body may contain link PLACEHOLDERS, never a raw URL. The
//      tracked link is minted per recipient at send time (lib/links) — a literal
//      URL in the body is either dead weight or, worse, an untracked path out of
//      the funnel that no report will ever see.
//   2. Where a URL is unavoidable (an explicitly configured destination), its
//      host must be a brand site or a registered short domain.
//
// ⚠️ Rule 1 is what makes rule 2 cheap. If bodies could carry arbitrary URLs we
// would be validating attacker-controlled strings; because they cannot, rule 2
// only ever runs against a small set of configured values.

/** The placeholder the send pipeline substitutes per recipient. */
export const LINK_PLACEHOLDER = "{link}";

// Deliberately broad: anything that could be read as a link by a phone. Matching
// widely and refusing is the safe direction — a false positive is a validation
// message, a false negative is an untracked link in a live SMS.
const URL_LIKE =
  /(https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(com|net|org|io|co|link|xyz|info|biz|us|shop|site|online|club)\b/gi;

export type UrlRejection = {
  reason: "raw_url_in_body" | "host_not_allowed";
  found: string;
  message: string;
};

/**
 * Reject a creative body that contains anything URL-shaped.
 *
 * The placeholder is stripped BEFORE matching, so `{link}` never trips the
 * pattern and a body that uses it correctly always passes.
 */
export function checkCreativeBody(text: string): UrlRejection | null {
  const withoutPlaceholders = text.split(LINK_PLACEHOLDER).join(" ");
  const matches = withoutPlaceholders.match(URL_LIKE);
  if (!matches || matches.length === 0) return null;
  const found = matches[0];
  return {
    reason: "raw_url_in_body",
    found,
    message:
      `Creative text may not contain a raw link ("${found}"). ` +
      `Use the ${LINK_PLACEHOLDER} placeholder — the tracked link is generated per recipient at send time.`,
  };
}

function hostOf(value: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withScheme).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Every host the org may point a link at: brand sites + registered short domains. */
export async function allowedHosts(orgId: string): Promise<Set<string>> {
  const [domains, brandRows] = await Promise.all([
    db
      .select({ domain: short_domains.domain })
      .from(short_domains)
      .where(
        and(eq(short_domains.org_id, orgId), eq(short_domains.status, "active")),
      ),
    db.select({ website: brands.website }).from(brands).where(eq(brands.org_id, orgId)),
  ]);

  const out = new Set<string>();
  for (const d of domains) {
    const h = hostOf(d.domain);
    if (h) out.add(h);
  }
  for (const b of brandRows) {
    if (!b.website) continue;
    const h = hostOf(b.website);
    if (h) out.add(h);
  }
  return out;
}

/**
 * Validate an explicitly configured destination URL against the allowlist.
 *
 * A subdomain of an allowed host passes (`go.brand.com` for `brand.com`); an
 * unrelated host does not. Suffix matching is anchored on a dot so `evilbrand.com`
 * cannot pass as a subdomain of `brand.com`.
 */
export function checkDestination(
  url: string,
  allowed: Set<string>,
): UrlRejection | null {
  const host = hostOf(url);
  if (!host) {
    return {
      reason: "host_not_allowed",
      found: url,
      message: `"${url}" is not a valid URL.`,
    };
  }
  for (const a of allowed) {
    if (host === a || host.endsWith(`.${a}`)) return null;
  }
  return {
    reason: "host_not_allowed",
    found: host,
    message:
      `"${host}" is not a brand site or a registered short domain. ` +
      `Add it under Settings → Short Domains, or point the link at an existing brand domain.`,
  };
}

/** Convenience for callers holding a list of brand ids rather than the whole org. */
export async function allowedHostsForBrands(
  orgId: string,
  brandIds: number[],
): Promise<Set<string>> {
  if (brandIds.length === 0) return allowedHosts(orgId);
  const rows = await db
    .select({ website: brands.website })
    .from(brands)
    .where(and(eq(brands.org_id, orgId), inArray(brands.id, brandIds)));
  const out = await allowedHosts(orgId);
  for (const r of rows) {
    const h = r.website ? hostOf(r.website) : null;
    if (h) out.add(h);
  }
  return out;
}
