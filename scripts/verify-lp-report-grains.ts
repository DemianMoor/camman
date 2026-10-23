import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { derive } from "@/components/reports/report-metrics";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { addEtDays, etDayBounds } from "@/lib/reporting/delivery-rollup";
import { salesPctOfReached } from "@/lib/reporting/landing-page-metrics";
import { getLandingPageReport, type LandingPageReport } from "@/lib/reporting/landing-page-report";
import { dripCostByStageInRange, getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
import { approvedRevenueClause, purchasedClause } from "@/lib/sale-attribution";
import { withReadOnlyDb } from "./_readonly-db";

// =============================================================================
// /reports/landing-pages — GRAIN VERIFICATION (docs/04-features/landing-page-report.md)
//
// Read-only: the independent side runs in ONE `BEGIN READ ONLY` transaction on
// its own session-mode connection (withReadOnlyDb). The report itself runs the
// app's own code path. Every expected value is computed in this run — nothing is
// pinned, because production keeps sending.
//
//   (a) Sends and Cost per offer foot to the Overview (getStageMetricsInRange,
//       conversion_date — the same day rules) for the same window. Sales and
//       Revenue foot, regular part, to the Overview's send-date tally source
//       (keitaro_stage_results + manual top-up, exactly what its send_date basis
//       sums per cohort stage) and, drip part, to a per-send ledger recount.
//   (b) Human clicks are COUNT(DISTINCT contact) at each row's grain, recomputed
//       from counted_clickers; Total is offer-distinct and <= the column sum.
//   (c) null-not-0: every ratio with no denominator is null (renders `—`),
//       including Sales % on a row with no Keitaro-covered stage. A fallback
//       offer is picked so this is exercised, and an unexercised check fails.
//   (12) Upsell adds revenue, never a sale (purchasedClause).
//   (d) Scope is printed first; an empty scope fails.
//
//   npx tsx --conditions=react-server scripts/verify-lp-report-grains.ts
// =============================================================================

let failed = 0;
let passed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const dialect = new PgDialect();

const FIXED_OFFERS = [62, 123, 152];

async function main() {
  await withReadOnlyDb(async (tx) => {
    const q = async (frag: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(frag);
      return (await tx.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];
    };
    const n = (v: unknown) => Number(v ?? 0);

    const [{ org_id: orgId }] = (await q(sql`SELECT org_id FROM offers WHERE id = ${FIXED_OFFERS[0]}`)) as { org_id: string }[];

    // Offers chosen BY DATA, not by id: the offer with the most upsell ledger
    // rows (criterion 12) and the offer with the most manual-mode sent stages
    // (criterion c's fallback cells). If either does not exist, its check fails
    // below rather than passing vacuously.
    const [up] = await q(sql`
      SELECT c.offer_id, count(*)::int AS n FROM conversion_events ce
      JOIN event_types et ON et.id = ce.event_type_id JOIN campaigns c ON c.id = ce.campaign_id
      WHERE ce.org_id = ${orgId}::uuid AND et.key = 'upsell' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
    const [man] = await q(sql`
      SELECT c.offer_id, count(*)::int AS n FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
      WHERE c.org_id = ${orgId}::uuid AND c.link_mode = 'manual' AND cs.sent_at IS NOT NULL AND cs.archived_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
    const upsellOffer = up ? n(up.offer_id) : null;
    const manualOffer = man ? n(man.offer_id) : null;
    const offers = [...new Set([...FIXED_OFFERS, ...(upsellOffer ? [upsellOffer] : []), ...(manualOffer ? [manualOffer] : [])])];

    const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
    const windows: { label: string; from: string | null; to: string | null }[] = [
      { label: "7d", from: addEtDays(todayEt, -6), to: todayEt },
      { label: "30d", from: addEtDays(todayEt, -29), to: todayEt },
      { label: "All Time", from: null, to: null },
    ];

    // --- (d) SCOPE, before any verdict.
    console.log("=== scope ===");
    console.log(`  database user: ${new URL(process.env.DATABASE_URL!).username} · org ${orgId}`);
    console.log(`  offers: ${offers.join(", ")} (fixed ${FIXED_OFFERS.join(", ")}; upsell offer ${upsellOffer ?? "NONE"}; manual offer ${manualOffer ?? "NONE"})`);
    console.log(`  windows: ${windows.map((w) => `${w.label} ${w.from ?? "offer created"}..${w.to ?? todayEt}`).join(" · ")}`);

    const reports: { offer: number; w: string; r: LandingPageReport }[] = [];
    for (const offerId of offers) {
      for (const w of windows) {
        const r = await getLandingPageReport({ orgId, offerId, from: w.from, to: w.to, splitByBrand: false });
        if (!r) { assert(false, `offer ${offerId} not found`); continue; }
        reports.push({ offer: offerId, w: w.label, r });
        console.log(`  offer ${offerId} ${w.label} (${r.range.from}..${r.range.to}): ${r.rows.length} rows, ${r.total.sends} sends, ${r.total.stages.regular} regular / ${r.total.stages.drip} drip / ${r.total.stages.manual} manual stages, ${r.duration_ms} ms`);
      }
    }
    const nonEmpty = reports.filter((x) => x.r.rows.length > 0);
    if (nonEmpty.length === 0) {
      assert(false, "scope is EMPTY — no offer has rows in any window (an empty scope is a failure, not a pass)");
      return;
    }

    // Overview runs org-wide per window; cache by window.
    const overviewCache = new Map<string, Awaited<ReturnType<typeof getStageMetricsInRange>>>();

    for (const { offer: offerId, w, r } of nonEmpty) {
      console.log(`\n=== offer ${offerId} · ${w} (${r.range.from}..${r.range.to}) ===`);
      const { fromUtc, toExclusiveUtc } = etDayBounds({ from: r.range.from, to: r.range.to });
      const sumRows = (f: (x: (typeof r.rows)[number]) => number) => r.rows.reduce((s, x) => s + f(x), 0);

      // ---- (a) Sends + Cost vs Overview
      const ck = `${r.range.from}|${r.range.to}`;
      if (!overviewCache.has(ck)) overviewCache.set(ck, await getStageMetricsInRange(orgId, r.range.from, r.range.to));
      const ov = overviewCache.get(ck)!.stages.filter((s) => s.offer_id === offerId);
      const ovSent = ov.reduce((s, x) => s + x.total_sent, 0);
      const ovCost = ov.reduce((s, x) => s + x.tally.cost, 0);
      assert(r.total.sends === ovSent, `(a) Sends ${r.total.sends} = Overview ${ovSent}`);
      // The Overview's one cost quirk: an ARCHIVED drip stage reaches it through
      // its tracker rows, and dripCostByStageInRange skips archived stages, so it
      // books that stage's LIFETIME total_cost on its first-send day. This report
      // prices it per send like every other drip stage. Swap exactly that part.
      const archivedDrip = (await q(sql`
        SELECT cs.id FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE c.org_id = ${orgId}::uuid AND c.offer_id = ${offerId} AND c.type = 'drip' AND cs.archived_at IS NOT NULL`))
        .map((x) => n(x.id));
      const ovArchived = ov.filter((x) => archivedDrip.includes(x.stage_id)).reduce((s, x) => s + x.tally.cost, 0);
      const perSend = await dripCostByStageInRange(orgId, fromUtc, toExclusiveUtc, { includeArchived: true });
      const archivedPerSend = archivedDrip.reduce((s, id) => s + (perSend.get(id) ?? 0), 0);
      const expectedCost = ovCost - ovArchived + archivedPerSend;
      if (archivedDrip.length) {
        console.log(`    ${archivedDrip.length} archived drip stage(s): Overview books $${ovArchived.toFixed(2)} (lifetime on first-send day), per-send rule $${archivedPerSend.toFixed(2)}`);
      }
      assert(near(r.total.cost, expectedCost),
        `(a) Cost ${r.total.cost.toFixed(4)} = Overview ${ovCost.toFixed(4)}${archivedDrip.length ? ` with archived drip re-priced per send → ${expectedCost.toFixed(4)}` : ""}`);
      assert(r.total.sends === sumRows((x) => x.sends) && near(r.total.cost, sumRows((x) => x.cost)),
        `(a) Sends and Cost foot to the rows`);

      // ---- (a) Sales + Revenue, regular: keitaro_stage_results + manual top-up per cohort stage
      const [reg] = await q(sql`
        WITH st AS (
          SELECT cs.id FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
          WHERE c.org_id = ${orgId}::uuid AND c.offer_id = ${offerId} AND c.type <> 'drip'
            AND cs.sent_at >= ${fromUtc.toISOString()}::timestamptz
            AND cs.sent_at < ${toExclusiveUtc.toISOString()}::timestamptz),
        k AS (SELECT stage_id, sum(sales)::int AS s, sum(revenue) AS rev FROM keitaro_stage_results WHERE stage_id IN (SELECT id FROM st) GROUP BY 1),
        m AS (SELECT stage_id, sum(delta)::int AS s FROM stage_manual_sales WHERE stage_id IN (SELECT id FROM st) GROUP BY 1)
        SELECT COALESCE(sum(COALESCE(k.s, 0) + GREATEST(0, COALESCE(m.s, 0) - COALESCE(k.s, 0))), 0)::int AS sales,
               COALESCE(sum(k.rev), 0)::float8 AS revenue
        FROM st LEFT JOIN k ON k.stage_id = st.id LEFT JOIN m ON m.stage_id = st.id`);
      assert(r.subtotals.regular.sales === n(reg.sales), `(a) regular Sales ${r.subtotals.regular.sales} = tracker tally + manual top-up ${n(reg.sales)}`);
      assert(near(r.subtotals.regular.revenue, n(reg.revenue)), `(a) regular Revenue ${r.subtotals.regular.revenue.toFixed(2)} = tracker tally ${n(reg.revenue).toFixed(2)}`);

      // ---- (a) Sales + Revenue, drip: per-send ledger recount by stage_sends.sent_at
      const [dr] = await q(sql`
        SELECT count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS sales,
               COALESCE(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0)::float8 AS revenue
        FROM conversion_events ce
        JOIN stage_sends ss ON ss.id = ce.stage_send_id
        JOIN campaign_stages cs ON cs.id = ss.stage_id JOIN campaigns c ON c.id = cs.campaign_id
        WHERE c.org_id = ${orgId}::uuid AND c.offer_id = ${offerId} AND c.type = 'drip'
          AND ss.status = 'sent' AND ss.sent_at >= ${fromUtc.toISOString()}::timestamptz
          AND ss.sent_at < ${toExclusiveUtc.toISOString()}::timestamptz`);
      assert(r.subtotals.drip.sales === n(dr.sales), `(a) drip Sales ${r.subtotals.drip.sales} = per-send ledger ${n(dr.sales)}`);
      assert(near(r.subtotals.drip.revenue, n(dr.revenue)), `(a) drip Revenue ${r.subtotals.drip.revenue.toFixed(2)} = per-send ledger ${n(dr.revenue).toFixed(2)}`);
      assert(r.total.sales === sumRows((x) => x.sales) && near(r.total.revenue, sumRows((x) => x.revenue)),
        `(a) Sales and Revenue foot to the rows`);

      // ---- (b) clicks dedup at display grain
      const all = new Set<string>();
      let rowsOk = 0;
      for (const row of r.rows) {
        const ids = row.sources.stage_ids;
        const regC = ids.length
          ? await q(sql`SELECT DISTINCT contact_id FROM counted_clickers WHERE stage_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
          : [];
        const pairs = row.sources.drip;
        const dripC = pairs.length
          ? await q(sql`
              SELECT DISTINCT cc.contact_id FROM stage_sends ss
              JOIN counted_clickers cc ON cc.stage_id = ss.stage_id AND cc.contact_id = ss.contact_id
              LEFT JOIN links l ON l.id = ss.link_id LEFT JOIN link_destinations d ON d.id = l.destination_id
              WHERE ss.status = 'sent' AND ss.sent_at >= ${fromUtc.toISOString()}::timestamptz
                AND ss.sent_at < ${toExclusiveUtc.toISOString()}::timestamptz
                AND (${sql.join(pairs.map((p) => sql`(ss.stage_id = ${p.stage_id} AND d.url IS NOT DISTINCT FROM ${p.url})`), sql` OR `)})`)
          : [];
        const set = new Set([...regC, ...dripC].map((x) => String(x.contact_id)));
        set.forEach((c) => all.add(c));
        const [mv] = ids.length
          ? await q(sql`
              SELECT COALESCE(sum(k.visit_clicks_clean), 0)::int AS v FROM keitaro_stage_results k
              JOIN campaign_stages cs ON cs.id = k.stage_id JOIN campaigns c ON c.id = cs.campaign_id
              WHERE c.link_mode = 'manual' AND k.stage_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
          : [{ v: 0 }];
        if (row.clicks === set.size + n(mv.v) && row.manual_visits === n(mv.v)) rowsOk++;
        else console.log(`    row ${row.key}: report ${row.clicks} (manual ${row.manual_visits}) vs recount ${set.size} + manual ${n(mv.v)}`);
      }
      assert(rowsOk === r.rows.length, `(b) ${rowsOk}/${r.rows.length} rows: clicks = recomputed COUNT(DISTINCT contact) (+ manual visits)`);
      const colSum = sumRows((x) => x.clicks);
      assert(r.total.clicks === all.size + r.total.manual_visits,
        `(b) Total clicks ${r.total.clicks} = offer-distinct ${all.size} + manual ${r.total.manual_visits}`);
      assert(r.total.clicks <= colSum, `(b) Total clicks ${r.total.clicks} <= column sum ${colSum} (does not foot by ${colSum - r.total.clicks}, by design)`);

      // ---- (c) null-not-0
      let nullCells = 0;
      let bad = 0;
      for (const m of [...r.rows, r.total]) {
        const d = derive({ sends: m.sends, revenue: m.revenue, sales: m.sales, clicks: m.clicks, cost: m.cost, optouts: m.optouts });
        const sp = salesPctOfReached(m);
        const expectNull = {
          rpm: m.sends === 0, net_rpm: m.sends === 0, ctr: m.sends === 0, oo_pct: m.sends === 0,
          epc: m.clicks === 0, sp: m.reach_covered_stages === 0 || m.reached === 0,
        };
        const got = { rpm: d.rpm, net_rpm: d.net_rpm, ctr: d.ctr, oo_pct: d.oo_pct, epc: d.epc, sp };
        for (const k of Object.keys(expectNull) as (keyof typeof expectNull)[]) {
          if (expectNull[k]) { nullCells++; if (got[k] !== null) bad++; }
          else if (got[k] === null) bad++;
        }
      }
      assert(bad === 0, `(c) ${nullCells} no-denominator cell(s) are null (render —), and no computable cell is null`);
    }

    // ---- (c) the fallback must actually be exercised somewhere
    console.log("\n=== c. fallback cells exercised ===");
    const fallback = nonEmpty.flatMap((x) =>
      x.r.rows.filter((row) => salesPctOfReached(row) === null && row.sends > 0).map((row) => `${x.offer}/${x.w}/${row.key}`));
    console.log(`  Sales % = — on ${fallback.length} row(s) with sends: ${fallback.slice(0, 6).join(", ")}${fallback.length > 6 ? " …" : ""}`);
    assert(fallback.length > 0, "(c) at least one row with sends renders Sales % as — (fallback exercised, not vacuous)");

    // ---- (12) Upsell: revenue yes, sale never
    console.log("\n=== 12. upsell is revenue, not a sale ===");
    if (upsellOffer == null) {
      assert(false, "(12) no upsell ledger rows in this org — the rule cannot be exercised");
    } else {
      const at = nonEmpty.find((x) => x.offer === upsellOffer && x.w === "All Time");
      const [u] = await q(sql`
        SELECT count(*) FILTER (WHERE et.key = 'upsell')::int AS upsell_rows,
               COALESCE(sum(ce.revenue) FILTER (WHERE et.key = 'upsell' AND ${approvedRevenueClause("ce")}), 0)::float8 AS upsell_rev,
               count(*) FILTER (WHERE et.key = 'upsell' AND ${purchasedClause("ce")})::int AS upsell_as_purchase
        FROM conversion_events ce JOIN event_types et ON et.id = ce.event_type_id
        JOIN campaign_stages cs ON cs.id = ce.stage_id JOIN campaigns c ON c.id = cs.campaign_id
        WHERE c.org_id = ${orgId}::uuid AND c.offer_id = ${upsellOffer}`);
      console.log(`  offer ${upsellOffer}: ${n(u.upsell_rows)} upsell rows, $${n(u.upsell_rev).toFixed(2)} approved upsell revenue`);
      assert(n(u.upsell_rows) > 0, "(12) the upsell offer has upsell rows in reportable stages");
      assert(n(u.upsell_as_purchase) === 0, "(12) purchasedClause matches 0 upsell rows — upsell never counts as a sale");
      if (at) {
        // Independent: purchases per stage from the ledger, topped up by the
        // manual tally per stage (max, not sum), over the offer's reportable stages.
        const [p] = await q(sql`
          WITH st AS (
            SELECT cs.id FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
            WHERE c.org_id = ${orgId}::uuid AND c.offer_id = ${upsellOffer} AND cs.sent_at IS NOT NULL),
          led AS (
            SELECT ce.stage_id,
                   count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS purchases,
                   count(*) FILTER (WHERE et.key = 'upsell' AND ce.status IN ('pending','approved'))::int AS upsells,
                   COALESCE(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0) AS revenue
            FROM conversion_events ce JOIN event_types et ON et.id = ce.event_type_id
            WHERE ce.stage_id IN (SELECT id FROM st) GROUP BY 1),
          m AS (SELECT stage_id, sum(delta)::int AS s FROM stage_manual_sales WHERE stage_id IN (SELECT id FROM st) GROUP BY 1)
          SELECT COALESCE(sum(COALESCE(led.purchases, 0)), 0)::int AS purchases,
                 COALESCE(sum(GREATEST(0, COALESCE(m.s, 0) - COALESCE(led.purchases, 0))), 0)::int AS topup,
                 COALESCE(sum(led.upsells), 0)::int AS upsells,
                 COALESCE(sum(led.revenue), 0)::float8 AS revenue
          FROM st LEFT JOIN led ON led.stage_id = st.id LEFT JOIN m ON m.stage_id = st.id`);
        const expected = n(p.purchases) + n(p.topup);
        console.log(`  All Time: ledger purchases ${n(p.purchases)} + manual top-up ${n(p.topup)} = ${expected}; counted upsell events ${n(p.upsells)}`);
        assert(at.r.total.sales === expected, `(12) report Sales ${at.r.total.sales} = purchases + manual top-up ${expected} (upsell not counted)`);
        assert(n(p.upsells) > 0 && at.r.total.sales !== expected + n(p.upsells), "(12) counting upsell as a sale would give a different number — the check can fail");
        assert(near(at.r.total.revenue, n(p.revenue)), `(12) report Revenue ${at.r.total.revenue.toFixed(2)} includes upsell (= approved purchase + upsell ${n(p.revenue).toFixed(2)})`);
      } else {
        assert(false, `(12) offer ${upsellOffer} has no All Time rows`);
      }
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
