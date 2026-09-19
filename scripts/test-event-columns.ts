import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryBuilder } from "drizzle-orm/pg-core";

import { keitaro_stage_results } from "@/db/schema";
import {
  addEventMaps,
  buildEventColumns,
  emptyTally,
  EMPTY_TALLY,
  eventCellValue,
  eventColumnById,
  orderEventTypes,
  parseEventMap,
  pluralizeLabel,
  scaleEventMap,
  visibleEventTypes,
  type EventColumn,
  type EventMap,
  type EventTally,
  type EventTypeSpec,
} from "@/lib/reporting/event-columns";

// PURE — no DB, no env. Run: npx tsx --conditions=react-server scripts/test-event-columns.ts
//
// ⭐ THE REGISTRY IN THIS TEST IS NOT PRODUCTION'S. It holds a `deposit` type
// that exists in no database anywhere, and a second signal (`trial`). A
// generator that hard-codes `registration` / `purchase` produces the wrong column
// list for it and cannot be rescued by the seed data.
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

const T = (
  key: string,
  label: string,
  display_order: number,
  f: Partial<EventTypeSpec> = {},
): EventTypeSpec => ({
  key,
  label,
  display_order,
  is_purchase: false,
  counts_revenue: false,
  is_retarget_signal: false,
  archived: false,
  ...f,
});

// ⭐ SINGULAR LABELS, because that is what migration 0181 actually seeds
// ('Purchase', 'Registration' — 0181:182-185). The plural in a header is the
// GENERATOR's doing, not the data's; a test that fed itself plural labels would
// never have noticed that production renders "Registration".
const PROD = [
  T("purchase", "Purchase", 10, { is_purchase: true, counts_revenue: true }),
  T("registration", "Registration", 20, { is_retarget_signal: true }),
];
const THREE = [
  ...PROD,
  T("deposit", "Deposit", 30, { is_purchase: true, counts_revenue: true }),
];

// ── ordering ────────────────────────────────────────────────────────────────
const ordered = orderEventTypes(PROD).map((t) => t.key);
check("O1 ⭐ signals sort BEFORE purchases, against display_order", ordered.join(",") === "registration,purchase", ordered.join(","));
const ordered3 = orderEventTypes(THREE).map((t) => t.key);
check("O2 ⭐ two purchase types tie-break on display_order", ordered3.join(",") === "registration,purchase,deposit", ordered3.join(","));
const tie = orderEventTypes([T("b_key", "B", 5), T("a_key", "A", 5)]).map((t) => t.key);
check("O3 an exact display_order tie breaks on key, so the order is total", tie.join(",") === "a_key,b_key", tie.join(","));

// ── the generated column set ────────────────────────────────────────────────
const cols = buildEventColumns(orderEventTypes(PROD));
const ids = cols.map((c) => c.id);
check(
  "C1 ⭐ the exact generated id list for production's registry",
  ids.join("|") ===
    [
      "evt:registration:count",
      "evt:registration:rate",
      "evt:registration:pending_n",
      "evt:purchase:count",
      "evt:purchase:rate",
      "evt:purchase:pending_n",
      "evt:purchase:revenue",
      "evt:purchase:pending_revenue",
      "evt:purchase:epc",
      "evtfunnel:registration:purchase",
    ].join("|"),
  ids.join("|"),
);
check(
  "C2 ⭐ Tier A is the OWNER'S NINE: count, rate and pending per type, plus the funnel ratio",
  cols.filter((c) => c.tier === "a").map((c) => c.id).join("|") ===
    [
      "evt:registration:count",
      "evt:registration:rate",
      "evt:registration:pending_n",
      "evt:purchase:count",
      "evt:purchase:rate",
      "evt:purchase:pending_n",
      "evtfunnel:registration:purchase",
    ].join("|"),
  cols.filter((c) => c.tier === "a").map((c) => c.id).join("|"),
);
check(
  "C2b ⭐ Tier B is ONLY the three money columns that duplicate an existing aggregate column",
  cols.filter((c) => c.tier === "b").map((c) => c.id).join("|") ===
    "evt:purchase:revenue|evt:purchase:pending_revenue|evt:purchase:epc",
  cols.filter((c) => c.tier === "b").map((c) => c.id).join("|"),
);
check(
  "C3 a type with counts_revenue=false gets NO revenue/pending$/EPC column",
  !ids.some((i) => i.startsWith("evt:registration:revenue") || i === "evt:registration:epc"),
  ids.join("|"),
);
check(
  "C4 ⭐ only the COUNT header is pluralised; the rest keep the singular stem",
  cols.find((c) => c.id === "evt:registration:count")?.header === "Registrations" &&
    cols.find((c) => c.id === "evt:registration:rate")?.header === "Registration rate" &&
    cols.find((c) => c.id === "evt:registration:pending_n")?.header === "Registration pending",
  JSON.stringify(cols.slice(0, 3).map((c) => c.header)),
);
check(
  "C5 ⭐ the funnel header names both labels, singular",
  cols.find((c) => c.id === "evtfunnel:registration:purchase")?.header === "Registration→Purchase %",
  String(cols.find((c) => c.id === "evtfunnel:registration:purchase")?.header),
);
// ── the pluraliser, which runs on FREE TEXT and must never throw ────────────
check("C5a already plural is left alone", pluralizeLabel("Purchases") === "Purchases");
// "Quiz" ⇒ "Quizes", not "Quizzes". That is the DUMB rule doing exactly what it
// says; consonant doubling is not worth an English inflection library here, and
// the escape hatch is one UPDATE on the label. Asserted so nobody "fixes" it into
// something with edge cases nobody tested.
check("C5b sibilant endings take -es", pluralizeLabel("Pitch") === "Pitches" && pluralizeLabel("Box") === "Boxes" && pluralizeLabel("Quiz") === "Quizes", `${pluralizeLabel("Pitch")}/${pluralizeLabel("Box")}/${pluralizeLabel("Quiz")}`);
check("C5c consonant + y takes -ies", pluralizeLabel("Enquiry") === "Enquiries");
check("C5d vowel + y takes -s", pluralizeLabel("Payday") === "Paydays");
check("C5e ⭐ an empty or whitespace label never produces an empty header or a throw", pluralizeLabel("") === "" && pluralizeLabel("   ") === "   ");
check("C5f ⭐ a label with punctuation or an emoji round-trips without a throw", pluralizeLabel("💰 Buy-now") === "💰 Buy-nows");

const four = buildEventColumns(
  orderEventTypes([...THREE, T("trial", "Trials", 15, { is_retarget_signal: true })]),
).filter((c) => c.kind === "funnel");
check(
  "C6 ⭐ funnel columns are the full signal x purchase cross product",
  four.map((c) => c.id).join("|") ===
    "evtfunnel:trial:purchase|evtfunnel:trial:deposit|evtfunnel:registration:purchase|evtfunnel:registration:deposit",
  four.map((c) => c.id).join("|"),
);
check(
  "C7 a registry with no signal generates no funnel column",
  buildEventColumns(orderEventTypes([PROD[0]])).every((c) => c.kind !== "funnel"),
);
check("C8 an empty registry generates no columns at all", buildEventColumns([]).length === 0);
// ⭐ C9/C10: a row can carry BOTH flags — nothing in 0181 forbids it, and it is a
// plausible thing to tick (a deposit that earns money AND marks a retarget lane).
// The cross product then paired it with itself: `evtfunnel:deposit:deposit`,
// "Deposit→Deposit %", n/n = 1 for every row that has one. Constant by
// construction; the only column here that cannot carry information.
const bothFlags = buildEventColumns(
  orderEventTypes([...PROD, T("deposit", "Deposit", 30, { is_purchase: true, counts_revenue: true, is_retarget_signal: true })]),
).filter((c) => c.kind === "funnel");
check(
  "C9 ⭐ a type that is BOTH a signal and a purchase is never paired with ITSELF",
  !bothFlags.some((c) => c.id === "evtfunnel:deposit:deposit"),
  bothFlags.map((c) => c.id).join("|"),
);
check(
  "C10 ⭐ and its other pairings still generate, in both directions",
  bothFlags.map((c) => c.id).join("|") === "evtfunnel:registration:deposit|evtfunnel:registration:purchase|evtfunnel:deposit:purchase",
  bothFlags.map((c) => c.id).join("|"),
);

// ── archived visibility (decision 12) ───────────────────────────────────────
const withArchived = [
  ...PROD,
  T("legacy_cpa", "Legacy CPA", 40, { is_purchase: true, counts_revenue: true, archived: true }),
];
const noData = visibleEventTypes(withArchived, [{}]).map((t) => t.key);
check("V1 ⭐ an archived type with no data in scope is DROPPED", !noData.includes("legacy_cpa"), noData.join(","));
const withData = visibleEventTypes(withArchived, [
  { legacy_cpa: { n: 0, pending_n: 0, revenue: 12.5, pending_revenue: 0 } },
]).map((t) => t.key);
check("V2 ⭐ an archived type WITH data in scope is KEPT", withData.includes("legacy_cpa"), withData.join(","));
check(
  "V3 an ACTIVE type with no data is always kept (decision 13)",
  visibleEventTypes(THREE, [{}]).map((t) => t.key).includes("deposit"),
);
check(
  "V4 an archived type whose only entry is all-zero is dropped",
  !visibleEventTypes(withArchived, [{ legacy_cpa: { ...EMPTY_TALLY } }]).map((t) => t.key).includes("legacy_cpa"),
);

// ── cell values ─────────────────────────────────────────────────────────────
const events: EventMap = {
  registration: { n: 40, pending_n: 0, revenue: 0, pending_revenue: 0 },
  purchase: { n: 10, pending_n: 2, revenue: 500, pending_revenue: 60 },
};
const by = (id: string) => cols.find((c) => c.id === id)!;
check("E1 count reads n", eventCellValue(by("evt:purchase:count"), events, 200) === 10);
check("E2 rate divides by counted clickers", eventCellValue(by("evt:registration:rate"), events, 200) === 0.2);
check("E3 ⭐ rate over ZERO clickers is null, not 0", eventCellValue(by("evt:registration:rate"), events, 0) === null);
check("E4 ⭐ rate is NOT clamped at 1 (decision 3)", eventCellValue(by("evt:registration:rate"), events, 20) === 2);
check("E5 revenue reads the approved sum", eventCellValue(by("evt:purchase:revenue"), events, 200) === 500);
check("E6 pending $ is its own value, never added to revenue", eventCellValue(by("evt:purchase:pending_revenue"), events, 200) === 60);
check("E7 per-event EPC divides approved revenue by counted clickers", eventCellValue(by("evt:purchase:epc"), events, 200) === 2.5);
check("E8 ⭐ EPC over zero clickers is null", eventCellValue(by("evt:purchase:epc"), events, 0) === null);
check("E9 funnel = purchases / registrations", eventCellValue(by("evtfunnel:registration:purchase"), events, 200) === 0.25);
check(
  "E10 ⭐ funnel over ZERO registrations is null, not 0",
  eventCellValue(by("evtfunnel:registration:purchase"), { purchase: events.purchase }, 200) === null,
);
check(
  "E11 ⭐ funnel is NOT clamped: a purchase with no registration can exceed 100%",
  eventCellValue(by("evtfunnel:registration:purchase"), {
    registration: { n: 2, pending_n: 0, revenue: 0, pending_revenue: 0 },
    purchase: { n: 5, pending_n: 0, revenue: 0, pending_revenue: 0 },
  }, 200) === 2.5,
);
check("E12 a type absent from the map reads 0, not null", eventCellValue(by("evt:purchase:count"), {}, 200) === 0);
// `toKey` is optional on EventColumn, so a hand-built funnel column — a fixture, a
// consumer assembling one by hand — can arrive without one. UNKNOWN, not 0.0%.
check(
  "E12b ⭐ a funnel column with NO toKey is null (unknown), not a confident 0",
  eventCellValue(
    { id: "evtfunnel:registration:", header: "", kind: "funnel", tier: "a", eventKey: "registration", muted: true } satisfies EventColumn,
    events,
    200,
  ) === null,
  String(
    eventCellValue(
      { id: "evtfunnel:registration:", header: "", kind: "funnel", tier: "a", eventKey: "registration", muted: true } satisfies EventColumn,
      events,
      200,
    ),
  ),
);
// E13 is not in the brief. The mutation sweep found it: swapping the pending_n
// case for the count case changed no bar, so the owner's "Pending" column — one
// of the nine — had no cell-value guard at all. `pending_n` is a SUBSET of `n`
// (2 of the 10 purchases are held), which is exactly what a reader who adds it to
// `n` would get wrong, and nothing would have caught it.
check("E13 ⭐ pending reads pending_n, a SUBSET of n that is never added to it", eventCellValue(by("evt:purchase:pending_n"), events, 200) === 2, String(eventCellValue(by("evt:purchase:pending_n"), events, 200)));

// ── merge / scale / parse ───────────────────────────────────────────────────
const a: EventMap = { purchase: { n: 1, pending_n: 0, revenue: 10, pending_revenue: 0 } };
addEventMaps(a, {
  purchase: { n: 2, pending_n: 1, revenue: 5, pending_revenue: 3 },
  registration: { n: 7, pending_n: 0, revenue: 0, pending_revenue: 0 },
});
check(
  "M1 merge adds every field of a shared key",
  JSON.stringify(a.purchase) === JSON.stringify({ n: 3, pending_n: 1, revenue: 15, pending_revenue: 3 }),
  JSON.stringify(a.purchase),
);
check("M2 merge adopts a key the target did not have", a.registration?.n === 7);
const s = scaleEventMap({ purchase: { n: 3, pending_n: 1, revenue: 15, pending_revenue: 3 } }, 1 / 3);
check(
  "M3 ⭐ scale multiplies every field (the By-Group fractional split)",
  Math.abs(s.purchase.n - 1) < 1e-9 && Math.abs(s.purchase.revenue - 5) < 1e-9,
  JSON.stringify(s),
);
check(
  "M4 merge does not alias the source object",
  (() => {
    const t: EventMap = {};
    const src = { purchase: { n: 1, pending_n: 0, revenue: 0, pending_revenue: 0 } };
    addEventMaps(t, src);
    t.purchase.n = 99;
    return src.purchase.n === 1;
  })(),
);
// M5 is the PURE half: it fixes the contract with hand-built values, so it runs
// with no database. The same claim is now asserted against the REAL column too —
// `keitaro_stage_results.events` landed in migration 0185 — by bars S13–S15 of
// scripts/test-stage-event-columns-db.ts, which read one row through the driver.
// What was measured, 2026-09-18 and re-measured against the column: postgres-js
// `JSON.parse`s a jsonb column, so a numeric INSIDE the json arrives as a JS
// number (exact at 1234567.8901 and 0.0001) — while a top-level `numeric` column
// arrives as a string. The parser takes both; neither branch is dead.
check(
  "M5 parse takes both shapes: a number from jsonb, a string from a top-level numeric column",
  JSON.stringify(
    parseEventMap({ purchase: { n: 2, pending_n: 0, revenue: 12.5, pending_revenue: 0 } }).purchase,
  ) === JSON.stringify({ n: 2, pending_n: 0, revenue: 12.5, pending_revenue: 0 }) &&
    JSON.stringify(
      parseEventMap({ purchase: { n: 2, pending_n: 0, revenue: "12.5000", pending_revenue: "0.0000" } }).purchase,
    ) === JSON.stringify({ n: 2, pending_n: 0, revenue: 12.5, pending_revenue: 0 }),
);
check(
  "M6 parse of null / undefined / a non-object is an empty map, never a throw",
  Object.keys(parseEventMap(null)).length === 0 &&
    Object.keys(parseEventMap(undefined)).length === 0 &&
    Object.keys(parseEventMap(7)).length === 0,
);

// ── eventColumnById: the persisted sort key, parsed WITHOUT the registry ─────
// The brief declares this export but exercises none of it. It is the one entry
// point that reads a column id back from a URL query parameter or localStorage,
// after the registry that generated it may have changed, so it is the one place a
// second copy of the id grammar could drift away from the generator.
// ⭐ THE COUNT IS PART OF THE BAR. `.every()` over an empty list is `true`, so the
// round-trip assertion alone passed vacuously against any generator that emitted
// nothing at all. 22 = 18 per-type columns (3 for each of the two signals, 6 for
// each of the two counts_revenue purchases) + 4 funnels (2 signals x 2 purchases).
const roundTrip = buildEventColumns(orderEventTypes([...THREE, T("trial", "Trials", 15, { is_retarget_signal: true })]));
const roundTripBroken = roundTrip.filter((c) => {
  const r = eventColumnById(c.id);
  return (
    !r ||
    r.id !== c.id ||
    r.kind !== c.kind ||
    r.tier !== c.tier ||
    r.eventKey !== c.eventKey ||
    r.toKey !== c.toKey ||
    r.muted !== c.muted
  );
});
check(
  "B1 ⭐ all 22 ids this registry emits (18 per-type + 4 funnels) parse back to the SAME kind/tier/keys/muted",
  roundTrip.length === 22 &&
    roundTrip.filter((c) => c.kind === "funnel").length === 4 &&
    roundTripBroken.length === 0,
  `${roundTrip.length} columns, ${roundTrip.filter((c) => c.kind === "funnel").length} funnels, broken: ${JSON.stringify(roundTripBroken.map((c) => c.id))}`,
);
check(
  "B2 ⭐ a funnel id keeps BOTH keys the right way round (denominator, then numerator)",
  eventColumnById("evtfunnel:registration:purchase")?.eventKey === "registration" &&
    eventColumnById("evtfunnel:registration:purchase")?.toKey === "purchase",
  JSON.stringify(eventColumnById("evtfunnel:registration:purchase")),
);
check(
  "B3 ⭐ a stale, hand-typed or non-event id is null, never a throw",
  eventColumnById("clicks") === null &&
    eventColumnById("") === null &&
    eventColumnById("evt:purchase") === null &&
    eventColumnById("evt:purchase:bogus") === null &&
    eventColumnById("evtfunnel:registration") === null &&
    eventColumnById("evt::count") === null,
);
// `event_types_key_format_check` (0181:43) constrains key to ^[a-z][a-z0-9_]*$, so
// no legal key contains a ':' and no id the generator emits has four segments.
// This is about a MALFORMED id — the input is a URL parameter or a localStorage
// value — not about a key the registry could hold.
check(
  "B4 a malformed id with an extra segment is null, never mis-split",
  eventColumnById("evt:a:b:count") === null,
  JSON.stringify(eventColumnById("evt:a:b:count")),
);
check(
  "B5 ⭐ a self-pairing funnel id has no column to parse back to, so it is null too",
  eventColumnById("evtfunnel:deposit:deposit") === null,
  JSON.stringify(eventColumnById("evtfunnel:deposit:deposit")),
);
// ⭐ THE SEGMENT IS HELD TO THE SAME CONSTRAINT THE COLUMN IT CLAIMS TO NAME IS
// (`event_types_key_format_check`, 0181:43). Without it `evt:PURCHASE:count`
// parsed into a perfectly-formed column whose eventKey matches no registry row:
// /api/keitaro/reports accepts a sort id by SHAPE, so a parse is an acceptance,
// and every row then read 0/null, every comparison tied, and the sort silently
// did nothing. Rejected, the route falls back to `revenue` — which is visible.
// ONE-SIDED: the same shape with a legal key parses (B7), so "reject everything"
// fails too.
check(
  "B6 ⭐ a key the DB could never hold is rejected rather than parsed into a column that matches nothing",
  eventColumnById("evt:PURCHASE:count") === null &&
    eventColumnById("evt:2fast:count") === null &&
    eventColumnById("evt:with space:count") === null &&
    eventColumnById("evt:kebab-case:count") === null &&
    eventColumnById("evtfunnel:signup:Purchase") === null,
  JSON.stringify([eventColumnById("evt:PURCHASE:count"), eventColumnById("evtfunnel:signup:Purchase")]),
);
check(
  "B7 a LEGAL key shape still parses — digits and underscores included (positive control on B6)",
  eventColumnById("evt:legacy_cpa2:count")?.eventKey === "legacy_cpa2" &&
    eventColumnById("evt:signup:pending_revenue")?.kind === "pending_revenue" &&
    eventColumnById("evtfunnel:signup:deposit_2")?.toKey === "deposit_2",
  JSON.stringify(eventColumnById("evt:legacy_cpa2:count")),
);

// ── the shared empty tally ───────────────────────────────────────────────────
// ⭐ THE REVIEW'S FINDING, MADE PERMANENT. `EMPTY_TALLY` is exported and
// `eventCellValue` hands it back for a missing key, so the obvious mistake in any
// consumer — `acc[k] = EMPTY_TALLY` followed by `addEventMaps(acc, …)` — mutated
// the ONE shared object for the whole process. It failed SILENTLY: the review
// measured an unrelated missing-key count cell reading 5 instead of 0 while every
// bar above this line stayed green.
check("S1 ⭐ EMPTY_TALLY is frozen, so the mistake below cannot be silent", Object.isFrozen(EMPTY_TALLY), JSON.stringify(EMPTY_TALLY));
const poison: EventMap = {};
// ⚠️ NO CAST, AND NO ERROR. `Readonly<EventTally>` does NOT stop this line:
// TypeScript ignores `readonly` modifiers when checking assignability, so a
// Readonly<T> goes into a Record<string, T> clean (measured 2026-09-18; the type
// only rejects a DIRECT write, TS2540). The freeze is what catches this one.
poison.ghost = EMPTY_TALLY;
let poisonThrew = false;
try {
  addEventMaps(poison, { ghost: { n: 5, pending_n: 5, revenue: 5, pending_revenue: 5 } });
} catch {
  poisonThrew = true; // frozen ⇒ a loud TypeError AT the mistake, not silent corruption elsewhere
}
check(
  "S2 ⭐ seeding an accumulator with EMPTY_TALLY cannot poison it process-wide",
  poisonThrew &&
    EMPTY_TALLY.n === 0 &&
    EMPTY_TALLY.pending_n === 0 &&
    EMPTY_TALLY.revenue === 0 &&
    EMPTY_TALLY.pending_revenue === 0,
  `threw=${poisonThrew} EMPTY_TALLY=${JSON.stringify(EMPTY_TALLY)}`,
);
check(
  "S3 ⭐ and an unrelated missing-key count cell STILL reads 0 (E12, re-asked after the attempt)",
  eventCellValue(by("evt:purchase:count"), {}, 200) === 0,
  String(eventCellValue(by("evt:purchase:count"), {}, 200)),
);
check(
  "S4 emptyTally() hands out a FRESH mutable zero, so nobody has to reach for the constant",
  (() => {
    const one = emptyTally();
    const two = emptyTally();
    one.n = 9;
    return one !== two && two.n === 0 && one !== (EMPTY_TALLY as EventTally) && EMPTY_TALLY.n === 0;
  })(),
);

// ── N: the schema mirror leads the database, so a BARE select is a hidden
// dependency ────────────────────────────────────────────────────────────────
//
// db/schema.ts names `events` and `unmapped_conversions` (0185) from the commit
// that adds them, while the DATABASE gets them only when the migration is
// applied — additive leads the code, CLAUDE.md §14. Drizzle's `db.select()` with
// no projection expands to every column the MIRROR names, so a handler that
// reads none of them still asks for them and answers 42703 (undefined_column)
// against a database that is one migration behind. N1 pins that premise against
// the real drizzle version; N2 is the bar: nothing selects this table without
// saying which columns it wants.
const bareSelectSql = new QueryBuilder().select().from(keitaro_stage_results).toSQL().sql;
check(
  "N1 ⭐ PREMISE: a bare db.select() over keitaro_stage_results really does expand to the mirror, `events` and `unmapped_conversions` included — this is what makes a projection-less read a dependency on migration 0185",
  bareSelectSql.includes('"events"') && bareSelectSql.includes('"unmapped_conversions"'),
  bareSelectSql,
);

/** Every .ts/.tsx under a shipped source root, so the scan cannot miss a new caller. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
    }
  };
  walk(root);
  return out;
}
// `.select()` — empty parens — reaching a `.from(keitaro_stage_results)` through
// any chain of intervening calls. `.select({...})` does not match: the parens are
// not empty.
const BARE_SELECT_ON_TABLE = /\.select\(\s*\)[\s\S]{0,400}?\.from\(\s*keitaro_stage_results\s*\)/;
const scanned = [...sourceFiles("app"), ...sourceFiles("lib")];
const bareCallers = scanned.filter((f) => BARE_SELECT_ON_TABLE.test(readFileSync(f, "utf8")));
check(
  `N2 ⭐ no shipped module selects keitaro_stage_results without a projection (scanned ${scanned.length} files under app/ and lib/) — a bare select there depends on every column the mirror has, not the ones it reads`,
  scanned.length > 100 && bareCallers.length === 0,
  `scanned=${scanned.length} bare=${bareCallers.join(", ") || "none"}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
