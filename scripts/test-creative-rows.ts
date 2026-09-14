// Pure checks for lib/reporting/creative-rows.ts. No database.
// Run: npx tsx scripts/test-creative-rows.ts
import { hideBelowMinSent, rpmOf, sendDaysOf, sortCreativeRows } from "../lib/reporting/creative-rows";
import { isCreativeSortKey, isPerformanceDimension, REPORT_DIMENSIONS } from "../lib/reporting/report-dimensions";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

check("rpm = revenue / sent × 1000, 2 decimals", rpmOf(250, 3000) === 83.33, rpmOf(250, 3000));
check("rpm is null at 0 sent", rpmOf(10, 0) === null);

const rows = [
  { key: "1:10", sent: 1000, revenue: 50, rpm: 50, click_to_reach_pct: null },
  { key: "2:10", sent: 4000, revenue: 50, rpm: 12.5, click_to_reach_pct: 3.1 },
  { key: "3:11", sent: 2000, revenue: 90, rpm: 45, click_to_reach_pct: 9.9 },
  { key: "4:11", sent: 0, revenue: 0, rpm: null, click_to_reach_pct: null },
];
const order = (sorted: { key: string }[]) => sorted.map((r) => r.key).join();
check("revenue desc, ties by sent desc", order(sortCreativeRows(rows, "revenue")) === "3:11,2:10,1:10,4:11", order(sortCreativeRows(rows, "revenue")));
check("rpm desc, nulls last", order(sortCreativeRows(rows, "rpm")) === "1:10,3:11,2:10,4:11", order(sortCreativeRows(rows, "rpm")));
check(
  "click_to_reach_pct desc, nulls last, null ties by sent",
  order(sortCreativeRows(rows, "click_to_reach_pct")) === "3:11,2:10,1:10,4:11",
  order(sortCreativeRows(rows, "click_to_reach_pct")),
);
check("sent desc", order(sortCreativeRows(rows, "sent")) === "2:10,3:11,1:10,4:11", order(sortCreativeRows(rows, "sent")));
check("sorting does not mutate the input", rows[0].key === "1:10");

const hidden = hideBelowMinSent(rows, 1500);
check("min_sent keeps rows with sent >= threshold", order(hidden.rows) === "2:10,3:11", order(hidden.rows));
check("min_sent counts the hidden rows", hidden.hidden === 2, hidden.hidden);
check("min_sent 0 hides nothing", hideBelowMinSent(rows, 0).hidden === 0);

check(
  "send days: first, last, distinct",
  JSON.stringify(sendDaysOf(["2026-09-03", "2026-09-01", "2026-09-03"])) ===
    JSON.stringify({ first_sent_date: "2026-09-01", last_sent_date: "2026-09-03", distinct_send_days: 2 }),
);
check(
  "send days: none",
  JSON.stringify(sendDaysOf([])) ===
    JSON.stringify({ first_sent_date: null, last_sent_date: null, distinct_send_days: 0 }),
);

check("creative is a performance dimension", isPerformanceDimension("creative"));
check("creative is NOT a Reports tab", !(REPORT_DIMENSIONS as readonly string[]).includes("creative"));
check("existing dimensions stay accepted", isPerformanceDimension("offer") && isPerformanceDimension("hourly"));
check("an unknown dimension is rejected", !isPerformanceDimension("brand"));
check("sort keys", isCreativeSortKey("rpm") && !isCreativeSortKey("profit"));

console.log(failures === 0 ? "\ntest-creative-rows OK." : `\nFAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
