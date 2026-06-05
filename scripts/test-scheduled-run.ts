// Safe (read-only / no-send) checks for the scheduler orchestration.
//   1. SEND_ENABLED off -> runScheduledSends no-ops (returns send_disabled,
//      considered 0) WITHOUT touching any stage.
//   2. The due-stages selection SQL is valid and returns well-shaped rows.
// Does NOT fire any send (no isEnabled=true path) — never sends live.
//
// Run: npx tsx scripts/test-scheduled-run.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { db, sql as pgConn } from "@/db/client";
import { runScheduledSends, selectDueScheduledStages } from "@/lib/sends/scheduled";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  // 1. Kill-switch no-op. Injected isEnabled=false returns before any DB write.
  const off = await runScheduledSends(db, { isEnabled: () => false });
  check("SEND_ENABLED off -> send_disabled", off.send_disabled === true);
  check("SEND_ENABLED off -> nothing considered", off.considered === 0 && off.fired === 0);

  // 2. Due-selection SQL is valid (read-only). We don't assert a count — just
  // that it executes and returns an array of the right shape.
  const due = await selectDueScheduledStages(db, { now: new Date(), maxStages: 50 });
  check("due-stages query executes and returns an array", Array.isArray(due));
  console.log(`   (currently ${due.length} due tracked/approved stage(s))`);
  if (due[0]) {
    const r = due[0];
    check(
      "due row has expected shape",
      typeof r.stage_id === "number" &&
        typeof r.campaign_id === "number" &&
        typeof r.org_id === "string",
    );
  }

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nScheduler read-only checks passed." : `\nFAILED: ${failed} check(s).`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Scheduler test crashed:", err);
  process.exit(1);
});
