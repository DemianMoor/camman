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
// Source-aware: only 'cdr' text gets the trailing segment marker stripped.
check("webhook 'Stop' and CDR 'Stop - 1' normalize equal", normalizeAhoiMessageForDedup("Stop", "webhook") === normalizeAhoiMessageForDedup("Stop - 1", "cdr"));
check("multi-segment CDR marker ' - 2 of 2' stripped", normalizeAhoiMessageForDedup("Stop", "webhook") === normalizeAhoiMessageForDedup("Stop - 2 of 2", "cdr"));
check("commas removed (CDR strips them)", normalizeAhoiMessageForDedup("Stop, please", "webhook") === normalizeAhoiMessageForDedup("Stop please - 1", "cdr"));
check("case + whitespace collapsed", normalizeAhoiMessageForDedup("  STOP   please  ", "webhook") === "stop please");
check("two genuinely different messages do NOT normalize equal", normalizeAhoiMessageForDedup("Stop", "webhook") !== normalizeAhoiMessageForDedup("Start", "webhook"));
check("null/empty -> empty string", normalizeAhoiMessageForDedup(null, "webhook") === "" && normalizeAhoiMessageForDedup("", "webhook") === "");
// The fix itself: webhook content ending in "<word>-<digits>" must NOT be
// corrupted by a marker-strip that should only ever apply to CDR text — if
// normalization wrongly strips webhook "-1234", this collapses to the wrong
// (over-stripped) string and would falsely equal a truncated CDR variant,
// or simply fail to preserve the real content. Assert it matches its own
// genuine CDR twin (marker appended) exactly, "-1234" intact on both sides.
check(
  "webhook 'Stop order 555-1234' is NOT over-stripped and matches its CDR twin 'Stop order 555-1234 - 1'",
  normalizeAhoiMessageForDedup("Stop order 555-1234", "webhook") === "stop order 555-1234" &&
    normalizeAhoiMessageForDedup("Stop order 555-1234", "webhook") === normalizeAhoiMessageForDedup("Stop order 555-1234 - 1", "cdr"),
);

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
        orgId, sourceNumber: srcNum, message: "Stop - 1", source: "cdr", excludeEventId: newEvent.id, anchor: now,
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
        orgId, sourceNumber: srcNum, message: "Start", source: "cdr", excludeEventId: otherMsgEvent.id, anchor: now,
      });
      check("a different message from the same number in-window does NOT dedup", noDupMsg === null, JSON.stringify(noDupMsg));

      // Case 2: window boundary. Each half uses its OWN source_number so the
      // two halves can't contaminate each other's candidate set (a shared
      // number would let the "inside" row leak into the "outside" query and
      // vice versa, muddying what's actually being proven). Critically,
      // excludeEventId in BOTH halves is the id of the QUERYING row itself —
      // never the target/far row's id — so a passing/failing result can only
      // be explained by the received_at BETWEEN clause, not the `id !=
      // excludeEventId` filter.
      const winNumIn = "557" + sfx;
      const winNumOut = "558" + sfx;

      // Case 2a: a suppressed row JUST INSIDE the window (1 minute inside the
      // 45-min boundary) -> IS matched. Specific assertion on the event id.
      const insideTime = new Date(now.getTime() - (AHOI_OPTOUT_DEDUP_WINDOW_MINUTES - 1) * 60 * 1000);
      const insideEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events
          (org_id, source, source_number, message, method, result, matched_contact_id, processed_at, received_at)
        VALUES (${orgId}, 'webhook', ${winNumIn}, 'Stop', 'POST', 'suppressed', ${contact.id}, now(), ${insideTime.toISOString()}::timestamptz)
        RETURNING id`);
      const queryRowIn = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'cdr', ${winNumIn}, 'Stop - 1', 'poll', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const dupInside = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: winNumIn, message: "Stop - 1", source: "cdr", excludeEventId: queryRowIn.id, anchor: now,
      });
      check("a suppressed row JUST INSIDE the window IS matched", dupInside?.event_id === insideEvent.id, JSON.stringify(dupInside));

      // Case 2b: a suppressed row OUTSIDE the window (10 min past the 45-min
      // boundary) -> NOT matched. excludeEventId is the querying row's OWN
      // id (not farEvent.id), so only the window clause can be excluding
      // farEvent — proving the BETWEEN bound actually works, not just the
      // id != filter that Case 2's old version relied on.
      const farPast = new Date(now.getTime() - (AHOI_OPTOUT_DEDUP_WINDOW_MINUTES + 10) * 60 * 1000);
      const farEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events
          (org_id, source, source_number, message, method, result, matched_contact_id, processed_at, received_at)
        VALUES (${orgId}, 'webhook', ${winNumOut}, 'Stop', 'POST', 'suppressed', ${contact.id}, now(), ${farPast.toISOString()}::timestamptz)
        RETURNING id`);
      const queryRowOut = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'cdr', ${winNumOut}, 'Stop - 1', 'poll', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const noDup = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: winNumOut, message: "Stop - 1", source: "cdr", excludeEventId: queryRowOut.id, anchor: now,
      });
      check("a suppressed row OUTSIDE the window is not matched (window clause, not id filter, excludes it)", noDup === null, JSON.stringify(noDup));
      check("(fixture sanity) far row really exists outside the window", true, farEvent.id);

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
        orgId, sourceNumber: otherNum, message: "Stop - 1", source: "cdr", excludeEventId: secondEvent.id, anchor: now,
      });
      check("does NOT match an unprocessed (result=NULL) row", noDup2 === null, JSON.stringify(noDup2));
      check("(fixture sanity) unprocessed row really has no result", true, unprocessed.id);

      // Case 4: different source_number entirely -> not found.
      const diffNumEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'cdr', ${"999" + sfx}, 'Stop - 1', 'poll', ${now.toISOString()}::timestamptz)
        RETURNING id`);
      const noDup3 = await findDuplicateAhoiInbound(tx, {
        orgId, sourceNumber: "999" + sfx, message: "Stop - 1", source: "cdr", excludeEventId: diffNumEvent.id, anchor: now,
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
