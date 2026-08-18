import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { pickEffectiveShortDomain } from "@/lib/links/tracked-link";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ResolvedShortDomain {
  id: number;
  domain: string;
}

// THE single definition of "which host does this stage mint links under".
//
// Deliberately a SEPARATE module from lib/sends/short-domain.ts, which owns the
// brand form's WRITE path (normalize + upsert). This is the READ path, called on
// every tracked send; keeping them apart means the send path does not import the
// write helpers, and a change to one cannot silently alter the other.
//
// Extracted from lib/sends/kickoff.ts by B1 so the resolution has exactly one
// implementation: the send path and scripts/verify-brand-domain-resolution.ts
// both call THIS, and the verifier compares its answer against a separate,
// deliberately-duplicated transcription of the PRE-B1 rule. Two copies of the
// NEW rule proving each other correct would be worthless.
//
// Precedence, most specific first:
//
//   1. the STAGE'S SENDING NUMBER's override   (provider_phones.short_domain_id, 0137)
//   2. the BRAND'S DEFAULT                     (short_domains.is_default, 0140)
//   3. the brand's oldest active domain        (the pre-0140 rule, unchanged)
//
// Layer 2 is new and sits BETWEEN the two existing layers rather than replacing
// layer 3: 0136 let a brand hold several domains, which made "oldest active" an
// implicit choice the operator could not state. `is_default` makes it explicit
// and is DB-enforced to at most one per brand (0140). Where no default is
// flagged, layer 3 answers exactly as it always has.
//
// ⚠️ EVERY layer requires status='active'. A `pending` domain — which is how B1
// inserts the three g.* hostnames — must never be mintable, so a pending
// override falls THROUGH to the brand rather than failing the send. Activation
// is a deliberate operator act, never a side effect of assignment.
//
// ⚠️ REQUIRES MIGRATION 0140 (reads `is_default`). Additive migrations lead the
// code — this module must not deploy before 0140 is applied.
export async function resolveShortDomainForSend(
  dbc: DbOrTx,
  {
    orgId,
    brandId,
    providerPhoneId,
  }: { orgId: string; brandId: number | null; providerPhoneId: number | null },
): Promise<ResolvedShortDomain | null> {
  // ⚠️ The ORDER below is not expressed here — it is delegated to
  // pickEffectiveShortDomain (lib/links/tracked-link.ts), the one function the
  // stage form's preview also calls. This function's job is the DB lookups that
  // produce the two candidates; ranking them is shared, so the preview and the
  // send path cannot disagree about which host wins. See B2.

  // 1. Per-number override. Must be org-owned AND active.
  let phoneOverride: ResolvedShortDomain | null = null;
  if (providerPhoneId != null) {
    const override = (await dbc.execute(sql`
      SELECT d.id, d.domain
      FROM provider_phones ph
      JOIN short_domains d ON d.id = ph.short_domain_id
      WHERE ph.id = ${providerPhoneId}
        AND ph.org_id = ${orgId}
        AND d.org_id = ${orgId}
        AND d.status = 'active'
      LIMIT 1
    `)) as unknown as ResolvedShortDomain[];
    phoneOverride = override[0] ?? null;
  }

  // No brand ⇒ the brand candidate cannot exist; the phone override (if any) is
  // the only one. Still routed through the shared ranking so there is exactly
  // one place that decides.
  if (brandId == null) {
    return pickEffectiveShortDomain({ phoneOverrideDomain: phoneOverride?.domain })
      ? phoneOverride
      : null;
  }

  // 2. The brand's explicit default. At most one row can satisfy this
  //    (short_domains_one_default_per_brand), so no ORDER BY is needed to make
  //    it deterministic — the database guarantees it.
  const flagged = (await dbc.execute(sql`
    SELECT id, domain FROM short_domains
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
      AND status = 'active' AND is_default
    LIMIT 1
  `)) as unknown as ResolvedShortDomain[];

  // 3. Oldest active — the pre-0140 rule, character-for-character. Reached when
  //    a brand has active domains but none flagged as default.
  const oldest = flagged[0]
    ? []
    : ((await dbc.execute(sql`
        SELECT id, domain FROM short_domains
        WHERE org_id = ${orgId} AND brand_id = ${brandId} AND status = 'active'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `)) as unknown as ResolvedShortDomain[]);

  // The brand's EFFECTIVE domain: explicit default first, else oldest active.
  // This is the exact value the campaign-detail route must also return, since
  // the preview uses it as its brand-level candidate.
  const brandDefault = flagged[0] ?? oldest[0] ?? null;

  // ONE ranking, shared with the preview.
  const winner = pickEffectiveShortDomain({
    phoneOverrideDomain: phoneOverride?.domain,
    brandDefaultDomain: brandDefault?.domain,
  });
  if (winner == null) return null;
  return winner === phoneOverride?.domain ? phoneOverride : brandDefault;
}
