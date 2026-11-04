import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql, type SQL } from "drizzle-orm";

import { db } from "../db/client";
import { requirePreviewDb } from "./_require-preview-db";
import {
  approvedRevenueClause,
  pendingRevenueClause,
  purchasedClause,
} from "../lib/sale-attribution";
import { seedConversionEvent } from "./_conversion-fixture";

// =============================================================================
// MIGRATION 0231 — the v2 report matviews move each conversion to its own offer.
//
// One tracked campaign of offer A sends one stage to four recipients. Its
// ledger holds an own-offer sale and four conversions that Keitaro put on
// offer B (which has NO campaign of its own — the 82/124 shape on prod): two
// approved, one pending, one with no recipient (stage-level only). One
// recipient sits in BOTH targeted groups, so the group grain fans out and the
// footer grain must not. A rejected row on offer D moves nothing and must mint
// nothing. Offer C is a control campaign with no split at all.
//
// The test builds the v2 views FROM THE MIGRATION FILE (old 0183 views stay as
// deployed), refreshes old and v2 inside ONE transaction that always rolls
// back, and asserts:
//   A + B = the stage, at both footer halves and per group;
//   footer stage half = ledger half + the stage-only conversion, per offer;
//   Audience Stats rows identical old vs v2; control offer identical old vs v2;
//   the stage_sends passes (rate / attr / attributable) are byte-identical to
//   the installed old views (pg_get_viewdef), so the refresh cost cannot grow;
//   offer_split_amounts_v agrees with lib/sale-attribution.ts's clauses (R3).
//
// PREVIEW DB ONLY:
//   node scripts/with-preview-env.mjs npx tsx scripts/test-offer-report-split-db.ts
// RED PROOF (mutated copies of the SQL held in memory; the file is never written):
//   node scripts/with-preview-env.mjs npx tsx scripts/test-offer-report-split-db.ts --red
// =============================================================================

const MIGRATION_PATH = resolve(process.cwd(), "db/migrations/0231_offer_report_conversion_offer.sql");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
class Rollback extends Error {}

function statements(text: string): string[] {
  const out = text
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.split("\n").some((l) => l.trim() && !l.trim().startsWith("--")));
  // Guard the guard: a parser that silently matched nothing would test the
  // catalog, not the file. 1 SET + view + REVOKE + 3 x (create, index, revoke) + 1 INSERT.
  if (out.length !== 13) throw new Error(`expected 13 statements in 0231, found ${out.length}`);
  return out;
}

// ── mutations for the red proof ──────────────────────────────────────────────
const SPLIT_PRED = "AND ce.offer_id IS DISTINCT FROM xc.offer_id\n    )";
interface Mutation { name: string; what: string; apply: (t: string) => string; expectRed: string[] }
const MUTATIONS: Mutation[] = [
  {
    name: "conv-keeps-split",
    what: "`conv` stops excluding split rows (both matviews) — the moved money is counted twice",
    apply: (t) => t.split(SPLIT_PRED).join("AND false\n    )"),
    expectRed: ["footer-ledger-conserved", "group-conserved", "group-cells", "audience-unchanged", "footer-halves-agree"],
  },
  {
    name: "no-moved",
    what: "the group view's `moved` CTE contributes nothing — split money vanishes from the cells",
    apply: (t) => t.replace("  WHERE ss.status = 'sent'\n  GROUP BY camp.org_id, ce.offer_id, ccg.contact_group_id",
      "  WHERE false\n  GROUP BY camp.org_id, ce.offer_id, ccg.contact_group_id"),
    expectRed: ["group-conserved", "group-cells", "audience-unchanged"],
  },
  {
    name: "base-no-subtract",
    what: "the footer adds the split to the target offer but never takes it off the campaign's offer",
    apply: (t) => t.replace("SELECT s.org_id, s.campaign_offer_id, 0, -s.revenue, -s.sales, 0, 0, NULL::boolean",
      "SELECT s.org_id, s.campaign_offer_id, 0, 0 * s.revenue, 0 * s.sales, 0, 0, NULL::boolean"),
    expectRed: ["footer-stage-conserved", "footer-split", "footer-halves-agree"],
  },
  {
    name: "no-attributable-moved",
    what: "the footer's ledger half drops the moved conversions",
    apply: (t) => t.replace("\n  WHERE ss.status = 'sent'\n    AND EXISTS (", "\n  WHERE false\n    AND EXISTS ("),
    expectRed: ["footer-ledger-conserved", "footer-halves-agree"],
  },
  {
    name: "fresh-from-attr",
    what: "the fresh pool reads its offer list from `attr` again — a moved-only offer gets fresh_pool 0",
    apply: (t) => t.replace("FROM (SELECT DISTINCT org_id, offer_id FROM cells) o", "FROM (SELECT DISTINCT org_id, offer_id FROM attr) o"),
    expectRed: ["moved-offer-fresh"],
  },
  {
    name: "attr-drift",
    what: "the expensive stage_sends pass is edited (sent_7d window) — no longer the installed one",
    apply: (t) => t.replace("ss.sent_at >= now() - interval '7 days')::bigint  AS sent_7d,\n    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,\n    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d\n  FROM public.stage_sends ss",
      "ss.sent_at >= now() - interval '8 days')::bigint  AS sent_7d,\n    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,\n    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d\n  FROM public.stage_sends ss"),
    expectRed: ["stage-sends-pass-identical"],
  },
  {
    name: "split-view-pending-into-revenue",
    what: "offer_split_amounts_v counts pending money as revenue",
    apply: (t) => t.replace("        AND ce.status = 'approved'\n    ), 0)::numeric(14,4) AS revenue,\n    COALESCE(SUM(ce.revenue) FILTER (\n      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)\n        AND ce.status = 'pending'\n    ), 0)::numeric(14,4) AS pending_revenue\n  FROM public.conversion_events ce\n  JOIN public.campaign_stages cs",
      "        AND ce.status IN ('approved', 'pending')\n    ), 0)::numeric(14,4) AS revenue,\n    COALESCE(SUM(ce.revenue) FILTER (\n      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)\n        AND ce.status = 'pending'\n    ), 0)::numeric(14,4) AS pending_revenue\n  FROM public.conversion_events ce\n  JOIN public.campaign_stages cs"),
    expectRed: ["split-view-parity", "footer-split", "footer-halves-agree"],
  },
  {
    name: "split-view-mints-zero",
    what: "offer_split_amounts_v keeps a split that moves nothing — the rejected offer-D row mints a footer row",
    apply: (t) => t.replace("WHERE s.sales <> 0 OR s.revenue <> 0 OR s.pending_revenue <> 0;", "WHERE true;"),
    expectRed: ["no-zero-rows"],
  },
];

// ── fixture ──────────────────────────────────────────────────────────────────
interface Fx {
  orgId: string; offerA: number; offerB: number; offerC: number; offerD: number;
  g1: number; g2: number; stageA: number; stageC: number;
}

async function seed(tx: Tx): Promise<Fx> {
  const one = async <T>(q: SQL): Promise<T> => ((await tx.execute(q)) as unknown as T[])[0];
  const tag = randomUUID().slice(0, 8);
  const { id: orgId } = await one<{ id: string }>(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`);
  const { id: networkId } = await one<{ id: number }>(sql`SELECT id FROM affiliate_networks WHERE org_id = ${orgId}::uuid ORDER BY id LIMIT 1`);
  const offer = async (n: string) => (await one<{ id: number }>(sql`
    INSERT INTO offers (org_id, offer_id, name, network_id)
    VALUES (${orgId}::uuid, ${`t8-${n}-${tag}`}, ${`T8 ${n} ${tag}`}, ${networkId}) RETURNING id`)).id;
  const offerA = await offer("a"), offerB = await offer("b"), offerC = await offer("c"), offerD = await offer("d");
  const group = async (n: string) => (await one<{ id: number }>(sql`
    INSERT INTO contact_groups (org_id, contact_group_id, name, allow_voip, allow_unknown, allow_toll_free)
    VALUES (${orgId}::uuid, ${`t8-${n}-${tag}`}, ${`T8 ${n} ${tag}`}, true, true, true) RETURNING id`)).id;
  const g1 = await group("g1"), g2 = await group("g2");

  // c1 g1 · c2 g1 · c3 g2 · c4 g1+g2 (the fan-out recipient)
  const member: Record<string, number[]> = { c1: [g1], c2: [g1], c3: [g2], c4: [g1, g2] };
  const contact: Record<string, string> = {};
  for (const [i, k] of Object.keys(member).entries()) {
    contact[k] = (await one<{ id: string }>(sql`
      INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1998${tag.slice(0, 3)}${1000 + i}`})
      RETURNING id::text AS id`)).id;
    for (const g of member[k]) {
      await tx.execute(sql`INSERT INTO contact_contact_groups (org_id, contact_id, contact_group_id)
        VALUES (${orgId}::uuid, ${contact[k]}::uuid, ${g})`);
    }
  }
  const campaign = async (offerId: number, label: string) => {
    const { id: campaignId } = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, offer_id, link_mode, status, audience_contact_group_ids)
      VALUES (${orgId}::uuid, ${`t8-${label}-${tag}`}, ${`T8 ${label} ${tag}`}, ${offerId}, 'tracked', 'active',
              ${sql.raw(`ARRAY[${g1},${g2}]::int[]`)}) RETURNING id`);
    const { id: stageId } = await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, status, sent_at, total_cost)
      VALUES (${orgId}::uuid, ${campaignId}, 1, 'sent', now(), 8.0000) RETURNING id`);
    return { campaignId, stageId };
  };
  const ca = await campaign(offerA, "ca");
  const cc = await campaign(offerC, "cc");
  const send = async (c: { campaignId: number; stageId: number }, k: string) => (await one<{ id: string }>(sql`
    INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
    VALUES (${orgId}::uuid, ${c.campaignId}, ${c.stageId}, ${contact[k]}::uuid, '+19985550000', 'fixture', 'sent', now())
    RETURNING id::text AS id`)).id;
  const s: Record<string, string> = {};
  for (const k of Object.keys(member)) s[k] = await send(ca, k);
  const sc1 = await send(cc, "c1");

  const ev = (o: Parameters<typeof seedConversionEvent>[1]) => seedConversionEvent(tx, o);
  const onA = { orgId, campaignId: ca.campaignId, stageId: ca.stageId };
  await ev({ ...onA, offerId: offerA, stageSendId: s.c1, eventKey: "purchase", status: "approved", revenue: 100 });
  await ev({ ...onA, offerId: offerB, stageSendId: s.c2, eventKey: "purchase", status: "approved", revenue: 40 });
  await ev({ ...onA, offerId: offerB, stageSendId: s.c3, eventKey: "purchase", status: "pending", revenue: 10 });
  await ev({ ...onA, offerId: offerB, stageSendId: s.c4, eventKey: "purchase", status: "approved", revenue: 25 });
  await ev({ ...onA, offerId: offerB, stageSendId: null, contactId: null, eventKey: "purchase", status: "approved", revenue: 5 });
  await ev({ ...onA, offerId: offerD, stageSendId: s.c1, eventKey: "purchase", status: "rejected", revenue: 99 });
  await ev({ orgId, campaignId: cc.campaignId, stageId: cc.stageId, offerId: offerC, stageSendId: sc1,
    eventKey: "purchase", status: "approved", revenue: 30 });

  // Keitaro's stage aggregate (the footer's stage half): approved revenue and
  // counted purchases of everything on the stage, whatever offer it is on.
  const ksr = async (c: { campaignId: number; stageId: number }, sales: number, revenue: number) => tx.execute(sql`
    INSERT INTO keitaro_stage_results (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue)
    VALUES (${orgId}::uuid, ${c.campaignId}, ${c.stageId}, ${`t8-${tag}-${c.stageId}`}, current_date, ${sales}, ${revenue})`);
  await ksr(ca, 5, 170);
  await ksr(cc, 1, 30);
  return { orgId, offerA, offerB, offerC, offerD, g1, g2, stageA: ca.stageId, stageC: cc.stageId };
}

// ── run ──────────────────────────────────────────────────────────────────────
interface Run { passed: string[]; failed: string[]; lines: string[] }

/** The body of a top-level CTE `name AS (` … in pg_get_viewdef output, up to the next top-level CTE. */
function cteBody(def: string, name: string, next: string): string {
  const a = def.indexOf(`${name} AS (`);
  const b = def.indexOf(`), ${next} AS `, a);
  if (a < 0 || b < 0) return `<${name} not found>`;
  return def.slice(a + name.length, b).replace(/\s+/g, " ").trim();
}

async function runOnce(text: string, quiet: boolean): Promise<Run> {
  const run: Run = { passed: [], failed: [], lines: [] };
  const check = (id: string, ok: boolean, detail: string) => {
    (ok ? run.passed : run.failed).push(id);
    run.lines.push(`  ${ok ? "PASS" : "FAIL"}  ${id} — ${detail}`);
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      const fx = await seed(tx);
      // Test the FILE, not whatever the preview deploy already installed.
      for (const d of [
        "DROP MATERIALIZED VIEW IF EXISTS public.audience_report_group_totals_v2_mv",
        "DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_v2_mv",
        "DROP MATERIALIZED VIEW IF EXISTS public.offer_report_offer_totals_v2_mv",
        "DROP VIEW IF EXISTS public.offer_split_amounts_v",
      ]) await tx.execute(sql.raw(d));
      for (const st of statements(text)) await tx.execute(sql.raw(st));
      for (const mv of [
        "offer_group_report_mv", "audience_report_group_totals_mv", "offer_report_offer_totals_mv",
        "offer_group_report_v2_mv", "audience_report_group_totals_v2_mv", "offer_report_offer_totals_v2_mv",
      ]) await tx.execute(sql.raw(`REFRESH MATERIALIZED VIEW public.${mv}`));

      const q = async <T>(s: SQL) => (await tx.execute(s)) as unknown as T[];
      const offers = [fx.offerA, fx.offerB, fx.offerC, fx.offerD];
      type Cell = { offer_id: number; group_id: number; sends: number; sales: number; revenue: number; pending: number; cost: number; clicks: number; optouts: number; fresh: number; s7: number };
      const cells = (mv: string) => q<Cell>(sql`
        SELECT offer_id, group_id, sends::int, sales::int, revenue::float8 AS revenue, pending_revenue::float8 AS pending,
               cost::float8 AS cost, clicks::int, optouts::int, fresh_pool::int AS fresh, sent_7d::int AS s7
        FROM ${sql.raw(mv)} WHERE org_id = ${fx.orgId}::uuid AND offer_id IN (${sql.join(offers.map((o) => sql`${o}`), sql`, `)})`);
      const oldCells = await cells("offer_group_report_mv");
      const v2Cells = await cells("offer_group_report_v2_mv");
      type Foot = { offer_id: number; sends: number; revenue: number; sales: number; cost: number; has_manual: boolean; a_sends: number; a_rev: number; a_sales: number; a_pend: number };
      const foot = (mv: string) => q<Foot>(sql`
        SELECT offer_id, sends::int, revenue::float8 AS revenue, sales::int, cost::float8 AS cost, has_manual_stages AS has_manual,
               attributable_sends::int AS a_sends, attributable_revenue::float8 AS a_rev,
               attributable_sales::int AS a_sales, attributable_pending_revenue::float8 AS a_pend
        FROM ${sql.raw(mv)} WHERE org_id = ${fx.orgId}::uuid AND offer_id IN (${sql.join(offers.map((o) => sql`${o}`), sql`, `)})`);
      const oldFoot = await foot("offer_report_offer_totals_mv");
      const v2Foot = await foot("offer_report_offer_totals_v2_mv");
      const f = (rows: Foot[], o: number) => rows.find((r) => r.offer_id === o);
      const c = (rows: Cell[], o: number, g: number) => rows.find((r) => r.offer_id === o && r.group_id === g);
      const j = (x: unknown) => JSON.stringify(x ?? null);

      // ── footer, stage half (Keitaro): A + B = the stage; split amounts move.
      const vA = f(v2Foot, fx.offerA), vB = f(v2Foot, fx.offerB), oA = f(oldFoot, fx.offerA);
      check("footer-stage-conserved",
        !!vA && !!vB && !!oA && vA.revenue + vB.revenue === 170 && oA.revenue === 170 && vA.sales + vB.sales === 5 && !f(oldFoot, fx.offerB),
        `A ${vA?.revenue}+B ${vB?.revenue} = ${(vA?.revenue ?? 0) + (vB?.revenue ?? 0)} (old A ${oA?.revenue}); sales ${vA?.sales}+${vB?.sales}`);
      check("footer-split",
        !!vA && !!vB && vA.revenue === 100 && vA.sales === 1 && vB.revenue === 70 && vB.sales === 4 &&
          vB.sends === 0 && vB.cost === 0 && vB.has_manual === false && vA.sends === 4 && vA.cost === oA?.cost,
        `A ${j(vA)} · B ${j(vB)} (want A $100/1 sale/4 sends, B $70/4 sales/0 sends)`);
      // ── footer, ledger half: deduped per send (c4 counts once), A + B = old A.
      check("footer-ledger-conserved",
        !!vA && !!vB && !!oA && vA.a_rev + vB.a_rev === oA.a_rev && vA.a_sales + vB.a_sales === oA.a_sales &&
          vA.a_pend + vB.a_pend === oA.a_pend && vA.a_sends === oA.a_sends && vB.a_sends === 0 &&
          vA.a_rev === 100 && vB.a_rev === 65 && vB.a_pend === 10 && vB.a_sales === 3,
        `attributable A $${vA?.a_rev}/${vA?.a_sales} + B $${vB?.a_rev}/${vB?.a_sales} pend ${vB?.a_pend} (old A $${oA?.a_rev}/${oA?.a_sales})`);
      // ── the two halves agree: stage half = ledger half + the stage-only conversion ($5, 1 sale on B).
      check("footer-halves-agree",
        !!vA && !!vB && vA.revenue === vA.a_rev && vB.revenue === vB.a_rev + 5 && vA.sales === vA.a_sales && vB.sales === vB.a_sales + 1,
        `A ${vA?.revenue} vs ${vA?.a_rev}; B ${vB?.revenue} vs ${vB?.a_rev} + 5 stage-only`);

      // ── group cells: footer revenue = Σ group rows, once the fan-out recipient (c4, $25 on B, in g1 AND g2) is counted twice.
      const sum = (rows: Cell[], o: number) => rows.filter((r) => r.offer_id === o).reduce((a, r) => a + r.revenue, 0);
      const want = {
        a1: { sends: 3, revenue: 100, sales: 1, pending: 0 }, a2: { sends: 2, revenue: 0, sales: 0, pending: 0 },
        b1: { sends: 0, revenue: 65, sales: 2, pending: 0 }, b2: { sends: 0, revenue: 25, sales: 2, pending: 10 },
      };
      const got = {
        a1: c(v2Cells, fx.offerA, fx.g1), a2: c(v2Cells, fx.offerA, fx.g2),
        b1: c(v2Cells, fx.offerB, fx.g1), b2: c(v2Cells, fx.offerB, fx.g2),
      };
      const match = (g?: Cell, w?: { sends: number; revenue: number; sales: number; pending: number }) =>
        !!g && !!w && g.sends === w.sends && g.revenue === w.revenue && g.sales === w.sales && g.pending === w.pending;
      check("group-cells",
        match(got.a1, want.a1) && match(got.a2, want.a2) && match(got.b1, want.b1) && match(got.b2, want.b2) &&
          sum(v2Cells, fx.offerA) === vA?.a_rev && sum(v2Cells, fx.offerB) === (vB?.a_rev ?? 0) + 25 &&
          got.b1?.cost === 0 && got.b1?.clicks === 0 && got.b1?.s7 === 0,
        `A g1 ${j(got.a1)} g2 ${j(got.a2)} · B g1 ${j(got.b1)} g2 ${j(got.b2)}`);
      // ── per group, Σ over offers is conserved (sends, cost, money).
      const groupSum = (rows: Cell[], g: number) => rows.filter((r) => r.group_id === g)
        .reduce((a, r) => ({ sends: a.sends + r.sends, cost: a.cost + r.cost, revenue: a.revenue + r.revenue, sales: a.sales + r.sales, pending: a.pending + r.pending }),
          { sends: 0, cost: 0, revenue: 0, sales: 0, pending: 0 });
      const conserved = [fx.g1, fx.g2].every((g) => j(groupSum(oldCells, g)) === j(groupSum(v2Cells, g)));
      check("group-conserved", conserved,
        `g1 old ${j(groupSum(oldCells, fx.g1))} v2 ${j(groupSum(v2Cells, fx.g1))}; g2 old ${j(groupSum(oldCells, fx.g2))} v2 ${j(groupSum(v2Cells, fx.g2))}`);
      // ── a moved-only offer's rows carry a fresh pool (they read the offer list from `cells`).
      const [direct] = await q<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM contacts ct JOIN contact_contact_groups ccg ON ccg.contact_id = ct.id AND ccg.org_id = ct.org_id
        WHERE ccg.contact_group_id = ${fx.g1} AND ct.messaging_status = 'eligible'
          AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.contact_id = ct.id AND o.org_id = ct.org_id)
          AND NOT EXISTS (SELECT 1 FROM offer_exposures e WHERE e.contact_id = ct.id AND e.offer_id = ${fx.offerB})`);
      check("moved-offer-fresh", !!got.b1 && direct.n > 0 && got.b1.fresh === direct.n,
        `B g1 fresh_pool ${got.b1?.fresh} (direct count ${direct.n})`);

      // ── Audience Stats: identical, every column, for the fixture groups.
      const aud = (mv: string) => q<Record<string, unknown>>(sql`
        SELECT group_id, sends, revenue::text, pending_revenue::text, sales, clicks, cost::text, optouts, sent_7d, sent_30d, sent_90d
        FROM ${sql.raw(mv)} WHERE org_id = ${fx.orgId}::uuid AND group_id IN (${fx.g1}, ${fx.g2}) ORDER BY group_id`);
      const oldAud = await aud("audience_report_group_totals_mv"), v2Aud = await aud("audience_report_group_totals_v2_mv");
      check("audience-unchanged", oldAud.length === 2 && j(oldAud) === j(v2Aud), `old ${j(oldAud)} · v2 ${j(v2Aud)}`);

      // ── control offer C (no split): identical old vs v2, cells and footer.
      const ctlOld = oldCells.filter((r) => r.offer_id === fx.offerC), ctlV2 = v2Cells.filter((r) => r.offer_id === fx.offerC);
      check("control-identical",
        ctlOld.length === 1 && j(ctlOld.sort((a, b) => a.group_id - b.group_id)) === j(ctlV2.sort((a, b) => a.group_id - b.group_id)) &&
          j(f(oldFoot, fx.offerC)) === j(f(v2Foot, fx.offerC)) && f(v2Foot, fx.offerC)?.revenue === 30,
        `cells ${j(ctlV2)} · footer ${j(f(v2Foot, fx.offerC))}`);
      // ── a split that moves nothing (rejected, offer D) mints no row anywhere.
      check("no-zero-rows", !f(v2Foot, fx.offerD) && !v2Cells.some((r) => r.offer_id === fx.offerD),
        `offer D footer ${j(f(v2Foot, fx.offerD))}, cells ${v2Cells.filter((r) => r.offer_id === fx.offerD).length}`);

      // ── the stage_sends passes are the installed old views' text, node for node.
      const def = async (v: string) => (await q<{ d: string }>(sql`SELECT pg_get_viewdef(${`public.${v}`}::regclass, true) AS d`))[0].d;
      const [gOld, gV2, tOld, tV2] = await Promise.all([
        def("offer_group_report_mv"), def("offer_group_report_v2_mv"), def("offer_report_offer_totals_mv"), def("offer_report_offer_totals_v2_mv"),
      ]);
      const pairs: [string, string, string][] = [
        ["rate", cteBody(gOld, "rate", "conv"), cteBody(gV2, "rate", "conv")],
        ["attr", cteBody(gOld, "attr", "cell_clicks"), cteBody(gV2, "attr", "split_ce")],
        ["attributable", cteBody(tOld, "attributable", "offer_tracked"), cteBody(tV2, "attributable_own", "split_ce")],
      ];
      const bad = pairs.filter(([, a, b]) => a !== b || a.startsWith("<"));
      check("stage-sends-pass-identical", bad.length === 0,
        bad.length === 0 ? "rate, attr, attributable: pg_get_viewdef identical to the installed views" : `differs: ${bad.map((p) => p[0]).join(", ")}`);

      // ── R3: offer_split_amounts_v vs lib/sale-attribution.ts's clauses over getOfferSplits' selection.
      const [par] = await q<{ v: string; t: string }>(sql`
        SELECT
          (SELECT json_agg(x ORDER BY x.stage_id, x.offer_id)::text FROM (
             SELECT stage_id, campaign_offer_id, offer_id, sales::int, revenue::float8 AS revenue, pending_revenue::float8 AS pending
             FROM offer_split_amounts_v WHERE org_id = ${fx.orgId}::uuid AND stage_id IN (${fx.stageA}, ${fx.stageC})) x) AS v,
          (SELECT json_agg(x ORDER BY x.stage_id, x.offer_id)::text FROM (
             SELECT ce.stage_id, ca.offer_id AS campaign_offer_id, ce.offer_id,
                    count(*) FILTER (WHERE ${purchasedClause()})::int AS sales,
                    coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::float8 AS revenue,
                    coalesce(sum(ce.revenue) FILTER (WHERE ${pendingRevenueClause()}), 0)::float8 AS pending
             FROM conversion_events ce
             JOIN campaign_stages cs ON cs.id = ce.stage_id AND cs.org_id = ce.org_id
             JOIN campaigns ca ON ca.id = cs.campaign_id AND ca.org_id = ce.org_id
             WHERE ce.org_id = ${fx.orgId}::uuid AND ce.stage_id IN (${fx.stageA}, ${fx.stageC})
               AND ce.offer_id IS NOT NULL AND ce.offer_id IS DISTINCT FROM ca.offer_id
             GROUP BY ce.stage_id, ca.offer_id, ce.offer_id
             HAVING count(*) FILTER (WHERE ${purchasedClause()}) <> 0
                 OR coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0) <> 0
                 OR coalesce(sum(ce.revenue) FILTER (WHERE ${pendingRevenueClause()}), 0) <> 0) x) AS t`);
      check("split-view-parity", par.v === par.t && par.v !== null && par.v.includes("\"revenue\":70"),
        `view ${par.v} · clauses ${par.t}`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) {
      if (quiet) { run.lines.push(`  ERROR ${(e as Error).message.split("\n")[0]}`); return run; }
      throw e;
    }
  }
  return run;
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const text = readFileSync(MIGRATION_PATH, "utf8");
  if (!process.argv.includes("--red")) {
    console.log("=== 0231's v2 matviews, built from the file, over a seeded split stage ===");
    const r = await runOnce(text, false);
    for (const l of r.lines) console.log(l);
    console.log(`\n${r.passed.length} passed, ${r.failed.length} failed.`);
    process.exit(r.failed.length === 0 && r.passed.length > 0 ? 0 : 1);
  }
  console.log("=== RED PROOF: every assertion, against a deliberately broken 0231 ===\n");
  const green = await runOnce(text, false);
  if (green.failed.length > 0) {
    for (const l of green.lines) console.log(l);
    console.log("FAIL: the unmutated run is not green.");
    process.exit(1);
  }
  const wentRed = new Set<string>();
  let bad = 0;
  for (const m of MUTATIONS) {
    const mutated = m.apply(text);
    if (mutated === text) { console.log(`  BROKEN MUTATION  ${m.name} — changed nothing`); bad++; continue; }
    const r = await runOnce(mutated, true);
    console.log(`  ${m.name} — ${m.what}`);
    const err = r.lines.find((l) => l.startsWith("  ERROR"));
    if (err) { console.log(`     BROKEN MUTATION — SQL did not run:${err.slice(7)}`); bad++; continue; }
    const failed = new Set(r.failed);
    const missing = m.expectRed.filter((id) => !failed.has(id));
    r.failed.forEach((id) => wentRed.add(id));
    if (missing.length) bad++;
    console.log(`     red: ${r.failed.join(", ") || "none"}  [${missing.length ? `MISSED ${missing.join(", ")}` : "ok"}]`);
  }
  const never = green.passed.filter((id) => !wentRed.has(id) && id !== "control-identical");
  console.log(`\n${wentRed.size}/${green.passed.length} assertions proved able to go red (control-identical is a non-regression guard).`);
  if (never.length) console.log(`NOT PROVED: ${never.join(", ")}`);
  process.exit(never.length === 0 && bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
