import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  ahoiDlrRejectSpikeThreshold,
  ahoiDlrRejectWindowSeconds,
  countAhoiDlrRejectsSince,
  latchPause,
} from "@/lib/sends/circuit-breakers";
import type { DlrEvent } from "@/lib/sends/providers/types";

// Any drizzle executor — the top-level client or a transaction handle. Same
// shape as kickoff.ts's DbOrTx (not imported from there to avoid an odd
// cross-module dependency for a one-line type alias).
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CaptureAhoiDlrOpts {
  orgId: string;
  credentialId: number;
  providerId: number;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string | null;
  // Raw source/destination for archival — DlrEvent doesn't carry these (that
  // type only holds what reconcile needs), so the route extracts them
  // separately via extractAhoiWebhookFields and passes them here.
  fields: Record<string, string>;
  parsed: DlrEvent | null;
}

// Append-only raw+parsed capture. Never throws on a malformed/unparseable
// payload — parsed may be null (e.g. no uuid), in which case only the raw
// archival columns + fields.source/destination land; result/processed_at/
// matched_stage_send_id stay NULL until reconcileAhoiDlrEvent runs (Task 5).
export async function captureAhoiDlrEvent(
  dbc: DbOrTx,
  o: CaptureAhoiDlrOpts,
): Promise<{ id: string }> {
  const rows = (await dbc.execute(sql`
    INSERT INTO ahoi_dlr_events
      (org_id, credential_id, provider_id, method, query, headers, raw_body,
       provider_uuid, source, destination, send_status, status, smpp_status, smpp_code, error)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, ${o.method},
            ${JSON.stringify(o.query)}::jsonb, ${JSON.stringify(o.headers)}::jsonb, ${o.rawBody},
            ${o.parsed?.providerUuid ?? null}, ${o.fields.source ?? null}, ${o.fields.destination ?? null},
            ${o.parsed?.sendStatus ?? null}, ${o.parsed?.status ?? null},
            ${o.parsed?.smppStatus ?? null}, ${o.parsed?.smppCode ?? null}, ${o.parsed?.error ?? null})
    RETURNING id
  `)) as unknown as { id: string }[];
  return { id: rows[0].id };
}

export interface ReconcileAhoiDlrOpts {
  eventId: string;
  orgId: string;
  providerId: number;
  providerUuid: string;
  sendStatus: string;
}

export interface ReconcileAhoiDlrResult {
  result: "matched" | "unmatched";
  matchedStageSendId: string | null;
  pausedNow: boolean;
}

// Match a DLR's uuid to the send it belongs to, then feed the derived
// reject-rate breaker signal. NAMING DEBT (G2, carried from Section 2): the
// match is against stage_sends.texthub_message_id, which is named after
// TextHub but ALSO holds Ahoi's send-time uuid (Section 2's drain stores
// whatever messageId the adapter returns into that same column) — not
// renamed here; a cross-provider rename is a bigger migration than this
// section's scope. Multi-segment sends emit EXTRA DLRs under numeric-only
// uuids that never match a send-time `s-…` uuid (Phase 0 recon) — that is
// EXPECTED and lands as result='unmatched', not an error.
export async function reconcileAhoiDlrEvent(
  dbc: DbOrTx,
  o: ReconcileAhoiDlrOpts,
): Promise<ReconcileAhoiDlrResult> {
  const match = (await dbc.execute(sql`
    SELECT id FROM stage_sends WHERE texthub_message_id = ${o.providerUuid} AND org_id = ${o.orgId} LIMIT 1
  `)) as unknown as { id: string }[];
  const matchedStageSendId = match[0]?.id ?? null;
  const result: "matched" | "unmatched" = matchedStageSendId ? "matched" : "unmatched";

  await dbc.execute(sql`
    UPDATE ahoi_dlr_events
    SET matched_stage_send_id = ${matchedStageSendId}, result = ${result}, processed_at = now()
    WHERE id = ${o.eventId}
  `);

  let pausedNow = false;
  if (o.sendStatus === "rejected") {
    // Derived signal (a), spec §5: reject-rate -> circuit breaker. Counts ONLY
    // ahoi_dlr_events rows (not send_attempts / stage_sends) — structurally
    // disjoint from the drain's send-time failure-spike breaker, so the same
    // failure can never be counted by both (see the composition test).
    const windowSec = ahoiDlrRejectWindowSeconds();
    const n = await countAhoiDlrRejectsSince(dbc, o.providerId, windowSec);
    if (n >= ahoiDlrRejectSpikeThreshold()) {
      pausedNow = await latchPause(dbc, {
        providerId: o.providerId,
        orgId: o.orgId,
        reason: `dlr_reject_spike: ${n} rejected DLRs in ${windowSec}s`,
      });
    }
  } else if (o.sendStatus && o.sendStatus !== "carrier_sent" && o.sendStatus !== "delivered") {
    // G4: any send_status outside the three known values gets a DISTINCT log
    // line so a real opt-out-error signature (O1, unconfirmed) is spottable
    // in production the first time it appears — never auto-classified here.
    console.warn(
      `[ahoi-dlr] unmapped send_status="${o.sendStatus}" (uuid=${o.providerUuid}) — logged for triage, not auto-classified as opt-out (that's Section 4's job)`,
    );
  }

  return { result, matchedStageSendId, pausedNow };
}
