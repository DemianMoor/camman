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
import { formatStamp, requiredTags, type MessageShape } from "@/lib/messages/render";
import { TAGS } from "@/lib/messages/tags";
import { notifyTelegram } from "@/lib/alerts/telegram";

type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * ONE statement per batch. The existing-skip set is read once (hashed NOT IN
 * over the stage's skip rows), not once per lead: a per-lead NOT EXISTS could
 * only use stage_sends_stage_id_idx, so a tagged stage that had already sent
 * 10K rows cost ~2M index visits per scheduler tick.
 * Arrays go in as ONE '{…}' literal each (a JS array interpolated into a
 * Drizzle sql template flattens into positional params).
 */
export async function insertSkippedSends(
  tx: DripTx,
  row: {
    orgId: string;
    campaignId: number;
    stageId: number;
    reason: string;
    renderedText: string;
    messageFormatId: number | null;
    formatCustom: boolean;
    leads: { contact_id: string; phone: string }[];
  },
): Promise<number> {
  if (row.leads.length === 0) return 0;
  const ids = `{${row.leads.map((l) => l.contact_id).join(",")}}`;
  // Phones are E.164; strip any quote/backslash so the array literal can't break.
  const phones = `{${row.leads.map((l) => `"${l.phone.replace(/["\\]/g, "")}"`).join(",")}}`;
  const ins = (await tx.execute(sql`
    INSERT INTO stage_sends
      (id, org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, last_error,
       message_format_id, format_custom)
    SELECT gen_random_uuid(), ${row.orgId}::uuid, ${row.campaignId}, ${row.stageId}, l.contact_id,
           l.phone, ${row.renderedText}, 'skipped_ineligible', ${row.reason},
           ${row.messageFormatId}, ${row.formatCustom}
    FROM unnest(${ids}::uuid[], ${phones}::text[]) AS l(contact_id, phone)
    WHERE l.contact_id NOT IN (
      SELECT ss.contact_id FROM stage_sends ss
      WHERE ss.stage_id = ${row.stageId} AND ss.status = 'skipped_ineligible'
        AND ss.last_error = ${row.reason} AND ss.contact_id IS NOT NULL
    )
    RETURNING id
  `)) as unknown as { id: string }[];
  return ins.length;
}

/**
 * 0216 INTERIM (P2 → P5): per-recipient tag rendering is not built yet, so a
 * drip message that needs CONTACT data ({first_name} {zip} {state}) is never
 * sent, and neither is a {brand} message whose campaign has no brand. Returns
 * null when the message can render (send normally); otherwise writes ONE
 * skipped_ineligible row per lead — reason `tags_not_supported_yet` or
 * `missing_brand`, idempotent — and returns the reason and how many rows were
 * NEW (only new rows are alerted: see tallySkip / notifyDripSkips). Journeys are NOT
 * touched: a first send stays routed and goes out once the message is fixed.
 * Both drip producers call this BEFORE minting (scripts/test-format-interim.ts).
 */
export async function skipIfTagged(
  tx: DripTx,
  i: {
    orgId: string;
    campaignId: number;
    stageId: number;
    creativeText: string;
    shape: MessageShape;
    /** The campaign's brand name ({brand} renders from it). */
    brandName: string;
    leads: { contact_id: string; phone: string }[];
  },
): Promise<{ reason: string; written: number } | null> {
  const tags = requiredTags({ shape: i.shape, creativeText: i.creativeText });
  const reason = tags.some((t) => TAGS[t].scope === "contact")
    ? "tags_not_supported_yet"
    : tags.includes("brand") && TAGS.brand.normalize(i.brandName) === null
      ? "missing_brand"
      : null;
  if (reason === null) return null;
  const written = await insertSkippedSends(tx, {
    orgId: i.orgId, campaignId: i.campaignId, stageId: i.stageId, reason,
    renderedText: i.creativeText, ...formatStamp(i.shape), leads: i.leads,
  });
  return { reason, written };
}

/** Per-tick tally of NEWLY written skip rows, by stage. */
export type DripSkipTally = Map<number, { campaignName: string; reason: string; leads: number }>;

export function tallySkip(
  t: DripSkipTally,
  i: { stageId: number; campaignName: string; result: { reason: string; written: number } | null },
): void {
  if (!i.result || i.result.written === 0) return;
  const cur = t.get(i.stageId);
  if (cur) cur.leads += i.result.written;
  else t.set(i.stageId, { campaignName: i.campaignName, reason: i.result.reason, leads: i.result.written });
}

/**
 * ONE Telegram per stage per tick, counting only leads skipped for the FIRST
 * time — a (stage, lead) is therefore alerted exactly once, never every tick
 * (owner ruling 2026-10-19). Clears the tally. Returns alerts sent.
 */
export async function notifyDripSkips(t: DripSkipTally): Promise<number> {
  let sent = 0;
  for (const [stageId, s] of t) {
    const why = s.reason === "missing_brand"
      ? "uses {brand} but the campaign has no brand"
      : "uses personalization tags ({first_name}/{zip}/{state}) that can't be sent yet";
    await notifyTelegram(
      `⚠️ Drip: ${s.leads} lead${s.leads === 1 ? "" : "s"} not sent on campaign "${s.campaignName}" · stage id ${stageId} — the message ${why}. ` +
        `They wait (first sends) or are skipped (follow-ups) until the message is fixed; each lead is reported once.`,
    ).catch(() => false);
    sent++;
  }
  t.clear();
  return sent;
}
