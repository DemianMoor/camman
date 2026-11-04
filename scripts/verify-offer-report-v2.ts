import "./_env-preload";

// VERIFY THE 0231 *_v2 REPORT VIEWS AGAINST THE OLD ONES — READ-ONLY (one
// BEGIN READ ONLY transaction on its own connection, scripts/_readonly-db.ts;
// getOfferSplits() is a plain SELECT through the app's pool).
//
// Run after scripts/fill-offer-report-v2.ts --apply, which refreshes the old
// views straight after the v2 ones, so both sides are snapshots minutes apart.
//
// What 0231 may change, and nothing else: conversions whose offer differs from
// the sending campaign's offer (offer_split_amounts_v) move from the campaign's
// offer to the conversion's offer. So:
//   V1  group cells of offers no split touches: identical old vs v2.
//   V2  group cells of touched offers: sends/cost/clicks/opt-outs identical (a
//       v2-only row has them 0); revenue/pending/sales differ by EXACTLY the
//       moved ledger amounts, recomputed here from conversion_events directly.
//   V3  Audience Stats (all offers of a group): identical old vs v2.
//   V4  footer: sends/cost/clicks/opt-outs/manual/attributable_sends identical;
//       revenue/sales differ by exactly offer_split_amounts_v (in - out);
//       attributable_* differ by exactly the moved ledger amounts at send grain;
//       Σ over offers of revenue and sales unchanged.
//   V5  footer halves agree: (stage-half delta) - (ledger-half delta) = the
//       split money that has no sent, group-targeted send to sit on.
//   V6  offer_split_amounts_v == getOfferSplits(lifetime) for every split stage
//       (Ruling R3: the By Offer tab and the footer move the same money).
//   V7  no stage's splits exceed its tracker totals (the runtime would leave
//       such a stage unsplit — "would_go_negative" — and the matview does not
//       replicate that skip), and no footer row goes negative.
// sent_7d/30d/90d and fresh_pool slide with now() between the two refreshes,
// so their differences are REPORTED, not failed. Exit 1 on any failed bar.
//
// Run: npx tsx --conditions=react-server scripts/verify-offer-report-v2.ts

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const eq = (a: unknown, b: unknown) => Math.abs(n(a) - n(b)) < 1e-6;

async function main() {
  const { withReadOnlyDb } = await import("./_readonly-db");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`read-only verify against ${host} at ${new Date().toISOString()}`);

  const d = await withReadOnlyDb(async (tx) => {
    await tx`SET LOCAL statement_timeout = '60s'`;
    const pop = await tx`SELECT matviewname, ispopulated FROM pg_matviews
      WHERE matviewname IN ('offer_group_report_mv','offer_group_report_v2_mv','audience_report_group_totals_mv',
        'audience_report_group_totals_v2_mv','offer_report_offer_totals_mv','offer_report_offer_totals_v2_mv') ORDER BY 1`;
    const log = await tx`SELECT view_name, refreshed_at::text FROM report_refresh_log
      WHERE view_name LIKE 'offer_group_report%' OR view_name LIKE 'audience_report%' OR view_name LIKE 'offer_report_offer_totals%' ORDER BY 1`;
    // Column lists spelled out per query (no .unsafe fragments: this script is read-only).
    const oldCells = await tx`SELECT org_id::text, offer_id, group_id, sends, revenue::float8 AS revenue,
      pending_revenue::float8 AS pending_revenue, sales, clicks, cost::float8 AS cost, optouts,
      sent_7d, sent_30d, sent_90d, fresh_pool FROM offer_group_report_mv`;
    const v2Cells = await tx`SELECT org_id::text, offer_id, group_id, sends, revenue::float8 AS revenue,
      pending_revenue::float8 AS pending_revenue, sales, clicks, cost::float8 AS cost, optouts,
      sent_7d, sent_30d, sent_90d, fresh_pool FROM offer_group_report_v2_mv`;
    const oldAud = await tx`SELECT org_id::text, group_id, sends, revenue::float8 AS revenue, pending_revenue::float8 AS pending_revenue,
      sales, clicks, cost::float8 AS cost, optouts, sent_7d, sent_30d, sent_90d FROM audience_report_group_totals_mv`;
    const v2Aud = await tx`SELECT org_id::text, group_id, sends, revenue::float8 AS revenue, pending_revenue::float8 AS pending_revenue,
      sales, clicks, cost::float8 AS cost, optouts, sent_7d, sent_30d, sent_90d FROM audience_report_group_totals_v2_mv`;
    const oldFoot = await tx`SELECT org_id::text, offer_id, sends, revenue::float8 AS revenue, sales, clicks, cost::float8 AS cost,
      optouts, has_manual_stages, attributable_sends, attributable_revenue::float8 AS attributable_revenue,
      attributable_sales, attributable_pending_revenue::float8 AS attributable_pending_revenue, unattributed_sends FROM offer_report_offer_totals_mv`;
    const v2Foot = await tx`SELECT org_id::text, offer_id, sends, revenue::float8 AS revenue, sales, clicks, cost::float8 AS cost,
      optouts, has_manual_stages, attributable_sends, attributable_revenue::float8 AS attributable_revenue,
      attributable_sales, attributable_pending_revenue::float8 AS attributable_pending_revenue, unattributed_sends FROM offer_report_offer_totals_v2_mv`;
    const splits = await tx`SELECT org_id::text, stage_id, campaign_offer_id, offer_id, sales, revenue::float8 AS revenue,
      pending_revenue::float8 AS pending_revenue FROM offer_split_amounts_v ORDER BY org_id, stage_id, offer_id`;
    // Independent of the view text: every split ledger row on a SENT send of a
    // tracked campaign, with the recipient's targeted groups (one row per group).
    const placed = await tx`
      SELECT ce.org_id::text, ce.offer_id AS to_offer, camp.offer_id AS from_offer, ccg.contact_group_id AS group_id,
             ce.id AS ce_id,
             (CASE WHEN ce.event_type_id IN (SELECT id FROM event_types WHERE counts_revenue) AND ce.status = 'approved' THEN ce.revenue ELSE 0 END)::float8 AS revenue,
             (CASE WHEN ce.event_type_id IN (SELECT id FROM event_types WHERE counts_revenue) AND ce.status = 'pending' THEN ce.revenue ELSE 0 END)::float8 AS pending,
             (ce.event_type_id IN (SELECT id FROM event_types WHERE is_purchase) AND ce.status IN ('pending','approved'))::int AS sale
      FROM conversion_events ce
      JOIN campaign_stages xs ON xs.id = ce.stage_id AND xs.org_id = ce.org_id
      JOIN campaigns xc ON xc.id = xs.campaign_id AND xc.org_id = ce.org_id
      JOIN stage_sends ss ON ss.id = ce.stage_send_id AND ss.status = 'sent'
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id AND camp.org_id = ce.org_id
      JOIN contact_contact_groups ccg ON ccg.contact_id = ss.contact_id AND ccg.contact_group_id = ANY(camp.gids) AND ccg.org_id = camp.org_id
      WHERE ce.offer_id IS NOT NULL AND ce.offer_id IS DISTINCT FROM xc.offer_id`;
    const overdrawn = await tx`
      WITH s AS (SELECT stage_id, sum(sales) AS sales, sum(revenue) AS revenue FROM offer_split_amounts_v GROUP BY stage_id),
      k AS (SELECT stage_id, sum(sales) AS sales, sum(revenue) AS revenue FROM keitaro_stage_results GROUP BY stage_id),
      m AS (SELECT stage_id, sum(delta) AS sales FROM stage_manual_sales GROUP BY stage_id)
      SELECT s.stage_id, s.sales, s.revenue::float8, COALESCE(k.revenue, 0)::float8 AS k_revenue,
             GREATEST(COALESCE(k.sales, 0), COALESCE(m.sales, 0)) AS k_sales
      FROM s LEFT JOIN k ON k.stage_id = s.stage_id LEFT JOIN m ON m.stage_id = s.stage_id
      WHERE s.revenue > COALESCE(k.revenue, 0) + 1e-6 OR s.sales > GREATEST(COALESCE(k.sales, 0), COALESCE(m.sales, 0))`;
    return { pop: [...pop], log: [...log], oldCells: [...oldCells], v2Cells: [...v2Cells], oldAud: [...oldAud],
      v2Aud: [...v2Aud], oldFoot: [...oldFoot], v2Foot: [...v2Foot], splits: [...splits], placed: [...placed],
      overdrawn: [...overdrawn] } as Record<string, Row[]>;
  });

  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    if (!ok) fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  console.log("populated:", JSON.stringify(d.pop));
  console.log("refresh stamps:", JSON.stringify(d.log));
  bar("all six views populated", d.pop.length === 6 && d.pop.every((p) => p.ispopulated === true));
  console.log(`scope: ${d.oldCells.length} old / ${d.v2Cells.length} v2 cells, ${d.oldAud.length}/${d.v2Aud.length} audience rows, ` +
    `${d.oldFoot.length}/${d.v2Foot.length} footer rows, ${d.splits.length} split (stage, offer) rows, ${d.placed.length} placed split cells`);
  bar("there are split rows to verify (an empty scope proves nothing)", d.splits.length > 0);

  const touched = new Set<string>();
  for (const s of d.splits) {
    if (s.campaign_offer_id == null) continue;
    touched.add(`${s.org_id}:${s.campaign_offer_id}`);
    touched.add(`${s.org_id}:${s.offer_id}`);
  }
  const ck = (r: Row) => `${r.org_id}:${r.offer_id}:${r.group_id}`;
  const oldC = new Map(d.oldCells.map((r) => [ck(r), r]));
  const v2C = new Map(d.v2Cells.map((r) => [ck(r), r]));
  const EXACT_CELL = ["sends", "revenue", "pending_revenue", "sales", "clicks", "cost", "optouts"];
  const DRIFT = ["sent_7d", "sent_30d", "sent_90d", "fresh_pool"];
  let drift = 0;
  const noteDrift = (a: Row | undefined, b: Row | undefined, cols: string[]) => {
    for (const c of cols) if (!eq(a?.[c], b?.[c])) drift++;
  };

  // V1
  const v1Bad: string[] = [];
  for (const k of new Set([...oldC.keys(), ...v2C.keys()])) {
    const [org, offer] = k.split(":");
    if (touched.has(`${org}:${offer}`)) continue;
    const a = oldC.get(k), b = v2C.get(k);
    if (!a || !b || EXACT_CELL.some((c) => !eq(a[c], b[c]))) v1Bad.push(k);
    else noteDrift(a, b, DRIFT);
  }
  bar("V1 cells of untouched offers identical", v1Bad.length === 0, `${v1Bad.length} differ${v1Bad.length ? `: ${v1Bad.slice(0, 5).join(", ")}` : ""}`);

  // V2 — expected delta per cell from the directly-placed split rows.
  const exp = new Map<string, { revenue: number; pending: number; sales: number }>();
  const add = (k: string, sign: number, r: Row) => {
    const e = exp.get(k) ?? { revenue: 0, pending: 0, sales: 0 };
    e.revenue += sign * n(r.revenue); e.pending += sign * n(r.pending); e.sales += sign * n(r.sale);
    exp.set(k, e);
  };
  for (const r of d.placed) {
    add(`${r.org_id}:${r.to_offer}:${r.group_id}`, 1, r);
    add(`${r.org_id}:${r.from_offer}:${r.group_id}`, -1, r);
  }
  const v2Bad: string[] = [];
  for (const k of new Set([...oldC.keys(), ...v2C.keys()])) {
    const [org, offer] = k.split(":");
    if (!touched.has(`${org}:${offer}`)) continue;
    const a = oldC.get(k), b = v2C.get(k);
    const e = exp.get(k) ?? { revenue: 0, pending: 0, sales: 0 };
    const ok = !!b &&
      ["sends", "clicks", "cost", "optouts"].every((c) => eq(a?.[c] ?? 0, b[c])) &&
      eq(n(b.revenue) - n(a?.revenue), e.revenue) && eq(n(b.pending_revenue) - n(a?.pending_revenue), e.pending) &&
      eq(n(b.sales) - n(a?.sales), e.sales);
    if (!ok) v2Bad.push(`${k} old ${JSON.stringify(a ?? null)} v2 ${JSON.stringify(b ?? null)} expected Δ ${JSON.stringify(e)}`);
    else if (a && b) noteDrift(a, b, DRIFT);
  }
  bar("V2 cells of touched offers move exactly the placed split money", v2Bad.length === 0, v2Bad.slice(0, 3).join(" | "));

  // V3
  const ak = (r: Row) => `${r.org_id}:${r.group_id}`;
  const oldA = new Map(d.oldAud.map((r) => [ak(r), r]));
  const v3Bad = [...new Set([...oldA.keys(), ...d.v2Aud.map(ak)])].filter((k) => {
    const a = oldA.get(k), b = d.v2Aud.find((r) => ak(r) === k);
    if (!a || !b) return true;
    noteDrift(a, b, ["sent_7d", "sent_30d", "sent_90d"]);
    return ["sends", "revenue", "pending_revenue", "sales", "clicks", "cost", "optouts"].some((c) => !eq(a[c], b[c]));
  });
  bar("V3 Audience Stats (all offers of a group) identical", v3Bad.length === 0, `${v3Bad.length} groups differ`);

  // V4 / V5
  const fk = (r: Row) => `${r.org_id}:${r.offer_id}`;
  const oldF = new Map(d.oldFoot.map((r) => [fk(r), r]));
  const v2F = new Map(d.v2Foot.map((r) => [fk(r), r]));
  const sd = new Map<string, { revenue: number; sales: number }>();
  for (const s of d.splits) {
    if (s.campaign_offer_id == null) continue;
    for (const [o, sign] of [[s.offer_id, 1], [s.campaign_offer_id, -1]] as const) {
      const k = `${s.org_id}:${o}`;
      const e = sd.get(k) ?? { revenue: 0, sales: 0 };
      e.revenue += sign * n(s.revenue); e.sales += sign * n(s.sales);
      sd.set(k, e);
    }
  }
  // Ledger half: placed rows, de-duplicated to one per conversion (EXISTS membership).
  const perCe = new Map<string, Row>();
  for (const r of d.placed) perCe.set(String(r.ce_id), r);
  const ld = new Map<string, { revenue: number; pending: number; sales: number }>();
  for (const r of perCe.values()) {
    for (const [o, sign] of [[r.to_offer, 1], [r.from_offer, -1]] as const) {
      const k = `${r.org_id}:${o}`;
      const e = ld.get(k) ?? { revenue: 0, pending: 0, sales: 0 };
      e.revenue += sign * n(r.revenue); e.pending += sign * n(r.pending); e.sales += sign * n(r.sale);
      ld.set(k, e);
    }
  }
  const v4Bad: string[] = [], v5Bad: string[] = [];
  for (const k of new Set([...oldF.keys(), ...v2F.keys()])) {
    const a = oldF.get(k), b = v2F.get(k);
    const s = sd.get(k) ?? { revenue: 0, sales: 0 };
    const l = ld.get(k) ?? { revenue: 0, pending: 0, sales: 0 };
    const ok = !!b &&
      ["sends", "clicks", "cost", "optouts", "attributable_sends", "unattributed_sends"].every((c) => eq(a?.[c] ?? 0, b[c])) &&
      (a ? a.has_manual_stages === b.has_manual_stages : b.has_manual_stages === false) &&
      eq(n(b.revenue) - n(a?.revenue), s.revenue) && eq(n(b.sales) - n(a?.sales), s.sales) &&
      eq(n(b.attributable_revenue) - n(a?.attributable_revenue), l.revenue) &&
      eq(n(b.attributable_pending_revenue) - n(a?.attributable_pending_revenue), l.pending) &&
      eq(n(b.attributable_sales) - n(a?.attributable_sales), l.sales);
    if (!ok) v4Bad.push(`${k} old ${JSON.stringify(a ?? null)} v2 ${JSON.stringify(b ?? null)} Δstage ${JSON.stringify(s)} Δledger ${JSON.stringify(l)}`);
    if (b) {
      // V5: what the stage half moved but the ledger half could not place.
      const unplaced = s.revenue - l.revenue;
      const gap = (n(b?.revenue) - n(a?.revenue)) - (n(b?.attributable_revenue) - n(a?.attributable_revenue));
      if (!eq(gap, unplaced)) v5Bad.push(`${k} gap ${gap} vs unplaced ${unplaced}`);
    }
  }
  const sum = (rows: Row[], c: string) => rows.reduce((t, r) => t + n(r[c]), 0);
  bar("V4 footer moves exactly offer_split_amounts_v (stage half) and the placed rows (ledger half)", v4Bad.length === 0, v4Bad.slice(0, 3).join(" | "));
  bar("V4 Σ footer revenue and sales over all offers unchanged",
    eq(sum(d.oldFoot, "revenue"), sum(d.v2Foot, "revenue")) && eq(sum(d.oldFoot, "sales"), sum(d.v2Foot, "sales")),
    `revenue ${sum(d.oldFoot, "revenue").toFixed(4)} -> ${sum(d.v2Foot, "revenue").toFixed(4)}, sales ${sum(d.oldFoot, "sales")} -> ${sum(d.v2Foot, "sales")}`);
  bar("V5 footer halves agree (stage-half Δ - ledger-half Δ = split money with no group-targeted send)", v5Bad.length === 0, v5Bad.slice(0, 3).join(" | "));

  // V6 — R3 parity with the By Offer tab's function.
  const { getOfferSplits } = await import("@/lib/reporting/offer-splits");
  const v6Bad: string[] = [];
  const byOrg = new Map<string, number[]>();
  for (const s of d.splits) byOrg.set(String(s.org_id), [...new Set([...(byOrg.get(String(s.org_id)) ?? []), n(s.stage_id)])]);
  for (const [org, stages] of byOrg) {
    const ts = (await getOfferSplits(org, stages, null)).filter((x) => x.sales !== 0 || x.revenue !== 0 || x.pending_revenue !== 0);
    const vs = d.splits.filter((s) => s.org_id === org);
    if (ts.length !== vs.length) v6Bad.push(`org ${org}: ${ts.length} function rows vs ${vs.length} view rows`);
    for (const t of ts) {
      const v = vs.find((s) => n(s.stage_id) === t.stage_id && n(s.offer_id) === t.offer_id);
      if (!v || !eq(v.sales, t.sales) || !eq(v.revenue, t.revenue) || !eq(v.pending_revenue, t.pending_revenue)) {
        v6Bad.push(`stage ${t.stage_id} offer ${t.offer_id}: fn ${JSON.stringify(t)} view ${JSON.stringify(v ?? null)}`);
      }
    }
  }
  bar("V6 offer_split_amounts_v == getOfferSplits(lifetime) (Ruling R3)", v6Bad.length === 0, v6Bad.slice(0, 3).join(" | "));

  // V7
  const negative = d.v2Foot.filter((r) => n(r.revenue) < -1e-6 || n(r.sales) < 0);
  bar("V7 no stage's splits exceed its tracker totals (runtime would_go_negative)", d.overdrawn.length === 0, JSON.stringify(d.overdrawn.slice(0, 5)));
  bar("V7 no v2 footer row is negative", negative.length === 0, JSON.stringify(negative.slice(0, 5)));

  console.log(`\nreported, not failed: ${drift} sent_7d/30d/90d / fresh_pool value(s) differ between the two snapshots (they slide with now()).`);
  console.log(fail === 0 ? "\nverify-offer-report-v2 OK." : `\n${fail} bar(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
