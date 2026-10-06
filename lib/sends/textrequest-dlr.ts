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

export interface TxrPollDlrBatchRow {
  messageId: string;
  /** Already normalized by the caller: trim().toLowerCase(), never null. */
  status: string;
  errorCode: string | null;
  rawBody: string;
}

export interface TxrPollDlrBatchResult {
  captured: number;
  matched: number;
  unmatched: number;
  /** Rows already held (same provider, message_id, status) — the per-row path's "dupe". */
  dupe: number;
}

// ONE PAGE of the messages poll in ONE statement — the batched form of
// captureTxrPollDlrEvent + reconcileTxrDlrEvent (ClickUp 869fcqhcu).
//
// WHY: the per-row path runs a transaction and ~4 round trips per message,
// measured at 197 ms/row (2026-10-06 backfill: 3,196 rows in 629 s). A 1,000-row
// page took ~200 s, so every poll run of the night of 2026-10-05 hit Vercel's
// 60 s limit (25 runs in a row) and the DLR backstop silently did nothing.
//
// ⚠️ SAME RESULT AS THE PER-ROW PATH, by construction:
//   · same columns, same values: method 'poll', headers {}, the row's JSON as
//     raw_body, status/error_code as given, stage_send_id NULL (no ?ss= here);
//   · same dedup: the 0123 partial unique index (provider_id, message_id,
//     status) WHERE method = 'poll', DO NOTHING — a re-read state is dropped, a
//     state CHANGE (sent → delivered) lands as its own row;
//   · within one page, a repeated (message_id, status) keeps the FIRST
//     occurrence, which is what sequential per-row capture does;
//   · same match: stage_sends.texthub_message_id = message_id within the org,
//     LIMIT 1 (2026-10-06: one shared id in all of stage_sends, two ahi sends,
//     none among txr sends — so LIMIT 1 is exact for txr);
//   · same final row state: matched_stage_send_id, result matched|unmatched,
//     processed_at stamped. The per-row path reaches it with an INSERT then an
//     UPDATE; here the match is resolved first and inserted directly, because a
//     sibling CTE cannot UPDATE a row another CTE inserted in the same statement.
// scripts/verify-txr-poll-batch.ts diffs the two paths on a real page.
export async function captureTxrPollDlrBatch(
  dbc: DbOrTx,
  o: {
    orgId: string;
    credentialId: number;
    providerId: number;
    query: Record<string, string>;
    rows: TxrPollDlrBatchRow[];
  },
): Promise<TxrPollDlrBatchResult> {
  if (o.rows.length === 0) return { captured: 0, matched: 0, unmatched: 0, dupe: 0 };
  const payload = JSON.stringify(
    o.rows.map((r, i) => ({
      ord: i,
      message_id: r.messageId,
      status: r.status,
      error_code: r.errorCode,
      raw_body: r.rawBody,
    })),
  );
  const out = (await dbc.execute(sql`
    WITH input AS (
      SELECT DISTINCT ON (message_id, status) message_id, status, error_code, raw_body, ord
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS x(ord int, message_id text, status text, error_code text, raw_body text)
      ORDER BY message_id, status, ord
    ),
    resolved AS (
      SELECT i.*, m.id AS ss_id
      FROM input i
      LEFT JOIN LATERAL (
        SELECT id FROM stage_sends
        WHERE texthub_message_id = i.message_id AND org_id = ${o.orgId}
        LIMIT 1
      ) m ON true
    ),
    ins AS (
      INSERT INTO textrequest_dlr_events
        (org_id, credential_id, provider_id, method, query, headers, raw_body,
         message_id, status, error_code, stage_send_id,
         matched_stage_send_id, result, processed_at)
      SELECT ${o.orgId}, ${o.credentialId}, ${o.providerId}, 'poll',
             ${JSON.stringify(o.query)}::jsonb, '{}'::jsonb, raw_body,
             message_id, status, error_code, NULL,
             ss_id, CASE WHEN ss_id IS NULL THEN 'unmatched' ELSE 'matched' END, now()
      FROM resolved
      ORDER BY ord
      ON CONFLICT (provider_id, message_id, status) WHERE method = 'poll' DO NOTHING
      RETURNING matched_stage_send_id
    )
    SELECT count(*)::int AS captured,
           count(*) FILTER (WHERE matched_stage_send_id IS NOT NULL)::int AS matched
    FROM ins
  `)) as unknown as { captured: number; matched: number }[];
  const captured = Number(out[0]?.captured ?? 0);
  const matched = Number(out[0]?.matched ?? 0);
  return { captured, matched, unmatched: captured - matched, dupe: o.rows.length - captured };
}
