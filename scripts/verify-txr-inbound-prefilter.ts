// Proof that the inbound pre-filter (skip rows already captured AND processed)
// leaves EXACTLY the same database state as the unfiltered per-row path, on
// REAL Text Request inbound pages (ClickUp 869fcqhcu, PR #306 review).
//
//   current path = processTxrInboundRow on EVERY row of the page (what the poll
//                  did before the pre-filter)
//   new path     = the production pollTxrMessages (directions R) fed the same page
//
// Each path runs in its own transaction, ROLLED BACK. Nothing is written.
//
// To include NEW STOP rows on a page whose STOPs are all already captured in
// production, each transaction first "un-processes" the first N STOP senders of
// the page: deletes their inbound event row(s) and their opt_outs (attributions
// cascade). Both paths then take the full suppression path for them (contact →
// opt_outs → cascade → attribution → counters → breaker). The same reset runs in
// both transactions, so the comparison is like for like.
//
// Compared: textrequest_inbound_events rows for the page, opt_outs and
// opt_out_attributions for the page's senders, campaign_stages opt-out
// counters, and breaker state (campaigns.send_paused*, campaign_circuit_events).
//
// Run: npx tsx --conditions=react-server scripts/verify-txr-inbound-prefilter.ts \
//        <dashboard_id> <start ISO> <end ISO> [resetStops=0]
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  pollTxrMessages,
  processTxrInboundRow,
  resolveTxrPollTargets,
  type TxrMessageRow,
} from "@/lib/sends/textrequest-messages-poll";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import { textrequestBaseUrl } from "@/lib/sends/providers/textrequest";

// Breaker trips would post to Telegram after the poll loop — never from a proof.
delete process.env.TELEGRAM_BOT_TOKEN;

const [dashboardId, startDate, endDate, resetArg] = process.argv.slice(2);
const RESET = Number(resetArg ?? 0);
const ROLLBACK = Symbol("rollback");
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const toE164 = (p: string | null) => (p ? (p.startsWith("+") ? p : `+${p}`) : null);
const arr = (xs: string[]) => sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::text[]`;

async function main() {
  if (!dashboardId || !startDate || !endDate) throw new Error("usage: <dashboard_id> <start ISO> <end ISO> [resetStops]");
  const t = (await resolveTxrPollTargets(db)).find((x) => x.dashboard_id === dashboardId);
  if (!t) throw new Error(`no poll target for dashboard ${dashboardId}`);

  const u = new URL(`${textrequestBaseUrl()}/dashboards/${encodeURIComponent(dashboardId)}/messages`);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("page", "0");
  u.searchParams.set("page_size", "1000");
  u.searchParams.set("message_direction", "R");
  u.searchParams.set("sort", "desc");
  const res = await fetch(u, { headers: { "x-api-key": t.api_key, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = (((await res.json()) as { items?: TxrMessageRow[] }).items ?? []).filter((m) => m.message_direction === "R");
  const ids = page.map((m) => m.message_id);
  const phones = [...new Set(page.map((m) => toE164(m.customer_phone)).filter((p): p is string => !!p))];
  const stops = page.filter((m) => isOptOutKeyword(m.body ?? ""));
  const reset = stops.slice(0, RESET);
  const resetIds = reset.map((m) => m.message_id);
  const resetPhones = [...new Set(reset.map((m) => toE164(m.customer_phone)).filter((p): p is string => !!p))];
  console.log(`page: dashboard ${dashboardId}, ${startDate} .. ${endDate}: ${page.length} inbound rows, ${stops.length} STOP-keyword, resetting ${reset.length} to new (1 API call)`);
  if (page.length === 0) throw new Error("empty page — pick another window");

  const prep = async (tx: Tx) => {
    if (reset.length === 0) return;
    await tx.execute(sql`DELETE FROM textrequest_inbound_events WHERE provider_id = ${t.provider_id} AND provider_uuid = ANY(${arr(resetIds)})`);
    await tx.execute(sql`DELETE FROM opt_outs WHERE org_id = ${t.org_id} AND phone_number = ANY(${arr(resetPhones)})`);
  };

  const snapshot = async (tx: Tx) => {
    const events = await tx.execute(sql`
      SELECT provider_uuid, source, method, source_number, destination_number, message, result,
             matched_contact_id, matched_stage_send_id, (processed_at IS NOT NULL) AS processed
      FROM textrequest_inbound_events WHERE provider_id = ${t.provider_id} AND provider_uuid = ANY(${arr(ids)})
      ORDER BY provider_uuid, source`);
    const optOuts = await tx.execute(sql`
      SELECT contact_id, phone_number, source, created_at::text AS created_at FROM opt_outs
      WHERE org_id = ${t.org_id} AND phone_number = ANY(${arr(phones)}) ORDER BY phone_number, source, created_at`);
    const attributions = await tx.execute(sql`
      SELECT oo.phone_number, a.stage_send_id, a.stage_id, a.campaign_id, a.created_at::text AS created_at
      FROM opt_out_attributions a JOIN opt_outs oo ON oo.id = a.opt_out_id
      WHERE oo.org_id = ${t.org_id} AND oo.phone_number = ANY(${arr(phones)}) ORDER BY oo.phone_number, a.stage_id`);
    const stageIds = ((attributions as unknown as { stage_id: number }[]).map((a) => a.stage_id));
    const counters = stageIds.length
      ? await tx.execute(sql`
          SELECT id, inbound_opt_out_count, opt_out_count, total_cost::text AS total_cost FROM campaign_stages
          WHERE id = ANY(${sql`ARRAY[${sql.join(stageIds.map((x) => sql`${x}`), sql`, `)}]::int[]`}) ORDER BY id`)
      : [];
    const campaignIds = [...new Set((attributions as unknown as { campaign_id: number }[]).map((a) => a.campaign_id))];
    const breaker = campaignIds.length
      ? await tx.execute(sql`
          SELECT c.id, c.send_paused, c.send_paused_reason,
                 (SELECT count(*)::int FROM campaign_circuit_events e WHERE e.campaign_id = c.id) AS circuit_events
          FROM campaigns c WHERE c.id = ANY(${sql`ARRAY[${sql.join(campaignIds.map((x) => sql`${x}`), sql`, `)}]::int[]`}) ORDER BY c.id`)
      : [];
    return { events, optOuts, attributions, counters, breaker } as Record<string, unknown>;
  };

  let before: Record<string, unknown> = {};
  let current: Record<string, unknown> = {};
  const currentCounts = { new: 0, dupe: 0, suppressed: 0 };
  let currentMs = 0;
  await db.transaction(async (tx) => {
    await prep(tx);
    before = await snapshot(tx);
    const t0 = Date.now();
    for (const m of page) {
      const o = await processTxrInboundRow(tx as unknown as typeof db, t, m);
      if (o.kind === "dupe") currentCounts.dupe++;
      else { currentCounts.new++; if (o.suppressed) currentCounts.suppressed++; }
    }
    currentMs = Date.now() - t0;
    current = await snapshot(tx);
    throw ROLLBACK;
  }).catch((e) => { if (e !== ROLLBACK) throw e; });

  let filtered: Record<string, unknown> = {};
  let pollRes: Awaited<ReturnType<typeof pollTxrMessages>> | null = null;
  let filteredMs = 0;
  await db.transaction(async (tx) => {
    await prep(tx);
    const t0 = Date.now();
    pollRes = await pollTxrMessages(tx as unknown as typeof db, {
      orgId: t.org_id,
      directions: ["R"],
      fetchMessages: async (o) =>
        o.dashboardId === dashboardId && o.direction === "R"
          ? { ok: true as const, items: page, totalItems: page.length }
          : { ok: true as const, items: [], totalItems: 0 },
    });
    filteredMs = Date.now() - t0;
    filtered = await snapshot(tx);
    throw ROLLBACK;
  }).catch((e) => { if (e !== ROLLBACK) throw e; });

  const p = pollRes as unknown as Awaited<ReturnType<typeof pollTxrMessages>>;
  console.log(`current (per-row on every row): ${currentMs} ms, new ${currentCounts.new} / dupe ${currentCounts.dupe} / suppressed ${currentCounts.suppressed}`);
  console.log(`new (pre-filter):               ${filteredMs} ms, new ${p.inbound_captured} / dupe ${p.inbound_dupe} (of which skipped by lookup ${p.inbound_known}) / suppressed ${p.inbound_suppressed}`);
  check("same counts (new / dupe / suppressed)",
    currentCounts.new === p.inbound_captured && currentCounts.dupe === p.inbound_dupe && currentCounts.suppressed === p.inbound_suppressed);
  for (const k of ["events", "optOuts", "attributions", "counters", "breaker"]) {
    const a = JSON.stringify(current[k]);
    const b = JSON.stringify(filtered[k]);
    const n = (current[k] as unknown[]).length;
    check(`identical ${k} (${n} row(s))`, a === b, `current ${a.slice(0, 200)} … vs new ${b.slice(0, 200)}`);
  }
  if (reset.length > 0) {
    const grew = (current.optOuts as unknown[]).length - (before.optOuts as unknown[]).length;
    check(`the reset STOPs really took the suppression path (+${grew} opt_outs in both)`, grew > 0 && currentCounts.suppressed > 0);
  }
  console.log(failed === 0 ? "\nIDENTICAL (both transactions rolled back)" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
