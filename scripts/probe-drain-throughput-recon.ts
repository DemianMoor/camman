import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon: where does send throughput actually go?
// Measures effective messages/sec from historical stage_sends.sent_at, the
// per-minute + per-second rate profile, inter-slice gaps, per-phone parallelism,
// and what timing data send_attempts already carries.
//
// SELECT ONLY. Run: npx tsx scripts/probe-drain-throughput-recon.ts

function line(s = "") {
  console.log(s);
}
function hr(title: string) {
  line();
  line("=".repeat(78));
  line(title);
  line("=".repeat(78));
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) =>
    (await d.execute(query)) as unknown as T[];

  // ── 0. Configured caps ─────────────────────────────────────────────────────
  hr("0. CONFIGURED CAPS (sms_providers / provider_phones)");
  const providers = await q<Record<string, unknown>>(sql`
    SELECT id, sms_provider_id AS key, name, supports_api_send, send_paused,
           max_sends_per_run, max_sends_per_minute, max_sends_per_24h
    FROM sms_providers ORDER BY id`);
  for (const p of providers) {
    line(
      `provider ${p.id} [${p.key}] "${p.name}" api_send=${p.supports_api_send} paused=${p.send_paused} ` +
        `per_run=${p.max_sends_per_run} per_min=${p.max_sends_per_minute} per_24h=${p.max_sends_per_24h}`,
    );
  }
  const phones = await q<Record<string, unknown>>(sql`
    SELECT pp.id, pp.phone_number, pp.max_sends_per_second, pp.provider_id AS provider_id,
           pp.number_type AS status,
           (SELECT count(*)::int FROM stage_sends ss
             WHERE ss.provider_phone_id = pp.id AND ss.sent_at > now() - interval '14 days') AS sent_14d
    FROM provider_phones pp
    ORDER BY sent_14d DESC, pp.id
    LIMIT 25`);
  line();
  for (const p of phones) {
    line(
      `phone ${p.id} ${p.phone_number} provider=${p.provider_id} status=${p.status} ` +
        `max_sends_per_second=${p.max_sends_per_second} sent_14d=${p.sent_14d}`,
    );
  }

  // ── 1. Effective throughput per stage ──────────────────────────────────────
  hr("1. TOP 15 STAGES BY SENT COUNT (last 14 days) — effective msgs/sec");
  const top = await q<Record<string, unknown>>(sql`
    SELECT ss.stage_id,
           ss.campaign_id,
           p.sms_provider_id                    AS provider_key,
           pp.phone_number                      AS sender,
           pp.max_sends_per_second              AS mps_cfg,
           count(*)::int                        AS sent,
           min(ss.sent_at)::text                AS first_sent,
           max(ss.sent_at)::text                AS last_sent,
           EXTRACT(EPOCH FROM (max(ss.sent_at) - min(ss.sent_at)))::numeric(12,1) AS span_sec,
           count(DISTINCT ss.sent_at)::int      AS distinct_ts,
           count(DISTINCT date_trunc('minute', ss.sent_at))::int AS active_minutes
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    LEFT JOIN provider_phones pp ON pp.id = COALESCE(ss.provider_phone_id, s.provider_phone_id)
    WHERE ss.status = 'sent' AND ss.sent_at > now() - interval '14 days'
    GROUP BY ss.stage_id, ss.campaign_id, p.sms_provider_id, pp.phone_number, pp.max_sends_per_second
    ORDER BY sent DESC
    LIMIT 15`);
  line(
    "stage  camp   prov  sender          cfg_mps  sent    span_s   eff_mps  active_min  in-min_mps  distinct_ts  rows/ts",
  );
  for (const r of top) {
    const sent = Number(r.sent);
    const span = Number(r.span_sec);
    const eff = span > 0 ? sent / span : 0;
    const am = Number(r.active_minutes);
    const inMin = am > 0 ? sent / (am * 60) : 0;
    const dts = Number(r.distinct_ts);
    line(
      `${String(r.stage_id).padEnd(6)} ${String(r.campaign_id).padEnd(6)} ` +
        `${String(r.provider_key ?? "-").padEnd(5)} ${String(r.sender ?? "-").padEnd(15)} ` +
        `${String(r.mps_cfg ?? "-").padStart(7)}  ${String(sent).padStart(6)} ` +
        `${span.toFixed(0).padStart(7)}  ${eff.toFixed(2).padStart(7)}  ${String(am).padStart(10)}  ` +
        `${inMin.toFixed(2).padStart(10)}  ${String(dts).padStart(11)}  ${(sent / Math.max(dts, 1)).toFixed(1).padStart(7)}`,
    );
  }
  line();
  line("first/last sent_at for the same rows:");
  for (const r of top) line(`  stage ${r.stage_id}: ${r.first_sent} -> ${r.last_sent}`);

  const biggest = top[0];
  if (!biggest) {
    line("No sent rows in the last 14 days — nothing further to measure.");
    await c.end();
    return;
  }
  const bigStage = Number(biggest.stage_id);

  // ── 2. Per-minute rate profile for the biggest stage ───────────────────────
  hr(`2. PER-MINUTE HISTOGRAM — stage ${bigStage} (flat = loop-bound, sawtooth = invocation-bound)`);
  const perMin = await q<Record<string, unknown>>(sql`
    SELECT date_trunc('minute', sent_at)::text AS minute,
           count(*)::int AS n,
           count(DISTINCT sent_at)::int AS slices,
           min(sent_at)::text AS first_in_min,
           max(sent_at)::text AS last_in_min
    FROM stage_sends
    WHERE stage_id = ${bigStage} AND status = 'sent'
    GROUP BY 1 ORDER BY 1`);
  line("minute                     n     mps   slices  bar");
  for (const r of perMin) {
    const n = Number(r.n);
    line(
      `${String(r.minute).slice(0, 19).padEnd(21)} ${String(n).padStart(5)}  ${(n / 60).toFixed(2).padStart(6)}  ${String(r.slices).padStart(6)}  ` +
        "#".repeat(Math.min(60, Math.round(n / 25))),
    );
  }
  const minVals = perMin.map((r) => Number(r.n));
  if (minVals.length) {
    const zero = minVals.filter((v) => v === 0).length;
    line();
    line(
      `minutes=${minVals.length} max=${Math.max(...minVals)} min=${Math.min(...minVals)} ` +
        `mean=${(minVals.reduce((a, b) => a + b, 0) / minVals.length).toFixed(1)} zero_minutes=${zero}`,
    );
  }

  // ── 3. Intra-second rate ───────────────────────────────────────────────────
  hr(`3. INTRA-SECOND PEAK — stage ${bigStage} (busiest minute, per-second buckets)`);
  const busiest = perMin.reduce(
    (a, b) => (Number(b.n) > Number(a?.n ?? -1) ? b : a),
    perMin[0],
  );
  line(`busiest minute: ${busiest?.minute} (${busiest?.n} sends)`);
  const perSec = await q<Record<string, unknown>>(sql`
    SELECT date_trunc('second', sent_at)::text AS sec, count(*)::int AS n
    FROM stage_sends
    WHERE stage_id = ${bigStage} AND status = 'sent'
      AND sent_at >= ${String(busiest?.minute)}::timestamptz
      AND sent_at <  ${String(busiest?.minute)}::timestamptz + interval '1 minute'
    GROUP BY 1 ORDER BY 1`);
  for (const r of perSec) {
    line(`  ${String(r.sec).slice(11, 19)}  ${String(r.n).padStart(4)}  ${"#".repeat(Math.min(70, Number(r.n)))}`);
  }
  const peakAll = await q<{ peak: number; secs: number; p50: number; p95: number }>(sql`
    WITH s AS (
      SELECT date_trunc('second', sent_at) AS sec, count(*)::int AS n
      FROM stage_sends WHERE stage_id = ${bigStage} AND status = 'sent' GROUP BY 1
    )
    SELECT max(n)::int AS peak, count(*)::int AS secs,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY n)::int AS p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY n)::int AS p95
    FROM s`);
  line();
  line(
    `whole stage: peak sends in ANY single second = ${peakAll[0]?.peak} · active seconds = ${peakAll[0]?.secs} ` +
      `· p50 = ${peakAll[0]?.p50}/s · p95 = ${peakAll[0]?.p95}/s`,
  );

  // ── 4. Inter-slice gaps ────────────────────────────────────────────────────
  hr(`4. GAP DISTRIBUTION between consecutive DISTINCT sent_at values — stage ${bigStage}`);
  line("(all rows of one parallel slice share one sent_at — the UPDATE's now();");
  line(" so a distinct timestamp = one slice, and the gap = one slice's cycle time)");
  const gaps = await q<Record<string, unknown>>(sql`
    WITH ts AS (
      SELECT DISTINCT sent_at FROM stage_sends WHERE stage_id = ${bigStage} AND status = 'sent'
    ), g AS (
      SELECT EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at)))::numeric AS gap_s
      FROM ts
    )
    SELECT count(*)::int AS n,
           min(gap_s)::numeric(10,3) AS min_s,
           percentile_disc(0.25) WITHIN GROUP (ORDER BY gap_s)::numeric(10,3) AS p25,
           percentile_disc(0.50) WITHIN GROUP (ORDER BY gap_s)::numeric(10,3) AS p50,
           percentile_disc(0.75) WITHIN GROUP (ORDER BY gap_s)::numeric(10,3) AS p75,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY gap_s)::numeric(10,3) AS p95,
           percentile_disc(0.99) WITHIN GROUP (ORDER BY gap_s)::numeric(10,3) AS p99,
           max(gap_s)::numeric(10,3) AS max_s,
           sum(gap_s)::numeric(10,1) AS total_s,
           sum(gap_s) FILTER (WHERE gap_s > 5)::numeric(10,1) AS total_gt5s,
           count(*) FILTER (WHERE gap_s > 5)::int AS n_gt5s,
           count(*) FILTER (WHERE gap_s > 30)::int AS n_gt30s
    FROM g WHERE gap_s IS NOT NULL`);
  line(JSON.stringify(gaps[0], null, 2));
  const gapHist = await q<Record<string, unknown>>(sql`
    WITH ts AS (
      SELECT DISTINCT sent_at FROM stage_sends WHERE stage_id = ${bigStage} AND status = 'sent'
    ), g AS (
      SELECT EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at)))::numeric AS gap_s FROM ts
    )
    SELECT CASE
             WHEN gap_s < 0.1 THEN 'a <0.1s'
             WHEN gap_s < 0.25 THEN 'b 0.1-0.25s'
             WHEN gap_s < 0.5 THEN 'c 0.25-0.5s'
             WHEN gap_s < 1 THEN 'd 0.5-1s'
             WHEN gap_s < 2 THEN 'e 1-2s'
             WHEN gap_s < 5 THEN 'f 2-5s'
             WHEN gap_s < 15 THEN 'g 5-15s'
             WHEN gap_s < 60 THEN 'h 15-60s'
             WHEN gap_s < 300 THEN 'i 60-300s'
             ELSE 'j >300s' END AS bucket,
           count(*)::int AS n, sum(gap_s)::numeric(10,1) AS secs
    FROM g WHERE gap_s IS NOT NULL GROUP BY 1 ORDER BY 1`);
  line();
  line("bucket           count    total_seconds");
  for (const r of gapHist) {
    line(`${String(r.bucket).padEnd(15)} ${String(r.n).padStart(6)}   ${String(r.secs).padStart(10)}`);
  }

  // ── 5. Concurrency evidence: rows per distinct sent_at (slice size) ────────
  hr(`5. SLICE SIZE — rows sharing one sent_at timestamp — stage ${bigStage}`);
  const sliceHist = await q<Record<string, unknown>>(sql`
    WITH s AS (
      SELECT sent_at, count(*)::int AS rows_in_slice
      FROM stage_sends WHERE stage_id = ${bigStage} AND status = 'sent' GROUP BY 1
    )
    SELECT rows_in_slice, count(*)::int AS slices
    FROM s GROUP BY 1 ORDER BY slices DESC LIMIT 15`);
  line("rows_in_slice   slices");
  for (const r of sliceHist) {
    line(`${String(r.rows_in_slice).padStart(13)}   ${String(r.slices).padStart(6)}`);
  }

  // ── 6. Provider latency proxy ──────────────────────────────────────────────
  hr("6. send_attempts — what timing data exists?");
  const cols = await q<Record<string, unknown>>(sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'send_attempts' ORDER BY ordinal_position`);
  line(cols.map((r) => `${r.column_name}:${r.data_type}`).join("  "));
  const lat = await q<Record<string, unknown>>(sql`
    SELECT count(*)::int AS n,
           percentile_disc(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.created_at - ss.sent_at)))::numeric(10,3) AS p50_s,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.created_at - ss.sent_at)))::numeric(10,3) AS p95_s,
           max(EXTRACT(EPOCH FROM (a.created_at - ss.sent_at)))::numeric(10,3) AS max_s
    FROM send_attempts a
    JOIN stage_sends ss ON ss.id = a.stage_send_id
    WHERE a.created_at > now() - interval '7 days' AND ss.sent_at IS NOT NULL`);
  line();
  line(`attempt.created_at - stage_send.sent_at (post-send DB write lag, NOT provider latency): ${JSON.stringify(lat[0])}`);

  // ── 7. Multi-phone parallelism ─────────────────────────────────────────────
  hr("7. MULTI-PHONE PARALLELISM — seconds where 2+ phones sent simultaneously");
  const par = await q<Record<string, unknown>>(sql`
    WITH s AS (
      SELECT date_trunc('second', ss.sent_at) AS sec,
             COALESCE(ss.provider_phone_id, cs.provider_phone_id) AS phone_id,
             count(*)::int AS n
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.status = 'sent' AND ss.sent_at > now() - interval '14 days'
      GROUP BY 1, 2
    ), agg AS (
      SELECT sec, count(*)::int AS phones, sum(n)::int AS total, max(n)::int AS max_one_phone
      FROM s GROUP BY 1
    )
    SELECT phones,
           count(*)::int AS seconds,
           max(total)::int AS peak_total_per_sec,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY total)::int AS p50_total,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY total)::int AS p95_total,
           max(max_one_phone)::int AS peak_single_phone
    FROM agg GROUP BY 1 ORDER BY 1`);
  line("phones_active  seconds   p50_total/s  p95_total/s  peak_total/s  peak_single_phone/s");
  for (const r of par) {
    line(
      `${String(r.phones).padStart(13)}  ${String(r.seconds).padStart(7)}  ${String(r.p50_total).padStart(11)}  ` +
        `${String(r.p95_total).padStart(11)}  ${String(r.peak_total_per_sec).padStart(12)}  ${String(r.peak_single_phone).padStart(19)}`,
    );
  }

  // Per-phone effective rate over the last 14 days, only counting active minutes.
  const perPhone = await q<Record<string, unknown>>(sql`
    WITH s AS (
      SELECT COALESCE(ss.provider_phone_id, cs.provider_phone_id) AS phone_id,
             date_trunc('minute', ss.sent_at) AS minute, count(*)::int AS n
      FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.status = 'sent' AND ss.sent_at > now() - interval '14 days'
      GROUP BY 1, 2
    )
    SELECT s.phone_id, pp.phone_number, pp.max_sends_per_second AS cfg_mps,
           sum(s.n)::int AS sent, count(*)::int AS active_minutes,
           (sum(s.n)::numeric / (count(*) * 60))::numeric(10,2) AS mps_in_active_minutes,
           max(s.n)::int AS best_minute
    FROM s LEFT JOIN provider_phones pp ON pp.id = s.phone_id
    GROUP BY 1, 2, 3 ORDER BY sent DESC LIMIT 12`);
  line();
  line("phone_id  number           cfg_mps   sent   active_min  mps_in_active_min  best_minute (msgs)");
  for (const r of perPhone) {
    line(
      `${String(r.phone_id ?? "-").padStart(8)}  ${String(r.phone_number ?? "-").padEnd(15)} ${String(r.cfg_mps ?? "-").padStart(7)}  ` +
        `${String(r.sent).padStart(6)}  ${String(r.active_minutes).padStart(10)}  ${String(r.mps_in_active_minutes).padStart(17)}  ${String(r.best_minute).padStart(10)}`,
    );
  }

  // ── 8. Failure / throttle rate ─────────────────────────────────────────────
  hr("8. FAILURE / THROTTLE evidence — send_attempts (last 14 days)");
  const cls = await q<Record<string, unknown>>(sql`
    SELECT classification, ok, http_status, count(*)::int AS n
    FROM send_attempts
    WHERE created_at > now() - interval '14 days'
    GROUP BY 1,2,3 ORDER BY n DESC LIMIT 25`);
  line("classification      ok     http  count");
  for (const r of cls) {
    line(
      `${String(r.classification).padEnd(18)} ${String(r.ok).padEnd(6)} ${String(r.http_status).padStart(4)}  ${String(r.n).padStart(8)}`,
    );
  }
  const errs = await q<Record<string, unknown>>(sql`
    SELECT left(coalesce(error, '(null)'), 70) AS err, count(*)::int AS n
    FROM send_attempts WHERE created_at > now() - interval '14 days' AND ok = false
    GROUP BY 1 ORDER BY n DESC LIMIT 15`);
  line();
  line("top send_attempts errors:");
  for (const r of errs) line(`  ${String(r.n).padStart(7)}  ${r.err}`);

  const statusMix = await q<Record<string, unknown>>(sql`
    SELECT status, count(*)::int AS n FROM stage_sends
    WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY n DESC`);
  line();
  line("stage_sends status mix (rows created in last 14 days):");
  for (const r of statusMix) line(`  ${String(r.status).padEnd(20)} ${String(r.n).padStart(8)}`);

  // ── 9. Tick-boundary evidence ──────────────────────────────────────────────
  hr("9. TICK BOUNDARY EVIDENCE — sends bucketed by minute-of-5min-cycle (all stages, 14d)");
  const tickPhase = await q<Record<string, unknown>>(sql`
    SELECT (EXTRACT(MINUTE FROM sent_at)::int % 5) AS min_in_cycle,
           EXTRACT(SECOND FROM sent_at)::int / 10 AS ten_sec_bucket,
           count(*)::int AS n
    FROM stage_sends
    WHERE status = 'sent' AND sent_at > now() - interval '14 days'
    GROUP BY 1,2 ORDER BY 1,2`);
  line("min_in_5min_cycle : per-10s-bucket counts");
  const byMin = new Map<number, number[]>();
  for (const r of tickPhase) {
    const m = Number(r.min_in_cycle);
    const arr = byMin.get(m) ?? new Array(6).fill(0);
    arr[Number(r.ten_sec_bucket)] = Number(r.n);
    byMin.set(m, arr);
  }
  for (const [m, arr] of [...byMin.entries()].sort((a, b) => a[0] - b[0])) {
    line(`  +${m}m  ${arr.map((v) => String(v).padStart(7)).join(" ")}   (total ${arr.reduce((a, b) => a + b, 0)})`);
  }

  // ── 10. One stage, full timeline reconstruct ───────────────────────────────
  hr(`10. STAGE ${bigStage} — reconstructed drain sessions (gap > 30s = new cron tick)`);
  const sessions = await q<Record<string, unknown>>(sql`
    WITH ts AS (
      SELECT sent_at, count(*)::int AS n FROM stage_sends
      WHERE stage_id = ${bigStage} AND status = 'sent' GROUP BY 1
    ), m AS (
      SELECT sent_at, n,
             CASE WHEN EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at))) > 30
                  OR lag(sent_at) OVER (ORDER BY sent_at) IS NULL THEN 1 ELSE 0 END AS newgrp
      FROM ts
    ), g AS (
      SELECT sent_at, n, sum(newgrp) OVER (ORDER BY sent_at) AS grp FROM m
    )
    SELECT grp, min(sent_at)::text AS started, max(sent_at)::text AS ended,
           EXTRACT(EPOCH FROM (max(sent_at) - min(sent_at)))::numeric(10,1) AS dur_s,
           sum(n)::int AS sent, count(*)::int AS slices
    FROM g GROUP BY grp ORDER BY grp`);
  line("session  started              ended                dur_s    sent  slices   mps_within_session");
  for (const r of sessions) {
    const dur = Number(r.dur_s);
    const sent = Number(r.sent);
    line(
      `${String(r.grp).padStart(7)}  ${String(r.started).slice(0, 19)}  ${String(r.ended).slice(0, 19)}  ` +
        `${dur.toFixed(1).padStart(7)}  ${String(sent).padStart(6)}  ${String(r.slices).padStart(6)}   ` +
        `${(dur > 0 ? sent / dur : 0).toFixed(2)}`,
    );
  }

  // ── 11. Natural experiment: a rate=3 phone (slice=3, paced to 1s) ──────────
  // With rate=3 and batchSize=50 the drain emits ~17 paced slices per claimed
  // batch. Intra-batch gaps ≈ the 1s pacing floor; the ~every-17th gap carries
  // the FIXED per-batch overhead (pre-checks + claim + opt-out + dedup queries).
  hr("11. FIXED PER-BATCH OVERHEAD — 3/s toll-free stage (slice=3, pacing floor 1.0s)");
  const slowStage = await q<{ stage_id: number }>(sql`
    SELECT ss.stage_id FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.status = 'sent' AND ss.sent_at > now() - interval '14 days'
      AND COALESCE(ss.provider_phone_id, cs.provider_phone_id) = 27
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const slowId = Number(slowStage[0]?.stage_id);
  line(`stage ${slowId} (phone 27, +18446210404, cfg 3/s)`);
  const slowGaps = await q<Record<string, unknown>>(sql`
    WITH ts AS (
      SELECT sent_at, count(*)::int AS n FROM stage_sends
      WHERE stage_id = ${slowId} AND status = 'sent' GROUP BY 1
    ), g AS (
      SELECT n, EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at)))::numeric AS gap_s FROM ts
    )
    SELECT CASE
             WHEN gap_s < 1.0 THEN 'a <1.0s'
             WHEN gap_s < 1.1 THEN 'b 1.0-1.1s  (pacing floor)'
             WHEN gap_s < 1.5 THEN 'c 1.1-1.5s'
             WHEN gap_s < 2.5 THEN 'd 1.5-2.5s  (batch boundary?)'
             WHEN gap_s < 5 THEN 'e 2.5-5s'
             WHEN gap_s < 30 THEN 'f 5-30s'
             ELSE 'g >30s' END AS bucket,
           count(*)::int AS n,
           sum(gap_s)::numeric(10,1) AS total_s,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY gap_s)::numeric(10,3) AS p50
    FROM g WHERE gap_s IS NOT NULL GROUP BY 1 ORDER BY 1`);
  line("bucket                          count   total_s      p50");
  for (const r of slowGaps) {
    line(
      `${String(r.bucket).padEnd(30)} ${String(r.n).padStart(6)} ${String(r.total_s).padStart(9)} ${String(r.p50).padStart(8)}`,
    );
  }
  const slowSlices = await q<Record<string, unknown>>(sql`
    WITH s AS (SELECT sent_at, count(*)::int AS n FROM stage_sends
               WHERE stage_id = ${slowId} AND status='sent' GROUP BY 1)
    SELECT n AS rows_in_slice, count(*)::int AS slices FROM s GROUP BY 1 ORDER BY slices DESC LIMIT 8`);
  line();
  line(`slice sizes: ${slowSlices.map((r) => `${r.rows_in_slice}×${r.slices}`).join("  ")}`);

  // ── 12. Contention: does per-slice cycle time degrade with concurrency? ────
  hr("12. CONTENTION — slice cycle time vs number of phones draining in that second");
  const contention = await q<Record<string, unknown>>(sql`
    WITH slices AS (
      SELECT ss.stage_id,
             COALESCE(ss.provider_phone_id, cs.provider_phone_id) AS phone_id,
             ss.sent_at, count(*)::int AS n
      FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.status = 'sent' AND ss.sent_at > now() - interval '14 days'
      GROUP BY 1,2,3
      HAVING count(*) >= 40
    ), gapped AS (
      SELECT stage_id, sent_at, n,
             EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (PARTITION BY stage_id ORDER BY sent_at)))::numeric AS gap_s
      FROM slices
    ), conc AS (
      SELECT date_trunc('second', sent_at) AS sec,
             count(DISTINCT COALESCE(provider_phone_id, 0))::int AS phones
      FROM stage_sends WHERE status='sent' AND sent_at > now() - interval '14 days'
      GROUP BY 1
    )
    SELECT c.phones,
           count(*)::int AS slices,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY g.gap_s)::numeric(10,3) AS p50_gap_s,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY g.gap_s)::numeric(10,3) AS p95_gap_s,
           avg(g.n)::numeric(6,1) AS avg_slice_rows
    FROM gapped g JOIN conc c ON c.sec = date_trunc('second', g.sent_at)
    WHERE g.gap_s IS NOT NULL AND g.gap_s < 30
    GROUP BY 1 ORDER BY 1`);
  line("phones_in_second  slices   p50_gap_s   p95_gap_s   avg_slice_rows   implied_mps_per_stage");
  for (const r of contention) {
    const p50 = Number(r.p50_gap_s);
    line(
      `${String(r.phones).padStart(16)}  ${String(r.slices).padStart(6)}  ${String(r.p50_gap_s).padStart(9)}  ` +
        `${String(r.p95_gap_s).padStart(9)}  ${String(r.avg_slice_rows).padStart(14)}   ${(Number(r.avg_slice_rows) / p50).toFixed(2)}`,
    );
  }

  // ── 13. Campaign-level wall clock for a 40-50K send ───────────────────────
  hr("13. CAMPAIGN-LEVEL WALL CLOCK (last 14 days, ≥20K sent)");
  const camp = await q<Record<string, unknown>>(sql`
    SELECT ss.campaign_id, count(*)::int AS sent,
           count(DISTINCT ss.stage_id)::int AS stages,
           count(DISTINCT COALESCE(ss.provider_phone_id, 0))::int AS phones,
           min(ss.sent_at)::text AS started, max(ss.sent_at)::text AS ended,
           EXTRACT(EPOCH FROM (max(ss.sent_at) - min(ss.sent_at)))::numeric(10,0) AS span_s
    FROM stage_sends ss
    WHERE ss.status='sent' AND ss.sent_at > now() - interval '14 days'
    GROUP BY 1 HAVING count(*) >= 20000
    ORDER BY sent DESC LIMIT 12`);
  line("campaign  sent    stages phones  span_s   span_min  eff_mps  started");
  for (const r of camp) {
    const span = Number(r.span_s);
    line(
      `${String(r.campaign_id).padEnd(9)} ${String(r.sent).padStart(6)}  ${String(r.stages).padStart(6)} ${String(r.phones).padStart(6)}  ` +
        `${String(span).padStart(6)}  ${(span / 60).toFixed(1).padStart(8)}  ${(Number(r.sent) / Math.max(span, 1)).toFixed(2).padStart(7)}  ${String(r.started).slice(0, 19)}`,
    );
  }

  // ── 14. Long-running stage: cron-tick boundary visible? ───────────────────
  hr("14. LONG STAGE session reconstruction (gap > 20s = drain yielded / new tick)");
  for (const sid of [1705, 1690, 1688]) {
    const s = await q<Record<string, unknown>>(sql`
      WITH ts AS (
        SELECT sent_at, count(*)::int AS n FROM stage_sends
        WHERE stage_id = ${sid} AND status='sent' GROUP BY 1
      ), m AS (
        SELECT sent_at, n,
               CASE WHEN EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at))) > 20
                    OR lag(sent_at) OVER (ORDER BY sent_at) IS NULL THEN 1 ELSE 0 END AS ng,
               EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at)))::numeric(10,1) AS gap
        FROM ts
      ), g AS (SELECT sent_at, n, gap, sum(ng) OVER (ORDER BY sent_at) AS grp FROM m)
      SELECT grp, min(sent_at)::text AS started, max(sent_at)::text AS ended,
             EXTRACT(EPOCH FROM (max(sent_at)-min(sent_at)))::numeric(10,1) AS dur_s,
             sum(n)::int AS sent, count(*)::int AS slices,
             max(gap)::numeric(10,1) AS lead_gap_s
      FROM g GROUP BY grp ORDER BY grp`);
    line();
    line(`--- stage ${sid} ---`);
    line("sess  started              ended                dur_s   sent  slices  mps   gap_before");
    let prevEnd: number | null = null;
    for (const r of s) {
      const dur = Number(r.dur_s);
      const startMs = Date.parse(String(r.started));
      const idle = prevEnd != null ? ((startMs - prevEnd) / 1000).toFixed(1) : "-";
      prevEnd = Date.parse(String(r.ended));
      line(
        `${String(r.grp).padStart(4)}  ${String(r.started).slice(0, 19)}  ${String(r.ended).slice(0, 19)}  ` +
          `${dur.toFixed(0).padStart(5)}  ${String(r.sent).padStart(5)}  ${String(r.slices).padStart(6)}  ` +
          `${(dur > 0 ? Number(r.sent) / dur : 0).toFixed(1).padStart(5)}  ${idle.padStart(8)}s idle`,
      );
    }
  }

  // ── 15. Per-phone aggregate rate (does adding stages on one phone help?) ──
  hr("15. PER-PHONE PER-MINUTE RATE — busiest hour (all stages on that phone summed)");
  const busyHour = await q<{ h: string; n: number }>(sql`
    SELECT date_trunc('hour', sent_at)::text AS h, count(*)::int AS n
    FROM stage_sends WHERE status='sent' AND sent_at > now() - interval '14 days'
    GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  line(`busiest hour: ${busyHour[0]?.h} — ${busyHour[0]?.n} sends org-wide (${(Number(busyHour[0]?.n) / 3600).toFixed(1)}/s avg)`);
  const phoneMin = await q<Record<string, unknown>>(sql`
    SELECT date_trunc('minute', ss.sent_at)::text AS minute,
           COALESCE(ss.provider_phone_id, cs.provider_phone_id) AS phone_id,
           count(*)::int AS n,
           count(DISTINCT ss.stage_id)::int AS stages
    FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.status='sent'
      AND ss.sent_at >= ${String(busyHour[0]?.h)}::timestamptz
      AND ss.sent_at <  ${String(busyHour[0]?.h)}::timestamptz + interval '1 hour'
    GROUP BY 1,2 ORDER BY 1,2`);
  const mins = [...new Set(phoneMin.map((r) => String(r.minute)))];
  const phoneIds = [...new Set(phoneMin.map((r) => String(r.phone_id)))];
  line();
  line(`minute                ${phoneIds.map((p) => `ph${p}`.padStart(12)).join("")}      TOTAL   total_mps`);
  for (const m of mins) {
    const cells = phoneIds.map((p) => {
      const r = phoneMin.find((x) => String(x.minute) === m && String(x.phone_id) === p);
      return r ? `${r.n}(${r.stages}st)`.padStart(12) : "".padStart(12);
    });
    const tot = phoneMin.filter((x) => String(x.minute) === m).reduce((a, b) => a + Number(b.n), 0);
    line(`${m.slice(0, 19)}  ${cells.join("")}   ${String(tot).padStart(8)}   ${(tot / 60).toFixed(1).padStart(9)}`);
  }
  line();
  line("cell = messages(distinct stages sending on that phone that minute); phone cfg = 60/s = 3600/min");

  // ── 16. Peak org-wide minute ever ─────────────────────────────────────────
  hr("16. TOP 10 ORG-WIDE MINUTES (14d) — system-level ceiling");
  const topMin = await q<Record<string, unknown>>(sql`
    SELECT date_trunc('minute', ss.sent_at)::text AS minute, count(*)::int AS n,
           count(DISTINCT COALESCE(ss.provider_phone_id, cs.provider_phone_id))::int AS phones,
           count(DISTINCT ss.stage_id)::int AS stages
    FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.status='sent' AND ss.sent_at > now() - interval '14 days'
    GROUP BY 1 ORDER BY n DESC LIMIT 10`);
  line("minute                    msgs   mps   phones  stages");
  for (const r of topMin) {
    line(
      `${String(r.minute).slice(0, 19).padEnd(21)} ${String(r.n).padStart(6)}  ${(Number(r.n) / 60).toFixed(1).padStart(5)}  ` +
        `${String(r.phones).padStart(6)}  ${String(r.stages).padStart(6)}`,
    );
  }

  // ── 17. Overlapping-drain detection ───────────────────────────────────────
  // One serial drain emits ~1 slice per 2.48s ⇒ ≤ ~26 slices/minute for one
  // stage. A stage-minute with materially more slices means TWO cron
  // invocations were draining the SAME stage concurrently (safe: the claim is
  // FOR UPDATE SKIP LOCKED) — i.e. accidental concurrency.
  hr("17. OVERLAPPING DRAINS — slices per stage-minute (>26 ⇒ 2+ concurrent drain loops)");
  for (const sid of [1537, 1525, 1532, 1421, 1328]) {
    const g = await q<Record<string, unknown>>(sql`
      WITH ts AS (SELECT sent_at, count(*)::int AS n FROM stage_sends
                  WHERE stage_id=${sid} AND status='sent' GROUP BY 1),
      gg AS (SELECT n, EXTRACT(EPOCH FROM (sent_at - lag(sent_at) OVER (ORDER BY sent_at)))::numeric AS gap FROM ts)
      SELECT count(*)::int AS n, avg(n)::numeric(6,1) AS avg_slice,
             percentile_disc(0.10) WITHIN GROUP (ORDER BY gap)::numeric(8,3) AS p10,
             percentile_disc(0.25) WITHIN GROUP (ORDER BY gap)::numeric(8,3) AS p25,
             percentile_disc(0.50) WITHIN GROUP (ORDER BY gap)::numeric(8,3) AS p50,
             percentile_disc(0.75) WITHIN GROUP (ORDER BY gap)::numeric(8,3) AS p75,
             percentile_disc(0.90) WITHIN GROUP (ORDER BY gap)::numeric(8,3) AS p90
      FROM gg WHERE gap IS NOT NULL`);
    line(`stage ${sid} slice-gap deciles: ${JSON.stringify(g[0])}`);
  }
  const ov = await q<Record<string, unknown>>(sql`
    WITH s AS (SELECT stage_id, date_trunc('minute',sent_at) AS m,
                      count(DISTINCT sent_at)::int AS slices, count(*)::int AS n
               FROM stage_sends WHERE status='sent' AND sent_at > now()-interval '14 days'
               GROUP BY 1,2)
    SELECT CASE WHEN slices<=26 THEN 'a single drain loop (<=26 slices/min)'
                WHEN slices<=52 THEN 'b two concurrent (27-52)'
                ELSE 'c three+ concurrent (>52)' END AS bucket,
           count(*)::int AS stage_minutes, sum(n)::int AS msgs,
           max(slices)::int AS max_slices
    FROM s WHERE n > 300 GROUP BY 1 ORDER BY 1`);
  line();
  line("stage-minutes bucketed by slices/min (only minutes with >300 msgs):");
  for (const r of ov)
    line(`  ${String(r.bucket).padEnd(40)} ${String(r.stage_minutes).padStart(6)} stage-minutes  ${String(r.msgs).padStart(8)} msgs  max_slices=${r.max_slices}`);

  const pend = await q<Record<string, unknown>>(sql`
    SELECT count(*)::int AS rows, count(DISTINCT stage_id)::int AS stages
    FROM stage_sends WHERE status='pending'`);
  line();
  line(`current pending backlog: ${JSON.stringify(pend[0])}`);

  // ── 18. Per-statement cost of the drain's per-batch preamble ──────────────
  // The drain runs these SEQUENTIALLY before every 50-row batch. Timed here
  // from this machine, so the absolute numbers include local RTT — the point is
  // the RELATIVE cost vs a trivial round-trip (baseline row below).
  hr("18. PER-BATCH PREAMBLE — server-side cost of each statement the drain issues per 50 rows");
  const orgRow = await q<{ org_id: string }>(sql`
    SELECT org_id FROM stage_sends WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1`);
  const orgId = orgRow[0]?.org_id;
  // Server-side execution time via EXPLAIN ANALYZE (excludes this machine's RTT,
  // which is ~550ms from a laptop and would swamp the signal). Also reports the
  // measured wall time so the RTT share is visible.
  const timed = async (label: string, query: ReturnType<typeof sql>) => {
    let exec = NaN;
    let plan = "";
    try {
      const rows = (await d.execute(
        sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
      )) as unknown as Record<string, unknown>[];
      const j = (rows[0] as Record<string, unknown>)["QUERY PLAN"];
      const arr = typeof j === "string" ? JSON.parse(j) : j;
      exec = Number(arr?.[0]?.["Execution Time"] ?? NaN);
      plan = String(arr?.[0]?.Plan?.["Node Type"] ?? "");
    } catch {
      /* EXPLAIN unsupported for this shape */
    }
    const t0 = process.hrtime.bigint();
    await d.execute(query);
    const t1 = process.hrtime.bigint();
    line(
      `${label.padEnd(46)} server ${(Number.isFinite(exec) ? exec.toFixed(2) : "  n/a").padStart(8)} ms   ` +
        `wall ${(Number(t1 - t0) / 1e6).toFixed(0).padStart(5)} ms   ${plan}`,
    );
  };
  await timed("baseline  SELECT 1 (pure round-trip)", sql`SELECT 1`);
  await timed(
    "getOrgSendsEnabled / Paused (org_settings)",
    sql`SELECT sends_enabled, sends_paused FROM org_settings WHERE org_id = ${orgId} LIMIT 1`,
  );
  await timed("isProviderPaused", sql`SELECT send_paused FROM sms_providers WHERE id = 499 LIMIT 1`);
  await timed("isCampaignPaused", sql`SELECT send_paused FROM campaigns WHERE id = ${Number(biggest.campaign_id)} LIMIT 1`);
  await timed(
    "countSentSince(60s)  [per-provider join]",
    sql`SELECT count(*)::int AS n FROM stage_sends ss JOIN campaign_stages s ON s.id = ss.stage_id
        WHERE ss.org_id = ${orgId} AND s.sms_provider_id = 499 AND ss.sent_at IS NOT NULL
          AND ss.sent_at > now() - make_interval(secs => 60)`,
  );
  await timed(
    "countSentSince(86400s) [24h rolling ceiling]",
    sql`SELECT count(*)::int AS n FROM stage_sends ss JOIN campaign_stages s ON s.id = ss.stage_id
        WHERE ss.org_id = ${orgId} AND s.sms_provider_id = 499 AND ss.sent_at IS NOT NULL
          AND ss.sent_at > now() - make_interval(secs => 86400)`,
  );
  await timed(
    "dedup: phones sent within 1h (50 phones)",
    sql`SELECT DISTINCT phone FROM stage_sends
        WHERE org_id = ${orgId} AND status = 'sent'
          AND sent_at >= now() - interval '1 hour'
          AND phone IN (SELECT phone FROM stage_sends WHERE stage_id = ${bigStage} LIMIT 50)`,
  );
  await timed(
    "opt-out recheck (50 contact ids)",
    sql`SELECT DISTINCT contact_id FROM opt_outs
        WHERE org_id = ${orgId}
          AND contact_id IN (SELECT contact_id FROM stage_sends WHERE stage_id = ${bigStage} LIMIT 50)`,
  );
  line();
  line("NOTE: the drain issues ALL of the above (plus the claim UPDATE, the sent");
  line("UPDATE and the send_attempts INSERT) SEQUENTIALLY, once per 50 messages.");

  // ── 19. Full invocation timeline: what is the drain doing every 5 seconds? ─
  hr("19. INVOCATION TIMELINE — every stage's sends per 5s bucket, 2026-07-25 14:00–14:15 UTC");
  const tl = await q<Record<string, unknown>>(sql`
    SELECT to_char(date_trunc('minute', ss.sent_at)
             + (floor(EXTRACT(SECOND FROM ss.sent_at)/5)*interval '5 second'), 'HH24:MI:SS') AS t5,
           ss.stage_id,
           COALESCE(ss.provider_phone_id, cs.provider_phone_id) AS phone_id,
           count(*)::int AS n
    FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.status='sent'
      AND ss.sent_at >= '2026-07-25 14:00:00+00'::timestamptz
      AND ss.sent_at <  '2026-07-25 14:15:00+00'::timestamptz
    GROUP BY 1,2,3 ORDER BY 1,2`);
  const stageIds = [...new Set(tl.map((r) => String(r.stage_id)))];
  const phoneOf = new Map<string, string>();
  for (const r of tl) phoneOf.set(String(r.stage_id), String(r.phone_id));
  line(`stages: ${stageIds.map((s) => `${s}(ph${phoneOf.get(s)})`).join("  ")}`);
  line();
  line(`t5        ${stageIds.map((s) => s.padStart(8)).join("")}     total`);
  const buckets = [...new Set(tl.map((r) => String(r.t5)))].sort();
  for (const b of buckets) {
    const cells = stageIds.map((s) => {
      const r = tl.find((x) => String(x.t5) === b && String(x.stage_id) === s);
      return String(r?.n ?? "·").padStart(8);
    });
    const tot = tl.filter((x) => String(x.t5) === b).reduce((a, x) => a + Number(x.n), 0);
    line(`${b}  ${cells.join("")}  ${String(tot).padStart(8)}`);
  }

  // ── 20. Cross-phone parallelism at 5s granularity (sec-granularity in §7
  //        UNDERSTATES it: each phone emits ~1 slice per 2.5s, so two phones
  //        rarely land in the SAME clock second even when both are draining).
  hr("20. CROSS-PHONE PARALLELISM at 5-second granularity (14d)");
  const par5 = await q<Record<string, unknown>>(sql`
    WITH b AS (
      SELECT date_trunc('minute', ss.sent_at) + (floor(EXTRACT(SECOND FROM ss.sent_at)/5)*interval '5 second') AS t5,
             COALESCE(ss.provider_phone_id, cs.provider_phone_id) AS phone_id,
             count(*)::int AS n
      FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.status='sent' AND ss.sent_at > now() - interval '14 days'
      GROUP BY 1,2
    ), agg AS (
      SELECT t5, count(*)::int AS phones, sum(n)::int AS total FROM b GROUP BY 1
    )
    SELECT phones, count(*)::int AS buckets_5s,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY total)::int AS p50_per_5s,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY total)::int AS p95_per_5s,
           max(total)::int AS max_per_5s
    FROM agg GROUP BY 1 ORDER BY 1`);
  line("phones_active  buckets_5s   p50_mps   p95_mps   peak_mps");
  for (const r of par5) {
    line(
      `${String(r.phones).padStart(13)}  ${String(r.buckets_5s).padStart(10)}   ${(Number(r.p50_per_5s) / 5).toFixed(1).padStart(7)}   ` +
        `${(Number(r.p95_per_5s) / 5).toFixed(1).padStart(7)}   ${(Number(r.max_per_5s) / 5).toFixed(1).padStart(8)}`,
    );
  }

  hr("20b. 2026-07-25 14:00–15:00 UTC per-minute totals (2 phones, many stages)");
  const m725 = await q<Record<string, unknown>>(sql`
    SELECT to_char(date_trunc('minute', ss.sent_at),'HH24:MI') AS minute, count(*)::int AS n,
           count(DISTINCT COALESCE(ss.provider_phone_id, cs.provider_phone_id))::int AS phones,
           count(DISTINCT ss.stage_id)::int AS stages
    FROM stage_sends ss JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.status='sent'
      AND ss.sent_at >= '2026-07-25 14:00:00+00'::timestamptz
      AND ss.sent_at <  '2026-07-25 15:00:00+00'::timestamptz
    GROUP BY 1 ORDER BY 1`);
  line("minute   msgs   mps   phones stages");
  for (const r of m725) {
    line(
      `${r.minute}  ${String(r.n).padStart(5)}  ${(Number(r.n) / 60).toFixed(1).padStart(5)}  ${String(r.phones).padStart(6)} ${String(r.stages).padStart(6)}`,
    );
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
