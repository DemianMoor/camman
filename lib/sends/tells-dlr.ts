import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/textrequest-dlr";

// Tells DLR reconcile (Phase 3). Mirrors reconcileTxrDlrEvent, with the same
// two-step match: a DIRECT id first, then the provider message id as fallback.
//
// The direct id comes from the echoed `metadata` (`{stage_send_id}`) that the
// drain sets on every send — Tells carries no callback URL and no `?ss=`, so
// unlike Text Request there is no path-embedded handle, and `metadata` is the
// only direct route. Its casing trap is handled at extraction (§5.1).
//
// The fallback compares against stage_sends.texthub_message_id, which is the
// historically-named column holding whichever provider's send-time id applies
// (see the NAMING DEBT note in docs/03-data-model.md). Tells's `Id` is a STRING
// on the send response and a NUMBER on the webhook — both are coerced to text
// before they reach here, or this comparison would never match.

export interface ReconcileTellsDlrOpts {
  eventId: string;
  orgId: string;
  stageSendId: string | null;   // from metadata
  providerMessageId: string | null;
}

export interface ReconcileTellsDlrResult {
  result: "matched" | "unmatched";
  matchedStageSendId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reconcileTellsDlrEvent(
  dbc: DbOrTx,
  o: ReconcileTellsDlrOpts,
): Promise<ReconcileTellsDlrResult> {
  let matchedStageSendId: string | null = null;

  // metadata is attacker-influenceable in principle (it round-trips through a
  // third party), so it is shape-checked before being cast to uuid — a bad
  // value must produce "unmatched", never a SQL cast error that would fail the
  // whole sweep. The org_id filter is what actually makes it safe.
  if (o.stageSendId && UUID_RE.test(o.stageSendId)) {
    const m = (await dbc.execute(sql`
      SELECT id FROM stage_sends WHERE id = ${o.stageSendId}::uuid AND org_id = ${o.orgId} LIMIT 1
    `)) as unknown as { id: string }[];
    matchedStageSendId = m[0]?.id ?? null;
  }
  if (!matchedStageSendId && o.providerMessageId) {
    const m = (await dbc.execute(sql`
      SELECT id FROM stage_sends
      WHERE texthub_message_id = ${o.providerMessageId} AND org_id = ${o.orgId} LIMIT 1
    `)) as unknown as { id: string }[];
    matchedStageSendId = m[0]?.id ?? null;
  }

  const result: "matched" | "unmatched" = matchedStageSendId ? "matched" : "unmatched";
  await dbc.execute(sql`
    UPDATE tells_webhook_events
    SET matched_stage_send_id = ${matchedStageSendId ? sql`${matchedStageSendId}::uuid` : sql`NULL`},
        result = ${result},
        processed_at = now(),
        process_attempts = process_attempts + 1
    WHERE id = ${o.eventId} AND org_id = ${o.orgId}
  `);
  return { result, matchedStageSendId };
}
