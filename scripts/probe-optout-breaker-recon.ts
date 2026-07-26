import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon for the opt-out-rate breaker false-trip brief
// (docs/optout-rate-breaker-false-trip-2026-07-25.md). SELECT ONLY — this script
// must never UPDATE/INSERT/DELETE. Answers:
//   1. current pause state of campaigns 463/464/465/467
//   2. stages 1713 / 1710 limbo state + stage_sends breakdown
//   3. any OTHER stages in the same limbo
//   4. campaign_circuit_events contents (is Telegram delivery recorded?)
//   5. further false trips since 2026-07-25
//   6. null stage_send_id audit on opt_out_attributions
//   7. threshold recalibration percentiles (ALIGNED cohort)
//   8. §5.3 counterfactual re-check
//
// Run: npx tsx scripts/probe-optout-breaker-recon.ts

const CAMPAIGNS = [463, 464, 465, 467];
const STAGES = [1713, 1710];

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) =>
    (await d.execute(query)) as unknown as T[];
  // Heavy analytics: wrap in a tx so SET LOCAL statement_timeout sticks under the
  // transaction pooler.
  const qSlow = async <T>(query: ReturnType<typeof sql>) => {
    let out: T[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as T[];
    });
    return out;
  };
  const t = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    const r = await fn();
    console.log(`   (${label}: ${Date.now() - s}ms)`);
    return r;
  };
  const j = (rows: unknown[]) => JSON.stringify(rows, null, 2);

  console.log(`=== probe-optout-breaker-recon — ${new Date().toISOString()} ===\n`);

  // ── 0. scale ───────────────────────────────────────────────────────────────
  console.log("--- 0. table scale ---");
  const scale = await t("scale", () =>
    q<{ stage_sends_sent: number; attributions: number; stages_with_sends: number }>(sql`
      SELECT (SELECT count(*)::int FROM stage_sends WHERE status='sent' AND sent_at IS NOT NULL) AS stage_sends_sent,
             (SELECT count(*)::int FROM opt_out_attributions) AS attributions,
             (SELECT count(DISTINCT stage_id)::int FROM stage_sends WHERE status='sent') AS stages_with_sends`),
  );
  console.log(j(scale));

  // ── 1. campaign pause state ────────────────────────────────────────────────
  console.log("\n--- 1. campaigns 463/464/465/467 current state ---");
  console.log(
    j(
      await q(sql`
        SELECT id, name, status, send_paused, send_paused_reason,
               send_paused_at::text AS send_paused_at,
               (send_paused_at AT TIME ZONE 'America/New_York')::text AS send_paused_at_et
        FROM campaigns WHERE id IN (463,464,465,467) ORDER BY id`),
    ),
  );

  // ── 2. stages 1713 / 1710 ──────────────────────────────────────────────────
  console.log("\n--- 2. stages 1713 / 1710 ---");
  console.log(
    j(
      await q(sql`
        SELECT s.id AS stage_id, s.campaign_id, s.stage_number, s.label,
               s.scheduled_at::text AS scheduled_at,
               (s.scheduled_at AT TIME ZONE 'America/New_York')::text AS scheduled_at_et,
               s.sent_at::text AS sent_at,
               s.schedule_missed_at::text AS schedule_missed_at,
               s.materialized_at::text AS materialized_at,
               s.send_approved, s.archived_at::text AS archived_at,
               s.slip_hold_at::text AS slip_hold_at,
               s.preflight_aborted_at::text AS preflight_aborted_at,
               c.send_paused AS campaign_send_paused, c.status AS campaign_status,
               c.link_mode
        FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.id IN (1713, 1710) ORDER BY s.id`),
    ),
  );
  console.log("stage_sends by status:");
  console.log(
    j(
      await q(sql`
        SELECT stage_id, status, count(*)::int AS n
        FROM stage_sends WHERE stage_id IN (1713, 1710)
        GROUP BY stage_id, status ORDER BY stage_id, status`),
    ),
  );

  // ── 3. other limbo stages ──────────────────────────────────────────────────
  console.log("\n--- 3. OTHER stages in the same limbo (due in the past, sent_at NULL,");
  console.log("       schedule_missed_at NULL, campaign send_paused = true) ---");
  console.log(
    j(
      await q(sql`
        SELECT s.id AS stage_id, s.campaign_id, c.name AS campaign_name,
               s.stage_number,
               (s.scheduled_at AT TIME ZONE 'America/New_York')::text AS scheduled_at_et,
               s.materialized_at::text AS materialized_at,
               s.send_approved, s.slip_hold_at::text AS slip_hold_at,
               (SELECT count(*)::int FROM stage_sends ss WHERE ss.stage_id = s.id AND ss.status='pending') AS pending,
               (SELECT count(*)::int FROM stage_sends ss WHERE ss.stage_id = s.id AND ss.status='sent') AS sent_rows
        FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
        WHERE c.send_paused = true
          AND s.scheduled_at IS NOT NULL AND s.scheduled_at <= now()
          AND s.sent_at IS NULL AND s.schedule_missed_at IS NULL
          AND s.archived_at IS NULL
        ORDER BY s.scheduled_at`),
    ),
  );

  // ── 4. campaign_circuit_events ─────────────────────────────────────────────
  console.log("\n--- 4. campaign_circuit_events (all rows) ---");
  console.log(
    j(
      await q(sql`
        SELECT id, org_id, campaign_id, event, reason, actor_user_id,
               created_at::text AS created_at,
               (created_at AT TIME ZONE 'America/New_York')::text AS created_at_et
        FROM campaign_circuit_events ORDER BY id`),
    ),
  );
  console.log("columns of campaign_circuit_events (is Telegram delivery recorded?):");
  console.log(
    j(
      await q(sql`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'campaign_circuit_events' ORDER BY ordinal_position`),
    ),
  );

  // ── 5. further false trips ─────────────────────────────────────────────────
  console.log("\n--- 5. ALL campaigns currently send_paused = true ---");
  console.log(
    j(
      await q(sql`
        SELECT id, name, status, send_paused_reason,
               (send_paused_at AT TIME ZONE 'America/New_York')::text AS send_paused_at_et
        FROM campaigns WHERE send_paused = true ORDER BY send_paused_at`),
    ),
  );

  // ── 6. null stage_send_id audit ────────────────────────────────────────────
  console.log("\n--- 6. opt_out_attributions null stage_send_id audit ---");
  console.log(
    j(
      await q(sql`
        SELECT '30d' AS scope,
               count(*) FILTER (WHERE stage_send_id IS NULL)::int AS nulls,
               count(*)::int AS total
        FROM opt_out_attributions WHERE created_at > now() - interval '30 days'
        UNION ALL
        SELECT 'all_time',
               count(*) FILTER (WHERE stage_send_id IS NULL)::int,
               count(*)::int
        FROM opt_out_attributions`),
    ),
  );
  console.log("do oa.stage_id and ss.stage_id ever disagree? (join integrity)");
  console.log(
    j(
      await t("join-integrity", () =>
        qSlow(sql`
          SELECT count(*)::int AS joined,
                 count(*) FILTER (WHERE oa.stage_id <> ss.stage_id)::int AS stage_mismatch,
                 count(*) FILTER (WHERE ss.sent_at IS NULL)::int AS joined_but_never_sent
          FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id`),
      ),
    ),
  );

  // ── 7. threshold recalibration (ALIGNED cohort) ────────────────────────────
  // Numerator = attributions joined to stage_sends on stage_send_id, bucketed by
  // ss.stage_id / ss.sent_at. Denominator = that stage's 'sent' rows.
  console.log("\n--- 7a. per-stage LIFETIME aligned rate (stages with >= 200 sends) ---");
  console.log(
    j(
      await t("7a", () =>
        qSlow(sql`
          WITH sent AS (
            SELECT stage_id, count(*)::int AS sends, min(sent_at) AS first_send, max(sent_at) AS last_send
            FROM stage_sends WHERE status = 'sent' AND sent_at IS NOT NULL
            GROUP BY stage_id
          ),
          oo AS (
            SELECT ss.stage_id, count(*)::int AS stops
            FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
            WHERE ss.sent_at IS NOT NULL
            GROUP BY ss.stage_id
          ),
          r AS (
            SELECT s.stage_id, s.sends, COALESCE(o.stops,0) AS stops,
                   COALESCE(o.stops,0)::numeric / s.sends AS rate
            FROM sent s LEFT JOIN oo o ON o.stage_id = s.stage_id
            WHERE s.sends >= 200
          )
          SELECT count(*)::int AS stages,
                 sum(sends)::int AS total_sends, sum(stops)::int AS total_stops,
                 round(sum(stops)::numeric / sum(sends) * 100, 3) AS pooled_rate_pct,
                 round(percentile_cont(0.50) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p50_pct,
                 round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p75_pct,
                 round(percentile_cont(0.90) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p90_pct,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p95_pct,
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p99_pct,
                 round(max(rate)::numeric * 100, 3) AS max_pct
          FROM r`),
      ),
    ),
  );
  console.log("   top-15 stages by lifetime aligned rate (>=200 sends):");
  console.log(
    j(
      await t("7a-top", () =>
        qSlow(sql`
          WITH sent AS (
            SELECT stage_id, count(*)::int AS sends FROM stage_sends
            WHERE status='sent' AND sent_at IS NOT NULL GROUP BY stage_id
          ),
          oo AS (
            SELECT ss.stage_id, count(*)::int AS stops
            FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
            WHERE ss.sent_at IS NOT NULL GROUP BY ss.stage_id
          )
          SELECT s.stage_id, s.sends, COALESCE(o.stops,0) AS stops,
                 round(COALESCE(o.stops,0)::numeric / s.sends * 100, 3) AS rate_pct
          FROM sent s LEFT JOIN oo o ON o.stage_id = s.stage_id
          WHERE s.sends >= 200
          ORDER BY COALESCE(o.stops,0)::numeric / s.sends DESC LIMIT 15`),
      ),
    ),
  );

  console.log("\n--- 7b. per-stage 24h-COHORT rate, MATURE stages only (last send >= 24h ago,");
  console.log("        >= 200 sends). b1 = all STOPs ever; b2 = STOPs within 24h of the send");
  console.log("        (b2 is what the fixed 24h check can maximally observe) ---");
  console.log(
    j(
      await t("7b", () =>
        qSlow(sql`
          WITH sent AS (
            SELECT stage_id, count(*)::int AS sends, max(sent_at) AS last_send
            FROM stage_sends WHERE status='sent' AND sent_at IS NOT NULL
            GROUP BY stage_id
          ),
          oo AS (
            SELECT ss.stage_id,
                   count(*)::int AS stops_all,
                   count(*) FILTER (WHERE oa.created_at <= ss.sent_at + interval '24 hours')::int AS stops_24h
            FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
            WHERE ss.sent_at IS NOT NULL
            GROUP BY ss.stage_id
          ),
          r AS (
            SELECT s.stage_id, s.sends,
                   COALESCE(o.stops_all,0) AS stops_all,
                   COALESCE(o.stops_24h,0) AS stops_24h,
                   COALESCE(o.stops_all,0)::numeric / s.sends AS rate_all,
                   COALESCE(o.stops_24h,0)::numeric / s.sends AS rate_24h
            FROM sent s LEFT JOIN oo o ON o.stage_id = s.stage_id
            WHERE s.sends >= 200 AND s.last_send < now() - interval '24 hours'
          )
          SELECT count(*)::int AS stages,
                 round(sum(stops_all)::numeric / sum(sends) * 100, 3) AS pooled_all_pct,
                 round(sum(stops_24h)::numeric / sum(sends) * 100, 3) AS pooled_24h_pct,
                 round(percentile_cont(0.50) WITHIN GROUP (ORDER BY rate_all)::numeric * 100, 3) AS b1_p50,
                 round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate_all)::numeric * 100, 3) AS b1_p75,
                 round(percentile_cont(0.90) WITHIN GROUP (ORDER BY rate_all)::numeric * 100, 3) AS b1_p90,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rate_all)::numeric * 100, 3) AS b1_p95,
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY rate_all)::numeric * 100, 3) AS b1_p99,
                 round(max(rate_all)::numeric * 100, 3) AS b1_max,
                 round(percentile_cont(0.50) WITHIN GROUP (ORDER BY rate_24h)::numeric * 100, 3) AS b2_p50,
                 round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate_24h)::numeric * 100, 3) AS b2_p75,
                 round(percentile_cont(0.90) WITHIN GROUP (ORDER BY rate_24h)::numeric * 100, 3) AS b2_p90,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rate_24h)::numeric * 100, 3) AS b2_p95,
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY rate_24h)::numeric * 100, 3) AS b2_p99,
                 round(max(rate_24h)::numeric * 100, 3) AS b2_max
          FROM r`),
      ),
    ),
  );

  console.log("\n--- 7c. 2-HOUR cohort (short-window twin calibration): per stage, of the");
  console.log("        sends in its FIRST 2 hours, what fraction produced a STOP within 2h");
  console.log("        of that send. Mature (first_send >= 2h ago), >= 200 sends in window ---");
  console.log(
    j(
      await t("7c", () =>
        qSlow(sql`
          WITH first_send AS (
            SELECT stage_id, min(sent_at) AS t0 FROM stage_sends
            WHERE status='sent' AND sent_at IS NOT NULL GROUP BY stage_id
          ),
          win AS (
            SELECT ss.id, ss.stage_id, ss.sent_at
            FROM stage_sends ss JOIN first_send f ON f.stage_id = ss.stage_id
            WHERE ss.status='sent' AND ss.sent_at IS NOT NULL
              AND ss.sent_at <= f.t0 + interval '2 hours'
              AND f.t0 < now() - interval '2 hours'
          ),
          den AS (SELECT stage_id, count(*)::int AS sends FROM win GROUP BY stage_id),
          num AS (
            SELECT w.stage_id, count(*)::int AS stops
            FROM opt_out_attributions oa JOIN win w ON w.id = oa.stage_send_id
            WHERE oa.created_at <= w.sent_at + interval '2 hours'
            GROUP BY w.stage_id
          ),
          r AS (
            SELECT d.stage_id, d.sends, COALESCE(n.stops,0) AS stops,
                   COALESCE(n.stops,0)::numeric / d.sends AS rate
            FROM den d LEFT JOIN num n ON n.stage_id = d.stage_id
            WHERE d.sends >= 200
          )
          SELECT count(*)::int AS stages,
                 sum(sends)::int AS total_sends, sum(stops)::int AS total_stops,
                 round(sum(stops)::numeric / sum(sends) * 100, 3) AS pooled_pct,
                 round(percentile_cont(0.50) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p50_pct,
                 round(percentile_cont(0.75) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p75_pct,
                 round(percentile_cont(0.90) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p90_pct,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p95_pct,
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p99_pct,
                 round(percentile_cont(0.999) WITHIN GROUP (ORDER BY rate)::numeric * 100, 3) AS p999_pct,
                 round(max(rate)::numeric * 100, 3) AS max_pct
          FROM r`),
      ),
    ),
  );
  console.log("   top-15 stages by 2h-cohort rate:");
  console.log(
    j(
      await t("7c-top", () =>
        qSlow(sql`
          WITH first_send AS (
            SELECT stage_id, min(sent_at) AS t0 FROM stage_sends
            WHERE status='sent' AND sent_at IS NOT NULL GROUP BY stage_id
          ),
          win AS (
            SELECT ss.id, ss.stage_id, ss.sent_at
            FROM stage_sends ss JOIN first_send f ON f.stage_id = ss.stage_id
            WHERE ss.status='sent' AND ss.sent_at IS NOT NULL
              AND ss.sent_at <= f.t0 + interval '2 hours'
              AND f.t0 < now() - interval '2 hours'
          ),
          den AS (SELECT stage_id, count(*)::int AS sends FROM win GROUP BY stage_id),
          num AS (
            SELECT w.stage_id, count(*)::int AS stops
            FROM opt_out_attributions oa JOIN win w ON w.id = oa.stage_send_id
            WHERE oa.created_at <= w.sent_at + interval '2 hours'
            GROUP BY w.stage_id
          )
          SELECT d.stage_id, d.sends, COALESCE(n.stops,0) AS stops,
                 round(COALESCE(n.stops,0)::numeric / d.sends * 100, 3) AS rate_pct
          FROM den d LEFT JOIN num n ON n.stage_id = d.stage_id
          WHERE d.sends >= 200
          ORDER BY COALESCE(n.stops,0)::numeric / d.sends DESC LIMIT 15`),
      ),
    ),
  );

  // Per-CAMPAIGN aligned 24h rate distribution — the metric the FIXED per-campaign
  // check would actually evaluate, for comparison with the per-stage view.
  console.log("\n--- 7d. per-CAMPAIGN aligned rate over each campaign's own send history");
  console.log("        (>= 200 sends), for the per-campaign-vs-per-stage decision ---");
  console.log(
    j(
      await t("7d", () =>
        qSlow(sql`
          WITH sent AS (
            SELECT campaign_id, count(*)::int AS sends FROM stage_sends
            WHERE status='sent' AND sent_at IS NOT NULL GROUP BY campaign_id
          ),
          oo AS (
            SELECT ss.campaign_id, count(*)::int AS stops
            FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
            WHERE ss.sent_at IS NOT NULL GROUP BY ss.campaign_id
          ),
          r AS (
            SELECT s.campaign_id, s.sends, COALESCE(o.stops,0) AS stops,
                   COALESCE(o.stops,0)::numeric / s.sends AS rate
            FROM sent s LEFT JOIN oo o ON o.campaign_id = s.campaign_id
            WHERE s.sends >= 200
          )
          SELECT count(*)::int AS campaigns,
                 round(percentile_cont(0.50) WITHIN GROUP (ORDER BY rate)::numeric*100,3) AS p50,
                 round(percentile_cont(0.90) WITHIN GROUP (ORDER BY rate)::numeric*100,3) AS p90,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rate)::numeric*100,3) AS p95,
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY rate)::numeric*100,3) AS p99,
                 round(max(rate)::numeric*100,3) AS max
          FROM r`),
      ),
    ),
  );

  // 7e — same aligned lifetime metric at the ORIGINAL calibration floor (>=50
  // sends), to compare against the code comment's "330 stages >=50 sends:
  // p95 7.4%, p99 8.4%, max 13.8%".
  console.log("\n--- 7e. aligned lifetime rate at the ORIGINAL >=50-send floor ---");
  console.log(
    j(
      await t("7e", () =>
        qSlow(sql`
          WITH sent AS (
            SELECT stage_id, count(*)::int AS sends FROM stage_sends
            WHERE status='sent' AND sent_at IS NOT NULL GROUP BY stage_id
          ),
          oo AS (
            SELECT ss.stage_id, count(*)::int AS stops
            FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
            WHERE ss.sent_at IS NOT NULL GROUP BY ss.stage_id
          ),
          r AS (
            SELECT s.sends, COALESCE(o.stops,0)::numeric / s.sends AS rate
            FROM sent s LEFT JOIN oo o ON o.stage_id = s.stage_id WHERE s.sends >= 50
          )
          SELECT count(*)::int AS stages,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rate)::numeric*100,3) AS p95,
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY rate)::numeric*100,3) AS p99,
                 round(max(rate)::numeric*100,3) AS max
          FROM r`),
      ),
    ),
  );

  // 7f — how many historical stage-cohorts would TRIP at candidate thresholds.
  console.log("\n--- 7f. historical trip counts at candidate thresholds (>=200 sends) ---");
  console.log(
    j(
      await t("7f", () =>
        qSlow(sql`
          WITH sent AS (
            SELECT stage_id, count(*)::int AS sends FROM stage_sends
            WHERE status='sent' AND sent_at IS NOT NULL GROUP BY stage_id
          ),
          oo24 AS (
            SELECT ss.stage_id,
                   count(*) FILTER (WHERE oa.created_at <= ss.sent_at + interval '24 hours')::int AS s24,
                   count(*) FILTER (WHERE oa.created_at <= ss.sent_at + interval '2 hours')::int  AS s2
            FROM opt_out_attributions oa JOIN stage_sends ss ON ss.id = oa.stage_send_id
            WHERE ss.sent_at IS NOT NULL GROUP BY ss.stage_id
          ),
          r AS (
            SELECT s.sends,
                   COALESCE(o.s24,0)::numeric / s.sends AS r24,
                   COALESCE(o.s2,0)::numeric / s.sends AS r2
            FROM sent s LEFT JOIN oo24 o ON o.stage_id = s.stage_id WHERE s.sends >= 200
          )
          SELECT count(*)::int AS stages,
                 count(*) FILTER (WHERE r24 >= 0.10)::int AS trips_24h_at_10pct,
                 count(*) FILTER (WHERE r24 >= 0.12)::int AS trips_24h_at_12pct,
                 count(*) FILTER (WHERE r24 >= 0.15)::int AS trips_24h_at_15pct,
                 count(*) FILTER (WHERE r2  >= 0.06)::int AS trips_2h_at_6pct,
                 count(*) FILTER (WHERE r2  >= 0.08)::int AS trips_2h_at_8pct,
                 count(*) FILTER (WHERE r2  >= 0.10)::int AS trips_2h_at_10pct,
                 count(*) FILTER (WHERE r2  >= 0.12)::int AS trips_2h_at_12pct
          FROM r`),
      ),
    ),
  );

  // ── 8. §5.3 counterfactual re-check ────────────────────────────────────────
  console.log("\n--- 8. §5.3 counterfactual at each campaign's stored latch time ---");
  const latches = await q<{ campaign_id: number; latch: string }>(sql`
    SELECT campaign_id, min(created_at)::text AS latch
    FROM campaign_circuit_events
    WHERE event = 'paused' AND reason LIKE 'optout_rate_spike%'
    GROUP BY campaign_id ORDER BY campaign_id`);
  console.log(`latch timestamps from campaign_circuit_events: ${j(latches)}`);
  for (const l of latches) {
    const rows = await qSlow(sql`
      SELECT ${l.campaign_id}::int AS campaign_id,
        (SELECT count(*)::int FROM stage_sends
          WHERE campaign_id = ${l.campaign_id} AND status='sent'
            AND sent_at > ${l.latch}::timestamptz - interval '24 hours'
            AND sent_at <= ${l.latch}::timestamptz) AS denominator,
        (SELECT count(*)::int FROM opt_out_attributions
          WHERE campaign_id = ${l.campaign_id}
            AND created_at > ${l.latch}::timestamptz - interval '24 hours'
            AND created_at <= ${l.latch}::timestamptz) AS numerator_current,
        (SELECT count(*)::int FROM opt_out_attributions oa
          JOIN stage_sends ss ON ss.id = oa.stage_send_id
          WHERE oa.campaign_id = ${l.campaign_id}
            AND ss.sent_at > ${l.latch}::timestamptz - interval '24 hours'
            AND ss.sent_at <= ${l.latch}::timestamptz) AS numerator_aligned,
        (SELECT count(*)::int FROM stage_sends
          WHERE campaign_id = ${l.campaign_id} AND status='sent'
            AND sent_at > ${l.latch}::timestamptz - interval '2 hours'
            AND sent_at <= ${l.latch}::timestamptz) AS denominator_2h,
        (SELECT count(*)::int FROM opt_out_attributions oa
          JOIN stage_sends ss ON ss.id = oa.stage_send_id
          WHERE oa.campaign_id = ${l.campaign_id}
            AND ss.sent_at > ${l.latch}::timestamptz - interval '2 hours'
            AND ss.sent_at <= ${l.latch}::timestamptz) AS numerator_aligned_2h`);
    console.log(j(rows));
  }

  await c.end();
  console.log("\n=== done (read-only) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
