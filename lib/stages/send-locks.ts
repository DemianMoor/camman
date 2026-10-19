// Locks that apply once a stage has SENT (status='sent' on stage_sends — the one
// shared definition of "was messaged").
//   • drip creative (spec A9): a sent drip stage keeps its creative; the exposure
//     ledger reads campaign_stages.creative_id at send time, so a swap would
//     re-attribute pending rows to the new creative.
//   • message format (spec R4): see decideStageFormatChange.

import { sql } from "drizzle-orm";
import type { db } from "@/db/client";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function stageHasSent(dbc: DbOrTx, stageId: number): Promise<boolean> {
  const r = (await dbc.execute(sql`
    SELECT EXISTS (SELECT 1 FROM stage_sends WHERE stage_id = ${stageId} AND status = 'sent') AS sent
  `)) as unknown as { sent: boolean }[];
  return r[0]?.sent === true;
}

export const CREATIVE_LOCKED_TEXT = "Create a new stage to use another creative";

/** PURE. The form echoes creative_id, so only a DIFFERENT value is a change. */
export function decideCreativeChange(i: {
  isDrip: boolean;
  currentCreativeId: number | null;
  inputCreativeId: number | null | undefined;
  hasSent: boolean;
}): { ok: true } | { ok: false; reason: "creative_locked_after_send"; message: string } {
  if (!i.isDrip || !i.hasSent || i.inputCreativeId === undefined || i.inputCreativeId === i.currentCreativeId) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "creative_locked_after_send",
    message: `This drip stage has already sent, so its creative is locked. ${CREATIVE_LOCKED_TEXT}.`,
  };
}
