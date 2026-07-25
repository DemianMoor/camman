import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY: when does today's sending finish? Used to pick a quiet window for a
// migration that takes FK locks on contacts / stage_sends.
// Run: npx tsx scripts/probe-send-window-today.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) => (await d.execute(query)) as unknown as T[];

  const now = await q<{ utc: string; et: string }>(sql`
    SELECT now()::text AS utc, (now() AT TIME ZONE 'America/New_York')::text AS et`);
  console.log(`now: ${now[0]?.utc} UTC = ${now[0]?.et} ET`);

  const win = await q<{ id: number; key: string; wd_start: string; wd_end: string; we_start: string; we_end: string }>(sql`
    SELECT id, sms_provider_id AS key, send_window_weekday_start AS wd_start, send_window_weekday_end AS wd_end,
           send_window_weekend_start AS we_start, send_window_weekend_end AS we_end
    FROM sms_providers WHERE supports_api_send = true ORDER BY id`);
  console.log(`send windows (ET): ${JSON.stringify(win)}`);

  const stages = await q<{ pending: number; stages: number; next_et: string | null; last_et: string | null }>(sql`
    SELECT count(*)::int AS pending, count(DISTINCT ss.stage_id)::int AS stages,
           (min(s.scheduled_at) AT TIME ZONE 'America/New_York')::text AS next_et,
           (max(s.scheduled_at) AT TIME ZONE 'America/New_York')::text AS last_et
    FROM stage_sends ss JOIN campaign_stages s ON s.id = ss.stage_id
    WHERE ss.status = 'pending'`);
  console.log(`pending work: ${JSON.stringify(stages)}`);

  const upcoming = await q<{ scheduled_et: string; stage_id: number; rows: number }>(sql`
    SELECT (s.scheduled_at AT TIME ZONE 'America/New_York')::text AS scheduled_et, s.id AS stage_id,
           count(ss.id)::int AS rows
    FROM campaign_stages s
    LEFT JOIN stage_sends ss ON ss.stage_id = s.id AND ss.status = 'pending'
    WHERE s.scheduled_at IS NOT NULL AND s.scheduled_at > now() - interval '1 hour'
      AND s.schedule_missed_at IS NULL
    GROUP BY s.id, s.scheduled_at ORDER BY s.scheduled_at LIMIT 25`);
  console.log(`\nscheduled stages from the last hour onward (ET):`);
  for (const u of upcoming) console.log(`  ${u.scheduled_et}  stage ${u.stage_id}  pending ${u.rows}`);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
