// Proof that the batched poll capture (captureTxrPollDlrBatch) stores EXACTLY
// what the per-row path (captureTxrPollDlrEvent + reconcileTxrDlrEvent) stores,
// on one REAL page of Text Request data (ClickUp 869fcqhcu).
//
// Both paths run inside their own transaction and are ROLLED BACK — nothing is
// written. The page is fetched once (read-only API call) and fed to both.
//
// Pick a window whose messages are NOT already captured by the poll, or both
// paths will just report dupes and prove nothing — the script prints how many
// rows each path inserted and fails if that is 0.
//
// Run: npx tsx --conditions=react-server scripts/verify-txr-poll-batch.ts <dashboard_id> <start ISO> <end ISO>
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  captureTxrPollDlrBatch,
  captureTxrPollDlrEvent,
  reconcileTxrDlrEvent,
  type TxrPollDlrBatchRow,
} from "@/lib/sends/textrequest-dlr";
import { resolveTxrPollTargets, type TxrMessageRow } from "@/lib/sends/textrequest-messages-poll";
import { textrequestBaseUrl } from "@/lib/sends/providers/textrequest";

const [dashboardId, startDate, endDate] = process.argv.slice(2);
const ROLLBACK = Symbol("rollback");
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

type Stored = Record<string, unknown>;

async function snapshot(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], providerId: number, ids: string[]) {
  // Every column the capture writes, except the generated id/received_at.
  return (await tx.execute(sql`
    SELECT org_id, credential_id, provider_id, method, query, headers, raw_body,
           message_id, status, error_code, stage_send_id, matched_stage_send_id, result,
           (processed_at IS NOT NULL) AS processed
    FROM textrequest_dlr_events
    WHERE provider_id = ${providerId} AND method = 'poll'
      AND message_id = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[]`})
      AND received_at >= now()   -- now() is frozen at the transaction start: only this tx's rows
    ORDER BY message_id, status
  `)) as unknown as Stored[];
}

async function main() {
  if (!dashboardId || !startDate || !endDate) throw new Error("usage: <dashboard_id> <start ISO> <end ISO>");
  const t = (await resolveTxrPollTargets(db)).find((x) => x.dashboard_id === dashboardId);
  if (!t) throw new Error(`no poll target for dashboard ${dashboardId}`);

  const u = new URL(`${textrequestBaseUrl()}/dashboards/${encodeURIComponent(dashboardId)}/messages`);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("page", "0");
  u.searchParams.set("page_size", "1000");
  u.searchParams.set("message_direction", "S");
  u.searchParams.set("sort", "desc");
  const res = await fetch(u, { headers: { "x-api-key": t.api_key, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = (((await res.json()) as { items?: TxrMessageRow[] }).items ?? []).filter(
    (m) => m.message_direction === "S" && m.delivery_status,
  );
  console.log(`page: dashboard ${dashboardId}, ${startDate} .. ${endDate}, ${items.length} outbound rows with a status (1 API call)`);
  if (items.length === 0) throw new Error("empty page — pick another window");

  const query = { dashboard_id: dashboardId, start_date: startDate, end_date: endDate };
  const rows: TxrPollDlrBatchRow[] = items.map((m) => ({
    messageId: m.message_id,
    status: m.delivery_status!.trim().toLowerCase(),
    errorCode: m.delivery_error ?? null,
    rawBody: JSON.stringify(m),
  }));
  const ids = [...new Set(rows.map((r) => r.messageId))];

  let perRow: Stored[] = [];
  let perRowMs = 0;
  const perRowCounts = { captured: 0, dupe: 0, matched: 0 };
  await db
    .transaction(async (tx) => {
      const t0 = Date.now();
      for (const r of rows) {
        const captured = await captureTxrPollDlrEvent(tx, {
          orgId: t.org_id, credentialId: t.credential_id, providerId: t.provider_id, method: "poll",
          query, headers: {}, rawBody: r.rawBody, stageSendId: null,
          parsed: { messageId: r.messageId, status: r.status, errorCode: r.errorCode },
        });
        if (!captured) { perRowCounts.dupe++; continue; }
        perRowCounts.captured++;
        const rec = await reconcileTxrDlrEvent(tx, { eventId: captured.id, orgId: t.org_id, stageSendId: null, messageId: r.messageId });
        if (rec.result === "matched") perRowCounts.matched++;
      }
      perRowMs = Date.now() - t0;
      perRow = await snapshot(tx, t.provider_id, ids);
      throw ROLLBACK;
    })
    .catch((e) => { if (e !== ROLLBACK) throw e; });

  let batch: Stored[] = [];
  let batchMs = 0;
  let batchCounts = { captured: 0, dupe: 0, matched: 0, unmatched: 0 };
  await db
    .transaction(async (tx) => {
      const t0 = Date.now();
      batchCounts = await captureTxrPollDlrBatch(tx, {
        orgId: t.org_id, credentialId: t.credential_id, providerId: t.provider_id, query, rows,
      });
      batchMs = Date.now() - t0;
      batch = await snapshot(tx, t.provider_id, ids);
      throw ROLLBACK;
    })
    .catch((e) => { if (e !== ROLLBACK) throw e; });

  console.log(`per-row: ${perRowMs} ms, ${JSON.stringify(perRowCounts)}`);
  console.log(`batched: ${batchMs} ms, ${JSON.stringify(batchCounts)}`);
  check("the page actually inserted rows (otherwise this proves nothing)", perRow.length > 0, `${perRow.length}`);
  check("same number of rows stored", perRow.length === batch.length, `${perRow.length} vs ${batch.length}`);
  check("same captured / dupe / matched counts",
    perRowCounts.captured === batchCounts.captured && perRowCounts.dupe === batchCounts.dupe && perRowCounts.matched === batchCounts.matched);
  const a = perRow.map((r) => JSON.stringify(r));
  const b = batch.map((r) => JSON.stringify(r));
  const diff = a.filter((x, i) => x !== b[i]);
  check("every stored field identical, row by row (org, credential, provider, method, query, headers, raw_body, message_id, status, error_code, stage_send_id, matched_stage_send_id, result, processed)",
    diff.length === 0, `${diff.length} differing rows; first: ${diff[0]?.slice(0, 300)}`);
  const matched = perRow.filter((r) => r.matched_stage_send_id != null).length;
  console.log(`rows: ${perRow.length} stored, ${matched} matched to a send, ${perRow.length - matched} unmatched`);
  console.log(failed === 0 ? "\nIDENTICAL (both transactions rolled back)" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
