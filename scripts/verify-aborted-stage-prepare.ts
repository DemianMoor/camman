import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { deriveStageOperationalStatus } from "@/lib/stages/stage-status";

// READ-ONLY. Proves the fix resolves the real stranded stages with NO data
// surgery: runs the OLD and NEW count queries against production, feeds both
// into the real derivation, and reports whether Prepare would be offered.
//
// Run: npx tsx scripts/verify-aborted-stage-prepare.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);

  const rows = (await d.execute(sql`
    SELECT s.id AS stage_id, s.campaign_id, cm.name AS campaign, s.stage_number,
           s.scheduled_at::text, s.schedule_missed_at::text, s.materialized_at::text,
           s.sent_at::text, s.slip_hold_at::text, cm.link_mode, s.status,
           -- OLD: excluded 'rejected' only
           count(*) FILTER (WHERE ss.status <> 'rejected')::int AS total_old,
           -- NEW: excludes both audit buckets
           count(*) FILTER (WHERE ss.status NOT IN ('rejected','skipped_opted_out'))::int AS total_new,
           count(*) FILTER (WHERE ss.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE ss.status = 'sending')::int AS sending,
           count(*) FILTER (WHERE ss.status = 'sent')::int AS sent,
           count(*) FILTER (WHERE ss.status = 'failed')::int AS failed,
           count(*) FILTER (WHERE ss.status = 'skipped_duplicate')::int AS skipped_duplicate,
           count(*) FILTER (WHERE ss.status = 'rejected')::int AS rejected,
           count(*) FILTER (WHERE ss.status = 'skipped_opted_out')::int AS skipped_opted_out
    FROM campaign_stages s
    JOIN campaigns cm ON cm.id = s.campaign_id
    LEFT JOIN stage_sends ss ON ss.stage_id = s.id
    WHERE s.id IN (1713, 1710)
    GROUP BY s.id, s.campaign_id, cm.name, s.stage_number, s.scheduled_at,
             s.schedule_missed_at, s.materialized_at, s.sent_at, s.slip_hold_at,
             cm.link_mode, s.status
    ORDER BY s.id
  `)) as unknown as Record<string, string | number | null>[];

  for (const r of rows) {
    const shared = {
      linkMode: r.link_mode as string,
      status: r.status as string,
      scheduledAt: r.scheduled_at as string | null,
      sentAt: r.sent_at as string | null,
      scheduleMissedAt: r.schedule_missed_at as string | null,
      slipHoldAt: r.slip_hold_at as string | null,
      materializedAt: r.materialized_at as string | null,
    };
    const buckets = {
      pending: Number(r.pending),
      sending: Number(r.sending),
      sent: Number(r.sent),
      failed: Number(r.failed),
      skippedDuplicate: Number(r.skipped_duplicate),
    };
    const before = deriveStageOperationalStatus({
      ...shared,
      counts: { ...buckets, total: Number(r.total_old) },
    });
    const after = deriveStageOperationalStatus({
      ...shared,
      counts: { ...buckets, total: Number(r.total_new) },
    });

    console.log(`\n--- stage ${r.stage_id} · campaign ${r.campaign_id} · ${r.campaign} (stage ${r.stage_number}) ---`);
    console.log(`  rows: rejected=${r.rejected} skipped_opted_out=${r.skipped_opted_out} pending=${r.pending} sent=${r.sent}`);
    console.log(`  materialized_at: ${r.materialized_at ?? "NULL"}`);
    console.log(`  total  OLD=${r.total_old}  ->  NEW=${r.total_new}`);
    console.log(`  status OLD=${before}  ->  NEW=${after}`);
    // hasBatch drives the Prepare button in stage-send-panel.tsx.
    console.log(`  hasBatch OLD=${Number(r.total_old) > 0}  ->  NEW=${Number(r.total_new) > 0}`);
    console.log(
      `  PREPARE BUTTON: ${Number(r.total_old) > 0 ? "hidden" : "shown"}  ->  ${Number(r.total_new) > 0 ? "hidden" : "SHOWN"}`,
    );
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
