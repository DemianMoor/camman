// Reconciliation of drip_daily_rollup against the LIVE reports it must agree
// with (spec §7; owner gate before the Daily results UI). READ-ONLY.
//
//   npx tsx --conditions=react-server scripts/verify-drip-daily-rollup.ts <from>..<to> [<from>..<to> …]
//
// For each ET-day range, prints its input scope first and fails on an empty one:
//
//  P  Partner report (getPartnerReport, the live function): per non-sandbox
//     partner key, Σ activity cells over every drip campaign must EQUAL the
//     report's Sent, Send cost, Clicks, Opt-outs, Sales and Revenue. Exact
//     (money to the 1/100 cent). Same definitions by construction (owner Q1).
//  O  Overview with drip ON (getStageMetricsInRange, the live function): per drip
//     stage, Σ activity cells (all partners + unattributed) must EQUAL Total
//     Sent, Cost and Opt-outs. Sales/Revenue are REPORTED with the delta, not
//     failed: the Overview dates them by occurred_at through keitaro_stage_results
//     and joins on stage_id; the tab dates by detection via stage_send_id (Q1).
//     Clicks are not compared — different population (Keitaro visits).
//  L  Lead rows: Σ admitted / carried / leads admitted equal hand counts over
//     drip_journeys (+ lead_events.received_at), per campaign.
//  M  Money per campaign (owner Q1/Q3): lookup = admitted × the SAME calibrated
//     rate the partner report used (asserted equal), profit/ROI including it,
//     revenue per admitted lead (cohort basis). Every drip campaign is listed,
//     test campaigns included, with its cell count — the backfill's scope.
//
// The live functions read through the module db handle, so the two sides are
// not one snapshot: run on CLOSED days (ranges ending yesterday or earlier).
import "./_env-preload";

import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { addEtDays } from "@/lib/reporting/delivery-rollup";
import { dailyMoney } from "@/lib/reporting/drip-daily-money";
import { getCalibratedLookupRate } from "@/lib/reporting/lookup-rate";
import { getPartnerReport } from "@/lib/reporting/partner-report";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const money = (n: number) => Math.round(n * 10000);

async function verifyRange(orgId: string, from: string, to: string) {
  console.log(`\n=== ${from}..${to} (org ${orgId.slice(0, 8)})`);
  const t0 = Date.now();

  // ── rollup side ─────────────────────────────────────────────────────────
  const byKey = (await db.execute(sql`
    SELECT r.partner_key_id AS k,
           sum(r.first_sends + r.followup_sends)::int AS sent, sum(r.send_cost)::float8 AS cost,
           sum(r.clicks)::int AS clicks, sum(r.opt_outs)::int AS opt_outs,
           sum(r.sales)::int AS sales, sum(r.revenue)::float8 AS revenue
    FROM drip_daily_rollup r
    JOIN partner_keys k ON k.id = r.partner_key_id AND k.sandbox = false
    WHERE r.org_id = ${orgId}::uuid AND r.basis = 'activity' AND r.stage_id IS NOT NULL
      AND r.day_et BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1`)) as unknown as Record<string, number>[];
  const byStage = (await db.execute(sql`
    SELECT r.stage_id AS s,
           sum(r.first_sends + r.followup_sends)::int AS sent, sum(r.send_cost)::float8 AS cost,
           sum(r.opt_outs)::int AS opt_outs, sum(r.sales)::int AS sales, sum(r.revenue)::float8 AS revenue
    FROM drip_daily_rollup r
    WHERE r.org_id = ${orgId}::uuid AND r.basis = 'activity' AND r.stage_id IS NOT NULL
      AND r.day_et BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1`)) as unknown as Record<string, number>[];
  console.log(`  scope: ${byKey.length} partner key(s), ${byStage.length} drip stage(s) with activity in the rollup`);
  check("scope is not empty", byStage.length > 0);

  // ── P: partner report ───────────────────────────────────────────────────
  const pr = await getPartnerReport(orgId, from, to);
  const live = new Map<number, Record<string, number>>();
  for (const row of pr.rows) {
    const a = live.get(row.partner_key_id) ?? { sent: 0, cost: 0, clicks: 0, opt_outs: 0, sales: 0, revenue: 0 };
    a.sent += row.sent; a.cost += row.send_cost_usd; a.clicks += row.clicks;
    a.opt_outs += row.opt_outs; a.sales += row.sales; a.revenue += row.revenue_usd;
    live.set(row.partner_key_id, a);
  }
  const keys = new Set([...live.keys(), ...byKey.map((r) => Number(r.k))]);
  for (const k of keys) {
    const l = live.get(k) ?? { sent: 0, cost: 0, clicks: 0, opt_outs: 0, sales: 0, revenue: 0 };
    const r = byKey.find((x) => Number(x.k) === k) ?? { sent: 0, cost: 0, clicks: 0, opt_outs: 0, sales: 0, revenue: 0 };
    const cols = ["sent", "clicks", "opt_outs", "sales"] as const;
    const diffs = [
      ...cols.filter((c) => Number(l[c]) !== Number(r[c])).map((c) => `${c} live ${l[c]} rollup ${r[c]}`),
      ...(["cost", "revenue"] as const).filter((c) => money(Number(l[c])) !== money(Number(r[c])))
        .map((c) => `${c} live ${Number(l[c]).toFixed(4)} rollup ${Number(r[c]).toFixed(4)}`),
    ];
    check(`P key ${k}: sent ${l.sent}, cost $${Number(l.cost).toFixed(2)}, clicks ${l.clicks}, opt-outs ${l.opt_outs}, sales ${l.sales}, revenue $${Number(l.revenue).toFixed(2)}`,
      diffs.length === 0, diffs.join("; "));
  }

  // ── O: Overview, drip ON ────────────────────────────────────────────────
  const ov = await getStageMetricsInRange(orgId, from, to);
  const dripStages = new Set(
    ((await db.execute(sql`
      SELECT cs.id FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
      WHERE c.org_id = ${orgId}::uuid AND c.type = 'drip'`)) as unknown as { id: number }[]).map((r) => r.id),
  );
  const ovDrip = ov.stages.filter((s) => dripStages.has(s.stage_id));
  let salesDelta = 0, revDelta = 0, ovSales = 0, ovRev = 0;
  const stageIds = new Set([...ovDrip.map((s) => s.stage_id), ...byStage.map((r) => Number(r.s))]);
  for (const sid of stageIds) {
    const o = ovDrip.find((s) => s.stage_id === sid);
    const r = byStage.find((x) => Number(x.s) === sid) ?? { sent: 0, cost: 0, opt_outs: 0, sales: 0, revenue: 0 };
    const oSent = o?.total_sent ?? 0, oCost = o?.tally.cost ?? 0, oOpt = o?.opt_outs ?? 0;
    // A stage with no activity at all on either side is not a comparison.
    if (oSent === 0 && oCost === 0 && oOpt === 0 && Number(r.sent) === 0 && Number(r.opt_outs) === 0) continue;
    const diffs = [
      Number(r.sent) !== oSent ? `sent overview ${oSent} rollup ${r.sent}` : "",
      money(Number(r.cost)) !== money(oCost) ? `cost overview ${oCost.toFixed(4)} rollup ${Number(r.cost).toFixed(4)}` : "",
      Number(r.opt_outs) !== oOpt ? `opt-outs overview ${oOpt} rollup ${r.opt_outs}` : "",
    ].filter(Boolean);
    check(`O stage ${sid}: sent ${oSent}, cost $${oCost.toFixed(2)}, opt-outs ${oOpt}`, diffs.length === 0, diffs.join("; "));
    ovSales += o?.tally.sales ?? 0; ovRev += o?.tally.revenue ?? 0;
    salesDelta += Number(r.sales) - (o?.tally.sales ?? 0);
    revDelta += Number(r.revenue) - (o?.tally.revenue ?? 0);
  }
  console.log(`  INFO  sales/revenue vs Overview (dating differs by design): overview ${ovSales} / $${ovRev.toFixed(2)}, rollup − overview = ${salesDelta} / $${revDelta.toFixed(2)}`);

  // ── L: lead rows vs hand counts ─────────────────────────────────────────
  const F = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const T = fromZonedTime(`${addEtDays(to, 1)}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
  const leads = (await db.execute(sql`
    WITH dc AS (SELECT id FROM campaigns WHERE org_id = ${orgId}::uuid AND type = 'drip'),
    hand AS (
      SELECT j.campaign_id,
             count(*) FILTER (WHERE j.routed_at >= ${F}::timestamptz AND j.routed_at < ${T}::timestamptz)::int AS admitted,
             count(*) FILTER (WHERE j.routed_at >= ${F}::timestamptz AND j.routed_at < ${T}::timestamptz AND j.carried_days > 0)::int AS carried,
             count(*) FILTER (WHERE le.received_at >= ${F}::timestamptz AND le.received_at < ${T}::timestamptz)::int AS leads_admitted
      FROM drip_journeys j JOIN dc ON dc.id = j.campaign_id
      LEFT JOIN lead_events le ON le.id = j.lead_event_id
      GROUP BY 1),
    rolled AS (
      SELECT campaign_id, sum(admitted)::int AS admitted, sum(admitted_carried)::int AS carried, sum(leads_admitted)::int AS leads_admitted
      FROM drip_daily_rollup
      WHERE org_id = ${orgId}::uuid AND basis = 'activity' AND stage_id IS NULL
        AND day_et BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1)
    SELECT COALESCE(h.campaign_id, r.campaign_id) AS campaign_id,
           COALESCE(h.admitted, 0) AS h_adm, COALESCE(r.admitted, 0) AS r_adm,
           COALESCE(h.carried, 0) AS h_car, COALESCE(r.carried, 0) AS r_car,
           COALESCE(h.leads_admitted, 0) AS h_la, COALESCE(r.leads_admitted, 0) AS r_la
    FROM hand h FULL JOIN rolled r ON r.campaign_id = h.campaign_id
    WHERE COALESCE(h.admitted, 0) + COALESCE(h.leads_admitted, 0) + COALESCE(r.admitted, 0) + COALESCE(r.leads_admitted, 0) > 0
    ORDER BY 1`)) as unknown as Record<string, number>[];
  for (const l of leads) {
    check(`L campaign ${l.campaign_id}: admitted ${l.h_adm} (carried ${l.h_car}), leads admitted ${l.h_la}`,
      l.h_adm === l.r_adm && l.h_car === l.r_car && l.h_la === l.r_la,
      `rollup ${l.r_adm} (${l.r_car}) / ${l.r_la}`);
  }
  // ── M: money per campaign, every drip campaign listed ───────────────────
  const rate = await getCalibratedLookupRate();
  check(`M lookup rate is the partner report's: $${rate.rate.toFixed(6)} (${rate.source})`, rate.rate === pr.rate.rate);
  const camps = (await db.execute(sql`
    SELECT c.id, c.name, c.status,
           (SELECT count(*)::int FROM drip_daily_rollup r WHERE r.campaign_id = c.id) AS cells_all_time,
           COALESCE(sum(r.admitted)  FILTER (WHERE r.basis = 'activity'), 0)::int    AS a_admitted,
           COALESCE(sum(r.send_cost) FILTER (WHERE r.basis = 'activity'), 0)::float8 AS a_cost,
           COALESCE(sum(r.revenue)   FILTER (WHERE r.basis = 'activity'), 0)::float8 AS a_rev,
           COALESCE(sum(r.admitted)  FILTER (WHERE r.basis = 'cohort'), 0)::int      AS c_admitted,
           COALESCE(sum(r.send_cost) FILTER (WHERE r.basis = 'cohort'), 0)::float8   AS c_cost,
           COALESCE(sum(r.revenue)   FILTER (WHERE r.basis = 'cohort'), 0)::float8   AS c_rev
    FROM campaigns c
    LEFT JOIN drip_daily_rollup r ON r.campaign_id = c.id AND r.day_et BETWEEN ${from}::date AND ${to}::date
    WHERE c.org_id = ${orgId}::uuid AND c.type = 'drip'
    GROUP BY c.id, c.name, c.status ORDER BY c.id`)) as unknown as Record<string, string | number>[];
  const usd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);
  const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
  for (const c of camps) {
    const a = dailyMoney({ revenue: Number(c.a_rev), send_cost: Number(c.a_cost), admitted: Number(c.a_admitted) }, rate.rate);
    const k = dailyMoney({ revenue: Number(c.c_rev), send_cost: Number(c.c_cost), admitted: Number(c.c_admitted) }, rate.rate);
    console.log(`  INFO  campaign ${c.id} "${c.name}" [${c.status}] — ${c.cells_all_time} cells all-time | ` +
      `activity: admitted ${c.a_admitted}, send ${usd(a.send_cost_usd)}, lookup ${usd(a.lookup_cost_usd)}, revenue ${usd(a.revenue_usd)}, profit ${usd(a.profit_usd)}, ROI ${pct(a.roi)} | ` +
      `cohort: rev/admitted ${usd(k.revenue_per_admitted_usd)}, profit ${usd(k.profit_usd)}, ROI ${pct(k.roi)}`);
  }
  console.log(`  (${Date.now() - t0} ms)`);
}

async function main() {
  const ranges = process.argv.slice(2).map((a) => a.split(".."));
  if (ranges.length === 0 || ranges.some((r) => r.length !== 2)) {
    throw new Error("usage: <from>..<to> [<from>..<to> …]  (ET days, closed)");
  }
  const orgs = (await db.execute(sql`SELECT DISTINCT org_id FROM campaigns WHERE type = 'drip'`)) as unknown as { org_id: string }[];
  console.log(`READ-ONLY reconciliation — ${new URL(process.env.DATABASE_URL!).hostname}, ${orgs.length} org(s) with drip campaigns`);
  for (const { org_id } of orgs) for (const [from, to] of ranges) await verifyRange(org_id, from, to);
  console.log(failures === 0 ? "\nALL RECONCILED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
