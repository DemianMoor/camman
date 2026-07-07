import {
  dailyMessage,
  hourlyMessage,
} from "@/lib/reporting/telegram-report-format";
import type { ReportMetrics } from "@/lib/reporting/report-snapshot";

// Renders the daily + hourly messages from the ground-truth metrics pulled via
// the Supabase MCP (2026-07-01 final, 2026-07-02 so far), asserting the format
// and the two n/a branches (spend==0 ⇒ ROI n/a; delivered==0 ⇒ ratio n/a).

const yesterday: ReportMetrics = {
  sales: 12,
  revenue: 900,
  spend: 392.26,
  optOuts: 853,
  delivered: 38502,
  roiPct: ((900 - 392.26) / 392.26) * 100,
};
const today: ReportMetrics = {
  sales: 1,
  revenue: 75,
  spend: 0,
  optOuts: 9,
  delivered: 0,
  roiPct: null, // spend == 0
};

let failures = 0;
function eq(name: string, got: string, expected: string) {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}`);
  if (!ok) {
    console.log("  got:\n" + got);
    console.log("  expected:\n" + expected);
  }
}

const daily = dailyMessage("Wed 1 Jul", yesterday);
eq(
  "daily",
  daily,
  [
    "📊 <b>CamMan — Wed 1 Jul</b> (final, ET)",
    "Sales: 12",
    "Revenue: $900.00",
    "Spend: $392.26",
    "ROI: +129.4%",
    "Net Profit: $507.74",
    "Opt-outs: 853 (2.2% of 38,502 delivered)",
  ].join("\n"),
);

const hourly = hourlyMessage("Thu 2 Jul", today, 392.26);
eq(
  "hourly (spend==0 ⇒ ROI n/a, delivered==0 ⇒ ratio n/a)",
  hourly,
  [
    "⏱ <b>CamMan — Thu 2 Jul</b> (so far, ET)",
    "Sales: 1",
    "Revenue: $75.00",
    "Spend: $0.00",
    "ROI: n/a",
    "Net Profit: $75.00",
    "Opt-outs: 9 (n/a — 0 delivered)",
    "Yesterday spend: $392.26",
  ].join("\n"),
);

// Negative net profit renders as -$X.XX (minus before the $).
const loss: ReportMetrics = {
  sales: 2,
  revenue: 100,
  spend: 250,
  optOuts: 5,
  delivered: 1000,
  roiPct: ((100 - 250) / 250) * 100,
};
eq(
  "daily (net loss ⇒ -$150.00, ROI -60.0%)",
  dailyMessage("Fri 3 Jul", loss),
  [
    "📊 <b>CamMan — Fri 3 Jul</b> (final, ET)",
    "Sales: 2",
    "Revenue: $100.00",
    "Spend: $250.00",
    "ROI: -60.0%",
    "Net Profit: -$150.00",
    "Opt-outs: 5 (0.5% of 1,000 delivered)",
  ].join("\n"),
);

console.log("\n--- rendered daily ---\n" + daily);
console.log("\n--- rendered hourly ---\n" + hourly);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
