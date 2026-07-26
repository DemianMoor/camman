import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY handover list: which campaigns are latched and which stages are
// held in the "silent limbo" (due in the past, never sent, never marked missed
// because a paused campaign is filtered out of both scheduler phase selects).
// Run: npx tsx scripts/probe-recovery-handover.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (query: ReturnType<typeof sql>) =>
    (await d.execute(query)) as unknown as Record<string, unknown>[];

  const campaigns = await q(sql`
    SELECT id, name, status, send_paused,
           send_paused_reason,
           to_char(send_paused_at AT TIME ZONE 'America/New_York',
                   'YYYY-MM-DD HH24:MI:SS') AS paused_at_et
    FROM campaigns
    WHERE send_paused = true
    ORDER BY id`);

  const stages = await q(sql`
    SELECT s.id AS stage_id, s.campaign_id, s.stage_number, s.label,
           to_char(s.scheduled_at AT TIME ZONE 'America/New_York',
                   'YYYY-MM-DD HH24:MI') AS scheduled_et,
           s.sent_at, s.schedule_missed_at, s.send_approved,
           count(*) FILTER (WHERE ss.status = 'pending')::int AS pending
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN stage_sends ss ON ss.stage_id = s.id
    WHERE c.send_paused = true
      AND s.scheduled_at IS NOT NULL
      AND s.sent_at IS NULL
      AND s.schedule_missed_at IS NULL
      AND s.archived_at IS NULL
    GROUP BY s.id, s.campaign_id, s.stage_number, s.label,
             s.scheduled_at, s.sent_at, s.schedule_missed_at, s.send_approved
    HAVING count(*) FILTER (WHERE ss.status = 'pending') > 0
    ORDER BY s.scheduled_at`);

  console.log("=== LATCHED CAMPAIGNS ===");
  console.table(campaigns);
  console.log("\n=== HELD STAGES (due, unsent, not marked missed) ===");
  console.table(stages);
  const total = stages.reduce((a, r) => a + Number(r.pending ?? 0), 0);
  console.log(`\nTOTAL HELD MESSAGES: ${total.toLocaleString()}`);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
