import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bodyCarriesStop,
  optOutGateSubject,
  type ResolvedOptOutFooter,
} from "@/lib/sends/opt-out-footer";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { mintDripLeadLink } from "./mint";

type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ONE drip send — mint, render, gate, insert, stamp (Drip Phase 6).
//
// ⚠️ THIS EXISTS SO THE OPT-OUT GATE HAS EXACTLY ONE IMPLEMENTATION.
// Phase 6 adds a second producer of drip sends (behavioural follow-ups) beside
// the first-send scheduler. Two copies of a compliance gate is how the two
// in-use definitions drifted apart in Phase 4, and this gate decides whether a
// message carrying no opt-out language goes out. One function, two callers.
//
// ⚠️ ONE TRANSACTION covers all of it. The body cannot be built before the link
// code exists, and the gate must judge the text that will ACTUALLY ship — so a
// refusal has to roll back the mint too, or a refused message leaves an orphan
// link behind.

export class MintRefused extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
export class GateRefused extends Error {}

export interface DripSendInput {
  orgId: string;
  campaignId: number;
  stageId: number;
  contactId: string;
  phone: string;
  creativeId: number | null;
  creativeText: string;
  brandName: string;
  brandId: number | null;
  brandLandingHost: string | null;
  /** Stage's stored full_url; non-empty ⇒ hand-edited, wins over construction. */
  handEditedUrl?: string | null;
  campaignTrackingId: string | null;
  stageTrackingId: string | null;
  providerPhoneId: number;
  adapterCode: string | null;
  footer: ResolvedOptOutFooter;
  landingPage: {
    id: number | null;
    kind: string | null;
    slug: string | null;
    external_url: string | null;
    status: string | null;
  };
}

export interface DripSendResult {
  sendId: string;
  linkId: number;
  body: string;
}

/**
 * Mint this lead's link, render around it, gate the final text, and insert the
 * `stage_sends` row. Throws `MintRefused` / `GateRefused` so the caller can skip
 * ONE lead without losing the batch.
 *
 * The caller supplies the transaction, so the send row, the link and any journey
 * bookkeeping commit or roll back together.
 */
export async function dispatchDripSend(
  tx: DripTx,
  input: DripSendInput,
): Promise<DripSendResult> {
  const sendToken = randomUUID();

  const minted = await mintDripLeadLink(tx, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    stageId: input.stageId,
    contactId: input.contactId,
    creativeId: input.creativeId,
    brandId: input.brandId,
    providerPhoneId: input.providerPhoneId,
    sendToken,
    campaignTrackingId: input.campaignTrackingId,
    stageTrackingId: input.stageTrackingId,
    brandLandingHost: input.brandLandingHost,
    handEditedUrl: input.handEditedUrl,
    landingPage: input.landingPage,
  });
  // ⚠️ FAIL CLOSED. No link ⇒ no send: the creative's copy ends expecting a URL,
  // and a send with no link_id is unattributable — worse than silence.
  if (!minted.ok) throw new MintRefused(minted.reason, minted.message);

  const body = buildStageSms({
    brandName: input.brandName,
    creativeText: input.creativeText,
    linkUrl: minted.linkUrl,
    stopText: input.footer.text,
  });

  const descriptor = input.adapterCode ? getDescriptor(input.adapterCode) : null;
  const gate = optOutGateSubject({
    renderedBody: body,
    resolved: input.footer,
    providerKnownAppendedText: descriptor?.defaultOptOutFooter ?? null,
  });
  if (!gate.verifiable || (!bodyCarriesStop(gate.subject) && input.adapterCode === "txr")) {
    throw new GateRefused(
      !gate.verifiable ? "footer unverifiable" : "no STOP in rendered body",
    );
  }

  const ins = (await tx.execute(sql`
    INSERT INTO stage_sends
      (id, org_id, campaign_id, stage_id, contact_id, phone, provider_phone_id,
       link_id, rendered_text, status, created_at)
    VALUES (${sendToken}::uuid, ${input.orgId}::uuid, ${input.campaignId}, ${input.stageId},
            ${input.contactId}::uuid, ${input.phone}, ${input.providerPhoneId},
            ${minted.linkId}, ${body}, 'pending', now())
    RETURNING id
  `)) as unknown as { id: string }[];

  // The stage must be drainable or the row sits 'pending' for ever. Idempotent,
  // and refuses any stage whose drip_active is not TRUE.
  const { stampDripStageDrainable } = await import("./scheduler");
  await stampDripStageDrainable(tx, { stageId: input.stageId, orgId: input.orgId });

  return { sendId: ins[0].id, linkId: minted.linkId, body };
}
