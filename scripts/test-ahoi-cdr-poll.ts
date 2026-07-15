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
