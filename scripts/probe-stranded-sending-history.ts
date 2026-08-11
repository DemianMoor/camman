import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Historical rate measurement for the stale-rows card (869egqktp).
// 187 rows stranded in status='sending' in one night across 3 stages. Is that a
// one-off or a steady leak? Measure per ET day over the full history.
//
// A row in status='sending' was CLAIMED by the drain but never resolved to
// sent/failed. Anything older than an hour is not in flight — it is stranded,
// i.e. a message we may have paid for and cannot account for.
//
// Run: npx tsx scripts/probe-stranded-sending-history.ts

const ET = "America/New_York";

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (query: ReturnType<typeof sql>) => {
    let out: Record<string, unknown>[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as Record<string, unknown>[];
    });
    return out;
  };
  const show = (t: string, r: unknown[]) => { console.log(`\n=== ${t} ===`); console.table(r); };

  show("A current stage_sends status distribution (all time)", await q(sql`
    SELECT status, count(*)::text AS rows,
           min(created_at)::date::text AS first, max(created_at)::date::text AS last
    FROM stage_sends GROUP BY 1 ORDER BY count(*) DESC
  `));

  show("B stranded ('sending', older than 1h) — totals", await q(sql`
    SELECT count(*)::text AS stranded_rows,
           count(DISTINCT stage_id)::text AS stages,
           count(DISTINCT campaign_id)::text AS campaigns,
           min(created_at)::date::text AS first_day,
           max(created_at)::date::text AS last_day,
           count(DISTINCT (created_at AT TIME ZONE ${ET})::date)::text AS distinct_days_affected
    FROM stage_sends
    WHERE status = 'sending' AND created_at < now() - interval '1 hour'
  `));

  show("C stranded per ET day (full history, worst 25 days)", await q(sql`
    SELECT (created_at AT TIME ZONE ${ET})::date::text AS et_day,
           count(*)::text AS stranded,
           count(DISTINCT stage_id)::text AS stages,
           count(DISTINCT campaign_id)::text AS campaigns
    FROM stage_sends
    WHERE status = 'sending' AND created_at < now() - interval '1 hour'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 25
  `));

  show("D stranded per ET month + rate vs total sends", await q(sql`
    WITH s AS (
      SELECT to_char(created_at AT TIME ZONE ${ET}, 'YYYY-MM') AS month,
             count(*) FILTER (WHERE status = 'sending' AND created_at < now() - interval '1 hour') AS stranded,
             count(*) AS total_rows,
             count(*) FILTER (WHERE status = 'sent') AS sent
      FROM stage_sends GROUP BY 1
    )
    SELECT month, stranded::text AS stranded, sent::text AS sent, total_rows::text AS total_rows,
           round(100.0 * stranded / nullif(total_rows, 0), 4)::text AS stranded_pct,
           round(stranded / nullif(EXTRACT(DAY FROM date_trunc('month', (month || '-01')::date) + interval '1 month' - interval '1 day'), 0), 1)::text AS avg_per_day
    FROM s ORDER BY month
  `));

  show("E does a stranded row carry a send attempt? (did we pay for it?)", await q(sql`
    SELECT CASE WHEN sa.n IS NULL OR sa.n = 0 THEN 'no attempt row — never dispatched'
                WHEN sa.ok THEN 'attempt OK — provider accepted, status never advanced'
                ELSE 'attempt failed — status never advanced' END AS bucket,
           count(*)::text AS stranded_rows
    FROM stage_sends ss
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, bool_or(ok) AS ok FROM send_attempts a WHERE a.stage_send_id = ss.id
    ) sa ON TRUE
    WHERE ss.status = 'sending' AND ss.created_at < now() - interval '1 hour'
    GROUP BY 1 ORDER BY 2 DESC
  `));

  show("F age distribution of stranded rows", await q(sql`
    SELECT CASE WHEN created_at > now() - interval '1 day'  THEN 'under 1 day'
                WHEN created_at > now() - interval '7 days' THEN '1-7 days'
                WHEN created_at > now() - interval '30 days' THEN '7-30 days'
                ELSE 'over 30 days' END AS age,
           count(*)::text AS stranded_rows
    FROM stage_sends
    WHERE status = 'sending' AND created_at < now() - interval '1 hour'
    GROUP BY 1 ORDER BY 2 DESC
  `));

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
