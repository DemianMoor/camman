import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { runDripSchedulerManual } from "@/lib/drip/poke";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-scheduler-manual-lease.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const row = async () =>
  (await db.execute(sql`SELECT * FROM cron_locks WHERE job_name = 'drip-scheduler'`))[0] ?? null;

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const posture = await db.execute(sql`SELECT org_id, drip_enabled FROM org_settings WHERE drip_enabled = true`);
  console.log(`  preview orgs with drip_enabled=true: ${posture.length}`);
  if (posture.length > 0) {
    console.log("NEEDS_CONTEXT: preview has drip-enabled orgs; a run could insert stage_sends");
    process.exit(2);
  }
  const before = await row();
  console.log("  cron_locks before:", JSON.stringify(before));
  try {
    await db.execute(sql`
      INSERT INTO cron_locks (job_name, lease_until) VALUES ('drip-scheduler', now() + interval '2 minutes')
      ON CONFLICT (job_name) DO UPDATE SET lease_until = now() + interval '2 minutes'`);
    const held = await runDripSchedulerManual();
    bar("M1 lease held => ran:false", held.ran === false);
    await db.execute(sql`UPDATE cron_locks SET lease_until = NULL WHERE job_name = 'drip-scheduler'`);
    const free = await runDripSchedulerManual();
    bar("M2 lease free => ran:true with result", free.ran === true && typeof (free as { result: unknown }).result === "object");
    const after = await row();
    bar("M3 lease released after run", (after as { lease_until: unknown } | null)?.lease_until == null);
  } finally {
    if (before) {
      const b = before as { lease_until: string | null; skipped_count: number; last_skipped_at: string | null };
      await db.execute(sql`
        UPDATE cron_locks SET lease_until = ${b.lease_until}::timestamptz, skipped_count = ${b.skipped_count},
          last_skipped_at = ${b.last_skipped_at}::timestamptz WHERE job_name = 'drip-scheduler'`);
    } else {
      await db.execute(sql`DELETE FROM cron_locks WHERE job_name = 'drip-scheduler'`);
    }
    console.log("  cron_locks after restore:", JSON.stringify(await row()));
  }

  const src = readFileSync("app/api/cron/drip-scheduler/route.ts", "utf8");
  const manualBranch = src.slice(src.indexOf("if (!bearerMatches)"), src.indexOf("if (isPokeRequest(req))"));
  bar("G1 manual branch no longer calls runDripSchedulerBatch(", !manualBranch.includes("runDripSchedulerBatch("));
  bar("G2 manual branch calls runDripSchedulerManual(", manualBranch.includes("runDripSchedulerManual("));
  bar("G3 manual branch answers 409 prior_run_in_progress", manualBranch.includes("409") && manualBranch.includes("prior_run_in_progress"));

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
