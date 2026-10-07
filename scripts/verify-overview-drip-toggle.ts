// Verifies the Overview "Show Drip Campaigns" toggle (getStageMetricsInRange's
// excludeDrip). READ-ONLY. Usage:
//   npx tsx --conditions=react-server scripts/verify-overview-drip-toggle.ts \
//     <dripFrom> <dripTo> <regularFrom> <regularTo>
//
// A — a range WITH drip sends. Every additive OFF total must equal the
//     unfiltered result minus the drip stages' own contributions, with drip
//     identified by an independent SQL read (not by the code under test). The
//     deduplicated clicker totals are not additive, so they are checked against
//     hand-written SQL instead.
// B — a regular-only range. ON and OFF must be identical.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { getStageMetricsInRange, type StageMetricsResult } from "@/lib/reporting/stage-funnel";

const [dripFrom, dripTo, regFrom, regTo] = process.argv.slice(2);
if (!regTo) throw new Error("usage: <dripFrom> <dripTo> <regularFrom> <regularTo>");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function plain(r: StageMetricsResult): string {
  return JSON.stringify(r, (_k, v) =>
    v instanceof Map ? [...v.entries()].sort((x, y) => Number(x[0]) - Number(y[0])) : v,
  );
}

function utcBounds(from: string, to: string) {
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    fromUtc: fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE),
    toUtc: fromZonedTime(`${next}T00:00:00`, CAMPAIGN_TIMEZONE),
  };
}

async function main() {
  const orgs = (await db.execute(sql`SELECT id FROM organizations`)) as unknown as { id: string }[];
  for (const { id: orgId } of orgs) {
    const drip = new Set(
      ((await db.execute(sql`
        SELECT id FROM campaigns WHERE org_id = ${orgId}::uuid AND type = 'drip'
      `)) as unknown as { id: number }[]).map((r) => Number(r.id)),
    );
    console.log(`\norg ${orgId}: ${drip.size} drip campaign(s) [${[...drip].join(", ")}]`);

    // ---- A: range with drip sends ----------------------------------------
    const [onA, offA, defA] = await Promise.all([
      getStageMetricsInRange(orgId, dripFrom, dripTo, { excludeDrip: false }),
      getStageMetricsInRange(orgId, dripFrom, dripTo, { excludeDrip: true }),
      getStageMetricsInRange(orgId, dripFrom, dripTo),
    ]);
    check("A: ON is identical to the call without the option (default unchanged)", plain(onA) === plain(defA));

    const dripStages = onA.stages.filter((s) => drip.has(s.campaign_id));
    const dripSent = dripStages.reduce((n, s) => n + s.total_sent, 0);
    check("A: range actually contains drip sends (test is not vacuous)", dripSent > 0, `drip sent=${dripSent} over ${dripStages.length} stage(s)`);
    check("A: OFF has no drip rows", offA.stages.every((s) => !drip.has(s.campaign_id)));

    const keep = onA.stages.filter((s) => !drip.has(s.campaign_id));
    const byId = (xs: typeof keep) => JSON.stringify([...xs].sort((a, b) => a.stage_id - b.stage_id));
    check("A: OFF rows == ON rows minus drip, each row unchanged", byId(keep) === byId(offA.stages), `${keep.length} rows`);

    const sum = (f: (s: (typeof dripStages)[number]) => number) => dripStages.reduce((n, s) => n + f(s), 0);
    const additive: [string, number, number][] = [
      ["total_sent", onA.grandTotalSent - sum((s) => s.total_sent), offA.grandTotalSent],
      ["opt_outs", onA.grandOptOuts - sum((s) => s.opt_outs), offA.grandOptOuts],
      ["clickers (keitaro)", onA.grand.visit_clicks_clean - sum((s) => s.tally.visit_clicks_clean), offA.grand.visit_clicks_clean],
      ["offer_redirect", onA.grand.redirect_clicks_clean - sum((s) => s.tally.redirect_clicks_clean), offA.grand.redirect_clicks_clean],
      ["sales", onA.grand.sales - sum((s) => s.tally.sales), offA.grand.sales],
      ["manual_topup", onA.grand.manual_topup - sum((s) => s.tally.manual_topup), offA.grand.manual_topup],
      ["revenue", onA.grand.revenue - sum((s) => s.tally.revenue), offA.grand.revenue],
      ["pending_revenue", onA.grand.pending_revenue - sum((s) => s.tally.pending_revenue), offA.grand.pending_revenue],
      ["cost", onA.grand.cost - sum((s) => s.tally.cost), offA.grand.cost],
      ["unmapped", onA.grand.unmapped - sum((s) => s.tally.unmapped), offA.grand.unmapped],
    ];
    for (const [k, want, got] of additive) {
      check(`A: OFF total ${k} == ON − drip`, close(want, got), `want=${want} got=${got}`);
    }

    // Deduplicated / lifetime figures against independent SQL.
    const { fromUtc, toUtc } = utcBounds(dripFrom, dripTo);
    const [ind] = (await db.execute(sql`
      SELECT
        count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text)) FILTER (
          WHERE cc.first_click_at >= ${fromUtc.toISOString()}::timestamptz
            AND cc.first_click_at < ${toUtc.toISOString()}::timestamptz)::int AS period_total,
        count(DISTINCT (cc.campaign_id::text || ':' || cc.contact_id::text))::int AS lifetime_total
      FROM counted_clickers cc JOIN campaigns c ON c.id = cc.campaign_id
      WHERE cc.org_id = ${orgId}::uuid AND c.type <> 'drip'
    `)) as unknown as { period_total: number; lifetime_total: number }[];
    const [rev] = (await db.execute(sql`
      SELECT coalesce(sum(k.revenue), 0)::float8 AS r
      FROM keitaro_stage_results k JOIN campaigns c ON c.id = k.campaign_id
      WHERE k.org_id = ${orgId}::uuid AND c.type <> 'drip'
    `)) as unknown as { r: number }[];
    check("A: OFF period counted clickers == independent SQL", offA.clickers.periodTotal === Number(ind.period_total), `sql=${ind.period_total} got=${offA.clickers.periodTotal} (ON=${onA.clickers.periodTotal})`);
    check("A: OFF lifetime counted clickers == independent SQL", offA.clickers.lifetimeTotal === Number(ind.lifetime_total), `sql=${ind.lifetime_total} got=${offA.clickers.lifetimeTotal} (ON=${onA.clickers.lifetimeTotal})`);
    check("A: OFF lifetime revenue == independent SQL", close(offA.clickers.lifetimeRevenueTotal, Number(rev.r)), `sql=${rev.r} got=${offA.clickers.lifetimeRevenueTotal}`);

    // ---- B: regular-only range --------------------------------------------
    const [onB, offB] = await Promise.all([
      getStageMetricsInRange(orgId, regFrom, regTo, { excludeDrip: false }),
      getStageMetricsInRange(orgId, regFrom, regTo, { excludeDrip: true }),
    ]);
    const dripInB = onB.stages.filter((s) => drip.has(s.campaign_id)).length;
    check("B: range has no drip rows (precondition)", dripInB === 0, `drip rows=${dripInB}`);
    // Lifetime figures span all history, which includes drip, so they are
    // compared separately; everything windowed must be byte-identical.
    const windowed = (r: StageMetricsResult) =>
      plain({ ...r, clickers: { ...r.clickers, lifetimeTotal: 0, lifetimeRevenueTotal: 0, lifetimeByCampaign: new Map(), lifetimeByStage: new Map(), lifetimeRevenueByCampaign: new Map(), lifetimeRevenueByStage: new Map() } });
    check("B: ON and OFF identical (rows, totals, period clickers)", windowed(onB) === windowed(offB), `${onB.stages.length} rows, sent=${onB.grandTotalSent}`);
    const rowLifetimeSame = onB.stages.every(
      (s) =>
        onB.clickers.lifetimeByStage.get(s.stage_id) === offB.clickers.lifetimeByStage.get(s.stage_id) &&
        onB.clickers.lifetimeByCampaign.get(s.campaign_id) === offB.clickers.lifetimeByCampaign.get(s.campaign_id) &&
        onB.clickers.lifetimeRevenueByStage.get(s.stage_id) === offB.clickers.lifetimeRevenueByStage.get(s.stage_id),
    );
    check("B: every row's lifetime clickers / revenue identical ON vs OFF", rowLifetimeSame);
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
