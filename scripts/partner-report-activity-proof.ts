import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { getPartnerReport } from "@/lib/reporting/partner-report";

// Partner report — activity-dated rows, production proof. READ-ONLY.
//
// ⭐ Every column of ONE ET day is recomputed here by a SEPARATE hand-written
// query that walks the raw rows by a different route (the ET-day bounds are
// built in SQL, the lead attribution is a correlated subquery, no CTE is shared
// with the report), and the report must agree on every (partner, tag) in the
// UNION of the hand sets — including a row with 0 intake whose only activity is
// a sale detected on an older lead. Comparing the report to its own SQL would
// only prove Postgres is deterministic.
//
// Run: npx tsx --conditions=react-server scripts/partner-report-activity-proof.ts [YYYY-MM-DD]
// Default day: today in ET.

const CAMPAIGN = 1606; // the live drip campaign; only used to find the org
const DAY =
  process.argv[2] ??
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const cents = (v: number) => Math.round(v * 1e4);
const key = (k: number, t: string) => `${k}/${t}`;

type Hand = {
  leads: number; mobile: number; voip: number; unknown: number; landline: number;
  lookups: number; sent: number; sent_cost: number; clicks: number;
  opt_outs: number; optout_cost: number; sales: number; revenue: number;
};
const zero = (): Hand => ({
  leads: 0, mobile: 0, voip: 0, unknown: 0, landline: 0, lookups: 0, sent: 0,
  sent_cost: 0, clicks: 0, opt_outs: 0, optout_cost: 0, sales: 0, revenue: 0,
});

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}   day (ET): ${DAY}\n`);

  const org = (await db.execute(sql`SELECT org_id FROM campaigns WHERE id = ${CAMPAIGN}`)) as unknown as { org_id: string }[];
  const orgId = org[0].org_id;

  // The ET day as a half-open UTC range, built in SQL (the report builds it in TS).
  const bounds = sql`
    (${DAY}::date)::timestamp AT TIME ZONE 'America/New_York' AS from_ts,
    ((${DAY}::date + 1))::timestamp AT TIME ZONE 'America/New_York' AS to_ts`;
  // The lead a drip send belongs to: the most recent non-sandbox journey that
  // had started by the time the send was created — as a correlated subquery.
  const lead = sql`
    (SELECT le.partner_key_id || '/' || COALESCE(le.interest_tag, '')
       FROM drip_journeys j JOIN lead_events le ON le.id = j.lead_event_id
      WHERE j.org_id = ss.org_id AND j.contact_id = ss.contact_id
        AND j.campaign_id = ss.campaign_id
        AND (j.first_send_at IS NULL OR j.first_send_at <= ss.created_at)
        AND le.sandbox = false
      ORDER BY j.routed_at DESC LIMIT 1)`;
  const rate = sql`COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0)`;

  const hand = new Map<string, Hand>();
  const at = (k: string) => {
    if (!hand.has(k)) hand.set(k, zero());
    return hand.get(k)!;
  };

  // 1. intake — the counters, on day_et
  const intake = (await db.execute(sql`
    SELECT partner_key_id || '/' || interest_tag AS k,
           sum(received)::int AS leads, sum(mobile)::int AS mobile, sum(voip)::int AS voip,
           sum(unknown)::int AS unknown, sum(landline)::int AS landline,
           sum(lookups_spent)::int AS lookups
    FROM lead_intake_daily
    WHERE org_id = ${orgId}::uuid AND day_et = ${DAY}::date
    GROUP BY 1`)) as unknown as Record<string, string | number>[];
  for (const r of intake) {
    Object.assign(at(String(r.k)), {
      leads: Number(r.leads), mobile: Number(r.mobile), voip: Number(r.voip),
      unknown: Number(r.unknown), landline: Number(r.landline), lookups: Number(r.lookups),
    });
  }

  // 2. sends — status 'sent', by the moment it was sent
  const sends = (await db.execute(sql`
    WITH b AS (SELECT ${bounds})
    SELECT k, count(*)::int AS n, sum(rate)::float8 AS cost FROM (
      SELECT ${lead} AS k, ${rate} AS rate
      FROM stage_sends ss CROSS JOIN b
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
        AND ss.sent_at >= b.from_ts AND ss.sent_at < b.to_ts) x
    WHERE k IS NOT NULL GROUP BY 1`)) as unknown as { k: string; n: number; cost: number }[];
  for (const r of sends) Object.assign(at(r.k), { sent: Number(r.n), sent_cost: Number(r.cost) });

  // 3. clicks — clean, by the moment of the click
  const clicks = (await db.execute(sql`
    WITH b AS (SELECT ${bounds})
    SELECT k, count(*)::int AS n FROM (
      SELECT ${lead} AS k
      FROM clicks ck CROSS JOIN b
      JOIN links l ON l.id = ck.link_id
      JOIN stage_sends ss ON ss.link_id = l.id
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      WHERE ck.org_id = ${orgId}::uuid
        AND ck.classification NOT IN ('bot', 'prefetch', 'suspect')
        AND ck.clicked_at >= b.from_ts AND ck.clicked_at < b.to_ts) x
    WHERE k IS NOT NULL GROUP BY 1`)) as unknown as { k: string; n: number }[];
  for (const r of clicks) at(r.k).clicks = Number(r.n);

  // 4. opt-outs — by the moment the STOP arrived, one row per opt-out, priced
  //    at the (max) rate of the sends it is attributed to
  const optouts = (await db.execute(sql`
    WITH b AS (SELECT ${bounds})
    SELECT k, count(*)::int AS n, sum(r)::float8 AS cost FROM (
      SELECT ${lead} AS k, o.id, max(${rate}) AS r
      FROM opt_outs o CROSS JOIN b
      JOIN opt_out_attributions oa ON oa.opt_out_id = o.id
      JOIN stage_sends ss ON ss.id = oa.stage_send_id
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      WHERE o.org_id = ${orgId}::uuid
        AND o.created_at >= b.from_ts AND o.created_at < b.to_ts
      GROUP BY 1, 2) x
    WHERE k IS NOT NULL GROUP BY 1`)) as unknown as { k: string; n: number; cost: number }[];
  for (const r of optouts) Object.assign(at(r.k), { opt_outs: Number(r.n), optout_cost: Number(r.cost) });

  // 5. sales + revenue — by DETECTION (conversion_events.created_at)
  const sales = (await db.execute(sql`
    WITH b AS (SELECT ${bounds})
    SELECT k,
           count(*) FILTER (WHERE is_purchase AND status IN ('pending', 'approved'))::int AS n,
           coalesce(sum(revenue) FILTER (WHERE counts_revenue AND status = 'approved'), 0)::float8 AS rev
    FROM (
      SELECT ${lead} AS k, ce.status, ce.revenue,
             coalesce(et.is_purchase, false) AS is_purchase,
             coalesce(et.counts_revenue, false) AS counts_revenue
      FROM conversion_events ce CROSS JOIN b
      JOIN stage_sends ss ON ss.id = ce.stage_send_id
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      LEFT JOIN event_types et ON et.id = ce.event_type_id
      WHERE ce.org_id = ${orgId}::uuid
        AND ce.created_at >= b.from_ts AND ce.created_at < b.to_ts) x
    WHERE k IS NOT NULL GROUP BY 1`)) as unknown as { k: string; n: number; rev: number }[];
  for (const r of sales) Object.assign(at(r.k), { sales: Number(r.n), revenue: Number(r.rev) });

  // Drop hand keys that have no activity at all (a sales query row with only
  // rejected conversions, say) — the report must not show those either.
  const active = new Map([...hand].filter(([, h]) => Object.values(h).some((v) => v !== 0)));

  console.log("── hand-computed activity for the day ──");
  for (const [k, h] of active) console.log(`  ${k}: ${JSON.stringify(h)}`);

  // ── the report ────────────────────────────────────────────────────────────
  const report = await getPartnerReport(orgId, DAY, DAY);
  console.log(`\n── getPartnerReport(${DAY}, ${DAY}) ──`);
  for (const r of report.rows) {
    console.log(`  ${r.partner_slug}/${r.interest_tag || "(untagged)"}: leads=${r.leads_received} ` +
      `sent=${r.sent} clicks=${r.clicks} opt=${r.opt_outs} sales=${r.sales} ` +
      `rev=$${r.revenue_usd.toFixed(2)} send_cost=$${r.send_cost_usd.toFixed(4)} ` +
      `lookup=$${r.lookup_cost_usd.toFixed(4)} net=$${r.net_profit_usd.toFixed(4)} roi=${r.roi}`);
  }
  console.log("");

  const reportKeys = report.rows.map((r) => key(r.partner_key_id, r.interest_tag)).sort();
  check("⭐ the report has a row for EXACTLY the (partner, tag) pairs with any activity",
        reportKeys, [...active.keys()].sort());

  for (const [k, h] of active) {
    const r = report.rows.find((x) => key(x.partner_key_id, x.interest_tag) === k);
    if (!r) continue; // already reported above
    check(`${k} intake columns`, [r.leads_received, r.mobile, r.voip, r.unknown, r.landline, r.lookups_spent],
          [h.leads, h.mobile, h.voip, h.unknown, h.landline, h.lookups]);
    check(`${k} sent / clicks / opt-outs / sales`, [r.sent, r.clicks, r.opt_outs, r.sales],
          [h.sent, h.clicks, h.opt_outs, h.sales]);
    check(`${k} revenue`, cents(r.revenue_usd), cents(h.revenue));
    check(`${k} send cost = sends + opt-out replies at their rates`,
          cents(r.send_cost_usd), cents(h.sent_cost + h.optout_cost));
    check(`${k} lookup cost = lookups × rate`,
          Math.round(r.lookup_cost_usd * 1e6), Math.round(h.lookups * report.rate.rate * 1e6));
    const cost = r.send_cost_usd + r.lookup_cost_usd;
    check(`${k} NET / ROI arithmetic`,
          [cents(r.net_profit_usd), r.roi == null ? null : Math.round(r.roi * 1e6)],
          [cents(r.revenue_usd - cost), cost > 0 ? Math.round(((r.revenue_usd - cost) / cost) * 1e6) : null]);
    check(`${k} CTR is clicks/sent or null`, r.ctr, r.sent > 0 ? r.clicks / r.sent : null);
  }

  // The report must not pad: a row with nothing in it is not "activity".
  check("no all-zero row in the report",
        report.rows.filter((r) =>
          r.leads_received + r.rejected + r.duplicate + r.sent + r.clicks + r.opt_outs + r.sales === 0
          && r.revenue_usd === 0).map((r) => key(r.partner_key_id, r.interest_tag)),
        []);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
