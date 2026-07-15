// CDR poll: (1) pure ET-window computation incl. the midnight-boundary case,
// (2) idempotent capture + direction filter via an injected fetcher, rolled
// back in a transaction (no real Ahoi network, no data survives).
// Run: npx tsx scripts/test-ahoi-cdr-poll.ts
import "./_env-preload";
import { sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";

import { db, sql as pgConn } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { computeCdrPollWindow, pollAhoiCdr, type AhoiCdrRow } from "@/lib/sends/ahoi-cdr-poll";
import { processAhoiInboundOptOut } from "@/lib/sends/ahoi-optout";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ---- Pure window computation ----
// Ordinary midday moment: startdate is literally "yesterday", enddate "today".
const midday = new Date("2026-07-15T18:00:00Z"); // ~2pm ET (no DST edge)
const w1 = computeCdrPollWindow(midday);
check("midday: enddate = today (ET)", w1.enddate === formatInTimeZone(midday, CAMPAIGN_TIMEZONE, "MM/dd/yyyy"), JSON.stringify(w1));
check(
  "midday: startdate = yesterday (ET)",
  w1.startdate === formatInTimeZone(new Date(midday.getTime() - 24 * 3600 * 1000), CAMPAIGN_TIMEZONE, "MM/dd/yyyy"),
  JSON.stringify(w1),
);

// ET-midnight boundary: a moment just after midnight ET must still treat
// "yesterday" as the PRIOR calendar date, not itself (this is the exact case
// campaignDayBoundsUtc's 1-hour-before-boundary trick is built for).
const justAfterMidnightEt = new Date("2026-07-15T04:05:00Z"); // 00:05 ET (summer, UTC-4)
const w2 = computeCdrPollWindow(justAfterMidnightEt);
check("just-after-ET-midnight: enddate is TODAY's ET date", w2.enddate === "07/15/2026", JSON.stringify(w2));
check("just-after-ET-midnight: startdate is YESTERDAY's ET date, not today's", w2.startdate === "07/14/2026", JSON.stringify(w2));

// A message uuid dated 23:59 ET the day before is inside BOTH a poll run at
// 00:05 ET (today) and one at 23:00 ET (yesterday) -> covered twice by
// design; idempotent INSERT (below) proves it lands exactly once.
const lateNightEt = new Date("2026-07-15T03:59:00Z"); // 23:59 ET the prior day
const w3 = computeCdrPollWindow(lateNightEt);
check(
  "23:59-ET-prior-day poll's window START <= that late-night date <= its END (straddles correctly)",
  w3.startdate <= "07/14/2026" && w3.enddate >= "07/14/2026",
  JSON.stringify(w3),
);

// ---- DB-backed: idempotent capture + direction filter (rolled-back tx) ----
async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      // pollAhoiCdr targets the credential of the provider whose
      // sms_provider_id = 'ahoi' (seeded in Section 1). Run against it directly
      // with an INJECTED fetcher (no network) and a rolled-back tx, so nothing
      // survives. Count assertions below assume the single seeded provider-
      // default ahoi credential this single-org install has (MEMORY: org count
      // = 1); `new`/`dupe` dedup by (provider_id, provider_uuid) so they're
      // robust even if extra ahoi credentials existed, and `inbound` is 1 per
      // credential.
      const realAhoi = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahoi'`);
      if (!realAhoi) { console.log("SKIP: no seeded ahoi provider row (run Section 1's seed)."); throw ROLLBACK; }

      const rows: AhoiCdrRow[] = [
        { date: "07/15/2026 10:00:00", your_cost: "0", submaster_id: "1", user_id: "1", submaster_cost: "0", user_cost: "0", surcharge: "0", src: "5642155963", dst: "3158359592", message: "Stop", direction: "in", alpha: "", msg_type: "sms", uuid: `cdrtest-${sfx}-1` },
        { date: "07/15/2026 10:01:00", your_cost: "0.0035", submaster_id: "1", user_id: "1", submaster_cost: "0", user_cost: "0", surcharge: "0", src: "3158359592", dst: "5642155963", message: "Hi", direction: "out", alpha: "", msg_type: "sms", uuid: `cdrtest-${sfx}-2` },
      ];
      const fetchCdr = async () => ({ ok: true as const, rows });

      const r1 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr });
      check("first poll: only direction=in counted", r1.inbound === 1, JSON.stringify(r1));
      check("first poll: 1 new row", r1.new === 1, JSON.stringify(r1));

      const cap1 = await tx.execute(sql`SELECT * FROM ahoi_inbound_events WHERE provider_uuid = ${`cdrtest-${sfx}-1`}`);
      check("inbound row captured with source='cdr'", (cap1 as unknown as { source: string }[])[0]?.source === "cdr");
      const outRow = await tx.execute(sql`SELECT 1 FROM ahoi_inbound_events WHERE provider_uuid = ${`cdrtest-${sfx}-2`}`);
      check("direction=out row NOT captured", (outRow as unknown[]).length === 0);

      // Idempotent re-run: same rows, zero new inserts.
      const r2 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr });
      check("second identical poll: 0 new (idempotent)", r2.new === 0, JSON.stringify(r2));
      check("second identical poll: 1 dupe", r2.dupe === 1, JSON.stringify(r2));

      // ---- NEW (Section 4, Task 5): a direction=in STOP row must also
      // produce a suppressed contact + opt_outs, not just a captured row.
      // stopSrc must be a valid 10-digit NANP number (area 315, exchange 586)
      // — the poll now normalizes it via ahoiSourceToE164. ----
      const stopSrc = "3155862001";
      const stopRows: AhoiCdrRow[] = [
        { date: "07/15/2026 11:00:00", your_cost: "0", submaster_id: "1", user_id: "1", submaster_cost: "0", user_cost: "0", surcharge: "0", src: stopSrc, dst: "3158359592", message: "STOP", direction: "in", alpha: "", msg_type: "sms", uuid: `cdrtest-${sfx}-stop` },
      ];
      const fetchStopCdr = async () => ({ ok: true as const, rows: stopRows });
      const r3 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr: fetchStopCdr });
      check("STOP row: 1 new", r3.new === 1, JSON.stringify(r3));
      const stopCap = await tx.execute(sql`SELECT * FROM ahoi_inbound_events WHERE provider_uuid = ${`cdrtest-${sfx}-stop`}`);
      check("STOP row captured + processed (result='suppressed')", (stopCap as unknown as { result: string }[])[0]?.result === "suppressed", JSON.stringify(stopCap[0]));
      const stopContact = await tx.execute(sql`SELECT id FROM contacts WHERE org_id = ${orgId} AND phone_number = ${"+1" + stopSrc}`);
      check("CDR STOP materialized a contact in E.164 form", (stopContact as unknown[]).length === 1);
      const stopOptOut = await tx.execute(sql`
        SELECT * FROM opt_outs WHERE contact_id = ${(stopContact as unknown as { id: string }[])[0]?.id} AND source = 'ahoi_cdr'`);
      check("opt_outs row written with source='ahoi_cdr'", (stopOptOut as unknown[]).length === 1);

      // Re-poll with the SAME row -> idempotent capture (unchanged behavior),
      // and processing must NOT run again (no second opt_outs row).
      const r4 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr: fetchStopCdr });
      check("re-poll of the same STOP row: 0 new (still idempotent)", r4.new === 0, JSON.stringify(r4));
      const stopOptOutCount = await tx.execute(sql`
        SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ${(stopContact as unknown as { id: string }[])[0]?.id}`);
      check("still exactly 1 opt_outs row after re-poll", (stopOptOutCount as unknown as { n: number }[])[0]?.n === 1, JSON.stringify(stopOptOutCount));

      // ---- NEW (Section 4, Task 5 — CARRY 1 backstop-doesn't-double-write
      // proof): a STOP already suppressed via the WEBHOOK (Layer 1) arrives
      // again via the CDR poll (Layer 2) shortly after, in the CDR's own
      // message representation (segment-marker-suffixed). pollAhoiCdr must
      // still CAPTURE the row (different provider_uuid than the webhook one,
      // which has none) but processAhoiInboundOptOut's cross-channel dedup
      // must mark it 'duplicate' and NOT write a second opt_outs row or a
      // second attribution/stage counter bump. ----
      const dupSrc = "3155863002";
      const dupPhone = "+1" + dupSrc;
      const dupCamp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode) VALUES (${orgId}, ${"cdrdup-camp-" + sfx}, ${"cdrdup"}, 'active', 'manual') RETURNING id`);
      const dupStage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text, inbound_opt_out_count, opt_out_count)
        VALUES (${orgId}, ${dupCamp.id}, 1, 'STOP', 0, 0) RETURNING id`);
      const dupContactPre = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${dupPhone}) RETURNING id`);
      const dupSend = await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, texthub_message_id, status, sent_at)
        VALUES (${orgId}, ${dupCamp.id}, ${dupStage.id}, ${dupContactPre.id}, ${dupPhone}, 'hi', ${"s-cdrdup-" + sfx}, 'sent', now())
        RETURNING id`);

      // Prior webhook-channel suppression (Layer 1) — set up directly via
      // processAhoiInboundOptOut, mirroring how the real webhook route calls it.
      const webhookEvent = await one<{ id: string }>(sql`
        INSERT INTO ahoi_inbound_events (org_id, source, source_number, message, method, received_at)
        VALUES (${orgId}, 'webhook', ${dupSrc}, 'STOP', 'POST', now())
        RETURNING id`);
      const webhookResult = await processAhoiInboundOptOut(tx, {
        eventId: webhookEvent.id, orgId, sourceNumber: dupSrc, message: "STOP",
        optOutSource: "ahoi_inbound_webhook", receivedAt: new Date(),
      });
      check(
        "(fixture) prior webhook STOP suppressed + attributed",
        webhookResult.kind === "suppressed" && webhookResult.attributed === true,
        JSON.stringify(webhookResult),
      );

      const dupCdrRows: AhoiCdrRow[] = [
        { date: "07/15/2026 11:10:00", your_cost: "0", submaster_id: "1", user_id: "1", submaster_cost: "0", user_cost: "0", surcharge: "0", src: dupSrc, dst: "3158359592", message: "STOP - 1", direction: "in", alpha: "", msg_type: "sms", uuid: `cdrtest-${sfx}-dup` },
      ];
      const fetchDupCdr = async () => ({ ok: true as const, rows: dupCdrRows });
      const r5 = await pollAhoiCdr(tx as unknown as typeof db, { orgId: org.id, fetchCdr: fetchDupCdr });
      check("cross-channel dup CDR row: still counted 'new' (captured, just not double-processed)", r5.new === 1, JSON.stringify(r5));
      const dupCap = await tx.execute(sql`SELECT * FROM ahoi_inbound_events WHERE provider_uuid = ${`cdrtest-${sfx}-dup`}`);
      check("cross-channel dup CDR row marked result='duplicate' (CARRY 1)", (dupCap as unknown as { result: string }[])[0]?.result === "duplicate", JSON.stringify(dupCap[0]));
      const dupOptOutCount = await tx.execute(sql`SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ${dupContactPre.id}`);
      check("still exactly 1 opt_outs row (CDR backstop did not double-write)", (dupOptOutCount as unknown as { n: number }[])[0]?.n === 1, JSON.stringify(dupOptOutCount));
      const dupAttrCount = await tx.execute(sql`SELECT count(*)::int AS n FROM opt_out_attributions WHERE stage_send_id = ${dupSend.id}`);
      check("still exactly 1 attribution (no double-count via CDR backstop)", (dupAttrCount as unknown as { n: number }[])[0]?.n === 1, JSON.stringify(dupAttrCount));
      const dupStageRow = await one<{ opt_out_count: number }>(sql`SELECT opt_out_count FROM campaign_stages WHERE id = ${dupStage.id}`);
      check("stage opt_out_count still 1, not double-bumped via CDR backstop", Number(dupStageRow.opt_out_count) === 1, JSON.stringify(dupStageRow));

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
