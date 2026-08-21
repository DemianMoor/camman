import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { brands, provider_phones } from "@/db/schema";

// Brand → sending-number enforcement (Drip Phase 1, item 1a).
//
// THE RULE: a stage's `provider_phone_id`, and a campaign's
// `default_provider_phone_id`, must be a number registered to THAT CAMPAIGN'S
// BRAND. A Guide Kin campaign may not send from a LumZen number.
//
// ⚠️ ENFORCED ON WRITE ONLY — never on send, and never as a DB constraint.
// This is deliberate and was an explicit product ruling (2026-08-21): 16
// existing stages already pair phone 114 (+18449903688, brand LumZen) with
// campaigns of both brands, three of them carrying 33,578 materialized
// `stage_sends` rows scheduled to dispatch. Blocking at send time would strand
// real messages; a DB CHECK would make those rows unwritable and break
// unrelated edits. The audience for this rule is the operator choosing a
// number, not the drain.
//
// GRANDFATHERING: callers on UPDATE paths must only invoke this when the pair
// is actually CHANGING (see `pairIsChanging`). An existing mismatched stage or
// campaign stays editable — you can rename it, re-schedule it, change its
// creative — as long as you do not touch the brand or the number. Re-validating
// an untouched legacy pair would turn a targeted rule into a blanket edit-lock
// on four active campaigns.
//
// ABSENT = ALLOWED, twice over, mirroring the per-number carrier policy
// (lib/sends/carrier-policy.ts):
//   • no number chosen            ⇒ nothing to check
//   • campaign has no brand yet   ⇒ nothing to match against (drafts are saved
//                                   with zero required fields; the draft→active
//                                   transition is what requires a brand)
//   • the NUMBER has no brand     ⇒ treated as shared / usable by any brand
// The last one is inert today (all 37 active numbers carry a brand_id) but is
// the forward-compatible reading: a NULL brand on a number must never mean
// "matches nothing", which would mute the number entirely.

export const PHONE_BRAND_MISMATCH_CODE = "phone_brand_mismatch";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PhoneBrandMismatch {
  /** Operator-facing message naming BOTH brands and the number. */
  message: string;
  phoneNumber: string;
  phoneBrandId: number | null;
  phoneBrandName: string | null;
  campaignBrandId: number;
  campaignBrandName: string | null;
}

/**
 * Returns `null` when the pairing is allowed, or a describable mismatch.
 *
 * Does NOT check org ownership of the phone — every caller already does that
 * immediately above (the pre-existing "doesn't belong to your organization"
 * guard), and duplicating it here would mean a second query on every write.
 */
export async function checkPhoneBrandMatch(
  dbc: DbOrTx,
  {
    orgId,
    providerPhoneId,
    campaignBrandId,
  }: {
    orgId: string;
    providerPhoneId: number | null | undefined;
    campaignBrandId: number | null | undefined;
  },
): Promise<PhoneBrandMismatch | null> {
  if (providerPhoneId == null) return null;
  if (campaignBrandId == null) return null;

  const rows = await dbc
    .select({
      phone_number: provider_phones.phone_number,
      phone_brand_id: provider_phones.brand_id,
      phone_brand_name: brands.name,
    })
    .from(provider_phones)
    .leftJoin(brands, eq(brands.id, provider_phones.brand_id))
    .where(
      and(eq(provider_phones.id, providerPhoneId), eq(provider_phones.org_id, orgId)),
    )
    .limit(1);

  const row = rows[0];
  // Phone not found / not this org: the caller's ownership guard owns that
  // error. Nothing to say here.
  if (!row) return null;
  // Shared number — allowed for any brand. See "ABSENT = ALLOWED" above.
  if (row.phone_brand_id == null) return null;
  if (row.phone_brand_id === campaignBrandId) return null;

  const campaignBrand = await dbc
    .select({ name: brands.name })
    .from(brands)
    .where(and(eq(brands.id, campaignBrandId), eq(brands.org_id, orgId)))
    .limit(1);
  const campaignBrandName = campaignBrand[0]?.name ?? null;

  return {
    message:
      `Number ${row.phone_number} is registered to ` +
      `${row.phone_brand_name ?? `brand ${row.phone_brand_id}`}, but this campaign's brand is ` +
      `${campaignBrandName ?? `brand ${campaignBrandId}`}. ` +
      `Choose a number registered to ${campaignBrandName ?? "this campaign's brand"}.`,
    phoneNumber: row.phone_number,
    phoneBrandId: row.phone_brand_id,
    phoneBrandName: row.phone_brand_name,
    campaignBrandId,
    campaignBrandName,
  };
}

/**
 * Is an UPDATE actually changing the (brand, number) pair?
 *
 * `undefined` means "absent from the patch" and is NOT a change; an explicit
 * `null` IS (clearing the number, or clearing the brand). This is the whole
 * grandfathering mechanism — see the note at the top of the file.
 */
export function pairIsChanging({
  nextPhoneId,
  currentPhoneId,
  nextBrandId,
  currentBrandId,
}: {
  nextPhoneId: number | null | undefined;
  currentPhoneId: number | null;
  nextBrandId: number | null | undefined;
  currentBrandId: number | null;
}): boolean {
  const phoneChanged = nextPhoneId !== undefined && nextPhoneId !== currentPhoneId;
  const brandChanged = nextBrandId !== undefined && nextBrandId !== currentBrandId;
  return phoneChanged || brandChanged;
}
