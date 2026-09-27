import "./_env-preload";

// CAMPAIGN 1460 / STAGE 4791 — the watched first lifecycle send. READ-ONLY.
//
// Every number is a SELECT; nothing is written, nothing is created, nothing is
// modified. Run it at each reading point (19h, 24h, 72h) and compare.
//
// ⚠️ ANCHORED ON THE STAGE'S OWN sent_at, NOT ON AN ET CALENDAR DAY. A window
// expressed as `<date> AT TIME ZONE 'America/New_York'` lands 8 hours early —
// Postgres casts the date to timestamptz in the session zone FIRST, then
// converts TO ET and hands back a naive timestamp that compares as UTC. Nothing
// here goes near a calendar day, so that cannot reach these figures.
//
// The two click numbers are DIFFERENT SOURCES and are expected to disagree:
// raw HUMAN_CLICK is what the engagement job evaluates, counted_clickers is a
// cron-maintained cache that lags scoring and separately RESCUES conversion-
// bearing recipients who never scored human. Reporting one without the other
// hides which of the two is moving.
//
// Run: npx tsx --conditions=react-server scripts/read-1460-metrics.ts

const STAGE_ID = 4791;
const CAMPAIGN_ID = 1460;

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { HUMAN_CLICK } = await import("@/lib/reporting/counted-clickers");

  const one = async <T>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];

  const stage = await one<{
    id: number;
    campaign_id: number;
    sent_at: string | null;
    tracking_id: string | null;
    sms_count: number;
    opt_out_count: number;
    click_count: number;
    total_cost: string;
  }>(sql`
    SELECT id, campaign_id, sent_at::text AS sent_at, tracking_id,
           sms_count, opt_out_count, click_count, total_cost::text
    FROM campaign_stages WHERE id = ${STAGE_ID}`);
  if (!stage) throw new Error(`stage ${STAGE_ID} not found`);
  if (stage.campaign_id !== CAMPAIGN_ID) {
    throw new Error(
      `stage ${STAGE_ID} belongs to campaign ${stage.campaign_id}, not ${CAMPAIGN_ID}`,
    );
  }

  const fire = sql`(SELECT sent_at FROM campaign_stages WHERE id = ${STAGE_ID})`;

  const r = await one<Record<string, string>>(sql`
    SELECT
      -- delivery
      (SELECT count(*) FROM stage_sends ss
        WHERE ss.stage_id = ${STAGE_ID} AND ss.status = 'sent')::text AS sent,
      (SELECT count(*) FROM stage_sends ss
        WHERE ss.stage_id = ${STAGE_ID})::text AS rows_total,

      -- raw clicks on this stage's links, any classification
      (SELECT count(*) FROM clicks ck
        JOIN links lk ON lk.id = ck.link_id
        WHERE lk.stage_id = ${STAGE_ID})::text AS raw_clicks,
      (SELECT count(*) FROM clicks ck
        JOIN links lk ON lk.id = ck.link_id
        WHERE lk.stage_id = ${STAGE_ID} AND ck.scored_at IS NULL)::text AS unscored_clicks,

      -- human clickers since the fire, at the (stage, contact) grain
      (SELECT count(DISTINCT lk.contact_id) FROM clicks ck
        JOIN links lk ON lk.id = ck.link_id
        WHERE lk.stage_id = ${STAGE_ID} AND ${HUMAN_CLICK}
          AND ck.clicked_at >= ${fire})::text AS human_clickers,
      (SELECT count(DISTINCT lk.contact_id) FROM clicks ck
        JOIN links lk ON lk.id = ck.link_id
        WHERE lk.stage_id = ${STAGE_ID} AND ${HUMAN_CLICK})::text AS human_clickers_any_time,

      -- the cached denominator Overview uses
      (SELECT count(*) FROM counted_clickers cc
        WHERE cc.stage_id = ${STAGE_ID})::text AS counted_clickers,
      (SELECT count(*) FROM counted_clickers cc
        WHERE cc.stage_id = ${STAGE_ID} AND cc.rescued_by_conversion)::text AS counted_rescued,

      -- conversions: the ledger, per recipient
      (SELECT count(*) FROM conversion_events ce
        WHERE ce.stage_send_id IN (
          SELECT id FROM stage_sends WHERE stage_id = ${STAGE_ID}))::text AS ledger_events,
      (SELECT count(DISTINCT ce.stage_send_id) FROM conversion_events ce
        WHERE ce.stage_send_id IN (
          SELECT id FROM stage_sends WHERE stage_id = ${STAGE_ID}))::text AS ledger_recipients,
      (SELECT coalesce(sum(ce.revenue), 0) FROM conversion_events ce
        JOIN event_types et ON et.id = ce.event_type_id
        WHERE ce.stage_send_id IN (
            SELECT id FROM stage_sends WHERE stage_id = ${STAGE_ID})
          AND et.counts_revenue AND ce.status = 'approved')::text AS approved_revenue,

      -- conversions: the legacy per-send columns, kept for parity
      (SELECT count(*) FROM stage_sends ss
        WHERE ss.stage_id = ${STAGE_ID} AND ss.sale_status IS NOT NULL)::text AS legacy_sale_rows,
      (SELECT coalesce(sum(ss.sale_revenue), 0) FROM stage_sends ss
        WHERE ss.stage_id = ${STAGE_ID} AND ss.sale_status IS NOT NULL)::text AS legacy_sale_revenue,

      -- opt-outs
      (SELECT count(*) FROM opt_out_attributions oa
        WHERE oa.stage_id = ${STAGE_ID})::text AS opt_outs,

      -- the cohorts this campaign selected, from the stamp
      (SELECT count(*) FROM stage_send_lifecycle l
        JOIN stage_sends ss ON ss.id = l.stage_send_id
        WHERE ss.stage_id = ${STAGE_ID})::text AS stamped,
      now()::text AS read_at
  `);

  const n = (k: string) => Number(r[k] ?? 0);
  const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(2) + "%" : "—");
  const sent = n("sent");

  const hoursSince = stage.sent_at
    ? (Date.parse(r.read_at) - Date.parse(stage.sent_at)) / 3_600_000
    : null;

  console.log(`\ncampaign ${CAMPAIGN_ID} · stage ${STAGE_ID} · ${stage.tracking_id ?? "(no tracking id)"}`);
  console.log(`fired   ${stage.sent_at}`);
  console.log(`read    ${r.read_at}` + (hoursSince ? `  (+${hoursSince.toFixed(1)}h)` : ""));

  console.log(`\nDELIVERY`);
  console.log(`  sent                      ${sent.toLocaleString()}`);
  console.log(`  stage_sends rows (all)    ${n("rows_total").toLocaleString()}`);
  console.log(`  status-at-send stamped    ${n("stamped").toLocaleString()}`);

  console.log(`\nCLICKS — two sources, expected to disagree`);
  console.log(`  human clickers (raw)      ${n("human_clickers").toLocaleString()}   CTR ${pct(n("human_clickers"), sent)}`);
  console.log(`  counted_clickers (cache)  ${n("counted_clickers").toLocaleString()}   CTR ${pct(n("counted_clickers"), sent)}`);
  console.log(`    of which rescued        ${n("counted_rescued").toLocaleString()}`);
  console.log(`  gap (raw − cached)        ${(n("human_clickers") - n("counted_clickers")).toLocaleString()}`);
  console.log(`  raw clicks (any class)    ${n("raw_clicks").toLocaleString()}`);
  console.log(`    not yet scored          ${n("unscored_clicks").toLocaleString()}`);

  console.log(`\nCONVERSIONS`);
  console.log(`  ledger events             ${n("ledger_events").toLocaleString()}`);
  console.log(`  ledger recipients         ${n("ledger_recipients").toLocaleString()}`);
  console.log(`  approved revenue          $${Number(r.approved_revenue).toFixed(2)}`);
  console.log(`  legacy sale_status rows   ${n("legacy_sale_rows").toLocaleString()}`);
  console.log(`  legacy sale_revenue       $${Number(r.legacy_sale_revenue).toFixed(2)}`);

  console.log(`\nOPT-OUTS`);
  console.log(`  attributions              ${n("opt_outs").toLocaleString()}   rate ${pct(n("opt_outs"), sent)}`);
  console.log(`  stage opt_out_count       ${stage.opt_out_count.toLocaleString()}`);

  console.log(`\nSTAGE COUNTERS (what the UI reads)`);
  console.log(`  sms_count ${stage.sms_count} · click_count ${stage.click_count} · total_cost $${Number(stage.total_cost).toFixed(2)}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
