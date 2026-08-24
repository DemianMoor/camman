import "server-only";

import { mintLink } from "@/lib/links/mint-link";
import { buildTrackedLinkUrl } from "@/lib/links/tracked-link";
import { buildLandingPageUrl } from "@/lib/landing-page-url";
import { resolveShortDomainForSend } from "@/lib/sends/resolve-short-domain";
import type { db } from "@/db/client";

// Per-lead link minting for drip sends (Drip Phase 5, ruling D).
//
// ⚠️ WHY THIS EXISTS. The scheduler used to render with `linkUrl:
// stage.short_url` -- a STATIC column that is NULL on a drip stage. The result
// was a real SMS whose copy ends in a colon and then simply stops, with
// stage_sends.link_id NULL: no /r/ redirect, no click, no Keitaro attribution.
// Drip is one lead at a time, so it mints one link per lead, which is also what
// makes per-recipient click attribution possible at all.
//
// ⚠️ FAIL CLOSED, PER LEAD. Every component -- landing page, brand landing host,
// short domain, both tracking IDs -- must resolve. If any does not, this returns
// a refusal and the caller SKIPS that lead; its journey stays 'routed' and the
// next tick retries once the configuration is fixed. Sending the message without
// its link is strictly worse than not sending it: the recipient gets a truncated
// ad, and the campaign gets an unattributable send it still paid for. This
// mirrors the opt-out gate's discipline exactly.
//
// ⚠️ NOTHING HERE IS A SECOND COPY OF A RULE. Destination construction is
// buildLandingPageUrl (shared with the stage editor's preview) and short-domain
// precedence is resolveShortDomainForSend (shared with kickoff and the
// verifier). Re-implementing either would let drip and blast send different URLs
// from the same configuration -- which is how the two in-use definitions drifted
// apart in Phase 4.

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DripMintRefusal =
  | "no_landing_page"
  | "brand_missing_landing_host"
  | "invalid_destination"
  | "no_short_domain"
  | "missing_tracking_id";

export type DripMintResult =
  | { ok: true; linkId: number; linkUrl: string; destinationUrl: string }
  | { ok: false; reason: DripMintRefusal; message: string };

export interface DripMintInput {
  orgId: string;
  campaignId: number;
  stageId: number;
  contactId: string;
  creativeId: number | null;
  brandId: number | null;
  providerPhoneId: number;
  /** Idempotency token for ONE outbound message; also the stage_sends row id. */
  sendToken: string;
  campaignTrackingId: string | null;
  stageTrackingId: string | null;
  brandLandingHost: string | null;
  /** The stage's stored full_url. Non-empty ⇒ hand-edited (the auto path stores
   *  NULL on a landing-page stage), so it wins over mint-time construction. */
  handEditedUrl?: string | null;
  landingPage: {
    id: number | null;
    kind: string | null;
    slug: string | null;
    external_url: string | null;
    status: string | null;
  };
}

/**
 * Resolve this lead's destination and mint its tracked link.
 *
 * Must be called with the same `tx` as the `stage_sends` insert, so a failure
 * anywhere in the message leaves no orphan link.
 */
export async function mintDripLeadLink(
  tx: DbOrTx,
  input: DripMintInput,
): Promise<DripMintResult> {
  const { landingPage: lp } = input;

  // ── 0. a hand-edited URL wins ─────────────────────────────────────────────
  // ⚠️ THE SAME RULE AS THE BLAST PATH (lib/sends/kickoff.ts). An operator who
  // appended &utm_source=... needs those params to reach the recipient;
  // reconstructing from the landing page would silently discard them and send a
  // URL nobody approved. Drip having a different rule from blasts here would be
  // indefensible -- it is the same field, edited on the same screen.
  //
  // Trusted only when it carries THIS stage's tracking id; otherwise fall
  // through to canonical construction rather than ship a broken destination.
  const handEdited = (input.handEditedUrl ?? "").trim();
  const tidForCheck = (input.stageTrackingId ?? "").trim();
  if (handEdited && tidForCheck && handEdited.includes(tidForCheck)) {
    const sd0 = await resolveShortDomainForSend(tx, {
      orgId: input.orgId, brandId: input.brandId, providerPhoneId: input.providerPhoneId,
    });
    if (!sd0) {
      return { ok: false, reason: "no_short_domain",
        message: "the campaign's brand has no active short domain for this number" };
    }
    const link0 = await mintLink(tx, {
      orgId: input.orgId, campaignId: input.campaignId, stageId: input.stageId,
      contactId: input.contactId, creativeId: input.creativeId, shortDomainId: sd0.id,
      destinationUrl: handEdited, sendToken: input.sendToken,
      campaignTrackingId: input.campaignTrackingId, stageTrackingId: input.stageTrackingId,
    });
    return { ok: true, linkId: link0.id,
             linkUrl: buildTrackedLinkUrl(sd0.domain, link0.code), destinationUrl: handEdited };
  }

  // ── 1. destination, built NOW from the campaign's CURRENT brand ───────────
  // Late construction is deliberate: a re-branded campaign self-corrects,
  // where a frozen absolute URL keeps pointing at the old brand's pages.
  if (lp.id == null || !lp.kind) {
    return {
      ok: false,
      reason: "no_landing_page",
      message:
        "the stage has no landing page, so no destination can be constructed " +
        "(a drip stage must carry one)",
    };
  }
  const built = buildLandingPageUrl({
    page: {
      id: lp.id,
      kind: lp.kind as "slug" | "external_url",
      slug: lp.slug,
      external_url: lp.external_url,
      status: lp.status ?? "active",
    },
    landingHost: input.brandLandingHost,
    trackingId: input.stageTrackingId,
    // /lp/ destinations take exactly one param (sub_id3); buildLandingPageUrl
    // drops tags there. Drip never supplies them.
    utmTags: null,
  });
  if (!built.ok) {
    return {
      ok: false,
      reason:
        built.reason === "brand_missing_landing_host"
          ? "brand_missing_landing_host"
          : "invalid_destination",
      message: built.message,
    };
  }

  // ── 2. tracking IDs — mintLink throws without both, so check first ────────
  // A throw here would abort the caller's transaction and lose the whole batch;
  // a refusal only skips this lead.
  if (!input.campaignTrackingId?.trim() || !input.stageTrackingId?.trim()) {
    return {
      ok: false,
      reason: "missing_tracking_id",
      message:
        "campaign or stage tracking ID is missing, so the link could not carry " +
        "attribution (the stage needs a creative and the campaign a brand+offer)",
    };
  }

  // ── 3. short domain — the ONE shared resolver ─────────────────────────────
  const sd = await resolveShortDomainForSend(tx, {
    orgId: input.orgId,
    brandId: input.brandId,
    providerPhoneId: input.providerPhoneId,
  });
  if (!sd) {
    return {
      ok: false,
      reason: "no_short_domain",
      message:
        "the campaign's brand has no active short domain for this number, so a " +
        "tracked link cannot be minted",
    };
  }

  // ── 4. mint ───────────────────────────────────────────────────────────────
  const link = await mintLink(tx, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    stageId: input.stageId,
    contactId: input.contactId,
    creativeId: input.creativeId,
    shortDomainId: sd.id,
    destinationUrl: built.url,
    sendToken: input.sendToken,
    campaignTrackingId: input.campaignTrackingId,
    stageTrackingId: input.stageTrackingId,
  });

  return {
    ok: true,
    linkId: link.id,
    linkUrl: buildTrackedLinkUrl(sd.domain, link.code),
    destinationUrl: built.url,
  };
}
