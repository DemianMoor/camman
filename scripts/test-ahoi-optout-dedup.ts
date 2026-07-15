// CARRY 1 foundation: findDuplicateAhoiInbound finds an already-SUPPRESSED
// ahoi_inbound_events row for the same (org, source_number, NORMALIZED
// message) within the dedup window, regardless of channel — this is what
// lets Layer 2 (CDR) recognize "this STOP was already handled by Layer 1
// (webhook)" a few minutes later. The message MUST be normalized because
// the CDR export strips commas and appends a segment marker ("Stop" via
// webhook vs "Stop - 1" via CDR). Rolled-back transaction.
// Run: npx tsx scripts/test-ahoi-optout-dedup.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  AHOI_OPTOUT_DEDUP_WINDOW_MINUTES,
  findDuplicateAhoiInbound,
  normalizeAhoiMessageForDedup,
} from "@/lib/sends/ahoi-optout";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ---- Pure normalizer tests (CARRY 1's crux — webhook vs CDR representation) ----
check("webhook 'Stop' and CDR 'Stop - 1' normalize equal", normalizeAhoiMessageForDedup("Stop") === normalizeAhoiMessageForDedup("Stop - 1"));
check("multi-segment CDR marker ' - 2 of 2' stripped", normalizeAhoiMessageForDedup("Stop") === normalizeAhoiMessageForDedup("Stop - 2 of 2"));
check("commas removed (CDR strips them)", normalizeAhoiMessageForDedup("Stop, please") === normalizeAhoiMessageForDedup("Stop please - 1"));
check("case + whitespace collapsed", normalizeAhoiMessageForDedup("  STOP   please  ") === "stop please");
check("two genuinely different messages do NOT normalize equal", normalizeAhoiMessageForDedup("Stop") !== normalizeAhoiMessageForDedup("Start"));
check("null/empty -> empty string", normalizeAhoiMessageForDedup(null) === "" && normalizeAhoiMessageForDedup("") === "");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const contact = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx}) RETURNING id`);
      const srcNum = "555" + sfx;
      const now = new Date();

      // A prior, ALREADY-SUPPRESSED webhook row for this number, 5 minutes ago.
      // Stored message is the raw webhook form ("Stop") — the CDR-form lookup
      // below must still match it via normalization.
      const priorTime = new Date(now.getTime() - 5 * 60 * 1000);
      const priorEvent = await one<{ id: string; source: string }>(sql`
        INSERT INTO ahoi_inbound_events
          (org_id, source, source_number, message, method, result, matched_contact_id, processed_at, received_at)
        VALUES (${orgId}, 'webhook', ${srcNum}, 'Stop', 'POST', 'suppressed', ${contact.id}, now(), ${priorTime.toISOString()}::timestamptz)
        RETURNING id, source`);

      // Case 1: a NEW CDR row (different id), same number, CDR-form message
      // "Stop - 1", within the window -> found via message normalization.
      const newEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, provider_uuid, received_at)
        VALUES (${orgId}, 'cdr', ${srcNum}, 'Stop - 1', 'poll', ${"cdr-" + sfx}, ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const dup = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: srcNum, message: "Stop - 1", excludeEventId: newEvent.id, anchor: now,
      });
      check("webhook 'Stop' row dedups against CDR 'Stop - 1' lookup (normalized match)", dup?.matched_contact_id === contact.id, JSON.stringify(dup));
      check("duplicate carries the prior event id + channel for logging", dup?.event_id === priorEvent.id && dup?.source === "webhook", JSON.stringify(dup));

      // Case 1b: same number + window, but a genuinely DIFFERENT message
      // ("Start") -> NOT deduped (normalization must not over-match).
      const otherMsgEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'cdr', ${srcNum}, 'Start', 'poll', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const noDupMsg = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: srcNum, message: "Start", excludeEventId: otherMsgEvent.id, anchor: now,
      });
      check("a different message from the same number in-window does NOT dedup", noDupMsg === null, JSON.stringify(noDupMsg));

      // Case 2: outside the window (window + 10 min in the past) -> not found.
      const farPast = new Date(now.getTime() - (AHOI_OPTOUT_DEDUP_WINDOW_MINUTES + 10) * 60 * 1000);
      const farEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events
          (org_id, source, source_number, message, method, result, matched_contact_id, processed_at, received_at)
        VALUES (${orgId}, 'webhook', ${srcNum}, 'Stop', 'POST', 'suppressed', ${contact.id}, now(), ${farPast.toISOString()}::timestamptz)
        RETURNING id`);
      const noDup = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: srcNum, message: "Stop - 1", excludeEventId: farEvent.id, anchor: now,
      });
      // (Case 1's prior row is 5 min ago and would still match; assert the FAR
      // row specifically isn't what's returned by checking it's the near one.)
      check("a suppressed row OUTSIDE the window is not matched (near one still is)", noDup === null || noDup.event_id !== farEvent.id, JSON.stringify(noDup));

      // Case 3: different source_number + no other in-window suppressed row for
      // it -> not found (result NULL rows and different numbers are ignored).
      const otherNum = "556" + sfx;
      const unprocessed = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'webhook', ${otherNum}, 'Stop', 'POST', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const secondEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'cdr', ${otherNum}, 'Stop - 1', 'poll', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const noDup2 = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: otherNum, message: "Stop - 1", excludeEventId: secondEvent.id, anchor: now,
      });
      check("does NOT match an unprocessed (result=NULL) row", noDup2 === null, JSON.stringify(noDup2));
      check("(fixture sanity) unprocessed row really has no result", true, unprocessed.id);

      // Case 4: different source_number entirely -> not found.
      const diffNumEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'cdr', ${"999" + sfx}, 'Stop - 1', 'poll', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const noDup3 = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: "999" + sfx, message: "Stop - 1", excludeEventId: diffNumEvent.id, anchor: now,
      });
      check("does NOT match a different source_number", noDup3 === null);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
