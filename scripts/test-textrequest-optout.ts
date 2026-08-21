// Text Request Phase 4 — opt-out intake. COMPLIANCE-CRITICAL, so the checks are
// about outcomes (is the number actually suppressed, exactly once, attributed to
// the right send) rather than about return shapes.
//
// Structure mirrors scripts/test-textrequest-poll.ts: pure payload parsing first,
// then a fully rolled-back transaction that applies migrations 0122-0124 inside
// itself (the txr migrations are deliberately not deployed until go-live).
//
// Run: npx tsx scripts/test-textrequest-optout.ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  applyTxrMigrationsInTx,
  isLockContentionError,
  TXR_MIGRATION_FILES,
} from "./_txr-migration-fixture";
import { textrequestPhoneToE164 } from "@/lib/sends/providers/textrequest";
import { pollTxrOptedOutContacts, type TxrContactRow } from "@/lib/sends/textrequest-contacts-poll";
import { recordTxrDlrOptOut, recordTxrSendRejectOptOuts } from "@/lib/sends/textrequest-dlr-optout";
import {
  classifyTxrWebhookPayload,
  contactUpdateIsOptOut,
  parseTxrContactUpdated,
  parseTxrMsgReceived,
} from "@/lib/sends/textrequest-inbound";
import { pollTxrMessages, type TxrMessageRow } from "@/lib/sends/textrequest-messages-poll";
import {
  captureTxrInboundEvent,
  isMessageShapedChannel,
  processTextrequestOptOut,
} from "@/lib/sends/textrequest-optout";

// Real bot token lives in .env.local — never let a test post to Telegram.
delete process.env.TELEGRAM_BOT_TOKEN;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ---------- 1. PURE: payload parsing ----------
console.log("— pure: msg_received payload (nested, camelCase) —");
const msgBody = {
  messageUniqueIdentifier: "eb2a0cc2-5b88-468b-b3f4-926b07bcb275",
  account: { id: 1414 },
  yourPhoneNumber: { id: 68093, phoneNumber: "18449903688" },
  conversation: {
    id: 21,
    date: "2026-07-25T14:03:11.5",
    consumerPhoneNumber: "18262062523",
    messageDirection: "R",
    message: "STOP",
    numSegments: 1,
  },
};
const msg = parseTxrMsgReceived(msgBody);
check("contact phone read from conversation.consumerPhoneNumber", msg?.contactPhone === "18262062523");
check("text read from conversation.message", msg?.message === "STOP");
check("direction read from conversation.messageDirection", msg?.direction === "R");
check("dashboard phone read from yourPhoneNumber.phoneNumber", msg?.dashboardPhone === "18449903688");
check("message GUID read from messageUniqueIdentifier", msg?.messageUuid === "eb2a0cc2-5b88-468b-b3f4-926b07bcb275");
check("a non-object body parses to null, not a throw", parseTxrMsgReceived("nope") === null);

console.log("\n— pure: contact_updated payload (flat, snake_case) —");
const optedOut = parseTxrContactUpdated({ phone_number: "18262062523", opted_out_utc: "2026-07-25T14:03:11", is_suppressed: false });
check("opted_out_utc is an opt-out", !!optedOut && contactUpdateIsOptOut(optedOut));
const suppressed = parseTxrContactUpdated({ phone_number: "18262062523", opted_out_utc: null, is_suppressed: true });
check("portal suppression (is_suppressed) is an opt-out too", !!suppressed && contactUpdateIsOptOut(suppressed));
const blockedOnly = parseTxrContactUpdated({ phone_number: "18262062523", opted_out_utc: null, is_suppressed: false, is_blocked: true });
check("is_blocked alone is NOT an opt-out (abuse control, not consent)", !!blockedOnly && !contactUpdateIsOptOut(blockedOnly));
const nameEdit = parseTxrContactUpdated({ phone_number: "18262062523", first_name: "Jo", opted_out_utc: null, is_suppressed: false });
check("a plain contact edit is NOT an opt-out", !!nameEdit && !contactUpdateIsOptOut(nameEdit));

console.log("\n— pure: event classification —");
check("?e= hint wins for msg_received", classifyTxrWebhookPayload("msg_received", {}) === "msg");
check("?e= hint wins for contact_updated", classifyTxrWebhookPayload("contact_updated", {}) === "contact");
check("?e= hint wins for msg_status_updated", classifyTxrWebhookPayload("msg_status_updated", {}) === "status");
check("no hint -> msg detected by shape", classifyTxrWebhookPayload(null, msgBody) === "msg");
check("no hint -> contact detected by shape", classifyTxrWebhookPayload(null, { phone_number: "1826" }) === "contact");
check(
  "no hint -> status detected by shape",
  classifyTxrWebhookPayload(null, { message_id: "g", status: "delivered" }) === "status",
);
check("unknown payload -> unknown", classifyTxrWebhookPayload(null, { foo: 1 }) === "unknown");

console.log("\n— pure: phone normalization + channel shape —");
check("11-digit TR wire format -> E.164", textrequestPhoneToE164("18262062523") === "+18262062523");
check("10-digit -> E.164", textrequestPhoneToE164("8262062523") === "+18262062523");
check("junk -> null (never a bogus contact)", textrequestPhoneToE164("123") === null && textrequestPhoneToE164(null) === null);
check("message-shaped channels are exactly the two message ones", isMessageShapedChannel("webhook_msg_received") && isMessageShapedChannel("poll_messages"));
check(
  "state-shaped channels are not message-shaped",
  !isMessageShapedChannel("webhook_contact_updated") &&
    !isMessageShapedChannel("poll_contacts") &&
    !isMessageShapedChannel("dlr") &&
    !isMessageShapedChannel("send_reject"),
);

// ---------- 2. DB-BACKED (rolled back) ----------
async function main() {
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const many = async <T>(q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];
      const sfx = Date.now().toString().slice(-9);

      await applyTxrMigrationsInTx(tx, TXR_MIGRATION_FILES);
      console.log("\n— db: migrations applied in-tx —");
      check("0122+0123+0124 apply cleanly", true);

      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const prov = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'txr'`);
      const cred = await one<{ id: number }>(sql`
        SELECT id FROM provider_credentials WHERE provider_id = ${prov.id} AND org_id = ${orgId} ORDER BY id LIMIT 1`);
      if (!prov || !cred) {
        console.log("SKIP: txr provider/credential missing.");
        throw ROLLBACK;
      }

      const dashboardId = `d${sfx}`;
      // Phone 114 (dashboard 68093) is CONFIGURED and live in production, so the
      // pollers resolve it alongside this fixture's dashboard. Every fake fetcher
      // answers only for the fixture's dashboard, otherwise these counts describe
      // the org's live config instead of the behaviour under test — which is what
      // silently turned this file red on main.
      type Ctx = { dashboardId: string; direction?: "S" | "R" };
      const onlyFixture =
        <T>(empty: T, f: (o: Ctx) => Promise<T>) =>
        async (o: Ctx) =>
          o.dashboardId === dashboardId ? f(o) : empty;
      await tx.execute(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, dashboard_id, credential_id, number_type, status)
        VALUES (${orgId}, ${prov.id}, ${"+1844" + sfx.slice(0, 7)}, ${dashboardId}, ${cred.id}, 'toll_free', 'active')`);

      // A live campaign + a recent send, so attribution has something to credit.
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"txropt-" + sfx}, 'txropt', 'active', 'manual') RETURNING id`);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, inbound_opt_out_count, opt_out_count)
        VALUES (${orgId}, ${camp.id}, 1, 0, 0) RETURNING id`);

      const wire = `1315586${sfx.slice(0, 4)}`;
      const e164 = `+${wire}`;
      const contact = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${e164})
        ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now() RETURNING id`);
      const send = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id, status, sent_at)
        VALUES (${orgId}, ${camp.id}, ${stage.id}, ${contact.id}, ${e164}, 'hi', ${"guid-sent-" + sfx}, 'sent', now())
        RETURNING id`);
      // A still-pending send to the same contact: a STOP must cancel it, not wait
      // for the drain's send-time re-check.
      const pending = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${camp.id}, ${stage.id}, ${contact.id}, ${e164}, 'hi again', 'pending')
        RETURNING id`);

      // ---- signal 1: msg_received STOP ----
      console.log("\n— db: signal 1 (msg_received STOP) —");
      const ev1 = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "webhook_msg_received",
        method: "POST", sourceNumber: wire, destinationNumber: "18449903688", message: "STOP",
        providerUuid: `guid-stop-${sfx}`, optedOutUtc: null, rawBody: "{}", receivedAt: new Date(),
      });
      check("capture returned a row", !!ev1);
      const r1 = await processTextrequestOptOut(tx, {
        eventId: ev1!.id, orgId, sourceNumber: wire, message: "STOP",
        channel: "webhook_msg_received", receivedAt: new Date(),
      });
      check("STOP -> suppressed", r1.kind === "suppressed", JSON.stringify(r1));
      check("STOP -> attributed to the recent send", r1.kind === "suppressed" && r1.attributed, JSON.stringify(r1));
      const oo1 = await many<{ id: number; source: string }>(sql`
        SELECT id, source FROM opt_outs WHERE org_id = ${orgId} AND contact_id = ${contact.id}`);
      check("exactly 1 opt_outs row", oo1.length === 1, JSON.stringify(oo1));
      check("opt_outs.source tags the real-time webhook channel", oo1[0]?.source === "textrequest_inbound_webhook", JSON.stringify(oo1));
      const attr = await many<{ stage_send_id: string }>(sql`
        SELECT stage_send_id FROM opt_out_attributions WHERE opt_out_id = ${oo1[0]!.id}`);
      check("attribution points at the most recent send", attr[0]?.stage_send_id === send.id, JSON.stringify(attr));
      const pendRow = await one<{ status: string; last_error: string | null }>(sql`
        SELECT status, last_error FROM stage_sends WHERE id = ${pending.id}`);
      check("pending send cascade-cancelled to skipped_opted_out", pendRow.status === "skipped_opted_out", JSON.stringify(pendRow));
      check("cancel reason is the distinct opt_out_cancel bucket", pendRow.last_error === "opt_out_cancel");
      const stageRow = await one<{ opt_out_count: number; inbound_opt_out_count: number }>(sql`
        SELECT opt_out_count, inbound_opt_out_count FROM campaign_stages WHERE id = ${stage.id}`);
      check("stage opt-out counters bumped to 1", Number(stageRow.opt_out_count) === 1 && Number(stageRow.inbound_opt_out_count) === 1, JSON.stringify(stageRow));

      // ---- cross-channel dedup: the poll re-reads that same STOP ----
      console.log("\n— db: cross-channel dedup (same message via the poll) —");
      const dupCapture = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "poll_messages",
        method: "poll", sourceNumber: wire, destinationNumber: "18449903688", message: "STOP",
        providerUuid: `guid-stop-${sfx}`, optedOutUtc: null, rawBody: "{}", receivedAt: new Date(),
      });
      check("same message GUID on another channel is dropped by the unique index", dupCapture === null);

      // ---- signal 2: contact_updated for the SAME number (no shared GUID) ----
      const ev2 = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "webhook_contact_updated",
        method: "POST", sourceNumber: wire, destinationNumber: null, message: null,
        providerUuid: null, optedOutUtc: new Date(), rawBody: "{}", receivedAt: new Date(),
      });
      const r2 = await processTextrequestOptOut(tx, {
        eventId: ev2!.id, orgId, sourceNumber: wire, message: null,
        channel: "webhook_contact_updated", receivedAt: new Date(),
      });
      check("contact_updated for an already-suppressed number is deduped", r2.kind === "duplicate", JSON.stringify(r2));
      const ooAfter = await many<{ id: number }>(sql`
        SELECT id FROM opt_outs WHERE org_id = ${orgId} AND contact_id = ${contact.id}`);
      check("still exactly 1 opt_outs row (no double-write)", ooAfter.length === 1, JSON.stringify(ooAfter));
      const attrAfter = await many<{ id: number }>(sql`
        SELECT id FROM opt_out_attributions WHERE stage_send_id = ${send.id}`);
      check("still exactly 1 attribution (no double-count)", attrAfter.length === 1, JSON.stringify(attrAfter));
      const stageAfter = await one<{ opt_out_count: number }>(sql`
        SELECT opt_out_count FROM campaign_stages WHERE id = ${stage.id}`);
      check("stage counter still 1", Number(stageAfter.opt_out_count) === 1, JSON.stringify(stageAfter));

      // ---- state signals act ONCE, even long after the window ----
      console.log("\n— db: a state signal outside the dedup window still acts only once —");
      const ev3 = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "poll_contacts",
        method: "poll", sourceNumber: wire, destinationNumber: null, message: null,
        providerUuid: null, optedOutUtc: null, rawBody: "{}",
        receivedAt: new Date(Date.now() + 48 * 3600_000), // two days later: dedup window can't reach
      });
      const r3 = await processTextrequestOptOut(tx, {
        eventId: ev3!.id, orgId, sourceNumber: wire, message: null,
        channel: "poll_contacts", receivedAt: new Date(Date.now() + 48 * 3600_000),
      });
      check(
        "already_opted_out (not a second opt_out row) — this is what stops has_opted_out=true re-attributing forever",
        r3.kind === "already_opted_out",
        JSON.stringify(r3),
      );
      const ooFinal = await many<{ id: number }>(sql`
        SELECT id FROM opt_outs WHERE org_id = ${orgId} AND contact_id = ${contact.id}`);
      check("STILL exactly 1 opt_outs row", ooFinal.length === 1, JSON.stringify(ooFinal));

      // ---- keyword gate: message-shaped only ----
      console.log("\n— db: keyword gate —");
      const chatWire = `1315587${sfx.slice(0, 4)}`;
      const ev4 = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "webhook_msg_received",
        method: "POST", sourceNumber: chatWire, destinationNumber: null, message: "thanks!",
        providerUuid: `guid-chat-${sfx}`, optedOutUtc: null, rawBody: "{}", receivedAt: new Date(),
      });
      const r4 = await processTextrequestOptOut(tx, {
        eventId: ev4!.id, orgId, sourceNumber: chatWire, message: "thanks!",
        channel: "webhook_msg_received", receivedAt: new Date(),
      });
      check("a non-keyword reply is ignored", r4.kind === "ignored", JSON.stringify(r4));
      const noOptOut = await many<unknown>(sql`
        SELECT 1 FROM opt_outs o JOIN contacts c2 ON c2.id = o.contact_id
        WHERE o.org_id = ${orgId} AND c2.phone_number = ${"+" + chatWire}`);
      check("no opt_out written for a chatty reply", noOptOut.length === 0);

      const stateWire = `1315588${sfx.slice(0, 4)}`;
      const ev5 = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "poll_contacts",
        method: "poll", sourceNumber: stateWire, destinationNumber: null, message: null,
        providerUuid: null, optedOutUtc: new Date(), rawBody: "{}", receivedAt: new Date(),
      });
      const r5 = await processTextrequestOptOut(tx, {
        eventId: ev5!.id, orgId, sourceNumber: stateWire, message: null,
        channel: "poll_contacts", receivedAt: new Date(),
      });
      check("a state signal with no text still suppresses (no keyword needed)", r5.kind === "suppressed", JSON.stringify(r5));
      check("suppressing an unknown number created the contact", r5.kind === "suppressed" && !!r5.contactId);

      // ---- invalid phone ----
      const ev6 = await captureTxrInboundEvent(tx, {
        orgId, credentialId: cred.id, providerId: prov.id, channel: "webhook_msg_received",
        method: "POST", sourceNumber: "123", destinationNumber: null, message: "STOP",
        providerUuid: `guid-bad-${sfx}`, optedOutUtc: null, rawBody: "{}", receivedAt: new Date(),
      });
      const r6 = await processTextrequestOptOut(tx, {
        eventId: ev6!.id, orgId, sourceNumber: "123", message: "STOP",
        channel: "webhook_msg_received", receivedAt: new Date(),
      });
      check("an unparseable number is invalid_phone, not a bogus contact", r6.kind === "invalid_phone", JSON.stringify(r6));

      // ---- signal 3a: messages poll inbound branch ----
      console.log("\n— db: signal 3a (messages poll inbound STOP) —");
      const pollWire = `1315589${sfx.slice(0, 4)}`;
      const inboundRows: TxrMessageRow[] = [
        { dashboard_phone: "18449903688", customer_phone: pollWire, customer_friendly_name: null, segments_count: 1, message_id: `guid-pollstop-${sfx}`, body: "Stop please", message_direction: "R", message_timestamp_utc: "2026-07-25T12:00:00", delivery_status: null, delivery_error: null },
        { dashboard_phone: "18449903688", customer_phone: pollWire, customer_friendly_name: null, segments_count: 1, message_id: `guid-pollchat-${sfx}`, body: "ok thanks", message_direction: "R", message_timestamp_utc: "2026-07-25T12:01:00", delivery_status: null, delivery_error: null },
      ];
      const pr = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture({ ok: true as const, items: [], totalItems: 0 }, async (o) => {
          const items = o.direction ? inboundRows.filter((r) => r.message_direction === o.direction) : inboundRows;
          return { ok: true as const, items, totalItems: items.length };
        }),
      });
      check("poll saw 2 inbound rows", pr.inbound_seen === 2, JSON.stringify(pr));
      check("poll captured both", pr.inbound_captured === 2, JSON.stringify(pr));
      check("only the STOP suppressed", pr.inbound_suppressed === 1, JSON.stringify(pr));
      const pollOptOut = await many<{ source: string }>(sql`
        SELECT o.source FROM opt_outs o JOIN contacts c3 ON c3.id = o.contact_id
        WHERE o.org_id = ${orgId} AND c3.phone_number = ${"+" + pollWire}`);
      check("poll-sourced opt_out tagged textrequest_messages_poll", pollOptOut[0]?.source === "textrequest_messages_poll", JSON.stringify(pollOptOut));
      const prAgain = await pollTxrMessages(tx as unknown as typeof db, {
        orgId,
        fetchMessages: onlyFixture({ ok: true as const, items: [], totalItems: 0 }, async (o) => {
          const items = o.direction ? inboundRows.filter((r) => r.message_direction === o.direction) : inboundRows;
          return { ok: true as const, items, totalItems: items.length };
        }),
      });
      check("re-poll: both inbound rows deduped by GUID", prAgain.inbound_dupe === 2 && prAgain.inbound_captured === 0, JSON.stringify(prAgain));

      // ---- signal 3b: contacts poll ----
      console.log("\n— db: signal 3b (contacts poll) —");
      const cWire = `1315590${sfx.slice(0, 4)}`;
      const contactRows: TxrContactRow[] = [
        { phone_number: cWire, is_suppressed: false, is_blocked: false, suppressed_reason: null, opted_out_utc: "2026-07-25T12:30:00", last_msg_received_utc: "2026-07-25T12:30:00" },
        // Already handled above via signal 1 — must be recognized, not re-written.
        { phone_number: wire, is_suppressed: false, is_blocked: false, suppressed_reason: null, opted_out_utc: "2026-07-25T12:31:00", last_msg_received_utc: "2026-07-25T12:31:00" },
      ];
      const cr = await pollTxrOptedOutContacts(tx as unknown as typeof db, {
        orgId,
        fetchContacts: onlyFixture({ ok: true as const, items: [], totalItems: 0 }, async () => ({
          ok: true as const,
          items: contactRows,
          totalItems: contactRows.length,
        })),
      });
      check("contacts poll: both rows actionable", cr.actionable === 2, JSON.stringify(cr));
      check("contacts poll: the known one is skipped without a row", cr.already_recorded === 1, JSON.stringify(cr));
      check("contacts poll: the new one is suppressed", cr.suppressed === 1, JSON.stringify(cr));
      const cOptOut = await many<{ source: string }>(sql`
        SELECT o.source FROM opt_outs o JOIN contacts c4 ON c4.id = o.contact_id
        WHERE o.org_id = ${orgId} AND c4.phone_number = ${"+" + cWire}`);
      check("contacts-poll opt_out tagged textrequest_contacts_poll", cOptOut[0]?.source === "textrequest_contacts_poll", JSON.stringify(cOptOut));
      const crAgain = await pollTxrOptedOutContacts(tx as unknown as typeof db, {
        orgId,
        fetchContacts: onlyFixture({ ok: true as const, items: [], totalItems: 0 }, async () => ({
          ok: true as const,
          items: contactRows,
          totalItems: contactRows.length,
        })),
      });
      check("re-poll: nothing new (both already recorded)", crAgain.suppressed === 0 && crAgain.already_recorded === 2, JSON.stringify(crAgain));

      // ---- signal 4a: DLR errorCode 2100 ----
      console.log("\n— db: signal 4a (DLR errorCode 2100) —");
      const dlrWire = `1315591${sfx.slice(0, 4)}`;
      const dlrContact = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+" + dlrWire})
        ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now() RETURNING id`);
      const dlrSend = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id, status, sent_at)
        VALUES (${orgId}, ${camp.id}, ${stage.id}, ${dlrContact.id}, ${"+" + dlrWire}, 'hi', ${"guid-dlr-" + sfx}, 'sent', now())
        RETURNING id`);
      await recordTxrDlrOptOut(tx as unknown as typeof db, {
        orgId, credentialId: cred.id, providerId: prov.id, errorCode: "2100",
        matchedStageSendId: dlrSend.id, messageId: `guid-dlr-${sfx}`, rawBody: "{}", receivedAt: new Date(),
      });
      const dlrOptOut = await many<{ source: string }>(sql`
        SELECT source FROM opt_outs WHERE org_id = ${orgId} AND contact_id = ${dlrContact.id}`);
      check("errorCode 2100 wrote an opt_out for the send's recipient", dlrOptOut.length === 1, JSON.stringify(dlrOptOut));
      check("tagged textrequest_dlr_optout", dlrOptOut[0]?.source === "textrequest_dlr_optout");
      await recordTxrDlrOptOut(tx as unknown as typeof db, {
        orgId, credentialId: cred.id, providerId: prov.id, errorCode: "2100",
        matchedStageSendId: dlrSend.id, messageId: `guid-dlr-${sfx}`, rawBody: "{}", receivedAt: new Date(),
      });
      const dlrOptOutAgain = await many<unknown>(sql`
        SELECT 1 FROM opt_outs WHERE org_id = ${orgId} AND contact_id = ${dlrContact.id}`);
      check("the same DLR twice writes only one opt_out", dlrOptOutAgain.length === 1, JSON.stringify(dlrOptOutAgain));

      const benign = await recordTxrDlrOptOut(tx as unknown as typeof db, {
        orgId, credentialId: cred.id, providerId: prov.id, errorCode: "30006",
        matchedStageSendId: dlrSend.id, messageId: `guid-dlr2-${sfx}`, rawBody: "{}", receivedAt: new Date(),
      });
      check("a non-opt-out error code (30006 landline) writes nothing", benign === null);
      const unmatched = await recordTxrDlrOptOut(tx as unknown as typeof db, {
        orgId, credentialId: cred.id, providerId: prov.id, errorCode: "2100",
        matchedStageSendId: null, messageId: `guid-orphan-${sfx}`, rawBody: "{}", receivedAt: new Date(),
      });
      check("an unmatched 2100 DLR is skipped (no recipient to guess)", unmatched === null);

      // ---- signal 4b: send-time reject 30050 ----
      console.log("\n— db: signal 4b (send-time reject) —");
      const rejWire = `1315592${sfx.slice(0, 4)}`;
      const rej = await recordTxrSendRejectOptOuts(tx as unknown as typeof db, {
        orgId, credentialId: cred.id, providerId: prov.id, phones: [`+${rejWire}`, `+${rejWire}`],
      });
      check("a rejected recipient is suppressed exactly once (deduped input)", rej.suppressed === 1, JSON.stringify(rej));
      const rejOptOut = await many<{ source: string }>(sql`
        SELECT o.source FROM opt_outs o JOIN contacts c5 ON c5.id = o.contact_id
        WHERE o.org_id = ${orgId} AND c5.phone_number = ${"+" + rejWire}`);
      check("tagged textrequest_send_reject", rejOptOut[0]?.source === "textrequest_send_reject", JSON.stringify(rejOptOut));
      const rej2 = await recordTxrSendRejectOptOuts(tx as unknown as typeof db, {
        orgId, credentialId: cred.id, providerId: prov.id, phones: [`+${rejWire}`],
      });
      check("a later run recognizes it instead of re-writing", rej2.suppressed === 0 && rej2.already === 1, JSON.stringify(rej2));

      throw ROLLBACK;
    });
  } catch (e) {
    if (isLockContentionError(e)) {
      // The txr tables reference contacts/stage_sends, and this database is
      // shared with production — a live send or poller was writing to them, so
      // the fixture's DDL couldn't take its locks within lock_timeout. Skipping
      // is correct: never queue behind (or deadlock with) real traffic to run a
      // test. Re-run when the drain is idle, or apply 0121-0124 for real and the
      // fixture becomes a no-op that can't contend at all.
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
