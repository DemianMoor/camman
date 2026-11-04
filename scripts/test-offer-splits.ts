// Pure checks for lib/reporting/offer-splits.ts splitStageMetrics. No DB.
// Run: npx tsx --conditions=react-server scripts/test-offer-splits.ts
import { splitStageMetrics, type OfferSplit } from "../lib/reporting/offer-splits";
import { addMetrics, zeroMetrics, type PerfMetrics } from "../lib/reporting/performance-report";

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

const base = (): PerfMetrics => ({
  ...zeroMetrics(),
  sent: 1000,
  opt_outs: 7,
  clickers: 120,
  redirects: 90,
  reached: 80,
  counted_clickers: 100,
  lifetime_clickers: 150,
  lifetime_revenue: 999.5,
  sales: 10,
  revenue: 500.25,
  pending_revenue: 40,
  events: {
    lead: { n: 12, pending_n: 2, revenue: 0, pending_revenue: 0 },
    purchase: { n: 10, pending_n: 1, revenue: 500.25, pending_revenue: 40 },
  },
  unmapped: 3,
  manual_topup: 0,
  cost: 77.7,
});
const split = (offer: number, o: Partial<OfferSplit> = {}): OfferSplit => ({
  stage_id: 1,
  offer_id: offer,
  sales: 0,
  revenue: 0,
  pending_revenue: 0,
  events: {},
  ...o,
});

// Sum of slices == m for EVERY numeric field and every events[key] field (generic).
const SPLIT_FIELDS = new Set(["split_in_revenue", "split_out_revenue"]);
function invariant(m: PerfMetrics, slices: ReturnType<typeof splitStageMetrics>): string {
  const sum = slices.map((s) => s.metrics).reduce((a, b) => addMetrics(a, b), zeroMetrics());
  const bad: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (SPLIT_FIELDS.has(k) || k === "events") continue;
    if (k === "reached") {
      if (sum.reached !== v) bad.push(k);
    } else if (typeof v === "number") {
      if (Math.abs((sum as unknown as Record<string, number>)[k] - v) > 1e-9) bad.push(k);
    }
  }
  const keys = new Set([...Object.keys(m.events), ...Object.keys(sum.events)]);
  for (const key of keys) {
    for (const f of ["n", "pending_n", "revenue", "pending_revenue"] as const) {
      const a = sum.events[key]?.[f] ?? 0;
      const b = m.events[key]?.[f] ?? 0;
      if (Math.abs(a - b) > 1e-9) bad.push(`events.${key}.${f}`);
    }
  }
  const sin = slices.reduce((a, s) => a + s.metrics.split_in_revenue, 0);
  const sout = slices.reduce((a, s) => a + s.metrics.split_out_revenue, 0);
  if (Math.abs(sin - sout) > 1e-9) bad.push("split_in != split_out");
  // Per-key split deltas cancel across the slices (out on the primary, in on each split).
  for (const [key, v] of Object.entries(sum.event_split_delta)) {
    if (Math.abs(v - (m.event_split_delta[key] ?? 0)) > 1e-9) bad.push(`event_split_delta.${key}`);
  }
  return bad.join(",");
}

// S1
{
  const m = base();
  const r = splitStageMetrics(5, m, []);
  check("S1 no splits => one slice identical to m", r.length === 1 && r[0].metrics === m && !r[0].secondary && r[0].offer_id === 5);
  check("S1 invariant", invariant(m, r) === "");
}
// S2
{
  const m = base();
  const r = splitStageMetrics(5, m, [
    split(6, { sales: 2, revenue: 100.1, pending_revenue: 10, events: { purchase: { n: 2, pending_n: 0, revenue: 100.1, pending_revenue: 10 } } }),
  ]);
  check("S2 two slices", r.length === 2 && !r[0].secondary && r[1].secondary && r[1].offer_id === 6);
  check("S2 invariant", invariant(m, r) === "", invariant(m, r));
  check("S2 primary reduced, keeps sent/cost/reached", r[0].metrics.sales === 8 && r[0].metrics.sent === 1000 && r[0].metrics.cost === 77.7 && r[0].metrics.reached === 80);
  check("S2 secondary carries only the four fields", r[1].metrics.sent === 0 && r[1].metrics.cost === 0 && r[1].metrics.reached === null && r[1].metrics.sales === 2);
  check("S2 split_out/in set", Math.abs(r[0].metrics.split_out_revenue - 100.1) < 1e-9 && r[1].metrics.split_in_revenue === 100.1 && r[0].metrics.split_in_revenue === 0);
  check("S2 input not mutated", m.sales === 10 && m.events.purchase.n === 10);
}
// S3
{
  const m = base();
  const r = splitStageMetrics(5, m, [
    split(6, { sales: 1, revenue: 50, events: { purchase: { n: 1, pending_n: 0, revenue: 50, pending_revenue: 0 } } }),
    split(7, { sales: 3, revenue: 150, pending_revenue: 5, events: { purchase: { n: 3, pending_n: 1, revenue: 150, pending_revenue: 5 } } }),
  ]);
  check("S3 three slices", r.length === 3 && r[1].offer_id === 6 && r[2].offer_id === 7);
  check("S3 invariant", invariant(m, r) === "", invariant(m, r));
  check("S3 split_out = sum of split_in", Math.abs(r[0].metrics.split_out_revenue - 200) < 1e-9);
}
// S4
{
  const m = base();
  const r = splitStageMetrics(5, m, [
    split(6, {
      sales: 1,
      revenue: 20,
      events: {
        lead: { n: 2, pending_n: 1, revenue: 0, pending_revenue: 0 },
        purchase: { n: 1, pending_n: 0, revenue: 20, pending_revenue: 0 },
      },
    }),
  ]);
  check(
    "S4 events move by key",
    r[0].metrics.events.lead.n === 10 && r[0].metrics.events.lead.pending_n === 1 &&
      r[0].metrics.events.purchase.n === 9 && r[1].metrics.events.lead.n === 2 && r[1].metrics.events.purchase.revenue === 20,
  );
  check("S4 invariant", invariant(m, r) === "", invariant(m, r));
  check(
    "S4 per-key own-revenue delta: +20 purchase on the campaign slice, -20 on the split",
    r[0].metrics.event_split_delta.purchase === 20 && r[1].metrics.event_split_delta.purchase === -20,
    JSON.stringify([r[0].metrics.event_split_delta, r[1].metrics.event_split_delta]),
  );
}
// S5
{
  const m = base();
  const r = splitStageMetrics(null, m, [split(6, { sales: 2, revenue: 10 })]);
  check("S5 null campaign offer still sums", r[0].offer_id === null && invariant(m, r) === "", invariant(m, r));
}
// S6
{
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.join(" "));
  };
  const m = base();
  const cases: [string, OfferSplit][] = [
    ["sales", split(6, { sales: 11 })],
    ["revenue", split(6, { revenue: 600 })],
    ["pending_revenue", split(6, { pending_revenue: 41 })],
    ["event field", split(6, { events: { lead: { n: 13, pending_n: 0, revenue: 0, pending_revenue: 0 } } })],
    ["event key absent from m", split(6, { events: { upsell: { n: 1, pending_n: 0, revenue: 0, pending_revenue: 0 } } })],
  ];
  for (const [name, sp] of cases) {
    const r = splitStageMetrics(5, m, [sp]);
    check(
      `S6 ${name} too large => unsplit + skipped`,
      r.length === 1 && r[0].skipped === "would_go_negative" && r[0].metrics === m && r[0].offer_id === 5 && invariant(m, r) === "",
    );
  }
  console.warn = orig;
  check("S6 warned once per case, never silent", warns.length === cases.length && warns.every((w) => w.includes("offer-splits")));
  const exact = splitStageMetrics(5, m, [split(6, { sales: 10, revenue: 500.25, pending_revenue: 40 })]);
  check("S6 exact equality (primary reaches 0) is allowed", exact.length === 2 && exact[0].metrics.sales === 0 && !exact[0].skipped);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
