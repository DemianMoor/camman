import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { addEtDays } from "@/lib/reporting/delivery-rollup";
import { ownRevenue } from "@/lib/reporting/offer-split-display";
import { getOfferSplits, isMovingSplit, splitStageMetrics, type OfferSplit } from "@/lib/reporting/offer-splits";
import { addMetrics, stageMetrics, zeroMetrics, type PerfMetrics } from "@/lib/reporting/performance-report";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
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
    if (slices[0].skipped === "would_go_negative") {
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

  // ---- (2) + (3) per offer, and the ledger rows behind each delta ----
  await withReadOnlyDb(async (tx) => {
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
          `    split_in ${usd(a.split_in_revenue)} | split_out ${usd(a.split_out_revenue)} | own-traffic revenue ${usd(own)} | own-traffic EPC ${epc} (clickers ${a.counted_clickers})`,
      );
    }
    if (!any) console.log("  (no offer changed)");

    const stageIds = [...splitsByStage.keys()];
    console.log("\nLedger rows behind the deltas (stage campaign offer -> conversion offer)");
    if (!stageIds.length) {
      console.log("  (none)");
      return;
    }
    const rows = await q(sql`
      SELECT ce.id, ce.stage_id, ca.offer_id AS campaign_offer, ce.offer_id AS ce_offer, ce.status, ce.revenue::text AS revenue,
             to_char(ce.occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS occurred_et, et.key AS event_key
      FROM conversion_events ce
      JOIN campaign_stages cs ON cs.id = ce.stage_id AND cs.org_id = ce.org_id
      JOIN campaigns ca ON ca.id = cs.campaign_id AND ca.org_id = ce.org_id
      LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
      WHERE ce.org_id = ${orgId}::uuid
        AND ce.stage_id IN (${sql.join(stageIds.map((i) => sql`${i}`), sql`, `)})
        AND ce.offer_id IS NOT NULL AND ce.offer_id IS DISTINCT FROM ca.offer_id
        AND (ce.occurred_at AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date
      ORDER BY ce.offer_id, ce.stage_id, ce.id
      LIMIT 500`);
    const skippedIds = new Set(skipped.map((l) => Number(l.split(" ")[1])));
    for (const r of rows) {
      console.log(
        `  ${skippedIds.has(Number(r.stage_id)) ? "[stage skipped: would_go_negative] " : ""}ce ${r.id} stage ${r.stage_id}: offer ${r.campaign_offer} -> ${r.ce_offer} | ${r.event_key ?? "?"} ${r.status} ${usd(Number(r.revenue))} | ${r.occurred_et} ET`,
      );
    }
    console.log(`  ${rows.length} row(s)${rows.length === 500 ? " (capped at 500)" : ""}`);
  });

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
