import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY: is a send drain in flight RIGHT NOW? Run before applying a migration
// that takes FK locks on contacts / stage_sends (0122/0124), because CREATE TABLE
// ... REFERENCES needs a ShareRowExclusiveLock on the referenced table and will
// queue behind — or deadlock with — an active drain's writes.
//
// Run: npx tsx scripts/probe-drain-idle.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) => (await d.execute(query)) as unknown as T[];

  const sending = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM stage_sends WHERE status = 'sending'`);
  const recent = await q<{ last_sent: string | null; in_last_2min: number }>(sql`
    SELECT max(sent_at)::text AS last_sent,
           count(*) FILTER (WHERE sent_at > now() - interval '2 minutes')::int AS in_last_2min
    FROM stage_sends WHERE sent_at IS NOT NULL`);
  const pending = await q<{ stages: number; rows: number }>(sql`
    SELECT count(DISTINCT stage_id)::int AS stages, count(*)::int AS rows
    FROM stage_sends WHERE status = 'pending'`);
  const due = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM campaign_stages
    WHERE scheduled_at IS NOT NULL AND scheduled_at <= now() + interval '5 minutes'
      AND sent_at IS NULL AND schedule_missed_at IS NULL`);
  const locks = await q<{ job_name: string; lease_until: string | null }>(sql`
    SELECT job_name, lease_until::text FROM cron_locks
    WHERE lease_until IS NOT NULL AND lease_until > now() ORDER BY job_name`);
  // Anything actively holding a lock on the two tables the migrations reference.
  const activity = await q<{ pid: number; state: string; query: string; waiting: string | null }>(sql`
    SELECT pid, state, left(query, 90) AS query, wait_event_type AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND state <> 'idle'
    ORDER BY query_start`);

  console.log(`stage_sends status='sending' (mid-flight claims): ${sending[0]?.n}`);
  console.log(`last sent_at: ${recent[0]?.last_sent ?? "(none)"} · sends in the last 2 min: ${recent[0]?.in_last_2min}`);
  console.log(`pending rows: ${pending[0]?.rows} across ${pending[0]?.stages} stage(s)`);
  console.log(`stages scheduled to fire within 5 min: ${due[0]?.n}`);
  console.log(`cron_locks: ${JSON.stringify(locks)}`);
  console.log(`non-idle backends: ${JSON.stringify(activity)}`);

  const busy = (sending[0]?.n ?? 0) > 0 || (recent[0]?.in_last_2min ?? 0) > 0;
  console.log(`\nVERDICT: ${busy ? "BUSY — do NOT apply migrations now" : "IDLE — safe to apply"}`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
