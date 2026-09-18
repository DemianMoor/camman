import { addRowToFunnel, emptyFunnel, mergeFunnel, type KeitaroResultRowLike } from "@/lib/keitaro/funnel";
import { normaliseLifetimeRow } from "@/lib/reporting/creative-lifetime";
import type { EventMap } from "@/lib/reporting/event-columns";
import {
  addMetrics,
  scaleMetrics,
  ZERO,
  zeroMetrics,
  type PerfMetrics,
} from "@/lib/reporting/performance-report";

// PURE. Run: npx tsx --conditions=react-server scripts/test-event-tally-merge.ts
//
// ⭐ THE FIELD-COVERAGE BARS ARE THE POINT. PerfMetrics is summed, scaled and
// fractionally split in five places; a field missed in any one of them reads zero
// on exactly one tab, which is the hardest kind of reporting bug to notice. A1/A2
// enumerate the keys instead of naming them, so a SIXTH field added later without
// touching addMetrics/scaleMetrics goes red here rather than on a screen.
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

const one = { n: 1, pending_n: 0, revenue: 10, pending_revenue: 0 };

// ⭐ A MISSING ENTRY IS A SENTINEL, NOT A CRASH. Each bar below reads the very
// key the mutation it guards against would DROP, and `m.purchase.n` on a missing
// key throws — which fails the run without printing which bar went red, so the
// proof that the bar can go red would be unreadable. -1 is never a legitimate
// count or revenue in these fixtures.
type T = { n: number; pending_n: number; revenue: number; pending_revenue: number };
const EN = (t: T | undefined) => t?.n ?? -1;
const ER = (t: T | undefined) => t?.revenue ?? -1;

// ── field coverage ──────────────────────────────────────────────────────────
// ⭐ `reached` IS SPECIAL AND BOTH BARS MUST SAY SO. It is `number | null` and
// addMetrics folds it through addNullable (lib/reporting/performance-report.ts),
// so 3 + 3 = 6, not 14. An earlier draft of this plan special-cased it in A2 and
// forgot to in A1, which made A1 fail for ever — a headline coverage guard that
// is permanently red is worse than no guard, because it trains people to ignore
// the output.
const probe = Object.fromEntries(
  Object.keys(ZERO).map((k) => [k, k === "events" ? { x: { ...one } } : k === "reached" ? 3 : 7]),
) as never;
const expectAdd = (k: string) => (k === "reached" ? 6 : 14);
const summed = addMetrics(probe, probe) as unknown as Record<string, unknown>;
const missedAdd = Object.keys(ZERO).filter((k) =>
  k === "events"
    ? (summed.events as Record<string, typeof one>).x?.n !== 2
    : summed[k] !== expectAdd(k),
);
check("A1 ⭐ addMetrics carries EVERY field of PerfMetrics", missedAdd.length === 0, missedAdd.join(","));
const scaled = scaleMetrics(probe, 0.5) as unknown as Record<string, unknown>;
const missedScale = Object.keys(ZERO).filter((k) =>
  k === "events"
    ? (scaled.events as Record<string, typeof one>).x?.n !== 0.5
    : scaled[k] !== (k === "reached" ? 1.5 : 3.5),
);
check("A2 ⭐ scaleMetrics carries EVERY field of PerfMetrics", missedScale.length === 0, missedScale.join(","));

// ── no shared mutable state ─────────────────────────────────────────────────
const z1 = zeroMetrics();
const z2 = zeroMetrics();
z1.events.purchase = { ...one };
check("A3 ⭐ two zeroMetrics() do NOT share one events map", z2.events.purchase === undefined);
// (An earlier draft asserted `{ ...ZERO }.events === ZERO.events` here. That is a
// property of JavaScript's spread operator, not of this code, and can never fail
// — it was furniture. Replaced by the bar that CAN fail: the frozen map.)
let froze = false;
try {
  (ZERO.events as EventMap).sneak = { ...one };
} catch {
  froze = true;
}
check(
  "A4 ⭐ ZERO.events is FROZEN, so a forgotten zeroMetrics() throws instead of corrupting a later request",
  froze && ZERO.events.sneak === undefined,
  JSON.stringify(ZERO.events),
);
const a = zeroMetrics();
const b = zeroMetrics();
b.events.purchase = { ...one };
const merged = addMetrics(a, b);
if (merged.events.purchase) merged.events.purchase.n = 99;
check(
  "A5 ⭐ addMetrics does not alias either input's map",
  EN(merged.events.purchase) === 99 && EN(b.events.purchase) === 1 && a.events.purchase === undefined,
  JSON.stringify({ merged: merged.events, a: a.events, b: b.events }),
);

// ── the persisted lifetime blob ─────────────────────────────────────────────
check(
  "A6 ⭐ a pre-0185 stored blob normalises to an EMPTY breakdown, not undefined",
  (() => {
    // A pre-0185 blob: no `events`, no `unmapped`, no `manual_topup`. Cast
    // THROUGH unknown, not `as never` — `never` would infer T = never and the
    // reads below would not typecheck against anything.
    const r = { sales: 1 } as unknown as PerfMetrics;
    const n = normaliseLifetimeRow(r);
    return Object.keys(n.events).length === 0 && n.unmapped === 0 && n.manual_topup === 0;
  })(),
);

// ── money precision through scaling and merging ─────────────────────────────
// ⭐ THESE BARS EXIST BECAUSE THE By-Group TAB SCALES AND THEN SUMS. Revenue
// inside the jsonb is numeric(12,4) and arrives as a JS double; a split that
// loses the fourth decimal, or that is not distributive, would show a group
// breakdown that does not foot to the stage it was split out of. Money is
// compared with an EXPLICIT tolerance tighter than the smallest representable
// unit (1e-4), never with ===, because a share is 1/3 of something.
const CENT4 = 1e-6; // an order of magnitude below the 0.0001 the column stores
const money = (x: number, y: number) => Math.abs(x - y) < CENT4;
const M = (rev: number, n = 1): EventMap => ({ purchase: { n, pending_n: 0, revenue: rev, pending_revenue: 0 } });
const P = (rev: number, n = 1) => ({ ...zeroMetrics(), sales: n, revenue: rev, events: M(rev, n) });

// A four-decimal revenue survives the funnel's two mergers unchanged.
const mt = emptyFunnel();
addRowToFunnel(mt, {
  visit_clicks_raw: 0, visit_clicks_clean: 0, redirect_clicks_raw: 0, redirect_clicks_clean: 0,
  raw_clicks: 0, clean_clicks: 0, sales: 1, revenue: "1234567.8901", pending_revenue: 0, cost: 0,
  events: { purchase: { n: 1, pending_n: 0, revenue: 1234567.8901, pending_revenue: 0.0001 } },
});
const mt2 = emptyFunnel();
mergeFunnel(mt2, mt);
check(
  "M1 ⭐ a 4-decimal revenue survives addRowToFunnel + mergeFunnel exactly",
  ER(mt2.events.purchase) === 1234567.8901 && (mt2.events.purchase?.pending_revenue ?? -1) === 0.0001,
  JSON.stringify(mt2.events),
);

// The By-Group split: scale by every share, then sum — must return the whole.
const whole = P(1234567.8901, 3);
const fracs = [1 / 3, 1 / 3, 1 / 3];
const reassembled = fracs
  .map((f) => scaleMetrics(whole, f))
  .reduce((acc, m) => addMetrics(acc, m), zeroMetrics());
check(
  "M2 ⭐ Σ scaleMetrics(m, fracᵢ) = m when Σ fracᵢ = 1 (the By-Group split reconciles, to 4 decimals)",
  money(ER(reassembled.events.purchase), 1234567.8901) &&
    money(EN(reassembled.events.purchase), 3) &&
    money(reassembled.revenue, 1234567.8901),
  `${ER(reassembled.events.purchase)} vs 1234567.8901`,
);

// Distributivity: the code scales the PARTS and sums them; a reader who sums the
// parts and scales the whole must get the same number, or By Group and the
// dimension it is split out of disagree.
const p1 = P(99.9999, 2);
const p2 = P(0.0001, 1);
const f = 0.25;
const scaleThenSum = addMetrics(scaleMetrics(p1, f), scaleMetrics(p2, f));
const sumThenScale = scaleMetrics(addMetrics(p1, p2), f);
check(
  "M3 ⭐ scaling then summing = summing then scaling, for the map and the scalar alike",
  money(ER(scaleThenSum.events.purchase), ER(sumThenScale.events.purchase)) &&
    ER(scaleThenSum.events.purchase) !== -1 &&
    money(scaleThenSum.revenue, sumThenScale.revenue) &&
    money(EN(scaleThenSum.events.purchase), EN(sumThenScale.events.purchase)),
  `${ER(scaleThenSum.events.purchase)} vs ${ER(sumThenScale.events.purchase)}`,
);

// ── unmapped survives every pure aggregation path ───────────────────────────
// ⭐ `unmapped` IS THE ONLY THING THAT EXPLAINS THE GAP between Σ (is_purchase) n
// and `sales`, together with manual_topup. A path that carries `events` but drops
// `unmapped` presents the breakdown as a complete explanation of Sales when it is
// not — so each aggregation is asserted on it SEPARATELY rather than trusting
// A1/A2 to have covered it.
const u1 = { ...zeroMetrics(), unmapped: 2, manual_topup: 5 };
const u2 = { ...zeroMetrics(), unmapped: 3, manual_topup: 7 };
const uSum = addMetrics(u1, u2);
const uScaled = scaleMetrics(uSum, 0.5);
const uFunnel = emptyFunnel();
addRowToFunnel(uFunnel, {
  visit_clicks_raw: 0, visit_clicks_clean: 0, redirect_clicks_raw: 0, redirect_clicks_clean: 0,
  raw_clicks: 0, clean_clicks: 0, sales: 0, revenue: 0, pending_revenue: 0, cost: 0,
  unmapped_conversions: 4,
});
const uMerged = emptyFunnel();
mergeFunnel(uMerged, uFunnel);
check(
  "U1 ⭐ unmapped + manual_topup survive addMetrics, scaleMetrics, addRowToFunnel and mergeFunnel",
  uSum.unmapped === 5 && uSum.manual_topup === 12 &&
    uScaled.unmapped === 2.5 && uScaled.manual_topup === 6 &&
    uFunnel.unmapped === 4 && uMerged.unmapped === 4,
  JSON.stringify({ uSum: uSum.unmapped, uScaled: uScaled.unmapped, uFunnel: uFunnel.unmapped, uMerged: uMerged.unmapped }),
);

// ── the funnel tally ────────────────────────────────────────────────────────
// ⚠️ `pending_revenue` IS REQUIRED on KeitaroResultRowLike since Phase 3 Task 6
// (lib/keitaro/funnel.ts) — a literal that omits it does not compile. Build the
// fixtures from a base so a future required field is a one-line fix here rather
// than N literals to hunt.
const ROW = (over: Partial<KeitaroResultRowLike> = {}): KeitaroResultRowLike => ({
  visit_clicks_raw: 0, visit_clicks_clean: 0, redirect_clicks_raw: 0, redirect_clicks_clean: 0,
  raw_clicks: 0, clean_clicks: 0, sales: 0, revenue: 0, pending_revenue: 0, cost: 0,
  ...over,
});

const t = emptyFunnel();
addRowToFunnel(t, ROW({
  sales: 2, revenue: "80.0000",
  events: { purchase: { n: 2, pending_n: 0, revenue: "80.0000", pending_revenue: "0.0000" } },
  unmapped_conversions: 3,
}));
check("F1 addRowToFunnel parses the jsonb STRING form (a #>> extraction, a hand-written fixture)", t.events.purchase?.revenue === 80, JSON.stringify(t.events));
check("F1b ⭐ …and the jsonb NUMBER form, which is what node-postgres actually returns", (() => { const u = emptyFunnel(); addRowToFunnel(u, ROW({ events: { purchase: { n: 1, pending_n: 0, revenue: 12.5, pending_revenue: 0 } } })); return ER(u.events.purchase) === 12.5; })());
check("F2 addRowToFunnel carries the unmapped count", t.unmapped === 3);
addRowToFunnel(t, ROW({
  events: { registration: { n: 5, pending_n: 0, revenue: 0, pending_revenue: 0 } },
}));
check("F3 a second row merges rather than replaces", t.events.purchase?.n === 2 && t.events.registration?.n === 5, JSON.stringify(t.events));
check("F4 ⭐ a row with NO events/unmapped columns is an empty breakdown, not a throw", t.unmapped === 3);
const into = emptyFunnel();
mergeFunnel(into, t);
check("F5 mergeFunnel carries the map and the unmapped count", into.events.purchase?.n === 2 && into.unmapped === 3);
if (into.events.purchase) into.events.purchase.n = 42;
check("F6 ⭐ mergeFunnel did not alias the source map", EN(into.events.purchase) === 42 && EN(t.events.purchase) === 2, JSON.stringify({ into: into.events, t: t.events }));
check("F7 ⭐ two emptyFunnel() do not share one map", (() => { const x = emptyFunnel(); const y = emptyFunnel(); x.events.k = { ...one }; return y.events.k === undefined; })());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
