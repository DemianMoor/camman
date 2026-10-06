// Text Request Phase 3b — messages-poll backstop + webhook health.
//
// Two halves:
//   1. PURE: UTC timestamp parsing, the rolling window, and the backwards page
//      walk. No DB, no network.
//   2. DB-BACKED, fully rolled back: migrations 0122+0123 are applied INSIDE the
//      transaction (Postgres DDL is transactional) because the txr migrations are
//      deliberately not applied to the shared database until the gated go-live
//      step. Reading the real .sql files means this also smoke-tests that those
//      migrations actually execute — including that every statement runs, which
//      is what a missing `--> statement-breakpoint` silently breaks.
//
// Run: npx tsx scripts/test-textrequest-poll.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { applyTxrMigrationsInTx, isLockContentionError } from "./_txr-migration-fixture";
import { checkTxrWebhookHealth, type TxrHook } from "@/lib/sends/textrequest-hooks";
import {
  txrAlertTransition,
  txrPassThresholdMin,
  txrPreviousRunDied,
} from "@/lib/sends/textrequest-poll-health";
import {
  computeTxrMessagesWindow,
  parseTxrUtcTimestamp,
  planTxrPageWalk,
  planTxrSortedWalk,
  pollTxrMessages,
  txrBudgetEnd,
  txrMergeOwed,
  txrOwedAfterAscending,
  txrWalkOrder,
  txrPassKey,
  txrUnreadRange,
  type TxrMessageRow,
  type TxrMessagesFetcher,
} from "@/lib/sends/textrequest-messages-poll";

// Alerts are best-effort and this box has a REAL bot token in .env.local — clear
// it so a test run can never post to the operator's Telegram chat. notifyTelegram
// is a silent no-op without a token.
delete process.env.TELEGRAM_BOT_TOKEN;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ---------- 1. PURE ----------
console.log("— pure: UTC timestamp parsing —");
// TR sends UTC with no designator. Parsing it as local time is the TextHub
// Mountain-time bug class; assert the exact epoch, not just "not null".
check(
  "naive TR timestamp is read as UTC",
  parseTxrUtcTimestamp("2026-07-25T09:39:35.227")?.toISOString() === "2026-07-25T09:39:35.227Z",
  String(parseTxrUtcTimestamp("2026-07-25T09:39:35.227")?.toISOString()),
);
check(
  "already-Z timestamp is not double-suffixed",
  parseTxrUtcTimestamp("2026-07-25T09:39:35Z")?.toISOString() === "2026-07-25T09:39:35.000Z",
);
check(
  "explicit offset is respected, not overridden",
  parseTxrUtcTimestamp("2026-07-25T09:39:35-04:00")?.toISOString() === "2026-07-25T13:39:35.000Z",
);
check("null/empty -> null", parseTxrUtcTimestamp(null) === null && parseTxrUtcTimestamp("  ") === null);
check("garbage -> null (never an Invalid Date)", parseTxrUtcTimestamp("not a date") === null);

console.log("\n— pure: rolling window —");
const now = new Date("2026-07-25T12:00:00.000Z");
const w = computeTxrMessagesWindow(now, 6);
check("start_date = now - lookback", w.start_date === "2026-07-25T06:00:00.000Z", w.start_date);
check("end_date = now + 5min skew", w.end_date === "2026-07-25T12:05:00.000Z", w.end_date);
// DST is a non-event because both sides are UTC — a window computed across the
// US fall-back instant is still exactly `lookback` hours wide.
const dstWin = computeTxrMessagesWindow(new Date("2026-11-01T05:30:00.000Z"), 6);
check(
  "window across a DST boundary is still exactly 6h wide",
  new Date(dstWin.end_date).getTime() - new Date(dstWin.start_date).getTime() === (6 * 60 + 5) * 60_000,
  JSON.stringify(dstWin),
);

console.log("\n— pure: sorted (newest-first) page walk —");
check(
  "sorted walk: empty collection -> no pages",
  JSON.stringify(planTxrSortedWalk(0, 1000, 20)) === JSON.stringify({ pages: [], truncated: false }),
);
check(
  "sorted walk: single partial page -> [0], not truncated",
  JSON.stringify(planTxrSortedWalk(3, 1000, 20)) === JSON.stringify({ pages: [0], truncated: false }),
);
check(
  "sorted walk: pages run FORWARD (0,1,2) because sort=desc puts newest on page 0",
  JSON.stringify(planTxrSortedWalk(2400, 1000, 20).pages) === JSON.stringify([0, 1, 2]),
);
const sortedCap = planTxrSortedWalk(25000, 1000, 20);
check("sorted walk: cap bites -> truncated flag set", sortedCap.truncated === true, JSON.stringify(sortedCap));
check(
  "sorted walk: cap keeps the NEWEST pages (0..19) and drops the oldest",
  sortedCap.pages.length === 20 && sortedCap.pages[0] === 0 && sortedCap.pages[19] === 19,
  JSON.stringify(sortedCap.pages),
);

console.log("\n— pure: backwards page walk (unsorted fallback) —");
check("empty collection -> no pages", JSON.stringify(planTxrPageWalk(0, 500, 20)) === JSON.stringify({ pages: [], truncated: false }));
check(
  "single partial page -> [0], not truncated",
  JSON.stringify(planTxrPageWalk(3, 500, 20)) === JSON.stringify({ pages: [0], truncated: false }),
);
check(
  "3 pages -> walked NEWEST-first (2,1,0)",
  JSON.stringify(planTxrPageWalk(1200, 500, 20).pages) === JSON.stringify([2, 1, 0]),
);
const capped = planTxrPageWalk(5000, 500, 2);
check("cap bites -> truncated flag set", capped.truncated === true, JSON.stringify(capped));
check(
  "cap keeps the NEWEST pages (9,8) and drops the oldest",
  JSON.stringify(capped.pages) === JSON.stringify([9, 8]),
  JSON.stringify(capped.pages),
);

// ---------- 2. DB-BACKED (rolled back) ----------
// ---------- 1b. PURE: owed ranges, outbound order, budget, run health (869fcqhcu) ----------
console.log("— pure: owed ranges, outbound order, budget, run health —");
{
  const from = new Date("2026-10-05T17:00:00Z");
  const to = new Date("2026-10-05T23:05:00Z");
  const u = txrUnreadRange(from, to, new Date("2026-10-05T23:01:30Z"));
  check(
    "unread = [window start, oldest read + 1 s]",
    u.from.toISOString() === from.toISOString() && u.to.toISOString() === "2026-10-05T23:01:31.000Z",
    JSON.stringify(u),
  );
  const none = txrUnreadRange(from, to, null);
  check("nothing read ⇒ the whole window is owed", none.from === from && none.to === to);
  check(
    "+1 s never runs past the window end",
    txrUnreadRange(from, to, new Date("2026-10-05T23:05:00Z")).to.toISOString() === to.toISOString(),
  );
  // Owed range after an OLDEST-first walk: from the newest row read, never backwards.
  const owed0 = { from: new Date("2026-10-06T09:49:00Z"), to: new Date("2026-10-06T16:09:00Z") };
  check("asc walk: owed start moves to the newest row read",
    txrOwedAfterAscending(owed0, new Date("2026-10-06T11:00:00Z")).from.toISOString() === "2026-10-06T11:00:00.000Z");
  check("asc walk: nothing read ⇒ unchanged (never backwards)", txrOwedAfterAscending(owed0, null) === owed0);
  check("asc walk: a row older than the start does not move it back",
    txrOwedAfterAscending(owed0, new Date("2026-10-06T09:00:00Z")) === owed0);
  // Merge: the window may only push the owed END.
  const win = { from: new Date("2026-10-06T10:20:00Z"), to: new Date("2026-10-06T16:25:00Z") };
  const after = { from: new Date("2026-10-06T11:00:00Z"), to: owed0.to };
  const m1 = txrMergeOwed(owed0, after, win);
  check("merge: open owed range + starved window ⇒ start stays at the progress point, end extends",
    m1?.from.toISOString() === "2026-10-06T11:00:00.000Z" && m1?.to.toISOString() === "2026-10-06T16:25:00.000Z", JSON.stringify(m1));
  const m2 = txrMergeOwed(owed0, null, win);
  check("merge: owed range finished ⇒ window leftover clipped to start no earlier than what was read",
    m2?.from.toISOString() === owed0.to.toISOString() && m2?.to.toISOString() === win.to.toISOString(), JSON.stringify(m2));
  check("merge: owed range finished + window leftover inside it ⇒ nothing owed",
    txrMergeOwed(owed0, null, { from: win.from, to: new Date("2026-10-06T16:00:00Z") }) === null);
  const m3 = txrMergeOwed(null, null, win);
  check("merge: first cut-short run ⇒ the window leftover as is",
    m3?.from.getTime() === win.from.getTime() && m3?.to.getTime() === win.to.getTime(), JSON.stringify(m3));
  check("merge: nothing left anywhere ⇒ null", txrMergeOwed(owed0, null, null) === null);
  const order = txrWalkOrder(
    [{ dashboard_id: "a" }, { dashboard_id: "b" }, { dashboard_id: "c" }],
    new Map([
      [txrPassKey("a", "S"), new Date("2026-10-06T10:00:00Z")],
      [txrPassKey("b", "S"), new Date("2026-10-06T09:00:00Z")],
    ]),
    "S",
  );
  check("order: never-passed first, then oldest pass first", order.map((x) => x.dashboard_id).join() === "c,b,a", JSON.stringify(order));
  check("budget: equal share of what is left", txrBudgetEnd(1000, 46000, 3) === 16000);
  check("budget: past the deadline ⇒ no time at all", txrBudgetEnd(50000, 45000, 2) === 50000);
  check("died: started after finished", txrPreviousRunDied(new Date("2026-10-06T10:15:00Z"), new Date("2026-10-06T10:00:40Z")) === true);
  check("died: never finished at all", txrPreviousRunDied(new Date("2026-10-06T10:15:00Z"), null) === true);
  check("not died: finished after started", txrPreviousRunDied(new Date("2026-10-06T10:15:00Z"), new Date("2026-10-06T10:15:41Z")) === false);
  check("not died: first ever run", txrPreviousRunDied(null, null) === false);
  check("alert once per streak", txrAlertTransition(true, false) === "alert" && txrAlertTransition(true, true) === "none");
  check("recover once", txrAlertTransition(false, true) === "recover" && txrAlertTransition(false, false) === "none");
  check("thresholds: outbound 4 runs, inbound 2 runs (+5 min slack)", txrPassThresholdMin("S") === 65 && txrPassThresholdMin("R") === 35);
}

async function main() {
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const sfx = Date.now().toString().slice(-9);

      // Apply the not-yet-deployed txr migrations inside this tx (short
      // lock_timeout — see the fixture's header for why that is load-bearing).
      await applyTxrMigrationsInTx(tx, [
        "0122_textrequest_dlr_events.sql",
        "0123_textrequest_dlr_poll_idempotency.sql",
      ]);
      check("migrations 0122+0123 apply cleanly (all statements)", true);
      const idx = (await tx.execute(sql`
        SELECT indexname FROM pg_indexes WHERE tablename = 'textrequest_dlr_events'
      `)) as unknown as { indexname: string }[];
      check(
        "0123's partial unique index exists after apply",
        idx.some((i) => i.indexname === "textrequest_dlr_events_poll_uniq"),
        JSON.stringify(idx),
      );

      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      // The preview DB has no txr provider or credential, so this half used to
      // SKIP there and exercised nothing. Create them inside this (rolled-back)
      // transaction when absent.
      const prov =
        (await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'txr'`)) ??
        (await one<{ id: number }>(sql`
          INSERT INTO sms_providers (org_id, sms_provider_id, name)
          VALUES (${orgId}, 'txr', 'Text Request (test fixture)') RETURNING id`));
      const cred =
        (await one<{ id: number }>(sql`
          SELECT id FROM provider_credentials WHERE provider_id = ${prov.id} AND org_id = ${orgId} ORDER BY id LIMIT 1`)) ??
        (await one<{ id: number }>(sql`
          INSERT INTO provider_credentials (org_id, provider_id, api_key)
          VALUES (${orgId}, ${prov.id}, 'test-fixture-key') RETURNING id`));

      // A txr sending number bound to that credential + a dashboard. Phone 114
      // (dashboard 68093) is configured and LIVE in production now, so the poll
      // resolves it too; `onlyFixture` below keeps this fixture's counts
      // independent of that. This is what a CONFIGURED number looks like.
      const dashboardId = `d${sfx}`;
      await tx.execute(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, dashboard_id, credential_id, number_type, status)
        VALUES (${orgId}, ${prov.id}, ${"+1844" + sfx.slice(0, 7)}, ${dashboardId}, ${cred.id}, 'toll_free', 'active')`);

      // A sent message to reconcile against.
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"txrpoll-" + sfx}, 'txrpoll', 'active', 'manual') RETURNING id`);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number) VALUES (${orgId}, ${camp.id}, 1) RETURNING id`);
      const contact = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1315586" + sfx.slice(0, 4)})
        ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now() RETURNING id`);
      const knownMsgId = `guid-known-${sfx}`;
      const send = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id, status, sent_at)
        VALUES (${orgId}, ${camp.id}, ${stage.id}, ${contact.id}, ${"+1315586" + sfx.slice(0, 4)}, 'hi', ${knownMsgId}, 'sent', now())
        RETURNING id`);

      const rows: TxrMessageRow[] = [
        // outbound, delivered, matches our send -> captured + matched
        { dashboard_phone: "18449903688", customer_phone: "13155860001", customer_friendly_name: null, segments_count: 1, message_id: knownMsgId, body: "hi", message_direction: "S", message_timestamp_utc: "2026-07-25T11:00:00", delivery_status: "delivered", delivery_error: null },
        // outbound, delivered, unknown message id -> captured + unmatched
        { dashboard_phone: "18449903688", customer_phone: "13155860002", customer_friendly_name: null, segments_count: 1, message_id: `guid-orphan-${sfx}`, body: "hi", message_direction: "S", message_timestamp_utc: "2026-07-25T11:01:00", delivery_status: "delivered", delivery_error: null },
        // outbound with NO delivery status -> skipped (would defeat the unique key)
        { dashboard_phone: "18449903688", customer_phone: "13155860003", customer_friendly_name: null, segments_count: 1, message_id: `guid-nostatus-${sfx}`, body: "hi", message_direction: "S", message_timestamp_utc: "2026-07-25T11:02:00", delivery_status: null, delivery_error: null },
        // INBOUND -> not the DLR table's business (Phase 4 owns it)
        { dashboard_phone: "18449903688", customer_phone: "13155860004", customer_friendly_name: null, segments_count: 1, message_id: `guid-inbound-${sfx}`, body: "STOP", message_direction: "R", message_timestamp_utc: "2026-07-25T11:03:00", delivery_status: null, delivery_error: null },
      ];
      // Phone 114 is CONFIGURED in production now (dashboard 68093), so the poll
      // resolves it alongside this fixture's dashboard. Every fake fetcher must
      // answer only for the fixture's dashboard — otherwise these counts
      // describe the org's live config instead of the behaviour under test,
      // which is what silently turned this file red on main.
      const onlyFixture =
        (f: TxrMessagesFetcher): TxrMessagesFetcher =>
        async (o) =>
          o.dashboardId === dashboardId ? f(o) : { ok: true as const, items: [], totalItems: 0 };

      // The poll now keeps per-dashboard state between runs (owed outbound
      // ranges, pass stamps). A page-capped fixture run leaves an owed range
      // that the NEXT call would read first, so blocks that assert exact counts
      // start from a clean slate.
      const clearPollState = () =>
        tx.execute(sql`DELETE FROM cron_locks WHERE job_name LIKE ${"textrequest-poll:%"}`);

      // The real API filters by `message_direction` server-side, so the fixture
      // does too — otherwise each direction walk would see every row and the
      // counts below would be describing a fixture artifact, not the poll.
      const fetchMessages = onlyFixture(async (o) => {
        const items = o.direction ? rows.filter((r) => r.message_direction === o.direction) : rows;
        return { ok: true as const, items, totalItems: items.length };
      });

      const r1 = await pollTxrMessages(tx as unknown as typeof db, { orgId, fetchMessages });
      // >= 1, not === 1: the org also has the real configured dashboard. The row
      // counts below stay exact because every fetcher answers only for ours.
      check("poll: the fixture dashboard was polled", r1.dashboards_polled >= 1, JSON.stringify(r1));
      check("poll: only outbound-with-status counted (2 of 4)", r1.outbound_with_status === 2, JSON.stringify(r1));
      check("poll: 2 captured", r1.captured === 2, JSON.stringify(r1));
      check("poll: 1 matched to its stage_send", r1.matched === 1, JSON.stringify(r1));
      check("poll: 1 unmatched (orphan message id)", r1.unmatched === 1, JSON.stringify(r1));
      check("poll: not truncated", r1.truncated === false, JSON.stringify(r1));

      const capMatched = (await tx.execute(sql`
        SELECT method, status, result, matched_stage_send_id, stage_send_id
        FROM textrequest_dlr_events WHERE message_id = ${knownMsgId}`)) as unknown as {
        method: string; status: string; result: string; matched_stage_send_id: string | null; stage_send_id: string | null;
      }[];
      check("captured row tagged method='poll'", capMatched[0]?.method === "poll", JSON.stringify(capMatched[0]));
      check("captured row reconciled to the right send", capMatched[0]?.matched_stage_send_id === send.id, JSON.stringify(capMatched[0]));
      check("poll channel carries no ?ss= stage_send_id", capMatched[0]?.stage_send_id === null);
      const skipped = (await tx.execute(sql`
        SELECT 1 FROM textrequest_dlr_events WHERE message_id IN (${`guid-nostatus-${sfx}`}, ${`guid-inbound-${sfx}`})`)) as unknown[];
      check("null-status and inbound rows were NOT captured", skipped.length === 0);

      // Same window re-read: the whole point of 0123.
      const r2 = await pollTxrMessages(tx as unknown as typeof db, { orgId, fetchMessages });
      check("re-poll: 0 newly captured (idempotent)", r2.captured === 0, JSON.stringify(r2));
      check("re-poll: 2 dupes", r2.dupe === 2, JSON.stringify(r2));
      const rowCount = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM textrequest_dlr_events WHERE message_id = ${knownMsgId}`)) as unknown as { n: number }[];
      check("still exactly 1 row for that message", rowCount[0]?.n === 1, JSON.stringify(rowCount));

      // A genuine state CHANGE must still land (status is part of the key).
      const changed: TxrMessageRow[] = [{ ...rows[0]!, delivery_status: "undelivered", delivery_error: "2100" }];
      const r3 = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture(async () => ({ ok: true as const, items: changed, totalItems: 1 })),
      });
      check("state change (delivered -> undelivered) is captured, not deduped", r3.captured === 1, JSON.stringify(r3));
      const errRow = (await tx.execute(sql`
        SELECT status, error_code FROM textrequest_dlr_events
        WHERE message_id = ${knownMsgId} AND status = 'undelivered'`)) as unknown as { status: string; error_code: string | null }[];
      check("delivery_error lands in error_code (2100)", errRow[0]?.error_code === "2100", JSON.stringify(errRow[0]));

      // ---- the request shape the walk asks TR for ----
      const calls: { direction?: string; sort?: string; page: number; pageSize: number }[] = [];
      const recorder = onlyFixture(async (o) => {
        calls.push({ direction: o.direction, sort: o.sort, page: o.page, pageSize: o.pageSize });
        const items = o.direction ? rows.filter((r) => r.message_direction === o.direction) : rows;
        return { ok: true as const, items, totalItems: items.length };
      });
      await pollTxrMessages(tx as unknown as typeof db, { orgId, fetchMessages: recorder });
      check(
        "walk: outbound and inbound are asked for SEPARATELY (own page budget each)",
        calls.some((c) => c.direction === "S") && calls.some((c) => c.direction === "R"),
        JSON.stringify(calls),
      );
      // The page budget is per-direction, but the FUNCTION budget (maxDuration
      // 60s) is shared, and outbound is the big side: 10,000 rows takes several
      // ticks to drain. Walking outbound first would mean STOP intake never gets
      // a turn during a large campaign - the opposite of the split's purpose.
      check(
        "walk: inbound is walked FIRST so a big outbound window cannot starve STOP intake",
        calls.findIndex((c) => c.direction === "R") < calls.findIndex((c) => c.direction === "S"),
        JSON.stringify(calls),
      );

      // ---- the same invariant with MORE THAN ONE dashboard ----
      // The check above holds under EITHER flattening while only one dashboard
      // exists, so it could not see the real bug (found live 2026-09-03):
      // per-dashboard (R,S) pairs put dashboard A's 10K-row outbound walk AHEAD
      // of dashboard B's inbound walk, and the shared 60s function budget dies
      // in it — B's STOP intake never gets a turn, and resolveTxrPollTargets has
      // no ORDER BY so which dashboard loses is arbitrary. Two dashboards is the
      // smallest world that tells the two flattenings apart, so state the
      // invariant globally: EVERY inbound request precedes EVERY outbound one.
      const dashboardId2 = `d2${sfx}`;
      await tx.execute(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, dashboard_id, credential_id, number_type, status)
        VALUES (${orgId}, ${prov.id}, ${"+1855" + sfx.slice(0, 7)}, ${dashboardId2}, ${cred.id}, 'toll_free', 'active')`);
      const calls2: { dashboardId: string; direction?: string }[] = [];
      await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: async (o) => {
          if (o.dashboardId !== dashboardId && o.dashboardId !== dashboardId2) {
            return { ok: true as const, items: [], totalItems: 0 };
          }
          calls2.push({ dashboardId: o.dashboardId, direction: o.direction });
          // Empty both sides: this block tests ORDER, not capture (the fixture's
          // rows were already ingested by the run above).
          return { ok: true as const, items: [], totalItems: 0 };
        },
      });
      const lastInbound = calls2.reduce((acc, c, i) => (c.direction === "R" ? i : acc), -1);
      const firstOutbound = calls2.findIndex((c) => c.direction === "S");
      check(
        "walk: with TWO dashboards, EVERY inbound request precedes EVERY outbound one",
        lastInbound >= 0 && firstOutbound >= 0 && lastInbound < firstOutbound,
        JSON.stringify(calls2),
      );
      check(
        "walk: both dashboards get their own inbound walk",
        new Set(calls2.filter((c) => c.direction === "R").map((c) => c.dashboardId)).size === 2,
        JSON.stringify(calls2),
      );
      check(
        "walk: every request is newest-first (sort=desc), not the oldest-first default",
        calls.length > 0 && calls.every((c) => c.sort === "desc"),
        JSON.stringify(calls),
      );
      check(
        "walk: default page size is 1000 — TR silently clamps anything larger",
        calls.length > 0 && calls.every((c) => c.pageSize === 1000),
        JSON.stringify(calls),
      );

      // ---- the crowd-out fix: a 10K outbound blast must not starve STOP intake ----
      // This is the alert from 2026-08-21 in miniature: outbound overflows the
      // page cap while an inbound STOP sits in the same window. Before the
      // direction split they shared one budget and the STOP could be dropped.
      const stopRow: TxrMessageRow = {
        dashboard_phone: "18449903688", customer_phone: "13155870001", customer_friendly_name: null,
        segments_count: 1, message_id: `guid-stop-${sfx}`, body: "STOP", message_direction: "R",
        message_timestamp_utc: "2026-07-25T11:10:00", delivery_status: null, delivery_error: null,
      };
      // Dated INSIDE the 6 h window: an unread part that lies entirely before
      // the window owes nothing, so an out-of-window fixture proves nothing here.
      const blastRow: TxrMessageRow = {
        ...rows[1]!,
        message_id: `guid-blast-${sfx}`,
        message_timestamp_utc: new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19),
      };
      const rBlast = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        maxPages: 1,
        pageSize: 1,
        fetchMessages: onlyFixture(async (o) =>
          o.direction === "R"
            ? { ok: true as const, items: [stopRow], totalItems: 1 }
            : { ok: true as const, items: [blastRow], totalItems: 5000 },
        ),
      });
      check(
        "blast: an outbound overflow still lets the inbound STOP through",
        rBlast.inbound_captured === 1 && rBlast.inbound_suppressed === 1,
        JSON.stringify(rBlast),
      );
      check("blast: the outbound truncation is still reported", rBlast.truncated === true, JSON.stringify(rBlast));

      check(
        "blast: the outbound overflow is now an OWED range, not a silent drop",
        rBlast.owed.some((g) => g.dashboard_id === dashboardId && g.direction === "S"),
        JSON.stringify(rBlast.owed),
      );
      await clearPollState();

      // ---- defense: TR SILENTLY IGNORES unknown params, so never trust the
      // server-side filter alone. If message_direction stopped being honored,
      // both walks would see every row — that must not double-process anything.
      const ignoreS: TxrMessageRow = { ...rows[0]!, message_id: `guid-ign-s-${sfx}` };
      const ignoreR: TxrMessageRow = { ...stopRow, message_id: `guid-ign-r-${sfx}`, customer_phone: "13155870002" };
      const rIgnored = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture(async () => ({ ok: true as const, items: [ignoreS, ignoreR], totalItems: 2 })),
      });
      check(
        "unfiltered: each row is processed exactly once across both walks",
        rIgnored.captured === 1 && rIgnored.dupe === 1 && rIgnored.inbound_captured === 1 && rIgnored.inbound_dupe === 1,
        JSON.stringify(rIgnored),
      );

      // ---- `sort` is undocumented; if TR ever rejects it the backstop must
      // degrade to the old oldest-first arithmetic, not go dark.
      const fallbackRow: TxrMessageRow = { ...rows[0]!, message_id: `guid-fallback-${sfx}` };
      const rFallback = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture(async (o) =>
          o.sort
            ? { ok: false as const, error: "HTTP 400" }
            : { ok: true as const, items: [fallbackRow], totalItems: 1 },
        ),
      });
      check(
        "sort rejected: falls back to the unsorted walk instead of capturing nothing",
        rFallback.captured === 1 && rFallback.sort_fallbacks > 0,
        JSON.stringify(rFallback),
      );

      // Truncation is reported, never silent.
      const rTrunc = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        maxPages: 1,
        pageSize: 1,
        fetchMessages: onlyFixture(async () => ({ ok: true as const, items: [rows[1]!], totalItems: 50 })),
      });
      check("page cap sets truncated=true", rTrunc.truncated === true, JSON.stringify(rTrunc));
      await clearPollState();

      // A fetch failure must not throw out of the poll.
      const rFail = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture(async () => ({ ok: false as const, error: "HTTP 500" })),
      });
      check("fetch failure is reported, not thrown", rFail.error === "HTTP 500" && rFail.captured === 0, JSON.stringify(rFail));
      check(
        "fetch failure owes the whole window (nothing was read)",
        rFail.owed.some((g) => g.dashboard_id === dashboardId && g.direction === "S"),
        JSON.stringify(rFail.owed),
      );
      await clearPollState();

      // ---- owed ranges: oldest-first, start never backwards, leftover time back ----
      // A fake API that honours the window, the page and the sort order, and a
      // fake clock that only the fixture dashboard's fetches advance (30 each).
      const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString().slice(0, 19);
      const tsOf = (r: TxrMessageRow) => new Date(r.message_timestamp_utc + "Z").getTime();
      type FetchLog = { kind: string; sort?: string; page: number; ts: number[] };
      const pager =
        (all: TxrMessageRow[], direction: "R" | "S", clk: { now: number }, log?: FetchLog[]): TxrMessagesFetcher =>
        async (o) => {
          if (o.dashboardId !== dashboardId || o.direction !== direction) return { ok: true as const, items: [], totalItems: 0 };
          clk.now += 30;
          const inWin = all
            .filter((r) => {
              const t = new Date(r.message_timestamp_utc + "Z").toISOString();
              return t >= o.window.start_date && t <= o.window.end_date;
            })
            .sort((a, b) => (o.sort === "desc" ? tsOf(b) - tsOf(a) : tsOf(a) - tsOf(b)));
          const items = inWin.slice(o.page * o.pageSize, (o.page + 1) * o.pageSize);
          log?.push({ kind: o.sort ?? "default", sort: o.sort, page: o.page, ts: items.map(tsOf) });
          return { ok: true as const, items, totalItems: inWin.length };
        };
      const gapFrom = async (dir: "R" | "S") => {
        const r = (await tx.execute(sql`
          SELECT watermark FROM cron_locks WHERE job_name = ${`textrequest-poll:gap-from:${dashboardId}:${dir}`}`)) as unknown as { watermark: string | Date }[];
        return r[0] ? new Date(r[0].watermark).getTime() : null;
      };
      const hasPass = async (dir: "R" | "S") =>
        ((await tx.execute(sql`SELECT 1 FROM cron_locks WHERE job_name = ${txrPassKey(dashboardId, dir)}`)) as unknown as unknown[]).length === 1;

      // A. A window cut short by the budget; the time left before the deadline
      //    goes back to this dashboard, which reads its owed range OLDEST-first
      //    and finishes it in the same run. (Dashboard 2 has a fresh pass stamp
      //    and dashboard 1 none, so dashboard 1 walks first, on half the time.)
      await clearPollState();
      await tx.execute(sql`INSERT INTO cron_locks (job_name, watermark) VALUES (${txrPassKey(dashboardId2, "S")}, now())`);
      const aRows = [30, 40, 50].map((ago, i) => ({ ...rows[0]!, message_id: `guid-a-${i}-${sfx}`, message_timestamp_utc: iso(ago) }));
      const aClk = { now: 0 };
      const aLog: FetchLog[] = [];
      const rA = await pollTxrMessages(tx as unknown as typeof db, {
        orgId, directions: ["S"], pageSize: 1, fetchMessages: pager(aRows, "S", aClk, aLog),
        clock: () => aClk.now, deadlineAt: 100, stateful: true,
      });
      const aWin = rA.walks.find((w) => w.dashboard_id === dashboardId && w.kind === "window");
      const aGap = rA.walks.find((w) => w.dashboard_id === dashboardId && w.kind === "gap");
      check("A: the window walk stopped for time after 2 pages (newest-first)", aWin?.stopped === "budget" && aWin?.pages_read === 2, JSON.stringify(aWin));
      check("A: leftover time went back — an owed-range walk ran in the SAME run and completed", aGap?.complete === true, JSON.stringify(aGap));
      check("A: the owed range was read OLDEST-first (sort=asc)", aLog.some((l) => l.sort === "asc"), JSON.stringify(aLog));
      check("A: all 3 rows captured once, nothing owed, pass stamp written",
        rA.captured === 3 && rA.owed.length === 0 && (await hasPass("S")), JSON.stringify({ captured: rA.captured, owed: rA.owed }));

      // B. The 68804 shape: a BIG owed range + a window that gets ZERO time,
      //    several runs in a row. The owed start must strictly advance every run
      //    (never back over time already read oldest-first) and the range must
      //    complete; every row is captured exactly once.
      await clearPollState();
      await tx.execute(sql`INSERT INTO cron_locks (job_name, watermark) VALUES (${txrPassKey(dashboardId2, "S")}, now())`);
      const oldRows = Array.from({ length: 21 }, (_, i) => ({ ...rows[0]!, message_id: `guid-b-old-${i}-${sfx}`, message_timestamp_utc: iso(300 - i * 10) }));
      const newRows = Array.from({ length: 10 }, (_, i) => ({ ...rows[0]!, message_id: `guid-b-new-${i}-${sfx}`, message_timestamp_utc: iso(5 + i * 5) }));
      const bRows = [...oldRows, ...newRows];
      const seedFrom = new Date(tsOf(oldRows[0]!)).toISOString();
      const seedTo = new Date(tsOf(oldRows[20]!) + 1000).toISOString();
      await tx.execute(sql`
        INSERT INTO cron_locks (job_name, watermark) VALUES
          (${`textrequest-poll:gap-from:${dashboardId}:S`}, ${seedFrom}::timestamptz),
          (${`textrequest-poll:gap-to:${dashboardId}:S`}, ${seedTo}::timestamptz)`);
      const starts: (number | null)[] = [new Date(seedFrom).getTime()];
      let bCaptured = 0;
      let bRuns = 0;
      let windowStarved = true;
      const N_B = 8;
      for (let run = 1; run <= N_B; run++) {
        const clk = { now: 0 };
        const r = await pollTxrMessages(tx as unknown as typeof db, {
          orgId, directions: ["S"], pageSize: 1, fetchMessages: pager(bRows, "S", clk),
          clock: () => clk.now, deadlineAt: 200, stateful: true,
        });
        bCaptured += r.captured;
        bRuns = run;
        const firstWindow = r.walks.find((w) => w.dashboard_id === dashboardId && w.kind === "window");
        const s = await gapFrom("S");
        starts.push(s);
        if (s !== null && firstWindow && firstWindow.pages_read !== 0) windowStarved = false;
        if (s === null) break;
      }
      const advancing = starts.slice(1).every((s, i) => s === null || (starts[i] !== null && s > starts[i]!));
      console.log(`   B: owed start per run: ${starts.map((s) => (s === null ? "done" : new Date(s).toISOString().slice(11, 19))).join(" → ")}`);
      check("B: the window walk got zero time while the range was owed (the 68804 shape)", windowStarved);
      check("B: the owed start strictly advanced every run, never backwards", advancing, JSON.stringify(starts));
      check(`B: the owed range completed within N = ${N_B} runs (took ${bRuns})`, starts[starts.length - 1] === null, JSON.stringify(starts));
      check(`B: every one of the ${bRows.length} rows captured exactly once across the runs`, bCaptured === bRows.length, `${bCaptured}`);
      check("B: pass stamp written once nothing is owed", await hasPass("S"));

      // C. Inbound shares the mechanism: an owed STOP range is read OLDEST-first
      //    and every STOP in it is fully processed. Budget (20 s) and the 2-run
      //    alert are unchanged — asserted here and in test-textrequest-poll-run.ts.
      await clearPollState();
      const stopRows: TxrMessageRow[] = [120, 110, 100, 90].map((ago, i) => ({
        dashboard_phone: "18449903688", customer_phone: `1315591${sfx.slice(-3)}${i}`, customer_friendly_name: null,
        segments_count: 1, message_id: `guid-c-stop-${i}-${sfx}`, body: "STOP", message_direction: "R",
        message_timestamp_utc: iso(ago), delivery_status: null, delivery_error: null,
      }));
      await tx.execute(sql`
        INSERT INTO cron_locks (job_name, watermark) VALUES
          (${`textrequest-poll:gap-from:${dashboardId}:R`}, ${new Date(tsOf(stopRows[0]!)).toISOString()}::timestamptz),
          (${`textrequest-poll:gap-to:${dashboardId}:R`}, ${new Date(tsOf(stopRows[3]!) + 1000).toISOString()}::timestamptz)`);
      const cClk = { now: 0 };
      const cLog: FetchLog[] = [];
      const rC = await pollTxrMessages(tx as unknown as typeof db, {
        orgId, directions: ["R"], pageSize: 1, fetchMessages: pager(stopRows, "R", cClk, cLog), stateful: true,
      });
      const gapReads = cLog.filter((l) => l.sort === "asc").flatMap((l) => l.ts);
      check("C: the owed STOP range was read with sort=asc", gapReads.length === 4, JSON.stringify(cLog));
      check("C: STOPs were read oldest-first", gapReads.every((t, i) => i === 0 || t > gapReads[i - 1]!), JSON.stringify(gapReads));
      check("C: all 4 STOPs were captured and suppressed", rC.inbound_captured === 4 && rC.inbound_suppressed === 4, JSON.stringify(rC));
      const cDone = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM textrequest_inbound_events
        WHERE provider_id = ${prov.id} AND provider_uuid = ANY(${sql`ARRAY[${sql.join(stopRows.map((r) => sql`${r.message_id}`), sql`, `)}]::text[]`})
          AND result = 'suppressed' AND processed_at IS NOT NULL`)) as unknown as { n: number }[];
      check("C: each STOP row is stored processed (result suppressed, processed_at set)", cDone[0]?.n === 4, JSON.stringify(cDone));
      check("C: the inbound owed range is cleared and the R pass stamp written", rC.owed.length === 0 && (await hasPass("R")), JSON.stringify(rC.owed));
      check("C: the inbound 'no complete pass' alert is still 2 runs (35 min)", txrPassThresholdMin("R") === 35);
      await clearPollState();

      // ---- manual runs own no state (the race with a cron run mid-walk) ----
      // Seed an owed range and a pass stamp for BOTH directions, then run a
      // manual (stateful: false) poll that reads everything it asks for. It must
      // not delete the owed ranges and must not stamp passes.
      const seedAt = "2026-10-01T00:00:00.000Z";
      const seedKeys = (["R", "S"] as const).flatMap((d) => [
        `textrequest-poll:gap-from:${dashboardId}:${d}`,
        `textrequest-poll:gap-to:${dashboardId}:${d}`,
        txrPassKey(dashboardId, d),
      ]);
      for (const k of seedKeys) {
        await tx.execute(sql`INSERT INTO cron_locks (job_name, watermark) VALUES (${k}, ${seedAt}::timestamptz)`);
      }
      const manualCalls: string[] = [];
      const rManual = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture(async (o) => {
          manualCalls.push(`${o.direction}:${o.window.start_date}`);
          return { ok: true as const, items: [], totalItems: 0 };
        }),
      });
      const after = (await tx.execute(sql`
        SELECT job_name, watermark::text AS w FROM cron_locks
        WHERE job_name = ANY(${sql`ARRAY[${sql.join(seedKeys.map((k) => sql`${k}`), sql`, `)}]::text[]`})`)) as unknown as { job_name: string; w: string }[];
      check("manual run: every seeded owed range and pass stamp is still there (both directions)", after.length === seedKeys.length, JSON.stringify(after));
      check("manual run: none of them was rewritten", after.every((r) => new Date(r.w).toISOString() === seedAt), JSON.stringify(after));
      check("manual run: it does not read the owed range either (walks only its own window)",
        !manualCalls.some((c) => c.endsWith(seedAt)), JSON.stringify(manualCalls));
      check("manual run: walks completed (so a stateful run WOULD have cleared the ranges)", rManual.walks.every((w) => w.complete));
      await clearPollState();

      // ---- inbound pre-filter: skip only rows captured AND processed ----
      // X: stored + processed (processed_at set)  → skipped by the page lookup
      // Y: stored, processed_at NULL (a webhook capture whose processing failed)
      //    → NOT skipped: takes the per-row path, whose capture conflicts → dupe,
      //      exactly as before this change
      // Z: new → per-row path → captured + processed
      const mk = (id: string, body: string): TxrMessageRow => ({
        dashboard_phone: "18449903688", customer_phone: `13155890${id.length}${sfx.slice(-2)}`, customer_friendly_name: null,
        segments_count: 1, message_id: `${id}-${sfx}`, body, message_direction: "R",
        message_timestamp_utc: iso(5), delivery_status: null, delivery_error: null,
      });
      const X = mk("pf-x", "thanks"), Y = mk("pf-yy", "thanks"), Z = mk("pf-zzz", "thanks");
      await tx.execute(sql`
        INSERT INTO textrequest_inbound_events (org_id, credential_id, provider_id, source, method, provider_uuid, received_at, result, processed_at)
        VALUES (${orgId}, ${cred.id}, ${prov.id}, 'webhook_msg_received', 'POST', ${X.message_id}, now(), 'ignored', now()),
               (${orgId}, ${cred.id}, ${prov.id}, 'webhook_msg_received', 'POST', ${Y.message_id}, now(), NULL, NULL)`);
      const rPf = await pollTxrMessages(tx as unknown as typeof db, {
        orgId, directions: ["R"],
        fetchMessages: onlyFixture(async () => ({ ok: true as const, items: [X, Y, Z], totalItems: 3 })),
      });
      check("pre-filter: all 3 inbound rows seen", rPf.inbound_seen === 3, JSON.stringify(rPf));
      check("pre-filter: only the processed row (X) is skipped by the lookup", rPf.inbound_known === 1, JSON.stringify(rPf));
      check("pre-filter: the unprocessed row (Y) took the per-row path and conflicted, as before", rPf.inbound_dupe === 2, JSON.stringify(rPf));
      check("pre-filter: the new row (Z) was captured and processed", rPf.inbound_captured === 1, JSON.stringify(rPf));
      const yRow = (await tx.execute(sql`
        SELECT count(*)::int AS n, bool_and(processed_at IS NULL) AS still_unprocessed FROM textrequest_inbound_events
        WHERE provider_id = ${prov.id} AND provider_uuid = ${Y.message_id}`)) as unknown as { n: number; still_unprocessed: boolean }[];
      check("pre-filter: Y is unchanged (one row, still unprocessed — same as the per-row path leaves it)",
        yRow[0]?.n === 1 && yRow[0]?.still_unprocessed === true, JSON.stringify(yRow));
      const zRow = (await tx.execute(sql`
        SELECT result, processed_at IS NOT NULL AS done FROM textrequest_inbound_events
        WHERE provider_id = ${prov.id} AND provider_uuid = ${Z.message_id}`)) as unknown as { result: string; done: boolean }[];
      check("pre-filter: Z stored with result + processed_at in one go", zRow[0]?.done === true && zRow[0]?.result === "ignored", JSON.stringify(zRow));

      // ---- webhook health ----
      const ourUrl = `https://app.example.com/api/webhooks/textrequest/events/tok-${sfx}`;
      let reactivated: number[] = [];
      const hooks: TxrHook[] = [
        { id: 1, target_url: ourUrl, event: "msg_received", dashboard_id: 1, httpVerb: "POST", is_user_defined: false, is_connected: false },
        { id: 2, target_url: ourUrl, event: "contact_updated", dashboard_id: 1, httpVerb: "POST", is_user_defined: false, is_connected: true },
        // A third party's hook (Zapier etc.) that TR also disconnected — must be left alone.
        { id: 3, target_url: "https://hooks.zapier.com/abc", event: "msg_received", dashboard_id: 1, httpVerb: "POST", is_user_defined: true, is_connected: false },
        // Field absent -> unknown, must NOT be treated as disconnected.
        { id: 4, target_url: ourUrl, event: "msg_status_updated", dashboard_id: 1, httpVerb: "POST", is_user_defined: false, is_connected: null },
      ];
      const health = await checkTxrWebhookHealth(tx as unknown as typeof db, {
        orgId,
        listHooks: async (_k, d) => ({ ok: true as const, status: 200, hooks: d === dashboardId ? hooks : [], error: null }),
        reactivate: async (_k, _d, id) => {
          reactivated.push(id);
          return { ok: true as const, status: 204, error: null };
        },
      });
      check("health: our 3 hooks recognized, the foreign one excluded", health.ours === 3, JSON.stringify(health));
      check("health: 1 disconnected hook found", health.disconnected === 1, JSON.stringify(health));
      check("health: it was reactivated", health.reactivated === 1 && reactivated.join() === "1", JSON.stringify(reactivated));
      check("health: a third party's disconnected hook is NOT touched", !reactivated.includes(3));
      check("health: is_connected=null is left alone", !reactivated.includes(4));
      check(
        "health: nothing reported missing (all 3 required events present)",
        !health.missing.some((m) => m.startsWith(`${dashboardId}:`)),
        JSON.stringify(health.missing),
      );

      // Missing-event reporting (the normal pre-go-live state).
      reactivated = [];
      const health2 = await checkTxrWebhookHealth(tx as unknown as typeof db, {
        orgId,
        listHooks: async () => ({ ok: true as const, status: 200, hooks: [], error: null }), // no hooks anywhere
        reactivate: async () => ({ ok: true as const, status: 204, error: null }),
      });
      check(
        "health: with no hooks registered, all 3 required events are reported missing",
        ["msg_received", "contact_updated", "msg_status_updated"].every((e) =>
          health2.missing.includes(`${dashboardId}:${e}`),
        ),
        JSON.stringify(health2.missing),
      );
      check("health: missing hooks are NOT an alert-worthy disconnect", health2.disconnected === 0);

      const healthErr = await checkTxrWebhookHealth(tx as unknown as typeof db, {
        orgId,
        listHooks: async () => ({ ok: false as const, status: 401, hooks: [], error: "Text Request HTTP 401" }),
        reactivate: async () => ({ ok: true as const, status: 204, error: null }),
      });
      check("health: list failure is reported, not thrown", healthErr.error === "Text Request HTTP 401", JSON.stringify(healthErr));

      throw ROLLBACK;
    });
  } catch (e) {
    if (isLockContentionError(e)) {
      console.log(
        "\nSKIP (db half): could not acquire DDL locks on contacts/stage_sends within lock_timeout —" +
          " production traffic is writing to them right now. Pure checks above still ran.",
      );
    } else if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
