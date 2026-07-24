// Pure unit test for the Phase 4 drain-estimate formatter (no DB).
// Run: npx tsx scripts/test-preflight-estimate.ts
import { formatDrainEstimate } from "@/lib/sends/preflight";

let failed = 0;
const eq = (name: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got "${got}" want "${want}"`}`);
};

eq("sub-minute rounds to seconds", formatDrainEstimate(30), "≈ 30s");
eq("floor at 1s", formatDrainEstimate(0.4), "≈ 1s");
eq("minutes", formatDrainEstimate(45 * 60), "≈ 45m");
eq("just under an hour", formatDrainEstimate(59 * 60), "≈ 59m");
eq("whole hours", formatDrainEstimate(2 * 3600), "≈ 2h");
eq("hours + minutes", formatDrainEstimate(2 * 3600 + 5 * 60), "≈ 2h 5m");
// The live incident: 9,000 messages on a 3/s toll-free number.
eq("9000 msgs @ 3/s ≈ 50m", formatDrainEstimate(Math.ceil(9000 / 3)), "≈ 50m");
// Same audience on a 60/s short code.
eq("9000 msgs @ 60/s ≈ 3m", formatDrainEstimate(Math.ceil(9000 / 60)), "≈ 3m");

if (failed) { console.log(`\nFAILED: ${failed}`); process.exit(1); }
console.log("\ntest-preflight-estimate OK.");
