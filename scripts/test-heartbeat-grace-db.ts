import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// first_run_grace_hours on HeartbeatExpectation (lib/reporting/cron-heartbeat.ts),
// against the PREVIEW DB's cron_locks. Job names are unique per run and every
// row this test touches is deleted by exact key at the end (count read back).
//
// Why it exists: on 2026-09-22 the delivery rollup's reconciliation ran before
// its refresh on first deploy and paged "never ran" — the mutual watch
// bootstraps in both directions. The grace makes "never ran" stale only after
// the watcher has seen the job missing for longer than 2x its interval.
//
// Run: npx tsx scripts/test-heartbeat-grace-db.ts

import { sql } from "drizzle-orm";

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const H = await import("@/lib/reporting/cron-heartbeat");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };
  const tag = `hbgrace-${Date.now()}`;
  const graced = { job_name: `${tag}-graced`, max_age_hours: 1, first_run_grace_hours: 0.25, label: "graced test job" };
  const plain = { job_name: `${tag}-plain`, max_age_hours: 1, label: "plain test job" };
  const ran = { job_name: `${tag}-ran`, max_age_hours: 1, first_run_grace_hours: 0.25, label: "ran test job" };
  const keys = [graced.job_name, plain.job_name, ran.job_name, H.awaitingFirstRunKey(graced.job_name), H.awaitingFirstRunKey(plain.job_name), H.awaitingFirstRunKey(ran.job_name)];
  const backdate = (key: string, minutes: number) =>
    db.execute(sql`UPDATE cron_locks SET watermark = now() - (${minutes} * interval '1 minute') WHERE job_name = ${key}`);

  try {
    console.log("NEVER RAN, WITH GRACE");
    const [g1] = await H.checkHeartbeats(db, [graced]);
    bar("G1 first check: not stale, awaiting ~0h, first-seen stamp written",
      !g1.stale && g1.awaiting_first_run_hours != null && g1.awaiting_first_run_hours < 0.05, JSON.stringify(g1));
    await backdate(H.awaitingFirstRunKey(graced.job_name), 10);
    const [g2] = await H.checkHeartbeats(db, [graced]);
    bar("G2 missing 10 min (grace 15 min): still not stale", !g2.stale && (g2.awaiting_first_run_hours ?? 0) > 0.15, JSON.stringify(g2));
    await backdate(H.awaitingFirstRunKey(graced.job_name), 30);
    const [g3] = await H.checkHeartbeats(db, [graced]);
    bar("G3 missing 30 min (grace 15 min): stale", g3.stale && (g3.awaiting_first_run_hours ?? 0) > 0.45, JSON.stringify(g3));
    const [g4] = await H.checkHeartbeats(db, [graced]);
    bar("G4 a later check keeps the FIRST stamp (does not reset the grace)", g4.stale && (g4.awaiting_first_run_hours ?? 0) > 0.45, JSON.stringify(g4));
    const msg = H.heartbeatBreaches([g4])[0] ?? "";
    bar("G5 the breach text says how long it has been missing", msg.includes("NEVER recorded a run") && msg.includes("since first checked"), msg);

    console.log("\nNEVER RAN, NO GRACE (unchanged behaviour)");
    const [p1] = await H.checkHeartbeats(db, [plain]);
    bar("P1 stale on the first check, no stamp", p1.stale && p1.awaiting_first_run_hours === null, JSON.stringify(p1));
    const stamp = (await db.execute(sql`SELECT count(*)::int AS n FROM cron_locks WHERE job_name = ${H.awaitingFirstRunKey(plain.job_name)}`)) as unknown as { n: number }[];
    bar("P2 no awaiting row is written for a job without a grace", Number(stamp[0]?.n) === 0, JSON.stringify(stamp[0]));

    console.log("\nHAS RUN (grace irrelevant — max_age_hours decides, as before)");
    await H.recordHeartbeat(db, ran.job_name);
    const [r1] = await H.checkHeartbeats(db, [ran]);
    bar("R1 ran just now: not stale, no awaiting figure", !r1.stale && r1.awaiting_first_run_hours === null, JSON.stringify(r1));
    await backdate(ran.job_name, 120);
    const [r2] = await H.checkHeartbeats(db, [ran]);
    bar("R2 last ran 2h ago with max_age 1h: stale (the grace does not soften this)", r2.stale && r2.age_hours === 2, JSON.stringify(r2));

    console.log("\nREAL EXPECTATIONS");
    bar("E1 the three delivery-rollup jobs carry a grace of 2x their interval",
      H.HEARTBEAT_JOBS.deliveryRollup.first_run_grace_hours === 20 / 60 &&
        H.HEARTBEAT_JOBS.deliveryRollupSettle.first_run_grace_hours === 6 &&
        H.HEARTBEAT_JOBS.deliveryRollupReconcile.first_run_grace_hours === 48);
    const others = Object.entries(H.HEARTBEAT_JOBS).filter(([k]) => !k.startsWith("deliveryRollup"));
    bar(`E2 no other job's behaviour changed (${others.length} expectations without a grace)`,
      others.length > 0 && others.every(([, e]) => e.first_run_grace_hours === undefined), others.map(([k]) => k).join(", "));

    console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await db.execute(sql`DELETE FROM cron_locks WHERE job_name IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`);
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM cron_locks WHERE job_name LIKE ${`${tag}%`}`)) as unknown as { n: number }[];
    console.log(`\nTeardown: ${left[0]?.n} cron_locks row(s) left for this run`);
    if (Number(left[0]?.n) !== 0) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
