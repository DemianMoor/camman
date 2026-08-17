import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// A bare hostname: labels of [a-z0-9-] joined by dots, with a 2+ char TLD.
// No scheme, no path, no port. e.g. "go.brand.co".
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export type NormalizeResult =
  | { ok: true; host: string | null } // null = empty input
  | { ok: false; error: string };

// Strip scheme/path/port/whitespace and lowercase, then validate as a bare
// hostname. Empty input → host: null.
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

// ── The brand short-domain WRITE surface ─────────────────────────────────────
//
// ⚠️ `applyBrandShortDomain` — the one-row upsert this module used to export —
// IS GONE, deliberately and permanently. Two defects killed it, both created by
// migration 0136 (which let a brand hold SEVERAL short domains) and neither
// noticed because the guard that covered it was never re-run:
//
//   1. It ended in `ON CONFLICT (brand_id) DO UPDATE`, but 0136 DROPPED
//      `short_domains_brand_id_uniq` — the index that conflict target infers
//      from. Postgres refused to plan the statement at all:
//      `42P10: there is no unique or exclusion constraint matching the ON
//      CONFLICT specification`. Saving a brand's short domain 500'd in
//      production from the day 0136 landed.
//   2. Its clear branch ran `DELETE … WHERE org_id = … AND brand_id = …`, which
//      post-0136 deletes EVERY domain of that brand rather than the one being
//      removed — including a `pending` row provisioned for a later activation.
//
// Brand domains are LIST-SHAPED now, so the write surface is a set of targeted
// operations, not an upsert. **THERE MUST NEVER BE A BRAND-WIDE DELETE PATH
// AGAIN** — `deleteShortDomain` takes an id and only an id, and
// scripts/verify-brand-domains.ts asserts at source level that no
// `DELETE FROM short_domains` keyed on brand_id exists anywhere in this repo.

export type AddResult =
  | { ok: true; id: number; domain: string }
  | { ok: false; reason: "invalid_domain" | "domain_taken"; message: string };

// ADD — always inserts as `pending`. A newly registered hostname has not been
// proven to route to the app yet, and activation is a deliberate operator act
// (B1); nothing may arrive mintable.
//
// The conflict target is `(org_id, domain)` — `short_domains_org_id_domain_unique`,
// the unique that actually still exists after 0136. On conflict we REFUSE with
// "already registered" rather than `DO NOTHING`/`DO UPDATE`: silently adopting
// a hostname that belongs to another brand would move that brand's minting, and
// silently succeeding on a row you did not create is how an operator ends up
// believing they own a domain they do not.
export async function addShortDomain(
  dbc: DbOrTx,
  { orgId, brandId, rawDomain }: { orgId: string; brandId: number; rawDomain: string | null | undefined },
): Promise<AddResult> {
  const norm = normalizeShortDomain(rawDomain);
  if (!norm.ok) return { ok: false, reason: "invalid_domain", message: norm.error };
  if (norm.host === null) {
    return { ok: false, reason: "invalid_domain", message: "Enter a domain to add." };
  }

  const inserted = (await dbc.execute(sql`
    INSERT INTO short_domains (org_id, brand_id, domain, status, is_default)
    VALUES (${orgId}, ${brandId}, ${norm.host}, 'pending', false)
    ON CONFLICT (org_id, domain) DO NOTHING
    RETURNING id, domain
  `)) as unknown as { id: number; domain: string }[];

  if (!inserted[0]) {
    // DO NOTHING returns no row on conflict. Read back WHY so the operator is
    // told which brand holds it rather than a bare "conflict".
    const owner = (await dbc.execute(sql`
      SELECT b.name AS brand_name FROM short_domains d
      JOIN brands b ON b.id = d.brand_id
      WHERE d.org_id = ${orgId} AND d.domain = ${norm.host}
      LIMIT 1
    `)) as unknown as { brand_name: string }[];
    return {
      ok: false,
      reason: "domain_taken",
      message: owner[0]
        ? `${norm.host} is already registered to ${owner[0].brand_name}.`
        : `${norm.host} is already registered.`,
    };
  }
  return { ok: true, id: inserted[0].id, domain: inserted[0].domain };
}

export type StatusResult =
  | { ok: true; id: number; status: string }
  | { ok: false; reason: "not_found"; message: string };

// ACTIVATE / DEACTIVATE — a targeted update BY ID, org-scoped.
//
// Deactivating also clears `is_default`: a non-active row must never be a
// brand's default, or re-activating it later would silently move minting for
// the whole brand. Resolution then falls back to oldest-active, which is the
// pre-0140 behaviour and safe.
export async function setShortDomainStatus(
  dbc: DbOrTx,
  { orgId, id, status }: { orgId: string; id: number; status: "active" | "pending" },
): Promise<StatusResult> {
  const rows = (await dbc.execute(sql`
    UPDATE short_domains
    SET status = ${status},
        is_default = CASE WHEN ${status} = 'active' THEN is_default ELSE false END
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING id, status
  `)) as unknown as { id: number; status: string }[];
  if (!rows[0]) return { ok: false, reason: "not_found", message: "Short domain not found" };
  return { ok: true, id: rows[0].id, status: rows[0].status };
}

export type DefaultResult =
  | { ok: true; id: number }
  | { ok: false; reason: "not_found" | "not_active"; message: string };

// SET DEFAULT — targeted by id. Clears the brand's existing default first,
// because `short_domains_one_default_per_brand` would otherwise reject the
// write; both statements run in the caller's transaction so the brand is never
// left with zero defaults if the second fails.
//
// Refuses a non-ACTIVE row. A pending domain as brand default would mean
// activation silently redirects the whole brand's minting — the operator must
// activate first, then choose it, as two deliberate acts.
export async function setShortDomainDefault(
  dbc: DbOrTx,
  { orgId, id }: { orgId: string; id: number },
): Promise<DefaultResult> {
  const target = (await dbc.execute(sql`
    SELECT id, brand_id, status FROM short_domains
    WHERE id = ${id} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as { id: number; brand_id: number; status: string }[];
  if (!target[0]) return { ok: false, reason: "not_found", message: "Short domain not found" };
  if (target[0].status !== "active") {
    return {
      ok: false,
      reason: "not_active",
      message: "Activate this domain before making it the brand default.",
    };
  }

  await dbc.execute(sql`
    UPDATE short_domains SET is_default = false
    WHERE org_id = ${orgId} AND brand_id = ${target[0].brand_id} AND is_default AND id <> ${id}
  `);
  await dbc.execute(sql`
    UPDATE short_domains SET is_default = true WHERE id = ${id} AND org_id = ${orgId}
  `);
  return { ok: true, id };
}

export type DeleteResult =
  | { ok: true; id: number }
  | { ok: false; reason: "not_found" | "domain_in_use"; message: string };

// DELETE — BY ID ONLY. Never by brand.
//
// The minted-links guard is preserved from the old helper and now scopes to the
// single row: a domain with minted links cannot be removed, because deleting it
// would orphan the links that resolve through it. Deactivate instead.
export async function deleteShortDomain(
  dbc: DbOrTx,
  { orgId, id }: { orgId: string; id: number },
): Promise<DeleteResult> {
  const existing = (await dbc.execute(sql`
    SELECT id FROM short_domains WHERE id = ${id} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as { id: number }[];
  if (!existing[0]) return { ok: false, reason: "not_found", message: "Short domain not found" };

  const inUse = (await dbc.execute(sql`
    SELECT 1 AS ok FROM links WHERE short_domain_id = ${id} LIMIT 1
  `)) as unknown as { ok: number }[];
  if (inUse[0]) {
    return {
      ok: false,
      reason: "domain_in_use",
      message: "This short domain has minted links and can't be removed. Deactivate it instead.",
    };
  }

  await dbc.execute(sql`DELETE FROM short_domains WHERE id = ${id} AND org_id = ${orgId}`);
  return { ok: true, id };
}

export interface BrandShortDomainRow {
  id: number;
  domain: string;
  status: string;
  is_default: boolean;
}

// LIST — every domain of one brand, for the management surface.
//
// ⚠️ DELIBERATELY CARRIES NO MINTED-LINK COUNT. It used to select
// `(SELECT count(*) FROM links WHERE short_domain_id = d.id)` per row, purely so
// the UI could show "N minted links" and pre-disable Delete. `links` holds
// 3,227,905 rows and has NO index covering `short_domain_id`, so each count was
// a parallel seq scan of the whole table (~3.1s measured). One brand's list cost
// 6,822ms against 48ms without it, and the page issues one request per brand
// SERIALLY — ~20.5s before anything rendered, which is also why a "Make default"
// click appeared to do nothing: the write landed instantly and the refetch
// behind it took twenty seconds.
//
// The count was never load-bearing: `deleteShortDomain` re-checks minted links
// server-side and refuses with `domain_in_use`, so the client figure only ever
// pre-disabled a button the server already guards. Dropping it is a 140x
// improvement for a advisory number.
//
// To bring it back, add an index on `links(short_domain_id)` in its own
// migration and re-measure — deliberately NOT done here.
export async function listBrandShortDomains(
  dbc: DbOrTx,
  { orgId, brandId }: { orgId: string; brandId: number },
): Promise<BrandShortDomainRow[]> {
  return (await dbc.execute(sql`
    SELECT d.id, d.domain, d.status, d.is_default
    FROM short_domains d
    WHERE d.org_id = ${orgId} AND d.brand_id = ${brandId}
    ORDER BY d.is_default DESC, d.created_at ASC, d.id ASC
  `)) as unknown as BrandShortDomainRow[];
}
