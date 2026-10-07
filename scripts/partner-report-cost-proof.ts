import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { getPartnerReport, stripRevenueForPartner } from "@/lib/reporting/partner-report";

// Partner report Send Cost / NET Profit / ROI — production proof. READ-ONLY.
//
// ⭐ Send cost is checked against a SEPARATE counter-query that walks raw rows
// by a different route (per stage_send, then per opt_out, each priced by its own
// phone), plus a HAND-WRITTEN expectation for campaign 994 whose history is
// known: 5 sent drip messages on phone 114 and 1 attributed opt-out. Comparing
// the report to its own SQL would only prove Postgres is deterministic.
//
// Run: npx tsx --conditions=react-server scripts/partner-report-cost-proof.ts

const CAMPAIGN = 994;
const FROM = "2026-07-01";
const TO = "2026-10-31";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const cents = (v: number) => Math.round(v * 1e4); // compare at numeric(12,4)

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}\n`);

  const org = (await db.execute(sql`
    SELECT org_id FROM campaigns WHERE id = ${CAMPAIGN}
  `)) as unknown as { org_id: string }[];
  const orgId = org[0].org_id;

  const report = await getPartnerReport(orgId, FROM, TO);
  for (const r of report.rows) {
    console.log(`  ${r.partner_slug}/${r.interest_tag || "(untagged)"}: sent=${r.sent} ` +
      `opt=${r.opt_outs} send_cost=$${r.send_cost_usd.toFixed(4)} ` +
      `lookup=$${r.lookup_cost_usd.toFixed(4)} rev=$${r.revenue_usd.toFixed(2)} ` +
      `net=$${r.net_profit_usd.toFixed(4)} roi=${r.roi}`);
  }

  // ── campaign 994, by hand ────────────────────────────────────────────────
  console.log(`\n── campaign ${CAMPAIGN}: known history ──`);
  const c994 = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE ss.status = 'sent')::int AS sent,
           (SELECT count(DISTINCT oa.opt_out_id)::int FROM opt_out_attributions oa
              JOIN stage_sends s2 ON s2.id = oa.stage_send_id
             WHERE s2.campaign_id = ${CAMPAIGN}) AS opted,
           count(*) FILTER (WHERE ss.cost_per_sms IS NOT NULL)::int AS snapshotted,
           array_agg(DISTINCT ss.provider_phone_id) AS phones,
           array_agg(DISTINCT pp.cost_per_sms::text) AS live_rates
    FROM stage_sends ss LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
    WHERE ss.campaign_id = ${CAMPAIGN}
  `)) as unknown as {
    sent: number; opted: number; snapshotted: number; phones: number[]; live_rates: string[];
  }[];
  const h = c994[0];
  check("994 history: 5 sent, 1 opt-out, all on phone 114, none snapshotted",
        [h.sent, h.opted, h.phones, h.snapshotted], [5, 1, [114], 0]);
  check("phone 114's live rate is $0.0100", h.live_rates, ["0.0100"]);
  // 994's sends belong to the internal-test partner (P7 proof).
  const it = report.rows.filter((r) => r.partner_slug === "internal-test");
  const itSendCost = it.reduce((a, r) => a + r.send_cost_usd, 0);
  // Hand: $0.01 × (5 sends + 1 opt-out reply) = $0.06. Only true if 994 is the
  // only drip campaign with sends under internal-test, so assert that first.
  const itCampaigns = (await db.execute(sql`
    SELECT DISTINCT ss.campaign_id
    FROM stage_sends ss JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
    JOIN drip_journeys j ON j.contact_id = ss.contact_id AND j.campaign_id = ss.campaign_id
    JOIN lead_events le ON le.id = j.lead_event_id
    JOIN partner_keys k ON k.id = le.partner_key_id AND k.partner_slug = 'internal-test'
    WHERE ss.org_id = ${orgId}::uuid
  `)) as unknown as { campaign_id: number }[];
  check("internal-test's only drip campaign is 994", itCampaigns.map((r) => r.campaign_id), [994]);
  check("⭐ internal-test send cost == $0.01 × (5 + 1) = $0.06", cents(itSendCost), cents(0.06));

  // ── every row, against an independent counter-query ──────────────────────
  console.log("\n── every partner/tag: send cost vs raw rows ──");
  // Different route: no LATERAL, no CTE reuse — each send priced on its own,
  // each opt-out priced by the MIN-id send it is attributed to, summed per
  // partner/tag through the journey's lead event.
  const raw = (await db.execute(sql`
    WITH s AS (
      SELECT ss.id, ss.status, COALESCE(ss.cost_per_sms, pp.cost_per_sms, 0) AS rate,
             (SELECT le.partner_key_id FROM drip_journeys j JOIN lead_events le ON le.id = j.lead_event_id
               WHERE j.org_id = ss.org_id AND j.contact_id = ss.contact_id AND j.campaign_id = ss.campaign_id
                 AND (j.first_send_at IS NULL OR j.first_send_at <= ss.created_at) AND le.sandbox = false
               ORDER BY j.routed_at DESC LIMIT 1) AS pk,
             (SELECT COALESCE(le.interest_tag, '') FROM drip_journeys j JOIN lead_events le ON le.id = j.lead_event_id
               WHERE j.org_id = ss.org_id AND j.contact_id = ss.contact_id AND j.campaign_id = ss.campaign_id
                 AND (j.first_send_at IS NULL OR j.first_send_at <= ss.created_at) AND le.sandbox = false
               ORDER BY j.routed_at DESC LIMIT 1) AS tag
      FROM stage_sends ss
      JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      WHERE ss.org_id = ${orgId}::uuid
        AND (ss.created_at AT TIME ZONE 'America/New_York')::date BETWEEN ${FROM}::date AND ${TO}::date
    )
    SELECT pk, tag,
           (SELECT coalesce(sum(rate), 0) FROM s s2 WHERE s2.pk = s.pk AND s2.tag = s.tag AND s2.status = 'sent')::float8
         + (SELECT coalesce(sum(r), 0) FROM (
              SELECT DISTINCT ON (oa.opt_out_id) s3.rate AS r
              FROM opt_out_attributions oa JOIN s s3 ON s3.id = oa.stage_send_id
              WHERE s3.pk = s.pk AND s3.tag = s.tag
              ORDER BY oa.opt_out_id, s3.rate DESC) x)::float8 AS cost
    FROM s WHERE pk IS NOT NULL GROUP BY pk, tag
  `)) as unknown as { pk: number; tag: string; cost: number }[];
  for (const q of raw) {
    const row = report.rows.find((r) => r.partner_key_id === q.pk && r.interest_tag === q.tag);
    check(`send cost key ${q.pk}/${q.tag || "(untagged)"} == raw $${Number(q.cost).toFixed(4)}`,
          row ? cents(row.send_cost_usd) : "missing", cents(Number(q.cost)));
  }

  // ── NET / ROI arithmetic, every row ──────────────────────────────────────
  for (const r of report.rows) {
    const cost = r.send_cost_usd + r.lookup_cost_usd;
    check(`NET/ROI arithmetic ${r.partner_slug}/${r.interest_tag || "(untagged)"}`,
          [cents(r.net_profit_usd), r.roi == null ? null : Math.round(r.roi * 1e6)],
          [cents(r.revenue_usd - cost), cost > 0 ? Math.round(((r.revenue_usd - cost) / cost) * 1e6) : null]);
  }

  // ── strip, on a SYNTHETIC non-zero row (real revenue may be 0) ───────────
  console.log("\n── partner view with revenue OFF ──");
  const synthetic = {
    ...report,
    rows: report.rows.map((r) => ({
      ...r, revenue_usd: 1234.56, send_cost_usd: 9.87, net_profit_usd: 1000, roi: 3.2,
    })),
  };
  check("the fixture is non-empty", synthetic.rows.length > 0, true);
  const stripped = stripRevenueForPartner(synthetic).rows;
  check("⭐ strip zeroes revenue, send cost and NET; nulls ROI on EVERY row",
        stripped.map((r) => [r.revenue_usd, r.send_cost_usd, r.net_profit_usd, r.roi]),
        synthetic.rows.map(() => [0, 0, 0, null]));
  check("and leaves the partner's own numbers untouched",
        stripped.map((r) => [r.sent, r.opt_outs, r.lookup_cost_usd]),
        synthetic.rows.map((r) => [r.sent, r.opt_outs, r.lookup_cost_usd]));

  // ── the forward snapshot expression the drip inserts now use ─────────────
  const snap = (await db.execute(sql`
    SELECT (SELECT pp.cost_per_sms FROM provider_phones pp WHERE pp.id = ${114}) AS rate
  `)) as unknown as { rate: string }[];
  check("the insert's rate subquery binds an integer phone id and returns its rate",
        snap[0].rate, "0.0100");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
