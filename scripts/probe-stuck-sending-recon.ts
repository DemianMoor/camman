import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon. Three questions:
//   1. The two re-dated stages — is materialization running, queued, or dead?
//   2. The 187 stage_sends stuck in status='sending' — dispatched or not?
//   3. Today's other two prepared stages — intact and untouched?
//
// Run: npx tsx scripts/probe-stuck-sending-recon.ts

const ET = "America/New_York";

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) =>
    (await d.execute(query)) as unknown as T[];

  console.log("=== NOW ===");
  console.log(
    JSON.stringify(
      (await q(sql`SELECT now()::text AS utc, to_char(now() AT TIME ZONE ${ET}, 'YYYY-MM-DD HH24:MI:SS') AS et`))[0],
    ),
  );

  // ---------------------------------------------------------------- Q1 + Q3
  // Every stage that currently has non-terminal work, plus the two named ones.
  console.log("\n=== Q1/Q3 — STAGES WITH OUTSTANDING WORK ===");
  console.table(
    await q(sql`
      SELECT s.id AS stage_id,
             s.campaign_id,
             c.name AS campaign,
             s.stage_number,
             s.label,
             to_char(s.scheduled_at AT TIME ZONE ${ET}, 'MM-DD HH24:MI') AS sched_et,
             to_char(s.materialized_at AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS materialized_et,
             to_char(s.sent_at AT TIME ZONE ${ET}, 'MM-DD HH24:MI') AS sent_et,
             to_char(s.schedule_missed_at AT TIME ZONE ${ET}, 'MM-DD HH24:MI') AS missed_et,
             s.send_approved,
             c.send_paused AS campaign_paused,
             s.archived_at IS NOT NULL AS archived
      FROM campaign_stages s
      JOIN campaigns c ON c.id = s.campaign_id
      WHERE EXISTS (
              SELECT 1 FROM stage_sends ss
              WHERE ss.stage_id = s.id AND ss.status IN ('pending','sending')
            )
         OR s.id IN (1710, 1713)
      ORDER BY s.scheduled_at
    `),
  );

  console.log("\n=== Q1/Q3 — stage_sends BY STATUS, per stage ===");
  console.table(
    await q(sql`
      SELECT ss.stage_id,
             ss.status,
             count(*)::int AS n,
             to_char(min(ss.created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS first_created_et,
             to_char(max(ss.created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS last_created_et,
             to_char(max(ss.sent_at)     AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS last_sent_et
      FROM stage_sends ss
      WHERE ss.stage_id IN (
        SELECT s.id FROM campaign_stages s
        WHERE EXISTS (SELECT 1 FROM stage_sends x WHERE x.stage_id = s.id AND x.status IN ('pending','sending'))
           OR s.id IN (1710, 1713)
      )
      GROUP BY ss.stage_id, ss.status
      ORDER BY ss.stage_id, ss.status
    `),
  );

  // Is a materialization actively in flight? kickoff writes rows in windows and
  // stamps materialized_at only when the whole stage is enumerated.
  console.log("\n=== Q1 — MATERIALIZATION LIVENESS (rows created in the last 15 min) ===");
  console.table(
    await q(sql`
      SELECT stage_id,
             count(*)::int AS rows_created_last_15min,
             to_char(max(created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS newest_row_et,
             round(extract(epoch FROM now() - max(created_at)))::int AS secs_since_newest
      FROM stage_sends
      WHERE created_at > now() - interval '15 minutes'
      GROUP BY stage_id ORDER BY stage_id
    `),
  );

  console.log("\n=== Q1 — cron_locks / active backends (is a job running at all?) ===");
  console.table(await q(sql`SELECT * FROM cron_locks ORDER BY job_name`));
  console.table(
    await q(sql`
      SELECT pid, state, left(query, 70) AS query,
             round(extract(epoch FROM now() - query_start))::int AS secs
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
      ORDER BY query_start
    `),
  );

  // -------------------------------------------------------------------- Q2
  console.log("\n=== Q2 — 'sending' ROWS: which stages, materialized when ===");
  console.table(
    await q(sql`
      SELECT ss.stage_id,
             ss.campaign_id,
             count(*)::int AS stuck,
             to_char(min(ss.created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS first_created_et,
             to_char(max(ss.created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS last_created_et,
             count(*) FILTER (WHERE ss.texthub_message_id IS NOT NULL)::int AS has_provider_msgid,
             count(*) FILTER (WHERE ss.attempts > 0)::int AS attempts_gt0,
             count(*) FILTER (WHERE ss.last_error IS NOT NULL)::int AS has_error
      FROM stage_sends ss
      WHERE ss.status = 'sending'
      GROUP BY ss.stage_id, ss.campaign_id
      ORDER BY ss.stage_id
    `),
  );

  // THE decisive question: does a send_attempts row exist for each stuck row?
  // No attempt row  => never dispatched (claimed, then the invocation died).
  // Attempt ok=true => the provider ACCEPTED it; only our status write was lost.
  console.log("\n=== Q2 — DISPATCH EVIDENCE (send_attempts per stuck row) ===");
  console.table(
    await q(sql`
      SELECT ss.stage_id,
             count(*)::int AS stuck_rows,
             count(sa.stage_send_id)::int AS with_attempt_row,
             count(*) FILTER (WHERE sa.ok IS TRUE)::int AS attempt_ok,
             count(*) FILTER (WHERE sa.ok IS FALSE)::int AS attempt_failed,
             count(*) FILTER (WHERE sa.stage_send_id IS NULL)::int AS no_attempt_never_dispatched
      FROM stage_sends ss
      LEFT JOIN send_attempts sa ON sa.stage_send_id = ss.id
      WHERE ss.status = 'sending'
      GROUP BY ss.stage_id ORDER BY ss.stage_id
    `),
  );

  console.log("\n=== Q2 — attempt detail for stuck rows THAT HAVE one ===");
  console.table(
    await q(sql`
      SELECT sa.http_status, sa.ok, sa.classification,
             count(*)::int AS n,
             to_char(min(sa.created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS first_et,
             to_char(max(sa.created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS last_et,
             left(max(coalesce(sa.error, sa.raw_body)), 60) AS sample
      FROM stage_sends ss
      JOIN send_attempts sa ON sa.stage_send_id = ss.id
      WHERE ss.status = 'sending'
      GROUP BY sa.http_status, sa.ok, sa.classification
      ORDER BY n DESC
    `),
  );

  // Age: when did the drain last touch each stuck stage (its last successful send)?
  console.log("\n=== Q2 — last successful send on each stuck stage (bounds the death window) ===");
  console.table(
    await q(sql`
      SELECT stage_id,
             to_char(max(sent_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS last_sent_et,
             round(extract(epoch FROM now() - max(sent_at))/3600, 1) AS hours_ago
      FROM stage_sends
      WHERE status = 'sent'
        AND stage_id IN (SELECT DISTINCT stage_id FROM stage_sends WHERE status = 'sending')
      GROUP BY stage_id ORDER BY stage_id
    `),
  );

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
