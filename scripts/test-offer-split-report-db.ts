// DB checks for the by-offer readers of the per-offer split (Task 5) on the PREVIEW DB.
//
// Fixture (one fresh org, manual-mode stages, one creative K, ET day 2026-10-05):
//   stage X — campaign offer A: 1000 sent, $10 cost, 100 visits, tracker 4 sales / $180.
//             Ledger: 2 sales on A ($100), 1 on B ($50), 1 on C ($30)  => splits B and C.
//             Plus a rejected conversion on D: an all-zero split that must mint no row.
//   stage Y — campaign offer B: 500 sent, $5 cost, 40 visits, tracker 1 sale / $20 (ledger: B).
//   stage Z — campaign offer A: nothing sent, NO tracker row, ledger 1 sale on C ($5)
//             => would_go_negative: every reader leaves Z whole on A.
//   stage W — DRIP, campaign offer A, sent 2026-09-01 (outside the day), tracker 1 sale / $7,
//             ledger 1 sale on C ($7) with no stage_send_id => C's unattributed drip conversion.
//
//   P1 By Offer: rows A, B, C; Σ sales / revenue = the stages'; A keeps X's sent / cost; totals unchanged
//   P2 C is pure secondary: sent 0, cost 0, hasNoOwnSends => EPC / Profit / Cost render "—"
//   P3 B is mixed: EPC = B's own revenue / B's counted clickers = $20 / 40
//   P4 Overview (stage funnel), By Number, By Sequence, Hourly, By Offer totals identical with and without the split
//   P5 landing-page report: C shows X's $30, B shows $50 + $20, A loses both; C is in the offer picker
//   P6 /creatives offer filter (computeCreativeMetrics) = By Offer for K; creative × offer under offer_id=C;
//      own-payout EPC numerator (fix round 1)
//   P7 per-event EPC numerator = own event revenue; would_go_negative skip; drip unattributed (fix round 1)
//
// The readers use the shared db client, so fixtures are COMMITTED and removed by org in `finally`.
//
// Run (preview DB only):
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2- | tr -d '\r\"')" \
//     npx tsx --conditions=react-server scripts/test-offer-split-report-db.ts
import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__OFFER_SPLIT_REPORT_TEST__";
const DAY = "2026-10-05";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

async function main() {
  // The overlap alert (owner ruling 2026-11-04) calls notifyTelegram, and
  // _env-preload loads .env.local's real bot token — never message the real chat
  // from a test. notifyTelegram reads these at call time, so unsetting here works.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { getPerformanceReport } = await import("@/lib/reporting/performance-report");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const { getLandingPageReport, offersWithSends } = await import("@/lib/reporting/landing-page-report");
  const { computeCreativeMetrics } = await import("@/lib/creatives/metrics-cache");
  const { hasNoOwnSends, ownEventMap, ownRevenue } = await import("@/lib/reporting/offer-split-display");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const tag = `osr-${Date.now()}`;
  let orgId: string | null = null;

  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const org = orgId;
    const mkOffer = async (s: string) => {
      const net = await one<{ id: number }>(
        sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}::uuid, ${`n${s}-${tag}`}, ${`N${s} ${tag}`}) RETURNING id`,
      );
      return (
        await one<{ id: number }>(sql`
          INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}::uuid, ${`o${s}-${tag}`}, ${net.id}, ${`O${s} ${tag}`}) RETURNING id`)
      ).id;
    };
    const [A, B, C, D] = [await mkOffer("a"), await mkOffer("b"), await mkOffer("c"), await mkOffer("d")];
    const etSale = (
      await one<{ id: number }>(sql`
        INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
        VALUES (${org}::uuid, 'sale', 'Sale', true, true) RETURNING id`)
    ).id;
    const K = (
      await one<{ id: number }>(sql`
        INSERT INTO creatives (org_id, slug, text, status) VALUES (${org}::uuid, ${`k-${tag}`}, 'fixture', 'active') RETURNING id`)
    ).id;

    const mkStage = async (
      offer: number, s: string, sms: number, cost: number, visits: number, kSales: number, kRev: number,
      o: { type?: string; day?: string; creative?: number | null; tracker?: boolean } = {},
    ) => {
      const day = o.day ?? DAY;
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, offer_id, type)
        VALUES (${org}::uuid, ${`c${s}-${tag}`}, ${`C${s} ${tag}`}, 'active', 'manual', ${offer}, ${o.type ?? "regular"}) RETURNING id`);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text, creative_id, sent_at, sms_count, total_cost)
        VALUES (${org}::uuid, ${camp.id}, 1, 'STOP', ${o.creative === undefined ? K : o.creative}, ${`${day}T15:00:00Z`}::timestamptz, ${sms}, ${String(cost)}::numeric)
        RETURNING id`);
      if (o.tracker === false) return { camp: camp.id, stage: stage.id };
      await db.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue, events,
           visit_clicks_raw, visit_clicks_clean)
        VALUES (${org}::uuid, ${camp.id}, ${stage.id}, ${`${tag}-s${stage.id}`}, ${day}::date, ${kSales}, ${String(kRev)}::numeric,
                ${JSON.stringify({ sale: { n: kSales, pending_n: 0, revenue: kRev, pending_revenue: 0 } })}::jsonb,
                ${visits}, ${visits})`);
      return { camp: camp.id, stage: stage.id };
    };
    const X = await mkStage(A, "x", 1000, 10, 100, 4, 180);
    const Y = await mkStage(B, "y", 500, 5, 40, 1, 20);
    const Z = await mkStage(A, "z", 0, 0, 0, 0, 0, { tracker: false });
    const W = await mkStage(A, "w", 0, 0, 0, 1, 7, { type: "drip", day: "2026-09-01", creative: null });

    let seq = 0;
    const ce = async (s: { camp: number; stage: number }, offer: number, status: string, revenue: number, at = `${DAY}T16:00:00Z`) =>
      db.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, campaign_id, stage_id, offer_id,
           event_type_id, status, revenue, occurred_at)
        VALUES (${org}::uuid, ${`${tag}-${++seq}`}, 'sale', 'sale', ${s.camp}, ${s.stage}, ${offer},
                ${etSale}, ${status}, ${String(revenue)}::numeric, ${at}::timestamptz)`);
    await ce(X, A, "approved", 50);
    await ce(X, A, "approved", 50);
    await ce(X, B, "approved", 50);
    await ce(X, C, "approved", 30);
    await ce(X, D, "rejected", 99); // moves nothing: no D row anywhere
    await ce(Y, B, "approved", 20);
    await ce(Z, C, "approved", 5); // more than Z's tracker holds => Z stays whole on A
    await ce(W, C, "approved", 7, "2026-09-01T16:00:00Z"); // drip, no stage_send_id

    const b = { from: DAY, to: DAY, providerPhoneId: null };
    const offerRep = await getPerformanceReport(org, "offer", b, { alertOverlap: true });
    // P8 (owner ruling 2026-11-04): the overlap stage Z latches one alert_state row;
    // a non-overlap stage latches none.
    const alerts = (await db.execute(sql`
      SELECT alert_key, state FROM alert_state WHERE org_id = ${org}::uuid AND alert_key LIKE 'offer_split_overlap:%'
    `)) as unknown as { alert_key: string; state: string }[];
    bar(
      "P8 overlap stage Z latches one firing alert, nothing else",
      alerts.length === 1 && alerts[0].alert_key === `offer_split_overlap:${org}:${Z.stage}` && alerts[0].state === "firing",
      JSON.stringify(alerts),
    );
    const row = (k: number) => offerRep.rows.find((r) => r.key === String(k));
    const [rA, rB, rC] = [row(A), row(B), row(C)];

    console.log("P1 By Offer");
    bar("rows are exactly A, B, C (no all-zero D row)",
      offerRep.rows.length === 3 && !!rA && !!rB && !!rC && !row(D), offerRep.rows.map((r) => r.key).join(","));
    const sumS = offerRep.rows.reduce((n, r) => n + r.sales, 0);
    const sumR = offerRep.rows.reduce((n, r) => n + r.revenue, 0);
    bar("Σ sales / revenue over rows = the stages' (5 / $200) = totals", sumS === 5 && near(sumR, 200) &&
      offerRep.totals.sales === 5 && near(offerRep.totals.revenue, 200), `${sumS} ${sumR}`);
    bar("A: sent 1000, cost $10, sales 2, revenue $100, split_out $80",
      rA?.sent === 1000 && near(rA.cost, 10) && rA.sales === 2 && near(rA.revenue, 100) && near(rA.split_out_revenue, 80),
      JSON.stringify(rA));
    bar("totals keep sent 1500 / cost $15 / split fields 0",
      offerRep.totals.sent === 1500 && near(offerRep.totals.cost, 15) &&
        offerRep.totals.split_in_revenue === 0 && offerRep.totals.split_out_revenue === 0);
    bar("A's events: sale n 2 (4 minus the 2 split out)", rA?.events.sale?.n === 2, JSON.stringify(rA?.events));

    console.log("\nP2 pure-secondary row");
    bar("C: sent 0, cost 0, sales 1, revenue $30, split_in $30",
      rC?.sent === 0 && rC.cost === 0 && rC.sales === 1 && near(rC.revenue, 30) && near(rC.split_in_revenue, 30), JSON.stringify(rC));
    bar("C renders — (hasNoOwnSends); A and B do not",
      !!rC && hasNoOwnSends(rC) && !!rA && !hasNoOwnSends(rA) && !!rB && !hasNoOwnSends(rB));

    console.log("\nP3 mixed row");
    bar("B: sent 500, sales 2, revenue $70, split_in $50, counted clickers 40",
      rB?.sent === 500 && rB.sales === 2 && near(rB.revenue, 70) && near(rB.split_in_revenue, 50) && rB.counted_clickers === 40,
      JSON.stringify(rB));
    bar("B's EPC numerator = own revenue $20 => EPC 0.5; A's = $180 => 1.8",
      !!rB && near(ownRevenue(rB) / rB.counted_clickers, 0.5) && !!rA && near(ownRevenue(rA) / rA.counted_clickers, 1.8),
      `${rB && ownRevenue(rB)} ${rA && ownRevenue(rA)}`);

    console.log("\nP7 per-event EPC numerator");
    bar("B's own sale revenue $20 (70 − 50 split in); A's $180 (100 + 80 split out); C's own $0",
      !!rB && !!rA && !!rC && near(ownEventMap(rB).sale.revenue, 20) && near(ownEventMap(rA).sale.revenue, 180) &&
        near(ownEventMap(rC).sale.revenue, 0),
      JSON.stringify([rA?.event_split_delta, rB?.event_split_delta, rC?.event_split_delta]));

    // P5 / P6 read the split state; P4 then compares against the unsplit state.
    console.log("\nP5 landing-page report");
    const lp = async (o: number) =>
      (await getLandingPageReport({ orgId: org, offerId: o, from: DAY, to: DAY, splitByBrand: false }))!;
    const [lpA, lpB, lpC] = [await lp(A), await lp(B), await lp(C)];
    bar("C: sales 1, revenue $30, no sends, no cost", lpC.total.sales === 1 && near(lpC.total.revenue, 30) &&
      lpC.total.sends === 0 && lpC.total.cost === 0, JSON.stringify(lpC.total));
    bar("B: sales 2, revenue $70 (own $20 + X's $50), sends 500", lpB.total.sales === 2 && near(lpB.total.revenue, 70) &&
      lpB.total.sends === 500, JSON.stringify(lpB.total));
    bar("A: sales 3, revenue $105 (X's own 2 / $100 + Z's $5 — Z is left whole), sends 1000",
      lpA.total.sales === 3 && near(lpA.total.revenue, 105) && lpA.total.sends === 1000, JSON.stringify(lpA.total));
    bar("C excludes Z's $5 (would_go_negative, the rule By Offer applies)", near(lpC.total.revenue, 30));
    bar("drip split-in with no send: counted as C's unattributed drip conversion, not A's",
      lpC.unattributed_drip_conversions === 1 && lpA.unattributed_drip_conversions === 0,
      `${lpC.unattributed_drip_conversions} ${lpA.unattributed_drip_conversions}`);
    const picker = (await offersWithSends(org)).map((o) => Number(o.id));
    bar("offer picker lists A, B and C (not D)", [A, B, C].every((o) => picker.includes(o)) && !picker.includes(D), picker.join(","));

    console.log("\nP6 /creatives offer filter = By Offer");
    const cm = await computeCreativeMetrics(org);
    const cmRow = (o: number | null) => cm.find((r) => r.creative_id === K && r.offer_id === o);
    for (const [o, r] of [[A, rA], [B, rB], [C, rC]] as const) {
      const c = cmRow(o);
      bar(`creative K under offer ${o === A ? "A" : o === B ? "B" : "C"}: sales / payout (30-day and lifetime) = By Offer`,
        !!c && !!r && c.sales === r.sales && near(c.payout, r.revenue) && c.lifetime_sales === r.sales && near(c.lifetime_payout, r.revenue),
        JSON.stringify(c));
    }
    const all = cmRow(null);
    bar("all-offers row unchanged: sales 5, payout $200, events sale 5", all?.sales === 5 && near(all.payout, 200) && all.events.sale === 5,
      JSON.stringify(all));
    bar("C's event count: sale 1; A's: sale 2", cmRow(C)?.events.sale === 1 && cmRow(A)?.events.sale === 2,
      JSON.stringify([cmRow(C)?.events, cmRow(A)?.events]));
    bar("C has no deliveries / clicks of its own", cmRow(C)?.visit_clickers === 0 && cmRow(C)?.manual_clean === 0);
    bar("own payout (EPC numerator): A $180, B $20, C $0, all offers $200 — 30-day and lifetime",
      [[A, 180], [B, 20], [C, 0], [null, 200]].every(([o, v]) => {
        const c = cmRow(o as number | null);
        return !!c && near(c.own_payout, v as number) && near(c.lifetime_own_payout, v as number);
      }),
      JSON.stringify([A, B, C, null].map((o) => [cmRow(o)?.own_payout, cmRow(o)?.lifetime_own_payout])));
    const crC = await getPerformanceReport(org, "creative", { ...b, offerId: C }, { alertOverlap: true });
    const crRowC = crC.rows.find((r) => r.offer_id === C);
    bar("dimension=creative offer_id=C: totals = C's By Offer row (sales 1, $30, sent 0)",
      crC.totals.sales === 1 && near(crC.totals.revenue, 30) && crC.totals.sent === 0 && !!crRowC && crRowC.creative_id === K,
      JSON.stringify(crC.totals));
    const crA = await getPerformanceReport(org, "creative", { ...b, offerId: A }, { alertOverlap: true });
    bar("dimension=creative offer_id=A: totals sales 2, $100, sent 1000, clickers 100",
      crA.totals.sales === 2 && near(crA.totals.revenue, 100) && crA.totals.sent === 1000 && crA.totals.counted_clickers === 100,
      JSON.stringify(crA.totals));

    console.log("\nP4 totals with and without the split");
    const snapshot = async () => {
      const funnel = await getStageMetricsInRange(org, DAY, DAY);
      const [num, sq, hr, off] = [
        await getPerformanceReport(org, "number", b, { alertOverlap: true }),
        await getPerformanceReport(org, "sequence", b, { alertOverlap: true }),
        await getPerformanceReport(org, "hourly", b, { alertOverlap: true }),
        await getPerformanceReport(org, "offer", b, { alertOverlap: true }),
      ];
      const strip = <T extends { refreshedAt: string | null }>(r: T) => ({ ...r, refreshedAt: null });
      return {
        overview: JSON.stringify({
          grand: funnel.grand, sent: funnel.grandTotalSent, oo: funnel.grandOptOuts,
          stages: [...funnel.stages].sort((p, q) => p.stage_id - q.stage_id),
        }),
        number: JSON.stringify(strip(num)),
        sequence: JSON.stringify(strip(sq)),
        hourly: JSON.stringify(strip(hr)),
        offerTotals: JSON.stringify(off.totals),
        offerRows: off.rows.length,
      };
    };
    const split = await snapshot();
    await db.execute(sql`UPDATE conversion_events SET offer_id = ${A} WHERE org_id = ${org}::uuid AND stage_id = ${X.stage}`);
    const unsplit = await snapshot();
    bar("control: the unsplit state has 2 offer rows (A, B), the split state 3", unsplit.offerRows === 2 && split.offerRows === 3);
    for (const k of ["overview", "number", "sequence", "hourly", "offerTotals"] as const) {
      bar(`${k} identical`, split[k] === unsplit[k], split[k] === unsplit[k] ? "" : `${split[k]}\n   vs ${unsplit[k]}`);
    }
  } finally {
    if (orgId) {
      const o = orgId;
      await db.execute(sql`DELETE FROM alert_state WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM keitaro_stage_results WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM campaign_stages WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM creatives WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM event_types WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM offers WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM affiliate_networks WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM organizations WHERE id = ${o}::uuid`);
    }
    const left = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`${MARKER}%`}`);
    bar("teardown left no fixture org", left.n === 0);
  }

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
