// Pure checks for lib/audience/pool-math.ts. No database.
// Run: npx tsx scripts/test-audience-pool-math.ts
import {
  poolCounts,
  REST_BUCKETS,
  restedCount,
  type HistogramsByGroup,
  type OfferHistograms,
} from "../lib/audience/pool-math";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const hist = (entries: Record<number, number>) =>
  Array.from({ length: REST_BUCKETS }, (_, b) => entries[b] ?? 0);

// Group "7": 100 eligible — 10 messaged today, 20 three days ago, 30 ten days
// ago, 40 never (bucket 31). The org total adds 5 never-messaged outside the group.
const base: HistogramsByGroup = {
  "7": hist({ 0: 10, 3: 20, 10: 30, 31: 40 }),
  total: hist({ 0: 10, 3: 20, 10: 30, 31: 45 }),
};
// The offer reached 25 of them (10 today, 15 ten days ago): 12 neither clicked
// nor converted (5 today, 7 ten days ago), 6 clicked without buying (2 today,
// 4 ten days ago).
const offer: OfferHistograms = {
  received: { "7": hist({ 0: 10, 10: 15 }) },
  received_not_clicked: { "7": hist({ 0: 5, 10: 7 }) },
  clickers_non_buyers: { "7": hist({ 0: 2, 10: 4 }) },
};

check("restedCount of an absent histogram is 0", restedCount(undefined, 7) === 0);
check("restedCount at 0 sums every bucket", restedCount(base["7"], 0) === 100);
check("restedCount at 7 keeps buckets >= 7", restedCount(base["7"], 7) === 70);
check("bucket 31 (31+ days or never) is rested at rest_days 30", restedCount(base["7"], 30) === 40);

const g7 = poolCounts(base, offer, "7", 7);
check("group_total_eligible", g7.group_total_eligible === 100, g7);
check("never_received = eligible - received", g7.never_received === 75, g7);
check("never_received_rested = rested eligible - rested received", g7.never_received_rested === 55, g7);
check("received_not_clicked_rested", g7.received_not_clicked_rested === 7, g7);
check("clickers_non_buyers", g7.clickers_non_buyers === 6, g7);
check("clickers_non_buyers_rested", g7.clickers_non_buyers_rested === 4, g7);

const g0 = poolCounts(base, offer, "7", 0);
check(
  "rest_days 0: every rested count equals its unrested count",
  g0.never_received_rested === g0.never_received && g0.clickers_non_buyers_rested === g0.clickers_non_buyers,
  g0,
);
let monotone = true;
let prev = g0;
for (let n = 1; n <= 30; n++) {
  const cur = poolCounts(base, offer, "7", n);
  if (
    cur.never_received_rested > prev.never_received_rested ||
    cur.received_not_clicked_rested > prev.received_not_clicked_rested ||
    cur.clickers_non_buyers_rested > prev.clickers_non_buyers_rested
  ) {
    monotone = false;
  }
  prev = cur;
}
check("every rested count is non-increasing in rest_days", monotone);

const never = poolCounts(base, undefined, "7", 7);
check(
  "an offer that never sent: never_received = eligible, the rest 0",
  never.never_received === 100 &&
    never.never_received_rested === 70 &&
    never.received_not_clicked_rested === 0 &&
    never.clickers_non_buyers === 0,
  never,
);
check("a group key absent from the snapshot counts 0", poolCounts(base, offer, "999", 7).group_total_eligible === 0);
check("the totals key reads the org histogram", poolCounts(base, undefined, "total", 0).group_total_eligible === 105);

console.log(failures === 0 ? "\ntest-audience-pool-math OK." : `\nFAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
