import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// READ-ONLY diagnostic: why didn't scheduled sends fire?
// Walks the exact gate chain from selectDueScheduledStages + runScheduledSends.
// Run: npx tsx scripts/diagnose-scheduled.ts

async function main() {
  console.log("SEND_ENABLED env =", JSON.stringify(process.env.SEND_ENABLED), "\n");
  // NOTE: this prints LOCAL env. The Vercel cron reads Vercel's env, which can differ.

  // All tracked-campaign stages that have a scheduled_at in the last 2 days,
  // with every gate column the cron evaluates.
  const rows = (await db.execute(sql`
    SELECT
      s.id                      AS stage_id,
      s.stage_number,
      s.campaign_id,
      c.name                    AS campaign_name,
      c.status                  AS campaign_status,
      c.link_mode,
      s.send_approved,
      s.scheduled_at,
      s.sent_at,
      s.schedule_missed_at,
      s.archived_at,
      s.sms_provider_id         AS provider_id,
      p.name                    AS provider_name,
      p.send_paused,
      p.supports_api_send,
      p.send_window_weekday_start,
      p.send_window_weekday_end,
      now()                     AS db_now
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE s.scheduled_at IS NOT NULL
      AND s.scheduled_at > now() - interval '2 days'
    ORDER BY s.scheduled_at DESC
    LIMIT 50
  `)) as unknown as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log("No stages with scheduled_at in the last 2 days. Nothing was scheduled, OR scheduled_at wasn't persisted.");
    return;
  }

  for (const r of rows) {
    const fails: string[] = [];
    if (r.link_mode !== "tracked") fails.push(`link_mode=${r.link_mode} (need 'tracked')`);
    if (r.campaign_status !== "active") fails.push(`campaign status=${r.campaign_status} (need 'active')`);
    if (r.send_approved !== true) fails.push(`send_approved=${r.send_approved} (need true)`);
    if (r.sent_at != null) fails.push(`sent_at already set (${r.sent_at})`);
    if (r.schedule_missed_at != null) fails.push(`schedule_missed_at set (${r.schedule_missed_at}) — window closed`);
    if (r.archived_at != null) fails.push(`archived`);
    if (r.send_paused === true) fails.push(`provider send_paused`);
    if (r.provider_id == null) fails.push(`no provider on stage`);
    if (r.supports_api_send !== true) fails.push(`provider supports_api_send=${r.supports_api_send}`);

    console.log("──────────────────────────────────────────────");
    console.log(`Stage #${r.stage_number} (id ${r.stage_id}) — campaign "${r.campaign_name}" (id ${r.campaign_id})`);
    console.log(`  scheduled_at: ${r.scheduled_at}   |  db now(): ${r.db_now}`);
    console.log(`  provider: ${r.provider_name ?? "—"}  window(weekday): ${r.send_window_weekday_start ?? "default"}–${r.send_window_weekday_end ?? "default"}`);
    if (fails.length === 0) {
      console.log("  ✅ Passes all DB gates — would be SELECTED by the cron (only SEND_ENABLED + ET window remain).");
    } else {
      console.log("  ❌ Blocked by:");
      for (const f of fails) console.log(`     - ${f}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
