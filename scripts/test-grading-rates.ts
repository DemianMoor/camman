// Pure unit checks for lib/reporting/grading-rates.ts — no env, no database.
// Run: npx tsx scripts/test-grading-rates.ts
import { addNullable, gradingRates, pct } from "@/lib/reporting/grading-rates";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

check("912 of 30000 is 3.04%", pct(912, 30000) === 3.04, pct(912, 30000));
check("rounds to 2 decimals", pct(1, 3) === 33.33, pct(1, 3));
check("over 100 is not clamped", pct(150, 100) === 150, pct(150, 100));
check("zero numerator is 0, not null", pct(0, 5) === 0, pct(0, 5));
check("zero denominator is null", pct(5, 0) === null, pct(5, 0));
check("null numerator is null", pct(null, 5) === null, pct(null, 5));
check("null denominator is null", pct(5, null) === null, pct(5, null));

const tracked = gradingRates({ sent: 1000, opt_outs: 31, clicks_human: 40, reached: 10, conversions: 2 });
check("click_to_reach = reached / clicks_human", tracked.click_to_reach_pct === 25, tracked);
check("reach_to_sale = conversions / reached", tracked.reach_to_sale_pct === 20, tracked);
check("opt_rate = opt_outs / sent", tracked.opt_rate === 3.1, tracked);

const manual = gradingRates({ sent: 500, opt_outs: 5, clicks_human: 12, reached: null, conversions: 3 });
check(
  "unknown reach nulls both reach rates",
  manual.click_to_reach_pct === null && manual.reach_to_sale_pct === null,
  manual,
);
check("unknown reach leaves opt_rate intact", manual.opt_rate === 1, manual);

check("addNullable sums numbers", addNullable(2, 3) === 5);
check("addNullable: a null part on the left is skipped", addNullable(null, 3) === 3);
check("addNullable: a null part on the right is skipped", addNullable(2, null) === 2);
check("addNullable: all-null stays null", addNullable(null, null) === null);
check("addNullable: zero is a real value, not null", addNullable(0, null) === 0);

console.log(failures === 0 ? "\nAll grading-rate checks passed." : `\nFAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
