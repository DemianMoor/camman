import "./_env-preload";

// READ-ONLY verification of the carrier-rejection ledger (migration 0225)
// against an INDEPENDENT computation from the raw receipt tables.
//
// ⚠️ Independence is the point. The reference SQL below is hand-written: it does
// not import lib/carrier-rejection/* and retypes the code lists, so a defect in
// the ledger's classification or folding cannot also be in the reference.
//
// Default thresholds (2 hard all-time, 3 soft in 30 days) unless an org has its
// own settings row. Prints the reference count, the ledger count and the
// symmetric difference per org. Before 0225 is applied it prints the reference
// only. Runs in a READ ONLY transaction (scripts/_readonly-db.ts).
//
// Run: npx tsx scripts/verify-carrier-rejections.ts

import { withReadOnlyDb } from "./_readonly-db";

const TXR_CODE = `coalesce(nullif(error_code, ''), substring(lower(raw_body) from '"error_?code"\\s*:\\s*"?([0-9]+)'))`;

const REFERENCE = `
WITH ev AS (
  SELECT coalesce(matched_stage_send_id, stage_send_id) ss_id, lower(status) = 'delivered' d,
    CASE WHEN lower(status) = 'undelivered' AND ${TXR_CODE} IN ('30005','2001','30006','2003') THEN 'hard'
         WHEN lower(status) = 'undelivered' AND ${TXR_CODE} IN ('30003','1002') THEN 'soft' END cls, 'txr' src
  FROM textrequest_dlr_events WHERE lower(status) IN ('delivered','undelivered') AND received_at < __CUTOFF__
  UNION ALL
  SELECT matched_stage_send_id, lower(status) = 'delivered',
    CASE WHEN lower(status) = 'error' AND lower(trim(error)) IN ('invalid destination address','teleservice not provisioned','mobile operator not found for the destination address') THEN 'hard'
         WHEN lower(status) = 'error' AND lower(trim(error)) IN ('absent subscriber','sm delivery failure') THEN 'soft' END, 'ahi'
  FROM ahoi_dlr_events WHERE lower(status) IN ('delivered','error') AND received_at < __CUTOFF__
  UNION ALL
  SELECT matched_stage_send_id, lower(status) = 'delivered',
    CASE WHEN lower(status) = 'undelivered' AND lower(trim(error_message)) IN ('unknown or invalid destination number.','landline or unreachable carrier detected.') THEN 'hard'
         WHEN lower(status) = 'undelivered' AND lower(trim(error_message)) = 'destination handset is unreachable.' THEN 'soft' END, 'tls'
  FROM tells_webhook_events WHERE kind = 'dlr' AND lower(status) IN ('delivered','undelivered') AND received_at < __CUTOFF__
),
msg AS (
  SELECT ss_id, bool_or(d) d, bool_or(cls = 'hard') h, bool_or(cls = 'soft') s, string_agg(DISTINCT src, ',') src
  FROM ev WHERE ss_id IS NOT NULL GROUP BY ss_id
),
o0 AS (
  SELECT s.org_id, s.phone, s.sent_at, m.src,
         CASE WHEN m.d THEN 'delivered' WHEN m.h THEN 'hard' WHEN m.s THEN 'soft' END outcome
  FROM msg m JOIN stage_sends s ON s.id = m.ss_id WHERE s.status = 'sent' AND s.sent_at IS NOT NULL
),
-- The phone's latest delivered message as a WINDOW, not a self-join: CTE row
-- estimates are tiny, and a join here was planned as a ~1M x ~700K nested loop
-- (cancelled at 600 s on prod, 2026-10-24).
o AS (
  SELECT o0.*, max(sent_at) FILTER (WHERE outcome = 'delivered') OVER (PARTITION BY org_id, phone) ld
  FROM o0
),
cfg AS (
  SELECT g.id org_id, coalesce(s.hard, 2) hard_thr, coalesce(s.soft, 3) soft_thr, coalesce(s.days, 30) soft_days
  FROM organizations g LEFT JOIN (SELECT org_id, NULL::int hard, NULL::int soft, NULL::int days FROM org_settings WHERE false) s ON s.org_id = g.id
)
SELECT o.org_id::text, o.phone, string_agg(DISTINCT o.src, ',') src
FROM o JOIN cfg USING (org_id)
WHERE o.outcome IN ('hard','soft') AND o.sent_at > coalesce(o.ld, '-infinity')
GROUP BY o.org_id, o.phone, cfg.hard_thr, cfg.soft_thr, cfg.soft_days
HAVING count(*) FILTER (WHERE o.outcome = 'hard') >= cfg.hard_thr
    OR count(*) FILTER (WHERE o.outcome = 'soft' AND o.sent_at >= __NOW__ - make_interval(days => cfg.soft_days)) >= cfg.soft_thr`;

async function main() {
  const t0 = Date.now();
  const out = await withReadOnlyDb(async (tx) => {
    // ONE snapshot for every read below, so the ledger and the reference see
    // the same rows even if a cron pass commits mid-run.
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    await tx`SET LOCAL statement_timeout = '600s'`;
    const has = (await tx`SELECT to_regclass('public.carrier_rejected_phones') IS NOT NULL AS ok`)[0].ok as boolean;
    // Compare like with like: the ledger holds receipts received before its
    // watermark and evaluated its soft window at its last refresh. Bound the
    // reference to the same cutoff and the same instant; before 0225, no bound.
    let cutoff = "'infinity'::timestamptz";
    let at = "now()";
    let bound: { watermark: string | null; evaluated_at: string | null } = { watermark: null, evaluated_at: null };
    if (has) {
      const b = (await tx`
        SELECT (SELECT watermark::text FROM cron_locks WHERE job_name = 'carrier-rejections:watermark') AS watermark,
               (SELECT max(evaluated_at)::text FROM carrier_rejected_phones) AS evaluated_at`)[0];
      bound = { watermark: b.watermark ?? null, evaluated_at: b.evaluated_at ?? null };
      // Values are timestamptz text read back from the DB, quoted as literals.
      if (bound.watermark) cutoff = `'${bound.watermark}'::timestamptz`;
      if (bound.evaluated_at) at = `'${bound.evaluated_at}'::timestamptz`;
    }
    let ref = REFERENCE.replaceAll("__CUTOFF__", cutoff).replaceAll("__NOW__", at);
    // When 0225 is applied, read each org's thresholds; before it, the defaults.
    if (has) {
      ref = ref.replace(
        "SELECT org_id, NULL::int hard, NULL::int soft, NULL::int days FROM org_settings WHERE false",
        "SELECT org_id, carrier_rejection_hard_threshold::int hard, carrier_rejection_soft_threshold::int soft, carrier_rejection_soft_window_days::int days FROM org_settings",
      );
    }
    const refRows = await tx.unsafe(ref);
    const ledger = has ? await tx`SELECT org_id::text, phone FROM carrier_rejected_phones` : [];
    return { has, ref: refRows, ledger, bound };
  });

  const key = (r: { org_id: string; phone: string }) => `${r.org_id}|${r.phone}`;
  const refSet = new Set(out.ref.map((r) => key(r as never)));
  const bySrc: Record<string, number> = {};
  for (const r of out.ref) bySrc[r.src as string] = (bySrc[r.src as string] ?? 0) + 1;
  console.log(`Reference (independent, raw receipts): ${refSet.size} numbers  ${JSON.stringify(bySrc)}  [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
  if (!out.has) {
    console.log("carrier_rejected_phones does not exist — 0225 not applied here; reference only.");
    return;
  }
  const ledSet = new Set(out.ledger.map((r) => key(r as never)));
  const onlyRef = [...refSet].filter((k) => !ledSet.has(k));
  const onlyLed = [...ledSet].filter((k) => !refSet.has(k));
  console.log(`Ledger (carrier_rejected_phones):      ${ledSet.size} numbers`);
  console.log(`Bound: receipts before ${out.bound.watermark} · soft window at ${out.bound.evaluated_at} (one REPEATABLE READ snapshot)`);
  console.log(`Only in reference: ${onlyRef.length}  ${onlyRef.slice(0, 10).join(" ")}`);
  console.log(`Only in ledger:    ${onlyLed.length}  ${onlyLed.slice(0, 10).join(" ")}`);
  console.log(onlyRef.length === 0 && onlyLed.length === 0 ? "MATCH" : "DIFF — see above");
  if (onlyRef.length + onlyLed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
