// P5: per-lead personalization for the two drip producers (the first-send
// scheduler and the follow-ups). Spec "P5 owner rules":
//   • a lead lacking a tag the message needs, or whose personalized body would
//     exceed its segment allowance, is SKIPPED: one skipped_ineligible row
//     (last_error = missing_tag:<tag> / segment_limit, rendered_text = the
//     attempted body with the missing tag left literal);
//   • a FIRST-SEND skip also closes the journey `exited` with the same
//     close_reason, in the same transaction; a FOLLOW-UP skip writes the row only;
//   • the segment check applies to PERSONALIZED bodies only — drip never checked
//     segments, and a tag-less body must ship exactly as before.
import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  checkRecipientBody,
  renderAttempted,
  renderMessage,
  requiredContactTags,
  type RenderInput,
} from "@/lib/messages/render";
import { MAX_SEGMENTS } from "@/lib/sends/segments";
import { insertSkippedSends } from "./skip-send";

type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DripRenderOutcome =
  | { ok: true; body: string }
  | { ok: false; reason: string; attempted: string };

/** PURE. One lead's body, or why it cannot be sent. */
export function renderDripBody(i: RenderInput & { allowMultiSegment: boolean }): DripRenderOutcome {
  const r = renderMessage(i);
  if (!r.ok) return { ok: false, reason: `missing_tag:${r.tag}`, attempted: renderAttempted(i) };
  if (
    requiredContactTags(i).length > 0 &&
    !checkRecipientBody(r.body, i.allowMultiSegment ? MAX_SEGMENTS : 1).ok
  ) {
    return { ok: false, reason: "segment_limit", attempted: r.body };
  }
  return { ok: true, body: r.body };
}

/** Thrown inside a producer's send transaction so the minted link rolls back. */
export class DripTagSkip extends Error {
  constructor(
    readonly reason: string,
    readonly attempted: string,
  ) {
    super(reason);
  }
}

/**
 * The skip row (idempotent per stage/contact/reason) and — for a FIRST send —
 * the journey closed `exited` in the same transaction. Returns rows written.
 */
export async function recordDripTagSkip(
  tx: DripTx,
  i: {
    orgId: string;
    campaignId: number;
    stageId: number;
    lead: { contact_id: string; phone: string };
    reason: string;
    renderedText: string;
    stamp: { messageFormatId: number | null; formatCustom: boolean };
    /** The journey to close on a FIRST-send skip; null for a follow-up. REQUIRED. */
    exitJourneyId: string | null;
  },
): Promise<number> {
  const written = await insertSkippedSends(tx, {
    orgId: i.orgId,
    campaignId: i.campaignId,
    stageId: i.stageId,
    reason: i.reason,
    renderedText: i.renderedText,
    messageFormatId: i.stamp.messageFormatId,
    formatCustom: i.stamp.formatCustom,
    leads: [i.lead],
  });
  if (i.exitJourneyId != null) {
    await tx.execute(sql`
      UPDATE drip_journeys
      SET state = 'exited', closed_at = now(), close_reason = ${i.reason}
      WHERE id = ${i.exitJourneyId}::uuid AND org_id = ${i.orgId}::uuid
        AND state = 'routed' AND first_send_at IS NULL
    `);
  }
  return written;
}
