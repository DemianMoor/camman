import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres";
import { runEpcMonitors, evaluateHumanShare, EXCLUDED_CONVERSION_ALERT_PCT, RULE_F_BASELINE,
  HUMAN_SHARE_MOM_BAND_PCT, HUMAN_SHARE_FLOOR_PCT, HUMAN_SHARE_CEILING_PCT } from "@/lib/reporting/epc-monitors";
import { HEARTBEAT_JOBS, checkHeartbeats, heartbeatBreaches, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
function assert(c:boolean,m:string){if(!c)throw new Error(`ASSERTION FAILED: ${m}`);console.log(`  ✓ ${m}`);}
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:5}); const d=drizzle(c);
  const r=await runEpcMonitors(d);
  console.log("\n=== human share of taps by month ==="); console.table(r.human_share);
  console.log("=== excluded-clicker conversion ==="); console.table([r.excluded_conversion]);
  console.log("=== rule F ==="); console.table([r.rule_f]);
  console.log("=== row-5 probe ==="); console.table([r.row5]);
  console.log("=== breaches ==="); console.log(r.breaches.length ? r.breaches : "(none)");

  assert(r.human_share.series.length >= 3, "human-share series covers all months of history");
  assert(!r.human_share.breached, `human share is inside its band (mom ${r.human_share.mom_change_pct}%)`);

  // The canary must actually fire. Synthetic series, each tripping one rule.
  const spike = evaluateHumanShare([
    { month: "2026-07", taps: 600000, human: 45000, human_share_pct: 7.5 },
    { month: "2026-08", taps: 600000, human: 90000, human_share_pct: 15.0 },
  ]);
  assert(spike.breached && /month-over-month/.test(spike.reason ?? ""), `+100% MoM fires (${spike.mom_change_pct}%)`);
  const ceiling = evaluateHumanShare([
    { month: "2026-08", taps: 600000, human: 540000, human_share_pct: 90.0 },
  ]);
  assert(ceiling.breached && /ceiling/.test(ceiling.reason ?? ""), "scorer-switched-off case fires the ceiling");
  const floor = evaluateHumanShare([
    { month: "2026-08", taps: 600000, human: 6000, human_share_pct: 1.0 },
  ]);
  assert(floor.breached && /floor/.test(floor.reason ?? ""), "near-total-exclusion fires the floor");
  const noisy = evaluateHumanShare([
    { month: "2026-07", taps: 600000, human: 45000, human_share_pct: 7.5 },
    { month: "2026-08", taps: 12, human: 12, human_share_pct: 100.0 },
  ]);
  assert(!noisy.breached, "a tiny partial month is ignored, not alarmed on");
  assert(HUMAN_SHARE_MOM_BAND_PCT === 30 && HUMAN_SHARE_FLOOR_PCT === 3 && HUMAN_SHARE_CEILING_PCT === 25,
    "thresholds are ±30% MoM, floor 3%, ceiling 25%");
  assert(EXCLUDED_CONVERSION_ALERT_PCT === 0.1, "excluded-conversion threshold is 0.1% as specified");
  assert(RULE_F_BASELINE === 8, "Rule F baseline is 8 as measured");
  assert(r.rule_f.rescues >= 0, "Rule F rescue count reads");
  assert(!r.row5.breached, `row 5 still measures zero (${r.row5.reached_without_click}) — the no-ingest decision holds`);
  // Dead-man check — the reason silence can be trusted.
  console.log("\n=== heartbeats ===");
  await recordHeartbeat(d, HEARTBEAT_JOBS.epcMonitors.job_name);
  const hb = await checkHeartbeats(d, Object.values(HEARTBEAT_JOBS));
  console.table(hb);
  assert(
    hb.find((h) => h.job_name === "epc-monitors")?.stale === false,
    "a just-recorded heartbeat is not stale",
  );
  const never = await checkHeartbeats(d, [
    { job_name: "does-not-exist", max_age_hours: 1, label: "phantom job" },
  ]);
  assert(never[0].stale === true, "a job that has NEVER run counts as stale, not healthy");
  assert(
    heartbeatBreaches(never).length === 1 && /NEVER/.test(heartbeatBreaches(never)[0]),
    "never-run produces an explicit breach message",
  );

  console.log("\nverify-epc-monitors OK.");
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
