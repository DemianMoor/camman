import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { addEtDays } from "@/lib/reporting/delivery-rollup";
import { ownRevenue } from "@/lib/reporting/offer-split-display";
import { getOfferSplits, isMovingSplit, splitStageMetrics, type OfferSplit } from "@/lib/reporting/offer-splits";
import { addMetrics, getStageDimensionReports, stageMetrics, zeroMetrics, type PerfMetrics } from "@/lib/reporting/performance-report";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
import { approvedRevenueClause, pendingRevenueClause, purchasedClause } from "@/lib/sale-attribution";
import { withReadOnlyDb } from "./_readonly-db";

// =============================================================================
// PER-OFFER SPLIT — TOTALS VERIFICATION (docs/04-features/reports-rollup.md)
//
// READ-ONLY. Runs the production code path (getStageMetricsInRange ->
// stageMetrics -> getOfferSplits -> splitStageMetrics, exactly as By Offer does)
// and proves, per campaign and per stage, that the unsplit metrics equal the sum
// of the split slices field for field (every numeric PerfMetrics field and every
// events[key] field). Exit 1 on any mismatch.
//
// The app's own functions only SELECT through the shared db client. This script's
// direct queries (offer names, explaining ledger rows) run inside ONE
// `BEGIN READ ONLY` transaction (withReadOnlyDb). It issues no writes and no SET.
//
//   npx tsx --conditions=react-server scripts/verify-offer-split-totals.ts \
//     --org <uuid> [--from YYYY-MM-DD --to YYYY-MM-DD]      (ET days, default last 30)
// =============================================================================

const EPS = 1e-6;
const dialect = new PgDialect();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// split_in/out and event_split_delta are the split's own bookkeeping: nonzero on
// slices, zero unsplit, so they are checked separately (split_in == split_out).
const SKIP_FIELDS = new Set(["split_in_revenue", "split_out_revenue", "event_split_delta", "events"]);

function diff(a: PerfMetrics, b: PerfMetrics): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as (keyof PerfMetrics)[]) {
    if (SKIP_FIELDS.has(k)) continue;
    const x = a[k] as number | null;
    const y = b[k] as number | null;
    if (x === null || y === null) {
      if (x !== y) out.push(`${k}: ${x} vs ${y}`);
    } else if (Math.abs(x - y) > EPS) out.push(`${k}: ${x} vs ${y}`);
  }
  const keys = new Set([...Object.keys(a.events), ...Object.keys(b.events)]);
  for (const key of keys) {
    for (const f of ["n", "pending_n", "revenue", "pending_revenue"] as const) {
      const x = a.events[key]?.[f] ?? 0;
      const y = b.events[key]?.[f] ?? 0;
      if (Math.abs(x - y) > EPS) out.push(`events.${key}.${f}: ${x} vs ${y}`);
    }
  }
  return out;
}

function diffSelected(a: PerfMetrics, b: PerfMetrics): string[] {
  const out: string[] = [];
  for (const k of ["sales", "revenue", "pending_revenue"] as const) {
    if (Math.abs(a[k] - b[k]) > EPS) out.push(`${k}: ${a[k]} vs ${b[k]}`);
  }
  for (const key of new Set([...Object.keys(a.events), ...Object.keys(b.events)])) {
    for (const f of ["n", "pending_n", "revenue", "pending_revenue"] as const) {
      const x = a.events[key]?.[f] ?? 0;
      const y = b.events[key]?.[f] ?? 0;
      if (Math.abs(x - y) > EPS) out.push(`events.${key}.${f}: ${x} vs ${y}`);
    }
  }
  return out;
}

const usd = (v: number) => `$${v.toFixed(2)}`;

async function main() {
  const orgId = arg("org");
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
    console.error("usage: --org <uuid> [--from YYYY-MM-DD --to YYYY-MM-DD]");
    process.exit(2);
  }
  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const to = arg("to") ?? todayEt;
  const from = arg("from") ?? addEtDays(to, -29);
  console.log(`Org ${orgId}; ET window ${from} .. ${to} (conversion_date basis)\n`);

  const { stages, clickers: clk } = await getStageMetricsInRange(orgId, from, to);
  const metricsOf = (s: (typeof stages)[number]) =>
    stageMetrics(s, clk.periodByStage, clk.lifetimeByStage, clk.lifetimeRevenueByStage);

  const splitsByStage = new Map<number, OfferSplit[]>();
  for (const sp of await getOfferSplits(orgId, stages.map((s) => s.stage_id), { fromEt: from, toEt: to })) {
    if (!isMovingSplit(sp)) continue;
    const l = splitsByStage.get(sp.stage_id) ?? [];
    l.push(sp);
    splitsByStage.set(sp.stage_id, l);
  }

  // ---- (1) per stage + per campaign: unsplit == sum of slices ----
  let failed = 0;
  let splitStages = 0;
  const skipped: string[] = [];
  const skippedIds = new Set<number>();
  const secondary = new Map<number, { sales: number; revenue: number; pending: number }>();
  const campUnsplit = new Map<number, PerfMetrics>();
  const campSlices = new Map<number, PerfMetrics>();
  const campName = new Map<number, string>();
  const offerBefore = new Map<number, PerfMetrics>();
  const offerAfter = new Map<number, PerfMetrics>();

  for (const s of stages) {
    const m = metricsOf(s);
    const stageSplits = splitsByStage.get(s.stage_id) ?? [];
    const slices = splitStageMetrics(s.offer_id, m, stageSplits);
    if (slices.length > 1) splitStages++;
    for (const sl of slices) {
      if (!sl.secondary || sl.offer_id == null) continue;
      const t = secondary.get(sl.offer_id) ?? { sales: 0, revenue: 0, pending: 0 };
      t.sales += sl.metrics.sales;
      t.revenue += sl.metrics.revenue;
      t.pending += sl.metrics.pending_revenue;
      secondary.set(sl.offer_id, t);
    }
    if (slices[0].skipped === "would_go_negative") {
      skippedIds.add(s.stage_id);
      skipped.push(`stage ${s.stage_id} (campaign ${s.campaign_id}, offer ${s.offer_id}): ${stageSplits.length} split(s) not applied`);
    }
    const sum = slices.reduce((acc, sl) => addMetrics(acc, sl.metrics), zeroMetrics());
    const d = diff(m, sum);
    if (Math.abs(sum.split_in_revenue - sum.split_out_revenue) > EPS) d.push("split_in != split_out");
    if (d.length) {
      failed++;
      console.log(`MISMATCH stage ${s.stage_id} (campaign ${s.campaign_id}): ${d.join("; ")}`);
    }
    campName.set(s.campaign_id, s.campaign_name);
    campUnsplit.set(s.campaign_id, addMetrics(campUnsplit.get(s.campaign_id) ?? zeroMetrics(), m));
    campSlices.set(s.campaign_id, addMetrics(campSlices.get(s.campaign_id) ?? zeroMetrics(), sum));
    if (s.offer_id != null) offerBefore.set(s.offer_id, addMetrics(offerBefore.get(s.offer_id) ?? zeroMetrics(), m));
    for (const sl of slices) {
      if (sl.offer_id != null) offerAfter.set(sl.offer_id, addMetrics(offerAfter.get(sl.offer_id) ?? zeroMetrics(), sl.metrics));
    }
  }
  for (const [cid, u] of campUnsplit) {
    const d = diff(u, campSlices.get(cid)!);
    if (d.length) {
      failed++;
      console.log(`MISMATCH campaign ${cid} (${campName.get(cid)}): ${d.join("; ")}`);
    }
  }
  console.log(
    `${stages.length} stages, ${splitStages} split, ${campUnsplit.size} campaigns, ${failed ? `${failed} MISMATCH(ES) ✗` : "all equal ✓"}`,
  );
  console.log(`would_go_negative skips: ${skipped.length}`);
  for (const l of skipped) console.log(`  ${l}`);

  // ---- (a) two REAL groupers, one splits and one does not ----
  // By Offer splits conversions across offers; By Sequence (no split layer) groups
  // the same stage set unsplit. Their row sums must agree on sales / revenue /
  // pending / every events[key] field. (The report API has no campaign dimension;
  // sequence is the unsplit stage-level grouper.)
  const [offerRep, seqRep] = await getStageDimensionReports(orgId, ["offer", "sequence"], {
    from,
    to,
    providerPhoneId: null,
    // Read-only script: the overlap alert writes alert_state, so it stays off here.
  }, { alertOverlap: false });
  const sumRows = (rows: PerfMetrics[]) => rows.reduce((acc, r) => addMetrics(acc, r), zeroMetrics());
  const dA = diffSelected(sumRows(offerRep.rows), sumRows(seqRep.rows));
  if (dA.length) {
    failed++;
    console.log(`MISMATCH (a) sum By Offer rows vs sum By Sequence rows: ${dA.join("; ")}`);
  } else {
    console.log("(a) sum By Offer rows == sum By Sequence rows (sales, revenue, pending, events) ✓");
  }

  // ---- (2) + (3) per offer, and the ledger rows behind each delta ----
  await withReadOnlyDb(async (tx) => {
    await tx.unsafe("SET LOCAL statement_timeout = '60s'");
    const q = async (frag: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(frag);
      return (await tx.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];
    };
    const ids = [...new Set([...offerBefore.keys(), ...offerAfter.keys()])].sort((a, b) => a - b);
    const names = new Map<number, string>();
    if (ids.length) {
      const rows = await q(sql`SELECT id, offer_id, name FROM offers WHERE org_id = ${orgId}::uuid AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
      for (const r of rows) names.set(Number(r.id), `${r.name ?? ""} (${r.offer_id})`.trim());
    }
    console.log("\nPer offer: unsplit (campaign offer) -> split (By Offer); changed offers only");
    let any = false;
    for (const id of ids) {
      const b = offerBefore.get(id) ?? zeroMetrics();
      const a = offerAfter.get(id) ?? zeroMetrics();
      const changed =
        b.sales !== a.sales || Math.abs(b.revenue - a.revenue) > EPS || Math.abs(b.pending_revenue - a.pending_revenue) > EPS;
      if (!changed) continue;
      any = true;
      const own = ownRevenue(a);
      const epc = a.counted_clickers > 0 ? usd(own / a.counted_clickers) : "—";
      console.log(
        `  offer ${id} ${names.get(id) ?? ""}\n` +
          `    sales ${b.sales} -> ${a.sales} | approved ${usd(b.revenue)} -> ${usd(a.revenue)} | pending ${usd(b.pending_revenue)} -> ${usd(a.pending_revenue)}\n` +
          `    split_in ${usd(a.split_in_revenue)} | split_out ${usd(a.split_out_revenue)} | own-traffic revenue ${usd(own)} | own-traffic EPC (indicative) ${epc} (clickers ${a.counted_clickers})`,
      );
    }
    if (!any) console.log("  (no offer changed)");

    // ---- (b) the split amounts vs a direct SQL read of the ledger ----
    // Independent grouping (by ce.offer_id) over the rows getOfferSplits reads;
    // would_go_negative stages are excluded (they are reported unsplit).
    const skipClause = skippedIds.size
      ? sql`AND ce.stage_id NOT IN (${sql.join([...skippedIds].map((i) => sql`${i}`), sql`, `)})`
      : sql``;
    const base = sql`
      FROM conversion_events ce
      JOIN campaign_stages cs ON cs.id = ce.stage_id AND cs.org_id = ce.org_id
      JOIN campaigns ca ON ca.id = cs.campaign_id AND ca.org_id = ce.org_id
      LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
      WHERE ce.org_id = ${orgId}::uuid
        AND ce.offer_id IS NOT NULL AND ce.offer_id IS DISTINCT FROM ca.offer_id
        AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date BETWEEN ${from}::date AND ${to}::date`;
    const direct = await q(sql`
      SELECT ce.offer_id::int AS offer_id,
             count(*) FILTER (WHERE ${purchasedClause()})::int AS sales,
             coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::text AS revenue,
             coalesce(sum(ce.revenue) FILTER (WHERE ${pendingRevenueClause()}), 0)::text AS pending
      ${base} ${skipClause}
      GROUP BY ce.offer_id`);
    const sqlBy = new Map(
      direct.map((r) => [Number(r.offer_id), { sales: Number(r.sales), revenue: Number(r.revenue), pending: Number(r.pending) }]),
    );
    const reportIn = new Map(offerRep.rows.map((r) => [Number(r.key), r.split_in_revenue]));
    let bBad = 0;
    for (const id of new Set([...sqlBy.keys(), ...secondary.keys()])) {
      const x = sqlBy.get(id) ?? { sales: 0, revenue: 0, pending: 0 };
      const y = secondary.get(id) ?? { sales: 0, revenue: 0, pending: 0 };
      const rin = reportIn.get(id) ?? 0;
      if (
        x.sales !== y.sales ||
        Math.abs(x.revenue - y.revenue) > EPS ||
        Math.abs(x.pending - y.pending) > EPS ||
        Math.abs(x.revenue - rin) > EPS
      ) {
        bBad++;
        console.log(
          `MISMATCH (b) offer ${id}: SQL sales ${x.sales} approved ${x.revenue} pending ${x.pending} | slices sales ${y.sales} approved ${y.revenue} pending ${y.pending} | report split_in ${rin}`,
        );
      }
    }
    if (bBad) failed++;
    else {
      console.log(
        `(b) split amounts == direct ledger SQL for ${sqlBy.size} offer(s) ✓${skippedIds.size ? ` (excluding ${skippedIds.size} would_go_negative stage(s))` : ""}`,
      );
    }

    // ---- ledger rows behind each delta, grouped by conversion offer ----
    const PER_OFFER = 25;
    console.log("\nLedger rows behind the deltas, by conversion offer (stage campaign offer -> conversion offer)");
    const rows = await q(sql`
      SELECT ce.id, ce.stage_id, ca.offer_id AS campaign_offer, ce.offer_id AS ce_offer, ce.status, ce.revenue::text AS revenue,
             to_char(ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI') AS occurred_et, et.key AS event_key
      ${base}
      ORDER BY ce.offer_id, ce.stage_id, ce.id`);
    if (!rows.length) console.log("  (none)");
    const byOffer = new Map<number, Record<string, unknown>[]>();
    for (const r of rows) byOffer.set(Number(r.ce_offer), [...(byOffer.get(Number(r.ce_offer)) ?? []), r]);
    for (const [id, list] of byOffer) {
      console.log(`  -> offer ${id} ${names.get(id) ?? ""}: ${list.length} row(s)`);
      for (const r of list.slice(0, PER_OFFER)) {
        console.log(
          `    ${skippedIds.has(Number(r.stage_id)) ? "[stage skipped: would_go_negative] " : ""}ce ${r.id} stage ${r.stage_id}: offer ${r.campaign_offer} -> ${r.ce_offer} | ${r.event_key ?? "?"} ${r.status} ${usd(Number(r.revenue))} | ${r.occurred_et} ET`,
        );
      }
      if (list.length > PER_OFFER) console.log(`    +${list.length - PER_OFFER} more`);
    }
  });

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
