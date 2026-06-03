import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// A bare hostname: labels of [a-z0-9-] joined by dots, with a 2+ char TLD.
// No scheme, no path, no port. e.g. "go.brand.co".
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export type NormalizeResult =
  | { ok: true; host: string | null } // null = empty input (clear the domain)
  | { ok: false; error: string };

// Strip scheme/path/port/whitespace and lowercase, then validate as a bare
// hostname. Empty input → host: null (caller treats as "clear").
export function normalizeShortDomain(raw: string | null | undefined): NormalizeResult {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return { ok: true, host: null };

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  s = s.split("/")[0] ?? ""; // strip path
  s = s.split("?")[0] ?? "";
  s = s.split("#")[0] ?? "";
  s = s.split(":")[0] ?? ""; // strip port
  s = s.replace(/^\.+|\.+$/g, ""); // strip leading/trailing dots

  if (!HOSTNAME_RE.test(s)) {
    return { ok: false, error: "Enter a valid domain like go.brand.co (no http://, no path)" };
  }
  return { ok: true, host: s };
}

export type ApplyResult =
  | { ok: true; domain: string | null }
  | { ok: false; reason: "invalid_domain" | "domain_taken" | "domain_in_use"; message: string };

// Upsert (or clear) the ONE short_domains row for a brand. Pre-checks the
// cross-brand (org_id, domain) uniqueness and the links FK so we never trip a
// constraint mid-transaction. Caller runs this inside the brand create/update
// transaction.
export async function applyBrandShortDomain(
  dbc: DbOrTx,
  { orgId, brandId, rawDomain }: { orgId: string; brandId: number; rawDomain: string | null | undefined },
): Promise<ApplyResult> {
  const norm = normalizeShortDomain(rawDomain);
  if (!norm.ok) return { ok: false, reason: "invalid_domain", message: norm.error };

  // Clear: remove the brand's row (refuse if minted links still reference it).
  if (norm.host === null) {
    const inUse = (await dbc.execute(sql`
      SELECT 1 AS ok FROM links l
      JOIN short_domains sd ON sd.id = l.short_domain_id
      WHERE sd.org_id = ${orgId} AND sd.brand_id = ${brandId}
      LIMIT 1
    `)) as unknown as { ok: number }[];
    if (inUse[0]) {
      return {
        ok: false,
        reason: "domain_in_use",
        message: "This short domain has minted links and can't be removed.",
      };
    }
    await dbc.execute(sql`
      DELETE FROM short_domains WHERE org_id = ${orgId} AND brand_id = ${brandId}
    `);
    return { ok: true, domain: null };
  }

  // Pre-check the (org_id, domain) uniqueness against OTHER brands.
  const taken = (await dbc.execute(sql`
    SELECT brand_id FROM short_domains
    WHERE org_id = ${orgId} AND domain = ${norm.host}
    LIMIT 1
  `)) as unknown as { brand_id: number }[];
  if (taken[0] && Number(taken[0].brand_id) !== brandId) {
    return {
      ok: false,
      reason: "domain_taken",
      message: "Another brand already uses this short domain.",
    };
  }

  // One row per brand: upsert on brand_id.
  await dbc.execute(sql`
    INSERT INTO short_domains (org_id, brand_id, domain, status)
    VALUES (${orgId}, ${brandId}, ${norm.host}, 'active')
    ON CONFLICT (brand_id) DO UPDATE SET domain = EXCLUDED.domain, status = 'active'
  `);
  return { ok: true, domain: norm.host };
}
