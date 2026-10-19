// A drip send that is decided NOT to happen, recorded as a stage_sends row with
// status 'skipped_ineligible' and the reason in last_error (the 0190 vocabulary).
// The exposure trigger fires only on 'sent' and cost / caps count only
// sent/sending/pending, so a skip row costs nothing and exposes nothing.
//
// IDEMPOTENT per (stage, contact, reason): a first send skipped without closing
// its journey is re-selected every scheduler tick, and must not leave a row per
// tick. A follow-up stops being re-selected once any row exists (already_sent).

import { sql } from "drizzle-orm";
import type { db } from "@/db/client";
import { formatStamp, requiredContactTags, type MessageShape } from "@/lib/messages/render";

type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertSkippedSend(
  tx: DripTx,
  row: {
    orgId: string;
    campaignId: number;
    stageId: number;
    contactId: string;
    phone: string;
    reason: string;
    renderedText: string;
    messageFormatId: number | null;
    formatCustom: boolean;
  },
): Promise<number> {
  const ins = (await tx.execute(sql`
    INSERT INTO stage_sends
      (id, org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, last_error,
       message_format_id, format_custom)
    SELECT gen_random_uuid(), ${row.orgId}::uuid, ${row.campaignId}, ${row.stageId}, ${row.contactId}::uuid,
           ${row.phone}, ${row.renderedText}, 'skipped_ineligible', ${row.reason},
           ${row.messageFormatId}, ${row.formatCustom}
    WHERE NOT EXISTS (
      SELECT 1 FROM stage_sends
      WHERE stage_id = ${row.stageId} AND contact_id = ${row.contactId}::uuid
        AND status = 'skipped_ineligible' AND last_error = ${row.reason}
    )
    RETURNING id
  `)) as unknown as { id: string }[];
  return ins.length;
}

/**
 * 0216 INTERIM (P2 → P5): per-recipient tag rendering is not built yet, so a
 * drip message that uses a tag is never sent. Returns null when the message has
 * no tag (send normally); otherwise writes ONE skipped_ineligible row per lead
 * (reason `tags_not_supported_yet`, idempotent) and returns how many were new.
 * Journeys are NOT touched — a first send stays routed and goes out once the tag
 * is removed. Both drip producers call this BEFORE minting
 * (scripts/test-format-interim.ts pins the call order).
 */
export async function skipIfTagged(
  tx: DripTx,
  i: {
    orgId: string;
    campaignId: number;
    stageId: number;
    creativeText: string;
    shape: MessageShape;
    leads: { contact_id: string; phone: string }[];
  },
): Promise<number | null> {
  // {brand} is campaign data and renders now; only contact tags are held back.
  if (requiredContactTags({ shape: i.shape, creativeText: i.creativeText }).length === 0) return null;
  let written = 0;
  for (const lead of i.leads) {
    written += await insertSkippedSend(tx, {
      orgId: i.orgId, campaignId: i.campaignId, stageId: i.stageId, contactId: lead.contact_id,
      phone: lead.phone, reason: "tags_not_supported_yet", renderedText: i.creativeText, ...formatStamp(i.shape),
    });
  }
  return written;
}
