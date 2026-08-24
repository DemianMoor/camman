// Read-only probe: runs the tracking-gap monitor against the configured database
// and prints what it would alert on. Sends NOTHING. Safe to run anytime.
// Run: npx tsx scripts/probe-tracking-gap.ts
import "./_env-preload";

import { db } from "@/db/client";
import { runTrackingGapMonitor } from "@/lib/reporting/tracking-gap";

// Wrapped in main() rather than top-level await: this repo's scripts run
// under tsx with no "type": "module" in package.json, so tsx transpiles to
// CJS, which esbuild rejects top-level await under (see other scripts/*.ts
// for the same async-main + .catch() convention).
async function main() {
  const started = Date.now();
  const report = await runTrackingGapMonitor(db);
  const ms = Date.now() - started;

  console.log(
    `evaluated ${report.stages_evaluated} stage(s) in ${ms}ms — ` +
      `${report.breaches.length} breach(es), ${report.clean_stage_ids.length} clean`,
  );
  console.log(
    `thresholds: >=${report.min_human_clicks} human clicks, ` +
      `sent ${report.maturity_hours}h-${report.window_days}d ago\n`,
  );
  for (const b of report.breaches) {
    console.log(
      `  stage ${b.stage_id}  ${b.tracking_id}  ${b.human_clicks} human clicks  ` +
        `${b.redirects} redirects\n    ${b.campaign_name}\n    ${b.destination_url}`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
