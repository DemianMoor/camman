import { addRowToFunnel, emptyFunnel, mergeFunnel, withFunnelDerived, type FunnelTally, type KeitaroResultRowLike } from "../lib/keitaro/funnel";

// PURE. No DB, no network.
//   npx tsx scripts/test-funnel-pending-exclusion.ts
//
// THE ONE INVARIANT PHASE 3 TASK 6 EXISTS TO CREATE: money that is still PENDING
// is carried, reported and never SPENT. `revenue` is approved-only
// (lib/sale-attribution.ts approvedRevenueClause); `pending_revenue` is the same
// money still held (pendingRevenueClause) and may yet be rejected, so it must
// never reach `epc`, `sales_cr` or `profit` — the three derived figures an
// operator makes a budget decision on.
//
// Until this file, that invariant was protected by a COMMENT
// (lib/keitaro/funnel.ts, "pending_revenue rides along untouched"). A comment
// does not go red. Phase 5 adds per-event columns on top of this shape, so the
// guard lands before the thing that will be tempted to sum them.
//
// SHAPE: differential, not a table of expected constants. Two tallies identical
// except for `pending_revenue`, and EVERY derived field must come out
// byte-identical apart from `pending_revenue` itself. That covers fields nobody
// has written yet — a future derived metric that starts consuming pending money
// goes red here without this file being touched. F5/F6 anchor the differential
// to something that DOES move, so "nothing changed" can never pass by the
// derivation having stopped reading revenue at all.

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

const DENOM = 100; // counted clickers

/** A stage-day's worth of clicks and cost, with the money left to the caller. */
function tally(money: { revenue: number; pending: number }): FunnelTally {
  return {
    ...emptyFunnel(),
    visit_clicks_raw: 130,
    visit_clicks_clean: 100,
    redirect_clicks_raw: 25,
    redirect_clicks_clean: 20,
    sales: 4,
    revenue: money.revenue,
    pending_revenue: money.pending,
    cost: 50,
  };
}

function main() {
  console.log("pending revenue is carried, never spent (lib/keitaro/funnel.ts)\n");

  // THE FIXTURE THE REVIEW ASKED FOR: pending-only. Four held purchases worth
  // $500 and not one approved dollar. Everything derived must read as though the
  // money were not there, because it may yet be taken back.
  const none = withFunnelDerived(tally({ revenue: 0, pending: 0 }), DENOM);
  const pendingOnly = withFunnelDerived(tally({ revenue: 0, pending: 500 }), DENOM);

  check(
    "F1 ⭐ EPC ignores pending money entirely — $500 held, $0 approved, EPC is 0",
    pendingOnly.epc === none.epc && pendingOnly.epc === 0,
    JSON.stringify({ pending: pendingOnly.epc, none: none.epc }),
  );
  check(
    "F2 ⭐ sales CR ignores it — it is sales / offer redirects, and held money is not a sale of its own",
    pendingOnly.sales_cr === none.sales_cr && pendingOnly.sales_cr === 4 / 20,
    JSON.stringify({ pending: pendingOnly.sales_cr, none: none.sales_cr }),
  );
  check(
    "F3 ⭐ profit ignores it — $500 held against $50 spent is still −$50, not +$450",
    pendingOnly.profit === none.profit && pendingOnly.profit === -50,
    JSON.stringify({ pending: pendingOnly.profit, none: none.profit }),
  );

  // THE CONTAINMENT GUARD. Not a list of three named fields: every derived key
  // except `pending_revenue` must be identical across the two tallies, so a
  // metric added later cannot quietly start spending held money.
  const leaked = (Object.keys(none) as (keyof typeof none)[]).filter(
    (k) => k !== "pending_revenue" && JSON.stringify(none[k]) !== JSON.stringify(pendingOnly[k]),
  );
  check(
    "F4 ⭐⭐ NO derived field moves when pending revenue appears — including ones added after this file",
    leaked.length === 0,
    JSON.stringify({ leaked, none, pendingOnly }),
  );
  check(
    "F4b and pending_revenue itself IS carried through, unrounded",
    pendingOnly.pending_revenue === 500 && none.pending_revenue === 0,
    JSON.stringify(pendingOnly.pending_revenue),
  );

  // NOT VACUOUS. The same $500, APPROVED, moves all three — so F1/F3 cannot pass
  // by the derivation having stopped reading revenue at all, and F4's
  // "nothing moved" is a statement about pending money rather than about the
  // comparison being blind.
  const approved = withFunnelDerived(tally({ revenue: 500, pending: 0 }), DENOM);
  check(
    "F5 ⭐ RED-ABILITY ANCHOR: the same $500 APPROVED does move EPC ($0 → $5.00) and profit (−$50 → $450)",
    approved.epc === 5 && approved.profit === 450,
    JSON.stringify({ epc: approved.epc, profit: approved.profit }),
  );
  check(
    "F6 so the difference between F1/F3 and F5 is the STATUS of the money, nothing else",
    approved.epc !== pendingOnly.epc && approved.profit !== pendingOnly.profit && approved.sales_cr === pendingOnly.sales_cr,
    JSON.stringify({ approved: approved.epc, pendingOnly: pendingOnly.epc }),
  );

  // THE TWO ACCUMULATORS. Held money must survive the row → tally → campaign
  // roll-up intact (it is reported), and must not be folded into `revenue` on the
  // way — the likeliest place for the two to merge is an accumulator, not the
  // derivation.
  const row: KeitaroResultRowLike = {
    visit_clicks_raw: 0,
    visit_clicks_clean: 0,
    redirect_clicks_raw: 0,
    redirect_clicks_clean: 0,
    raw_clicks: 0,
    clean_clicks: 0,
    sales: 1,
    revenue: "10.0000",
    pending_revenue: "90.0000",
    cost: "1.0000",
  };
  const acc = addRowToFunnel(addRowToFunnel(emptyFunnel(), row), row);
  check(
    "F7 addRowToFunnel keeps the two sums apart across rows (2 × $10 approved, 2 × $90 held)",
    acc.revenue === 20 && acc.pending_revenue === 180,
    JSON.stringify(acc),
  );
  const rolled = mergeFunnel(mergeFunnel(emptyFunnel(), acc), acc);
  check(
    "F8 mergeFunnel (stage → campaign) keeps them apart too",
    rolled.revenue === 40 && rolled.pending_revenue === 360,
    JSON.stringify(rolled),
  );
  check(
    "F9 ⭐ and the rolled-up EPC still divides ONLY the approved side ($40 / 100, not $400 / 100)",
    withFunnelDerived(rolled, DENOM).epc === 0.4,
    String(withFunnelDerived(rolled, DENOM).epc),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
