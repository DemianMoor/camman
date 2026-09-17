// Pure checks for the Phase 2 live-ingest window and the conversion ledger alert
// decisions. No DB, no network, no Telegram.
// Run: npx tsx scripts/test-conversion-monitor.ts
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { IngestResult } from "../lib/conversions/ingest";
import { liveIngestRange } from "../lib/conversions/keitaro-row";
import {
  CONFLICT_COMBOS_SQL,
  CONVERSION_ALERT_KEYS,
  CONVERSION_ALERT_KEY_PREFIXES,
  FETCH_FAILED_DEBOUNCE_MINUTES,
  INGEST_HEARTBEAT_ALERT_KEY,
  LEDGER_MAX_COMBOS,
  UNMAPPED_COMBOS_SQL,
  decideIngestAlerts,
  decideLedgerAlerts,
  decideProjectionAlert,
  formatIngestHeartbeatAlert,
  ingestFailed,
  typeConflictAlertKey,
  unmappedAlertKey,
  type ConflictCombo,
  type ConversionAlertDecision,
  type IngestOutcome,
  type LedgerHealth,
  type UnmappedCombo,
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
const ageText = (minutes: number) => firingText(decideIngestAlerts(refused, minutes), K.fetchFailed);
check(
  "A6 last-success age under 120 min reads as whole minutes (114 → 114 min ago, 17.6 → 18 min ago)",
  ageText(114).includes("Last complete ingest: 114 min ago.") &&
    ageText(17.6).includes("Last complete ingest: 18 min ago."),
  ageText(114),
);
check(
  "A7 last-success age of 120 min or more reads as hours with one decimal (120 → 2.0 h ago, 186 → 3.1 h ago)",
  ageText(120).includes("Last complete ingest: 2.0 h ago.") &&
    ageText(186).includes("Last complete ingest: 3.1 h ago.") &&
    !ageText(120).includes("min ago"),
  ageText(186),
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


console.log("\nledger combo keys");
const P = CONVERSION_ALERT_KEY_PREFIXES;
const unm = (over: Partial<UnmappedCombo>): UnmappedCombo => ({
  offer_id: null,
  keitaro_offer_id: null,
  offer_name: null,
  keitaro_type: "trash",
  total: 1,
  last_24h: 0,
  sample_event_ids: ["ev-1"],
  ...over,
});
const conf = (over: Partial<ConflictCombo>): ConflictCombo => ({
  offer_id: 134,
  keitaro_offer_id: null,
  offer_name: "Psycho Book",
  locked_event_key: "registration",
  conflicting_event_key: "purchase",
  total: 1,
  last_24h: 1,
  since: "2026-09-17T14:00:00Z",
  sample_event_ids: ["ev-conflict"],
  ...over,
});
// A ledger read that lists every combo (under the cap) unless `over` says otherwise.
const ledger = (
  unmapped: UnmappedCombo[],
  conflicts: ConflictCombo[],
  over: Partial<LedgerHealth> = {},
): LedgerHealth => ({
  unmapped_total: unmapped.reduce((n, c) => n + c.total, 0),
  unmapped_combo_count: unmapped.length,
  unmapped_combos: unmapped,
  conflict_total: conflicts.reduce((n, c) => n + c.total, 0),
  conflict_combo_count: conflicts.length,
  conflict_combos: conflicts,
  ...over,
});
const firingKeysOf = (ds: ConversionAlertDecision[]) => ds.filter((d) => d.state === "firing").map((d) => d.alertKey);
const okKeysOf = (ds: ConversionAlertDecision[]) => ds.filter((d) => d.state === "ok").map((d) => d.alertKey);
const sameKeys = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const keysOnly = (ds: ConversionAlertDecision[]) => JSON.stringify(ds.map((d) => `${d.state} ${d.alertKey}`));

const psycho = unm({
  offer_id: 134,
  offer_name: "Psycho Book",
  keitaro_type: "deposit",
  total: 5,
  last_24h: 2,
  sample_event_ids: ["ev-a", "ev-b", "ev-c", "ev-d"],
});
const k41 = unm({ keitaro_offer_id: 41, keitaro_type: "trash" });
const noOffer = unm({ keitaro_type: "lead" });
const regToPurchase = conf({ total: 3, sample_event_ids: ["ev-x", "ev-y", "ev-z", "ev-w"] });

const builtKeys = [
  unmappedAlertKey(psycho),
  unmappedAlertKey(k41),
  unmappedAlertKey(noOffer),
  unmappedAlertKey(unm({ offer_id: 134, keitaro_offer_id: 41 })),
  typeConflictAlertKey(regToPurchase),
  typeConflictAlertKey(conf({ offer_id: null, keitaro_offer_id: 41, offer_name: null })),
];
check(
  "C1 combo keys: unmapped:<offer>:<keitaro type>, type_conflicts:<offer>:<locked>><conflicting>; offer = offer_id, else k<keitaro offer id>, else none",
  JSON.stringify(builtKeys) ===
    JSON.stringify([
      "conversion_events:unmapped:134:deposit",
      "conversion_events:unmapped:k41:trash",
      "conversion_events:unmapped:none:lead",
      "conversion_events:unmapped:134:trash",
      "conversion_events:type_conflicts:134:registration>purchase",
      "conversion_events:type_conflicts:k41:registration>purchase",
    ]),
  JSON.stringify(builtKeys),
);
const oddKey = unmappedAlertKey(unm({ keitaro_type: "First Deposit: 2>1 ✓" }));
const longKey = unmappedAlertKey(unm({ keitaro_type: "x".repeat(200) }));
const oddConflictKey = typeConflictAlertKey(conf({ locked_event_key: "Reg:A>B", conflicting_event_key: null }));
// The suffixes are the first 6 hex characters of sha256 of the raw part, written
// out: sha256("First Deposit: 2>1 ✓") = 1239dd…, sha256("x"×200) = aa20c2…,
// sha256("Reg:A>B") = 34b636…, sha256("?") (a NULL event key) = 8a8de8….
check(
  "C2 key parts are sanitised (lowercase; anything outside [a-z0-9_-] → _, so ':' and '>' can't forge a separator), clipped to 40 chars, and a part sanitising changed carries ~<6 hex of sha256(raw)>",
  oddKey === "conversion_events:unmapped:none:first_deposit__2_1__~1239dd" &&
    longKey === `conversion_events:unmapped:none:${"x".repeat(40)}~aa20c2` &&
    oddConflictKey === "conversion_events:type_conflicts:134:reg_a_b~34b636>_~8a8de8" &&
    [...builtKeys, oddKey, longKey, oddConflictKey].every((k) => /^[a-z0-9_:>~-]+$/.test(k)),
  JSON.stringify({ oddKey, longKey, oddConflictKey }),
);
check(
  "C3 a combo's key ignores its counts, samples, since and offer name — a growing stream keeps one key",
  unmappedAlertKey(k41) ===
    unmappedAlertKey({ ...k41, total: 900, last_24h: 300, sample_event_ids: ["ev-new"], offer_name: "Renamed" }) &&
    typeConflictAlertKey(regToPurchase) ===
      typeConflictAlertKey({ ...regToPurchase, total: 50, since: "2026-09-18T01:00:00Z", sample_event_ids: [] }),
);
const typeKeys = ["first deposit", "first:deposit", "first>deposit", "first_deposit", "First_Deposit"].map((t) =>
  unmappedAlertKey(unm({ keitaro_type: t })),
);
const longKeys = [`${"x".repeat(40)}y`, `${"x".repeat(40)}z`].map((t) => unmappedAlertKey(unm({ keitaro_type: t })));
const pairKeys = [
  conf({ locked_event_key: "reg a", conflicting_event_key: "purchase" }),
  conf({ locked_event_key: "reg:a", conflicting_event_key: "purchase" }),
  conf({ locked_event_key: "reg_a", conflicting_event_key: "purchase" }),
].map(typeConflictAlertKey);
check(
  "C4 raw parts that sanitise alike get DIFFERENT keys: types differing only in a replaced character or in case, types differing only past the 40-char clip, event keys differing only in a replaced character; and a key is deterministic",
  new Set(typeKeys).size === typeKeys.length &&
    new Set(longKeys).size === longKeys.length &&
    longKeys[0] === `conversion_events:unmapped:none:${"x".repeat(40)}~3c9486` &&
    new Set(pairKeys).size === pairKeys.length &&
    unmappedAlertKey(unm({ keitaro_type: "first deposit" })) === typeKeys[0],
  JSON.stringify({ typeKeys, longKeys, pairKeys }),
);
const clean40 = "a".repeat(40);
check(
  "C5 an already-clean part (lowercase [a-z0-9_-], at most 40 chars) gets no suffix, byte-identical to the pre-hash keys; every key stays bounded",
  unmappedAlertKey(unm({ keitaro_type: "trash" })) === "conversion_events:unmapped:none:trash" &&
    unmappedAlertKey(unm({ keitaro_type: "first_deposit-2" })) === "conversion_events:unmapped:none:first_deposit-2" &&
    unmappedAlertKey(unm({ keitaro_type: clean40 })) === `conversion_events:unmapped:none:${clean40}` &&
    typeConflictAlertKey(conf({})) === "conversion_events:type_conflicts:134:registration>purchase" &&
    builtKeys.every((k) => !k.includes("~")) &&
    [...builtKeys, oddKey, longKey, ...typeKeys, ...longKeys].every((k) => k.length <= "conversion_events:unmapped:".length + 11 + 1 + 47),
  JSON.stringify(builtKeys),
);

console.log("\nledger alerts (per problem combo)");
const capKeys = [K.unmappedComboCap, K.typeConflictComboCap];
const cleanDs = decideLedgerAlerts(ledger([], []), []);
check(
  "L1 clean ledger, nothing firing → no combo decision; both cap keys ok (under the cap)",
  cleanDs.length === 2 && sameKeys(okKeysOf(cleanDs), capKeys),
  keysOnly(cleanDs),
);

const sickDs = decideLedgerAlerts(ledger([psycho, k41, noOffer], [regToPurchase]), []);
const unmappedText = firingText(sickDs, unmappedAlertKey(psycho));
check(
  "L2 unmapped page for one combo: its count, offer name + id, Keitaro type, created-in-24h count, samples, the fix",
  unmappedText.startsWith(PREFIX) &&
    unmappedText.includes(
      "5 conversion(s) for Psycho Book (offer 134) with Keitaro type deposit have no event-type mapping (2 created in the last 24h).",
    ) &&
    unmappedText.includes("Sample Keitaro event ids: ev-a, ev-b, ev-c") &&
    unmappedText.includes("Fix: add a conversion_event_mappings row"),
  unmappedText,
);
const k41Text = firingText(sickDs, unmappedAlertKey(k41));
const noOfferText = firingText(sickDs, unmappedAlertKey(noOffer));
check(
  "L3 offer label: the Keitaro offer id when no CamMan offer, else 'no offer'",
  k41Text.includes("1 conversion(s) for Keitaro offer 41 (no CamMan offer) with Keitaro type trash") &&
    noOfferText.includes("1 conversion(s) for no offer with Keitaro type lead"),
  `${k41Text}\n---\n${noOfferText}`,
);
const conflictText = firingText(sickDs, typeConflictAlertKey(regToPurchase));
check(
  "L4 type_conflicts page for one combo: its count, offer, locked → now-mapped event pair, first-seen-in-24h count, first seen in ET, samples, the doc",
  conflictText.startsWith(PREFIX) &&
    conflictText.includes(
      "3 conversion(s) for Psycho Book (offer 134) changed Keitaro type to one that maps to a different event: locked registration → now purchase (1 first seen in the last 24h).",
    ) &&
    conflictText.includes("First seen: Sep 17, 2026 10:00 AM ET") &&
    conflictText.includes("Sample Keitaro event ids: ev-x, ev-y, ev-z") &&
    conflictText.includes('"Event-type conflicts"'),
  conflictText,
);
check(
  "L5 samples are capped at 3 per page (the 4th sample id never appears)",
  !unmappedText.includes("ev-d") && !conflictText.includes("ev-w"),
  `${unmappedText}\n---\n${conflictText}`,
);
check(
  "L6 new combos, nothing firing → one firing decision per combo on its own key, no clears beyond the two under-cap cap keys",
  sickDs.length === 6 &&
    sameKeys(okKeysOf(sickDs), capKeys) &&
    sameKeys(firingKeysOf(sickDs), [
      unmappedAlertKey(psycho),
      unmappedAlertKey(k41),
      unmappedAlertKey(noOffer),
      typeConflictAlertKey(regToPurchase),
    ]),
  keysOnly(sickDs),
);
const grownK41 = { ...k41, total: 7, last_24h: 7, sample_event_ids: ["ev-7", "ev-6", "ev-5"] };
const latchedDs = decideLedgerAlerts(ledger([grownK41], []), [unmappedAlertKey(k41)]);
check(
  "L7 the same combo already firing, with more rows since → 'firing' on the SAME key again and no combo key cleared (notifyOnTransition's latch makes it no new page — DB S1b)",
  keysOnly(latchedDs) ===
    JSON.stringify([`ok ${K.unmappedComboCap}`, `ok ${K.typeConflictComboCap}`, `firing ${unmappedAlertKey(k41)}`]),
  keysOnly(latchedDs),
);
const staleDs = decideLedgerAlerts(ledger([k41], []), [
  unmappedAlertKey(k41),
  unmappedAlertKey(psycho),
  typeConflictAlertKey(regToPurchase),
  "conversion_events:unmapped", // no trailing colon: outside the prefix
  "conversionXevents:unmapped:1",
  K.fetchFailed,
]);
check(
  "L8 firing keys whose combo is gone → ok, under both prefixes; a present combo stays firing; keys outside the prefixes get no stale decision (only the two cap keys, from the cap rule)",
  staleDs.length === 5 &&
    sameKeys(okKeysOf(staleDs), [unmappedAlertKey(psycho), typeConflictAlertKey(regToPurchase), ...capKeys]) &&
    sameKeys(firingKeysOf(staleDs), [unmappedAlertKey(k41)]),
  keysOnly(staleDs),
);
const spaced = unm({ keitaro_type: "first deposit", total: 9 });
const underscored = unm({ keitaro_type: "first_deposit", total: 2 });
const collideDs = decideLedgerAlerts(ledger([spaced, underscored], []), []);
check(
  "L9 two combos whose Keitaro types sanitise alike → two keys and two pages, each with its own count (the hash suffix keeps them apart)",
  unmappedAlertKey(spaced) !== unmappedAlertKey(underscored) &&
    collideDs.length === 4 &&
    firingText(collideDs, unmappedAlertKey(spaced)).includes("9 conversion(s)") &&
    firingText(collideDs, unmappedAlertKey(underscored)).includes("2 conversion(s)"),
  keysOnly(collideDs),
);
const listed = Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) => unm({ keitaro_type: `type-${i}`, total: 20 - i }));
const pastCapKey = unmappedAlertKey(unm({ keitaro_type: "past-the-cap" }));
const staleConflictKey = typeConflictAlertKey(conf({ conflicting_event_key: "lead" }));
const cappedDs = decideLedgerAlerts(
  ledger(listed, [regToPurchase], { unmapped_combo_count: LEDGER_MAX_COMBOS + 4 }),
  [pastCapKey, staleConflictKey, K.unmappedComboCap],
);
const cappedTexts = firingKeysOf(cappedDs)
  .filter((k) => k.startsWith(P.unmapped))
  .map((k) => firingText(cappedDs, k));
check(
  "L10 over the cap (10 combos per kind): the 10 listed combos page and every unmapped page names the 4 more; no unmapped combo key clears (past the cap is not resolved), while type_conflicts, under its cap, still clears",
  LEDGER_MAX_COMBOS === 10 &&
    cappedTexts.length === 10 &&
    cappedTexts.every((t) => t.includes("4 more unmapped combo(s) are not listed or paged")) &&
    !firingText(cappedDs, typeConflictAlertKey(regToPurchase)).includes("not listed or paged") &&
    sameKeys(okKeysOf(cappedDs), [staleConflictKey, K.typeConflictComboCap]),
  `${keysOnly(cappedDs)}\n${cappedTexts[0]}`,
);
const capText = firingText(cappedDs, K.unmappedComboCap);
check(
  "L11 the cap key fires while the kind is over the cap — one decision on the fixed key (it is not a stale combo key), naming the kind, the combo count, the cap and what to do",
  cappedDs.filter((d) => d.alertKey === K.unmappedComboCap).length === 1 &&
    capText.startsWith(PREFIX) &&
    capText.includes("14 unmapped combos exist, more than the 10 per kind that are listed and paged.") &&
    capText.includes("Only the 10 most recently changed unmapped combos page.") &&
    capText.includes("WHERE event_type_id IS NULL OR status IS NULL") &&
    firingText(
      decideLedgerAlerts(ledger([], listed.map(() => regToPurchase), { conflict_combo_count: 11 }), []),
      K.typeConflictComboCap,
    ).includes("11 type-conflict combos exist, more than the 10 per kind"),
  capText,
);
const atCapDs = decideLedgerAlerts(ledger(listed, [], { unmapped_combo_count: LEDGER_MAX_COMBOS }), [
  pastCapKey,
  K.unmappedComboCap,
]);
check(
  "L12 back at the cap (exactly 10): the cap key clears, no page names more combos, and stale combo keys clear again",
  sameKeys(okKeysOf(atCapDs), [pastCapKey, ...capKeys]) &&
    firingKeysOf(atCapDs).length === LEDGER_MAX_COMBOS &&
    !firingText(atCapDs, unmappedAlertKey(listed[0])).includes("not listed or paged"),
  keysOnly(atCapDs),
);
// The statement's own ORDER BY: the last one, since array_agg has its own.
const orderBy = (q: SQL) => {
  const text = new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ");
  return text.slice(text.lastIndexOf("ORDER BY") + "ORDER BY ".length).split(" LIMIT")[0];
};
check(
  "L13 both combo statements rank by RECENCY, not by size: ORDER BY max(ce.updated_at) DESC first, then every GROUP BY column (so a new 1-row combo is listed and paged even when 10 bigger ones exist — DB P2)",
  orderBy(UNMAPPED_COMBOS_SQL) === "max(ce.updated_at) DESC, 1 NULLS LAST, 2 NULLS LAST, 3" &&
    orderBy(CONFLICT_COMBOS_SQL) === "max(ce.updated_at) DESC, 1 NULLS LAST, 2 NULLS LAST, 3, 4",
  JSON.stringify([orderBy(UNMAPPED_COMBOS_SQL), orderBy(CONFLICT_COMBOS_SQL)]),
);

console.log("\nstage-day projection alert (Phase 3 Task 3)");
const projOk = decideProjectionAlert({ kind: "ok" });
check(
  "J1 a successful projection clears the fixed key",
  projOk.alertKey === K.projectionFailed && projOk.state === "ok",
  JSON.stringify(projOk),
);
const projThrew = decideProjectionAlert({
  kind: "threw",
  error: "canceling statement due to statement timeout",
});
const projThrewText = projThrew.state === "firing" ? projThrew.text : "";
check(
  "J2 a throw fires it, names the error, and says the columns are stale rather than zeroed",
  projThrew.state === "firing" &&
    projThrewText.startsWith(PREFIX) &&
    projThrewText.includes("canceling statement due to statement timeout") &&
    projThrewText.includes("stale, never zeroed by a failure"),
  projThrewText,
);
check(
  "J3 the throw page names the watermark, so the reader knows nothing is stranded",
  projThrewText.includes("conversion-stage-day-projection") && projThrewText.includes("cron_locks"),
  projThrewText,
);
const projRefused = decideProjectionAlert({ kind: "refused", reason: "empty_ledger" });
const projRefusedText = projRefused.state === "firing" ? projRefused.text : "";
check(
  "J4 the empty-ledger refusal fires the SAME key and points at the Phase 1 backfill",
  projRefused.alertKey === K.projectionFailed &&
    projRefused.state === "firing" &&
    projRefusedText.includes("no stage-attributed rows") &&
    projRefusedText.includes("backfill-conversion-events.ts --apply") &&
    projRefusedText.includes("Nothing was written"),
  projRefusedText,
);
const clipped = decideProjectionAlert({ kind: "threw", error: "x".repeat(600) });
check(
  "J5 an unbounded error message is clipped like every other external text",
  clipped.state === "firing" && clipped.text.split("\n")[1].length <= 307,
  clipped.state === "firing" ? String(clipped.text.split("\n")[1].length) : "",
);

console.log("\nheartbeat alert");
const breach =
  "Conversion events ingest (Keitaro poll tick) last ran 3h ago (tolerance 1h). Its silence cannot be read as healthy.";
const hbText = formatIngestHeartbeatAlert(breach);
check("H1 heartbeat text: prefix + the breach line", hbText.startsWith(PREFIX) && hbText.includes(breach), hbText);

console.log("\nplain text + keys");
const texts = [
  fetchText,
  invalidText,
  hugeText,
  threwText,
  orgText,
  unmappedText,
  k41Text,
  noOfferText,
  conflictText,
  cappedTexts[0] ?? "",
  capText,
  hbText,
  projThrewText,
  projRefusedText,
];
const MARKUP = /<\/?[a-z][^>]*>|\*[^*\n]+\*|__[^_\n]+__|`/i;
check(
  "X1 no HTML or Markdown in any alert (notifyTelegram sends without parse_mode)",
  texts.every((t) => t.length > 0 && !MARKUP.test(t)),
  texts.filter((t) => t.length === 0 || MARKUP.test(t)).join("\n---\n"),
);
check(
  "K1 the fixed keys, the combo key prefixes and the heartbeat key are the strings the docs and alert_state rows name; neither cap key starts with a combo prefix, so the stale-combo clear can never touch one",
  K.fetchFailed === "conversion_events:fetch_failed" &&
    K.invalidRows === "conversion_events:invalid_rows" &&
    K.orgMismatch === "conversion_events:org_mismatch" &&
    K.projectionFailed === "conversion_events:projection_failed" &&
    K.unmappedComboCap === "conversion_events:combo_cap_exceeded:unmapped" &&
    K.typeConflictComboCap === "conversion_events:combo_cap_exceeded:type_conflicts" &&
    Object.keys(K).length === 6 &&
    P.unmapped === "conversion_events:unmapped:" &&
    P.typeConflicts === "conversion_events:type_conflicts:" &&
    Object.keys(P).length === 2 &&
    capKeys.every((k) => !k.startsWith(P.unmapped) && !k.startsWith(P.typeConflicts)) &&
    INGEST_HEARTBEAT_ALERT_KEY === "heartbeat:conversion-events-ingest",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
