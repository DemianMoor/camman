import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Text Request DLR (per-message status_callback) capture + reconcile. TR POSTs
// a JSON body { message_id, status, errorCode } to the per-message callback URL
// the drain set at send time, whose path carries the org/provider token and
// whose ?ss=<stage_send_id> query gives the send DIRECTLY — so reconcile is a
// direct id lookup, not Ahoi's uuid-guessing. Mirrors lib/sends/ahoi-dlr.ts's
// capture+reconcile-in-one-request shape.

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// TR delivery statuses (spec §1): accepted|queued|sending|error|sent|failed|
// undelivered|delivered. These three are terminal failures (the DLR-failure
// signal, analogous to Ahoi's `rejected`).
export const TXR_FAILURE_STATUSES: ReadonlySet<string> = new Set(["error", "failed", "undelivered"]);
// errorCodes that mean the recipient is opted out (spec §1): 2100 (status
// webhook), 30050 (conversation). Drives opt-out intake in Phase 4.
export const TXR_OPTOUT_ERROR_CODES: ReadonlySet<string> = new Set(["2100", "30050"]);

export interface TxrStatusCallback {
  messageId: string | null;
  status: string | null;
  errorCode: string | null;
}

// Pure parser for TR's JSON status_callback body. Tolerant: a non-JSON or
// shapeless body yields all-null (still captured verbatim by the route).
export function parseTxrStatusCallback(rawBody: string | null): TxrStatusCallback {
  if (!rawBody) return { messageId: null, status: null, errorCode: null };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { messageId: null, status: null, errorCode: null };
  }
  const messageId =
    typeof j.message_id === "string" || typeof j.message_id === "number" ? String(j.message_id) : null;
  const status = typeof j.status === "string" ? j.status.trim().toLowerCase() : null;
  const errorCode =
    typeof j.errorCode === "string" || typeof j.errorCode === "number" ? String(j.errorCode) : null;
  return { messageId, status, errorCode };
}

export interface CaptureTxrDlrOpts {
  orgId: string;
  credentialId: number;
  providerId: number;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string | null;
  stageSendId: string | null; // from the ?ss= query param
  parsed: TxrStatusCallback;
}

// Shared INSERT for both capture entry points below, so the column list can
// never drift between the webhook and poll channels. `conflict` is appended
// verbatim (empty for the webhook path, an ON CONFLICT DO NOTHING for the poll).
function insertTxrDlrEvent(dbc: DbOrTx, o: CaptureTxrDlrOpts, conflict: ReturnType<typeof sql>) {
  return dbc.execute(sql`
    INSERT INTO textrequest_dlr_events
      (org_id, credential_id, provider_id, method, query, headers, raw_body,
       message_id, status, error_code, stage_send_id)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, ${o.method},
            ${JSON.stringify(o.query)}::jsonb, ${JSON.stringify(o.headers)}::jsonb, ${o.rawBody},
            ${o.parsed.messageId}, ${o.parsed.status}, ${o.parsed.errorCode},
            ${o.stageSendId ? sql`${o.stageSendId}::uuid` : sql`NULL`})
    ${conflict}
    RETURNING id
  `) as unknown as Promise<{ id: string }[]>;
}

// Append-only raw+parsed capture (webhook channel). Never throws on a malformed
// payload. Deliberately UNCONSTRAINED: TR may POST several callbacks for one
// message as it transitions states, and every one is a legitimate row.
export async function captureTxrDlrEvent(dbc: DbOrTx, o: CaptureTxrDlrOpts): Promise<{ id: string }> {
  const rows = await insertTxrDlrEvent(dbc, o, sql``);
  return { id: rows[0].id };
}

// Poll channel (Phase 3b, method='poll'): the SAME message re-appears in every
// messages-poll tick whose window covers it, so capture must be idempotent or
// the table grows by one duplicate row per message per tick. Keyed on
// (provider_id, message_id, status) among method='poll' rows only — the partial
// unique index from migration 0123 — so a genuine state CHANGE (sent ->
// delivered) still lands as its own row while a re-read of the same state is
// dropped. Returns null when the row already existed (caller counts it as a
// dupe and skips reconcile).
//
// Callers MUST NOT pass a null parsed.status here: NULLs are distinct in a
// Postgres unique index, so a null-status row would defeat the dedup and insert
// every tick. The poll filters those out before calling (a message with no
// delivery status carries no DLR information to reconcile anyway).
export async function captureTxrPollDlrEvent(
  dbc: DbOrTx,
  o: CaptureTxrDlrOpts,
): Promise<{ id: string } | null> {
  const rows = await insertTxrDlrEvent(
    dbc,
    o,
    sql`ON CONFLICT (provider_id, message_id, status) WHERE method = 'poll' DO NOTHING`,
  );
  return rows[0] ? { id: rows[0].id } : null;
}

export interface ReconcileTxrDlrOpts {
  eventId: string;
  orgId: string;
  stageSendId: string | null; // ?ss= — direct key
  messageId: string | null; // fallback key
}

export interface ReconcileTxrDlrResult {
  result: "matched" | "unmatched";
  matchedStageSendId: string | null;
}

// Resolve the DLR to its send. Prefer the ?ss= stage_send_id from the URL (TR's
// direct advantage), validating it belongs to this org; fall back to
// message_id -> stage_sends.texthub_message_id (where the send-time GUID lands,
// same column Ahoi reuses). Then stamp the event row.
export async function reconcileTxrDlrEvent(dbc: DbOrTx, o: ReconcileTxrDlrOpts): Promise<ReconcileTxrDlrResult> {
  let matchedStageSendId: string | null = null;
  if (o.stageSendId) {
    const m = (await dbc.execute(sql`
      SELECT id FROM stage_sends WHERE id = ${o.stageSendId}::uuid AND org_id = ${o.orgId} LIMIT 1
    `)) as unknown as { id: string }[];
    matchedStageSendId = m[0]?.id ?? null;
  }
  if (!matchedStageSendId && o.messageId) {
    const m = (await dbc.execute(sql`
      SELECT id FROM stage_sends WHERE texthub_message_id = ${o.messageId} AND org_id = ${o.orgId} LIMIT 1
    `)) as unknown as { id: string }[];
    matchedStageSendId = m[0]?.id ?? null;
  }
  const result: "matched" | "unmatched" = matchedStageSendId ? "matched" : "unmatched";
  await dbc.execute(sql`
    UPDATE textrequest_dlr_events
    SET matched_stage_send_id = ${matchedStageSendId ? sql`${matchedStageSendId}::uuid` : sql`NULL`},
        result = ${result}, processed_at = now()
    WHERE id = ${o.eventId} AND org_id = ${o.orgId}
  `);
  return { result, matchedStageSendId };
}
