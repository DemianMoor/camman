// Pause / resume the contact-engagement cron, using the lease the job ALREADY
// respects — no engine_mode flip, no code change, nothing to remember to undo
// in a second place.
//
// HOW. withCronLease claims `cron_locks.job_name = 'contact-engagement-run'`
// with a one-statement conditional upsert: it wins only if the row is absent,
// NULL or expired. So writing a future `lease_until` ourselves makes every tick
// in that window take the skip path — it bumps skipped_count, logs
// "[cron-lease] … skipped", and returns without running. Resuming is
// `lease_until = NULL`. Because the lease is a ROW with an ABSOLUTE expiry, no
// process has to stay alive to hold it.
//
// ── WHY THE TTL IS 30 MINUTES ──────────────────────────────────────────────
// The dead-man check pages when the last SUCCESS is older than 45 minutes
// (HEARTBEAT_JOBS.contactEngagement.max_age_hours = 0.75). A pause longer than
// that fires `contact-engagement-stale` — the same alert that fired for real on
// 2026-09-23 — and a self-inflicted page is worse than useless because it
// teaches everyone to ignore the channel.
//
// A 30-minute TTL is therefore the safety property, not a guess: even if this
// script dies immediately after pausing, or the operator walks away, the lease
// expires and the job resumes BEFORE the alert threshold. Work that needs
// longer re-runs --pause to extend, which is a deliberate act rather than a
// silent drift past the alarm.
//
// Run:  npx tsx scripts/engagement-cron-pause.ts --pause
//       npx tsx scripts/engagement-cron-pause.ts --status
//       npx tsx scripts/engagement-cron-pause.ts --resume
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const LEASE = "contact-engagement-run"; // ENGAGEMENT_LEASE
const HEARTBEAT = "contact-engagement"; // stamped on every successful run
const TTL_MINUTES = 30;
const ALERT_AFTER_MINUTES = 45; // HEARTBEAT_JOBS.contactEngagement.max_age_hours

const MODE = process.argv.includes("--pause")
  ? "pause"
  : process.argv.includes("--resume")
    ? "resume"
    : "status";

type LeaseRow = {
  job_name: string;
  lease_until: string | null;
  skipped_count: number;
  last_skipped_at: string | null;
  held: boolean;
};

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const readLease = async (): Promise<LeaseRow | null> => {
      const [r] = (await pg`
        SELECT job_name, lease_until, skipped_count, last_skipped_at,
               (lease_until IS NOT NULL AND lease_until > now()) AS held
        FROM cron_locks WHERE job_name = ${LEASE}`) as unknown as LeaseRow[];
      return r ?? null;
    };
    const heartbeatAge = async () => {
      const [r] = (await pg`
        SELECT watermark,
               round(extract(epoch FROM (now() - watermark)) / 60)::int AS mins
        FROM cron_locks WHERE job_name = ${HEARTBEAT}`) as unknown as {
        watermark: string | null;
        mins: number | null;
      }[];
      return r ?? { watermark: null, mins: null };
    };

    if (MODE === "status") {
      const l = await readLease();
      const h = await heartbeatAge();
      console.log(`lease ${LEASE}:`);
      console.log(`  lease_until    ${l?.lease_until ?? "(none)"}`);
      console.log(`  currently held ${l?.held ? "YES — ticks are skipping" : "no — ticks run"}`);
      console.log(`  skipped_count  ${l?.skipped_count ?? 0}  (last ${l?.last_skipped_at ?? "never"})`);
      console.log(`\nheartbeat ${HEARTBEAT}:`);
      console.log(`  last success   ${h.watermark ?? "(never)"} — ${h.mins ?? "?"} min ago`);
      console.log(
        `  alert fires at ${ALERT_AFTER_MINUTES} min ⇒ ${
          h.mins == null ? "?" : Math.max(0, ALERT_AFTER_MINUTES - h.mins)
        } min of headroom`,
      );
      return;
    }

    if (MODE === "resume") {
      // Unconditional clear: we are the only writer that sets a far-future
      // lease, and a real run's lease is at most CRON_LEASE_MS (4 min) out.
      const before = await readLease();
      await pg`UPDATE cron_locks SET lease_until = NULL WHERE job_name = ${LEASE}`;
      console.log(`RESUMED — lease cleared (was ${before?.lease_until ?? "none"}).`);
      console.log(`Ticks skipped while paused: see skipped_count = ${before?.skipped_count ?? 0}`);
      const h = await heartbeatAge();
      console.log(`Last successful run ${h.mins ?? "?"} min ago; next tick at :10/:25/:40/:55.`);
      if ((h.mins ?? 0) >= ALERT_AFTER_MINUTES) {
        console.log(
          `⚠ the heartbeat is already past ${ALERT_AFTER_MINUTES} min — contact-engagement-stale may have fired; it clears on the next successful run.`,
        );
      }
      return;
    }

    // ── pause ──────────────────────────────────────────────────────────────
    // Wait for any IN-FLIGHT tick to finish, then claim. The claim is the same
    // single-statement CAS the job itself uses, so there is no window between
    // "looks free" and "is ours": if a tick beats us we simply lose and retry.
    const until = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
    for (let attempt = 1; ; attempt++) {
      const current = await readLease();
      if (current?.held) {
        console.log(
          `waiting — a tick is in flight (lease until ${current.lease_until}); re-checking in 10s …`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      const claimed = (await pg`
        INSERT INTO cron_locks (job_name, lease_until)
        VALUES (${LEASE}, ${until}::timestamptz)
        ON CONFLICT (job_name) DO UPDATE
          SET lease_until = ${until}::timestamptz
          WHERE cron_locks.lease_until IS NULL OR cron_locks.lease_until < now()
        RETURNING lease_until`) as unknown as { lease_until: string }[];
      if (claimed.length > 0) {
        const l = await readLease();
        const h = await heartbeatAge();
        console.log(`PAUSED — ticks will skip until ${claimed[0].lease_until} (${TTL_MINUTES} min).`);
        console.log(`  skipped_count is ${l?.skipped_count ?? 0} now; it rises once per suppressed tick.`);
        console.log(`  last successful run ${h.mins ?? "?"} min ago.`);
        console.log(
          `  ⚠ finish and --resume within ${Math.max(0, ALERT_AFTER_MINUTES - (h.mins ?? 0))} min ` +
            `or contact-engagement-stale fires. Re-run --pause to extend.`,
        );
        return;
      }
      console.log(`lost the claim to a tick (attempt ${attempt}) — waiting 10s …`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
