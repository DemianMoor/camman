import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";

// Post-22:00 verification. The 23,383 pending rows on 5 stages were INFERRED to
// be waiting for a scheduled window rather than stranded. This confirms it:
// the four 22:00-today stages must fire and their pending counts collapse.
// If they do not, this is a live ~23K-recipient failure, not a historical 266.
const STAGES = [2394, 2397, 2400, 2403]; // due 2026-08-11 22:00 UTC
const TOMORROW = 2390;                   // due 2026-08-12 22:00 UTC — should NOT have fired
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:3}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as Record<string,unknown>[];
  console.log(`checked at: ${(await q(sql`SELECT now()::text AS t`))[0].t}`);
  console.log("\n=== the five stages ===");
  console.table(await q(sql`
    SELECT cs.id AS stage_id, cs.scheduled_at::text AS scheduled,
           cs.sent_at::text AS fired_at,
           cs.schedule_missed_at::text AS missed_at,
           (SELECT count(*) FROM stage_sends s WHERE s.stage_id=cs.id AND s.status='pending')::int AS still_pending,
           (SELECT count(*) FROM stage_sends s WHERE s.stage_id=cs.id AND s.status='sent')::int AS sent,
           (SELECT count(*) FROM stage_sends s WHERE s.stage_id=cs.id)::int AS total
    FROM campaign_stages cs WHERE cs.id IN (2394,2397,2400,2403,2390) ORDER BY cs.scheduled_at, cs.id`));
  console.log("\n=== org-wide pending + drain liveness ===");
  console.table(await q(sql`
    SELECT (SELECT count(*)::int FROM stage_sends WHERE status='pending') AS pending_now,
           (SELECT count(*)::int FROM stage_sends WHERE status='sent' AND sent_at > now()-interval '2 hours') AS sent_last_2h,
           (SELECT count(*)::int FROM send_attempts WHERE created_at > now()-interval '2 hours') AS attempts_last_2h,
           (SELECT max(sent_at)::text FROM stage_sends WHERE status='sent') AS last_sent`));
  const fired=await q(sql`SELECT count(*)::int AS n FROM campaign_stages WHERE id IN (${sql.join(STAGES.map(s=>sql`${s}`),sql`, `)}) AND sent_at IS NOT NULL`);
  const leftover=await q(sql`SELECT coalesce(sum((SELECT count(*) FROM stage_sends s WHERE s.stage_id=cs.id AND s.status='pending')),0)::int AS n FROM campaign_stages cs WHERE cs.id IN (${sql.join(STAGES.map(s=>sql`${s}`),sql`, `)})`);
  const tomorrow=await q(sql`SELECT sent_at IS NULL AS still_waiting FROM campaign_stages WHERE id=${TOMORROW}`);
  console.log(`\nVERDICT:`);
  console.log(`  of the 4 stages due 22:00 today, fired: ${fired[0].n}/4`);
  console.log(`  pending left on those 4: ${leftover[0].n}`);
  console.log(`  the 2026-08-12 stage still waiting (expected true): ${tomorrow[0]?.still_waiting}`);
  console.log(Number(fired[0].n)===4 && Number(leftover[0].n)<500
    ? "  ✅ CONFIRMED — they were queued for the window, not stranded."
    : "  ⚠️ NOT CONFIRMED — investigate immediately; this may be a live failure.");
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
