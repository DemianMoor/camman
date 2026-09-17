// Pure checks for the Phase 2 live-ingest window and the conversion ledger alert
// decisions. No DB, no network, no Telegram.
// Run: npx tsx scripts/test-conversion-monitor.ts
import type { IngestResult } from "../lib/conversions/ingest";
import { liveIngestRange } from "../lib/conversions/keitaro-row";
import {
  CONVERSION_ALERT_KEYS,
  FETCH_FAILED_DEBOUNCE_MINUTES,
  INGEST_HEARTBEAT_ALERT_KEY,
  decideIngestAlerts,
  decideLedgerAlerts,
  formatIngestHeartbeatAlert,
  ingestFailed,
  type ConversionAlertDecision,
  type IngestOutcome,
  type LedgerHealth,
} from "../lib/conversions/monitor";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const PREFIX = "🟠 Tier-2 conversions:";
const K = CONVERSION_ALERT_KEYS;

type Firing = Extract<ConversionAlertDecision, { state: "firing" }>;
const stateOf = (ds: ConversionAlertDecision[], key: string) => ds.find((d) => d.alertKey === key)?.state;
const firingText = (ds: ConversionAlertDecision[], key: string): string =>
  ds.find((d): d is Firing => d.alertKey === key && d.state === "firing")?.text ?? "";

console.log("live ingest window");
const r1 = liveIngestRange(new Date("2026-09-17T14:05:00Z"));
check(
  "R1 7 ET calendar days: today − 6 days 00:00:00 → now, in ET",
  r1.from === "2026-09-11 00:00:00" && r1.to === "2026-09-17 10:05:00" && r1.timezone === "America/New_York",
  JSON.stringify(r1),
);
const r2 = liveIngestRange(new Date("2026-09-18T02:30:00Z"));
check(
  "R2 the ET date is used, not the UTC date (22:30 ET is still the 17th)",
  r2.from === "2026-09-11 00:00:00" && r2.to === "2026-09-17 22:30:00",
  JSON.stringify(r2),
);
const r3 = liveIngestRange(new Date("2026-11-02T04:30:00Z"));
check(
  "R3 DST fall-back week keeps all 7 days (now − 144h would start on 10-27)",
  r3.from === "2026-10-26 00:00:00" && r3.to === "2026-11-01 23:30:00",
  JSON.stringify(r3),
);
const r4 = liveIngestRange(new Date("2027-01-03T15:00:00Z"));
check(
  "R4 crosses a year boundary",
  r4.from === "2026-12-28 00:00:00" && r4.to === "2027-01-03 10:00:00",
  JSON.stringify(r4),
);

console.log("\ningest alerts");
const run = (over: Partial<IngestResult>): IngestResult => ({
  ok: true,
  dryRun: false,
  range: { from: "2026-09-11 00:00:00", to: "2026-09-17 10:05:00", timezone: "America/New_York" },
  fetched: 12,
  invalid: 0,
  invalidSamples: [],
  unresolved: 3,
  unresolvedSamples: [],
  rows: 9,
  unmappedInBatch: 0,
  statusOnlyInBatch: 0,
  inserted: 1,
  updated: 0,
  unchanged: 8,
  typeConflicts: 0,
  orgMismatch: 0,
  orgMismatchSamples: [],
  error: null,
  ...over,
});

const result = (over: Partial<IngestResult>): IngestOutcome => ({ kind: "result", result: run(over) });
const refused = result({
  ok: false,
  fetched: 0,
  rows: 0,
  unchanged: 0,
  error: "Keitaro conversions/log truncated: 1000 of 1200 rows",
});
const threw: IngestOutcome = {
  kind: "threw",
  range: { from: "2026-09-11 00:00:00", to: "2026-09-17 10:05:00", timezone: "America/New_York" },
  error: "connect ECONNREFUSED 10.0.0.1:6543",
};

const failedDs = decideIngestAlerts(refused, 20);
check(
  "A1 refused window, last complete ingest 20 min ago → only fetch_failed, firing (invalid_rows and org_mismatch left as they are)",
  failedDs.length === 1 && stateOf(failedDs, K.fetchFailed) === "firing",
  JSON.stringify(failedDs),
);
const fetchText = firingText(failedDs, K.fetchFailed);
check(
  "A2 fetch_failed text: prefix, the error, the window, the last-success age",
  fetchText.startsWith(PREFIX) &&
    fetchText.includes("truncated: 1000 of 1200 rows") &&
    fetchText.includes("2026-09-11 00:00:00 → 2026-09-17 10:05:00 America/New_York") &&
    fetchText.includes("Last complete ingest: 20 min ago"),
  fetchText,
);

const okDs = decideIngestAlerts(result({}), null);
check(
  "A3 complete clean window → fetch_failed ok (a successful run clears), invalid_rows ok, org_mismatch ok",
  okDs.length === 3 &&
    stateOf(okDs, K.fetchFailed) === "ok" &&
    stateOf(okDs, K.invalidRows) === "ok" &&
    stateOf(okDs, K.orgMismatch) === "ok",
  JSON.stringify(okDs),
);

const invalidDs = decideIngestAlerts(
  result({
    invalid: 4,
    invalidSamples: [
      "event_id=∅ conversion_type=Lead datetime=2026-09-17 09:00:00 revenue=0",
      "event_id=bad-dt conversion_type=Lead datetime=2026-09-17T09:00:00Z revenue=0",
      "event_id=no-type conversion_type=∅ datetime=2026-09-17 09:00:00 revenue=0",
      "event_id=fourth conversion_type=∅ datetime=∅ revenue=∅",
    ],
  }),
  null,
);
const invalidText = firingText(invalidDs, K.invalidRows);
check(
  "A4 unparseable rows → invalid_rows firing with the count and at most 3 samples; fetch_failed ok",
  stateOf(invalidDs, K.fetchFailed) === "ok" &&
    invalidText.startsWith(PREFIX) &&
    invalidText.includes("4 Keitaro conversion row(s)") &&
    invalidText.includes("event_id=bad-dt") &&
    invalidText.includes("event_id=no-type") &&
    !invalidText.includes("event_id=fourth"),
  invalidText,
);

const hugeText = firingText(
  decideIngestAlerts(result({ ok: false, error: `Keitaro conversions/log HTTP 502: ${"x".repeat(5000)}` }), null),
  K.fetchFailed,
);
check(
  "A5 an unbounded Keitaro error body is clipped (Telegram caps a message at 4,096 chars)",
  hugeText.length > 0 && hugeText.length < 1500,
  `length ${hugeText.length}`,
);

console.log("\nfetch_failed debounce");
const freshDs = decideIngestAlerts(refused, 5);
check(
  "D1 refused window, last complete ingest 5 min ago → no decision at all (no fire, no clear)",
  freshDs.length === 0,
  JSON.stringify(freshDs),
);
// A malformed 200 (Phase 1 72501c7) is refused like a truncated page: same key.
const malformed = result({
  ok: false,
  fetched: 0,
  rows: 0,
  unchanged: 0,
  error:
    "Keitaro conversions/log malformed response (expected JSON with a rows array and a numeric total): <html>challenge</html>",
});
const neverDs = decideIngestAlerts(malformed, null);
check(
  "D2 malformed response, no complete ingest ever recorded → fetch_failed firing, names the malformed page, says never",
  neverDs.length === 1 &&
    stateOf(neverDs, K.fetchFailed) === "firing" &&
    firingText(neverDs, K.fetchFailed).includes("malformed response") &&
    firingText(neverDs, K.fetchFailed).includes("Last complete ingest: never recorded"),
  JSON.stringify(neverDs),
);
check(
  "D3 the debounce is 15 min, and a last success exactly that old does not fire (older than, not equal)",
  FETCH_FAILED_DEBOUNCE_MINUTES === 15 && decideIngestAlerts(refused, FETCH_FAILED_DEBOUNCE_MINUTES).length === 0,
);
const threwDs = decideIngestAlerts(threw, 20);
const threwText = firingText(threwDs, K.fetchFailed);
check(
  "D4 an ingest that THREW is a failed tick: stale → only fetch_failed, firing, with the thrown message and window",
  ingestFailed(threw) &&
    ingestFailed(refused) &&
    !ingestFailed(result({})) &&
    threwDs.length === 1 &&
    threwText.startsWith(PREFIX) &&
    threwText.includes("connect ECONNREFUSED 10.0.0.1:6543") &&
    threwText.includes("2026-09-11 00:00:00 → 2026-09-17 10:05:00 America/New_York"),
  threwText,
);
check(
  "D5 an ingest that threw with a fresh heartbeat (5 min) → no decision (same debounce)",
  decideIngestAlerts(threw, 5).length === 0,
);

console.log("\norg mismatch");
const orgDs = decideIngestAlerts(
  result({
    orgMismatch: 4,
    orgMismatchSamples: [
      "ev-a 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
      "ev-b 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
      "ev-c 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
      "ev-d 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
    ],
  }),
  null,
);
const orgText = firingText(orgDs, K.orgMismatch);
check(
  "O1 complete window with orgMismatch > 0 → org_mismatch firing (no debounce) with the count and at most 3 samples; fetch_failed still clears",
  stateOf(orgDs, K.fetchFailed) === "ok" &&
    orgText.startsWith(PREFIX) &&
    orgText.includes("4 conversion(s) resolved to a different org") &&
    orgText.includes("ev-a 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b") &&
    orgText.includes("ev-c ") &&
    !orgText.includes("ev-d ") &&
    orgText.includes("2026-09-11 00:00:00 → 2026-09-17 10:05:00 America/New_York"),
  orgText,
);
const orgClearDs = decideIngestAlerts(result({ orgMismatch: 0, invalid: 1, invalidSamples: ["event_id=x"] }), null);
check(
  "O2 complete window with orgMismatch = 0 → org_mismatch ok (clears), independent of invalid_rows firing",
  stateOf(orgClearDs, K.orgMismatch) === "ok" && stateOf(orgClearDs, K.invalidRows) === "firing",
  JSON.stringify(orgClearDs),
);

console.log("\nledger alerts");
const clean: LedgerHealth = {
  unmapped_total: 0,
  unmapped_last_24h: 0,
  unmapped_samples: [],
  conflict_total: 0,
  conflict_samples: [],
};
const cleanDs = decideLedgerAlerts(clean);
check(
  "L1 clean ledger → unmapped ok, type_conflicts ok",
  cleanDs.length === 2 && stateOf(cleanDs, K.unmapped) === "ok" && stateOf(cleanDs, K.typeConflicts) === "ok",
  JSON.stringify(cleanDs),
);

const sick: LedgerHealth = {
  unmapped_total: 5,
  unmapped_last_24h: 2,
  unmapped_samples: [
    { keitaro_event_id: "ev-offer", keitaro_type: "trash", keitaro_offer_id: 41, offer_name: "Psycho Book" },
    { keitaro_event_id: "ev-keitaro", keitaro_type: "deposit", keitaro_offer_id: 41, offer_name: null },
    { keitaro_event_id: "ev-none", keitaro_type: "lead", keitaro_offer_id: null, offer_name: null },
    { keitaro_event_id: "ev-fourth", keitaro_type: "lead", keitaro_offer_id: null, offer_name: null },
  ],
  conflict_total: 1,
  conflict_samples: [
    {
      keitaro_event_id: "ev-conflict",
      locked_event_key: "registration",
      keitaro_type: "sale",
      conflicting_event_key: "purchase",
      since: "2026-09-17T14:00:00Z",
    },
  ],
};
const sickDs = decideLedgerAlerts(sick);
const unmappedText = firingText(sickDs, K.unmapped);
check(
  "L2 unmapped firing: total, last-24h count, offer name / Keitaro offer id / no offer, at most 3 samples",
  unmappedText.startsWith(PREFIX) &&
    unmappedText.includes("5 conversion(s) have no event-type mapping (2 new in the last 24h)") &&
    unmappedText.includes("ev-offer · Psycho Book · type trash") &&
    unmappedText.includes("ev-keitaro · Keitaro offer 41 · type deposit") &&
    unmappedText.includes("ev-none · no offer · type lead") &&
    !unmappedText.includes("ev-fourth"),
  unmappedText,
);
const conflictText = firingText(sickDs, K.typeConflicts);
check(
  "L3 type_conflicts firing: count, event id, locked key, Keitaro type → mapped key, since in ET",
  conflictText.startsWith(PREFIX) &&
    conflictText.includes("1 conversion(s)") &&
    conflictText.includes(
      "ev-conflict · locked registration · Keitaro type sale → purchase · since Sep 17, 2026 10:00 AM ET",
    ),
  conflictText,
);

console.log("\nheartbeat alert");
const breach =
  "Conversion events ingest (Keitaro poll tick) last ran 3h ago (tolerance 1h). Its silence cannot be read as healthy.";
const hbText = formatIngestHeartbeatAlert(breach);
check("H1 heartbeat text: prefix + the breach line", hbText.startsWith(PREFIX) && hbText.includes(breach), hbText);

console.log("\nplain text + fixed keys");
const texts = [fetchText, invalidText, hugeText, threwText, orgText, unmappedText, conflictText, hbText];
const MARKUP = /<\/?[a-z][^>]*>|\*[^*\n]+\*|__[^_\n]+__|`/i;
check(
  "X1 no HTML or Markdown in any alert (notifyTelegram sends without parse_mode)",
  texts.every((t) => t.length > 0 && !MARKUP.test(t)),
  texts.filter((t) => t.length === 0 || MARKUP.test(t)).join("\n---\n"),
);
check(
  "K1 the alert keys are the fixed strings the docs and alert_state rows name",
  K.fetchFailed === "conversion_events:fetch_failed" &&
    K.invalidRows === "conversion_events:invalid_rows" &&
    K.orgMismatch === "conversion_events:org_mismatch" &&
    K.unmapped === "conversion_events:unmapped" &&
    K.typeConflicts === "conversion_events:type_conflicts" &&
    INGEST_HEARTBEAT_ALERT_KEY === "heartbeat:conversion-events-ingest",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
