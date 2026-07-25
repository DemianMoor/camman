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

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { applyTxrMigrationsInTx, isLockContentionError } from "./_txr-migration-fixture";
import { checkTxrWebhookHealth, type TxrHook } from "@/lib/sends/textrequest-hooks";
import {
  computeTxrMessagesWindow,
  parseTxrUtcTimestamp,
  planTxrPageWalk,
  pollTxrMessages,
  type TxrMessageRow,
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

console.log("\n— pure: backwards page walk —");
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
      const prov = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'txr'`);
      if (!prov) {
        console.log("SKIP: no txr provider row (migration 0120 not applied).");
        throw ROLLBACK;
      }
      const cred = await one<{ id: number }>(sql`
        SELECT id FROM provider_credentials WHERE provider_id = ${prov.id} AND org_id = ${orgId} ORDER BY id LIMIT 1`);
      if (!cred) {
        console.log("SKIP: no txr credential row.");
        throw ROLLBACK;
      }

      // A txr sending number bound to that credential + a dashboard. The real
      // phone 114 has dashboard_id/credential_id still NULL (go-live config), so
      // the poll finds nothing in production yet — exactly the safe no-op we
      // want. This fixture is what a CONFIGURED number looks like.
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
      const fetchMessages = async () => ({ ok: true as const, items: rows, totalItems: rows.length });

      const r1 = await pollTxrMessages(tx as unknown as typeof db, { orgId, fetchMessages });
      check("poll: 1 dashboard polled", r1.dashboards_polled === 1, JSON.stringify(r1));
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
        fetchMessages: async () => ({ ok: true as const, items: changed, totalItems: 1 }),
      });
      check("state change (delivered -> undelivered) is captured, not deduped", r3.captured === 1, JSON.stringify(r3));
      const errRow = (await tx.execute(sql`
        SELECT status, error_code FROM textrequest_dlr_events
        WHERE message_id = ${knownMsgId} AND status = 'undelivered'`)) as unknown as { status: string; error_code: string | null }[];
      check("delivery_error lands in error_code (2100)", errRow[0]?.error_code === "2100", JSON.stringify(errRow[0]));

      // Truncation is reported, never silent.
      const rTrunc = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        maxPages: 1,
        pageSize: 1,
        fetchMessages: async () => ({ ok: true as const, items: [rows[1]!], totalItems: 50 }),
      });
      check("page cap sets truncated=true", rTrunc.truncated === true, JSON.stringify(rTrunc));

      // A fetch failure must not throw out of the poll.
      const rFail = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: async () => ({ ok: false as const, error: "HTTP 500" }),
      });
      check("fetch failure is reported, not thrown", rFail.error === "HTTP 500" && rFail.captured === 0, JSON.stringify(rFail));

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
        listHooks: async () => ({ ok: true as const, status: 200, hooks, error: null }),
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
      check("health: nothing reported missing (all 3 required events present)", health.missing.length === 0, JSON.stringify(health.missing));

      // Missing-event reporting (the normal pre-go-live state).
      reactivated = [];
      const health2 = await checkTxrWebhookHealth(tx as unknown as typeof db, {
        orgId,
        listHooks: async () => ({ ok: true as const, status: 200, hooks: [], error: null }),
        reactivate: async () => ({ ok: true as const, status: 204, error: null }),
      });
      check(
        "health: with no hooks registered, all 3 required events are reported missing",
        health2.missing.length === 3 && health2.missing.every((m) => m.startsWith(`${dashboardId}:`)),
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
