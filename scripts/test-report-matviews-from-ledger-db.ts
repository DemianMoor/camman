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
// THE THREE LEDGER-BACKED REPORT MATVIEWS, EXERCISED ON REAL CONVERSIONS.
//
// Migration 0183 rewrote offer_report_offer_totals_mv, offer_group_report_mv and
// audience_report_group_totals_mv to aggregate the conversion_events ledger.
// Until this file existed, NOTHING had ever run a conversion through them:
// camman-v2 holds zero ledger rows and production has no such table, so every
// check that passed was structural and never touched a number. This seeds the
// ledger, builds the matviews FROM THE MIGRATION FILE ITSELF, refreshes them and
// asserts where each dollar lands.
//
// It reads the DDL off disk rather than out of the catalog on purpose: the file
// is the thing under review, and the deployed definition on any given database
// may be older than it (see the report for camman-v2's case). So this asserts
// the migration as written, wherever it happens to be applied.
//
// REFRESH MATERIALIZED VIEW *without* CONCURRENTLY is transactional, and so is
// DDL in Postgres — so the drop/create/refresh/assert cycle runs entirely inside
// a transaction that always rolls back. CONCURRENTLY cannot run in a transaction
// block and is deliberately not used here.
//
// PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-report-matviews-from-ledger-db.ts
//
// RED PROOF — every assertion below must be ABLE to fail, or it is decoration:
//   … npx tsx scripts/test-report-matviews-from-ledger-db.ts --red
// runs the same fixtures against seven deliberately mutated copies of the
// migration's SQL (held in memory; the file on disk is never written) and
// requires each assertion to go red in at least one of them.
// =============================================================================

// The ./_require-preview-db import above is the refusal: an ALLOWLIST, so it
// also stops a raw IP, a pooler alias or a future prod project, which a re-typed
// "does the URL contain the prod ref?" test would wave straight through.
const MIGRATION_PATH = resolve(process.cwd(), "db/migrations/0183_report_views_from_ledger.sql");

// ── the migration's own SQL, as statements ───────────────────────────────────

/** The statement's first line that is not a comment — how a statement is typed. */
function firstCodeLine(stmt: string): string {
  for (const line of stmt.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("--")) return t;
  }
  return "";
}

/**
 * The matview DDL out of the migration, in file order. The REVOKEs, the
 * event_types backfill and the handle_new_user() replacement are not part of
 * what this test exercises and are skipped; everything else 0183 emits for the
 * three matviews is executed verbatim.
 */
function matviewStatements(text: string): string[] {
  const stmts = text
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => /^(DROP MATERIALIZED VIEW|CREATE MATERIALIZED VIEW|CREATE UNIQUE INDEX)/i.test(firstCodeLine(s)));
  // Guard the guard: a regex that silently matches nothing would make every
  // assertion below run against whatever is already in the catalog, which is
  // exactly the "it only ever passed structurally" failure this file exists to
  // end. 3 drops + 3 creates + 3 indexes.
  if (stmts.length !== 9) {
    throw new Error(`expected 9 matview statements in 0183, found ${stmts.length} — the parser or the file changed`);
  }
  return stmts;
}

/**
 * The three FILTER predicates the matviews carry, lifted out of the file text
 * in column order: purchases, revenue, pending_revenue.
 *
 * Scoped to the `conv` CTE body first, then split on FILTER, rather than
 * anchored on the surrounding aggregate calls: `attr` in the second matview has
 * three more `COUNT(*) FILTER (…)` of its own over `ss`, and anchoring on the
 * aggregate would silently grab one of those the moment the conv aggregate is
 * spelled differently.
 */
function migrationPredicates(text: string): { purchase: string; revenue: string; pending: string } {
  const blocks = [...text.matchAll(/\nconv AS \(\n([\s\S]*?)\n  FROM public\.conversion_events ce\n/g)].map((m) => m[1]);
  if (blocks.length !== 2) {
    throw new Error(`expected 2 conv CTEs in 0183, found ${blocks.length}`);
  }
  // The two matviews must carry the SAME definition, or "one definition,
  // copied" is already false before anything compares it to the TypeScript.
  if (blocks[0] !== blocks[1]) {
    throw new Error("the two conv CTEs in 0183 are not identical to each other");
  }
  const preds = [...blocks[0].matchAll(/FILTER \(\s*WHERE ([\s\S]*?)\s*\n {4}\)/g)].map((m) => m[1].trim());
  // Guard the guard: an empty predicate renders as `WHERE ` and would make the
  // parity check compare nothing against nothing.
  if (preds.length !== 3 || preds.some((p) => !p.includes("event_type_id"))) {
    throw new Error(`could not lift 3 predicates out of 0183's conv CTE (got ${JSON.stringify(preds)})`);
  }
  return { purchase: preds[0], revenue: preds[1], pending: preds[2] };
}

// ── deliberate mutations, for the red proof ──────────────────────────────────

const PURCHASE_TYPES = "ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)";
const REVENUE_TYPES = "ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)";
/** True for every row, unmapped ones included — the whole point of "blind". */
const ANY_TYPE = "(ce.event_type_id IS NULL OR ce.event_type_id IN (SELECT id FROM public.event_types))";
const ANY_STATUS = "ce.status IS NOT DISTINCT FROM ce.status";
/** Only the conv CTE's COUNT(*); `attr` has three more, over `ss`, not `ce`. */
const CONV_COUNT = "COUNT(*) FILTER (\n      WHERE ce.event_type_id";

interface Mutation {
  name: string;
  what: string;
  apply: (sqlText: string) => string;
  /** Assertion ids this mutation MUST turn red. */
  expectRed: string[];
}

const MUTATIONS: Mutation[] = [
  {
    name: "all-blind",
    what: "the purchase and revenue FILTERs lose BOTH their event-type and their status test, so every ledger row counts",
    apply: (t) =>
      t
        .split(PURCHASE_TYPES).join(ANY_TYPE)
        .split(REVENUE_TYPES).join(ANY_TYPE)
        .split("ce.status IN ('pending', 'approved')").join(ANY_STATUS)
        .split("ce.status = 'approved'").join(ANY_STATUS)
        .split("ce.status = 'pending'").join(ANY_STATUS),
    expectRed: ["registration", "pending", "rejected", "unmapped-null", "unmapped-approved", "offer-totals-x", "parity"],
  },
  {
    name: "pending-into-revenue",
    what: "approved-only revenue becomes approved-or-pending — pending money leaks into Revenue",
    apply: (t) => t.split("ce.status = 'approved'").join("ce.status IN ('approved', 'pending')"),
    expectRed: ["pending", "offer-totals-x", "offer-totals-y", "parity"],
  },
  {
    name: "counts-revenue-off",
    what: "the revenue event-type set is emptied — an approved purchase stops being revenue",
    apply: (t) => t.split("FROM public.event_types WHERE counts_revenue").join("FROM public.event_types WHERE counts_revenue AND FALSE"),
    expectRed: ["approved-purchase", "two-conversions", "offer-totals-x", "offer-totals-y", "parity"],
  },
  {
    name: "latest-wins",
    what: "the pre-ledger shape: one conversion per recipient, latest wins (COUNT DISTINCT send + MAX revenue)",
    apply: (t) =>
      t
        .split(CONV_COUNT).join("COUNT(DISTINCT ce.stage_send_id) FILTER (\n      WHERE ce.event_type_id")
        .split("SUM(ce.revenue) FILTER (").join("MAX(ce.revenue) FILTER ("),
    expectRed: ["two-conversions", "offer-totals-x", "offer-totals-y", "sales-exceed-sends"],
  },
  {
    name: "coalesce-one",
    what: "a recipient with NO ledger row is credited a purchase by the LEFT JOIN's COALESCE",
    apply: (t) => t.split("COALESCE(cv.purchases, 0)").join("COALESCE(cv.purchases, 1)"),
    expectRed: ["no-conversion", "offer-totals-x"],
  },
  {
    name: "break-additivity",
    what: "the audience totals stop being the sum of their offer cells",
    apply: (t) => t.split("SUM(revenue)::numeric(14,4) AS revenue").join("(SUM(revenue) + 1)::numeric(14,4) AS revenue"),
    expectRed: ["audience-additive"],
  },
  {
    name: "no-orgid",
    what: "the ledger join drops its org_id predicate (finding I1)",
    apply: (t) => t.split(" AND cv.org_id = camp.org_id").join(""),
    expectRed: ["org-scoped-join"],
  },
];

// ── the fixture ──────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Nine contact groups: one singleton per conversion case, plus an "all" group
 * holding every recipient. A singleton group makes each cell a single
 * recipient's story, so an assertion names exactly one case; the "all" group
 * makes the offer-grain dedup test a real one, because the naive sum of the
 * cells is then exactly twice the truth.
 */
const CASES = [
  { id: "approved-purchase", group: "g1", note: "approved purchase $100" },
  { id: "registration", group: "g2", note: "$0 registration, approved" },
  { id: "pending", group: "g3", note: "pending purchase $50" },
  { id: "rejected", group: "g4", note: "rejected purchase $70" },
  { id: "unmapped-null", group: "g5", note: "unmapped: NULL event type, NULL status, $30" },
  { id: "unmapped-approved", group: "g6", note: "unmapped: NULL event type, status approved, $40" },
  { id: "two-conversions", group: "g7", note: "TWO approved purchases, $25 + $35" },
  { id: "no-conversion", group: "g8", note: "sent, never converted" },
] as const;

interface Cell {
  sends: number;
  sales: number;
  revenue: number;
  pending: number;
}

/** offer X's cells, by group key. */
const EXPECT_X: Record<string, Cell> = {
  g1: { sends: 1, sales: 1, revenue: 100, pending: 0 },
  g2: { sends: 1, sales: 0, revenue: 0, pending: 0 },
  g3: { sends: 1, sales: 1, revenue: 0, pending: 50 },
  g4: { sends: 1, sales: 0, revenue: 0, pending: 0 },
  g5: { sends: 1, sales: 0, revenue: 0, pending: 0 },
  g6: { sends: 1, sales: 0, revenue: 0, pending: 0 },
  g7: { sends: 1, sales: 2, revenue: 60, pending: 0 },
  g8: { sends: 1, sales: 0, revenue: 0, pending: 0 },
  all: { sends: 8, sales: 4, revenue: 160, pending: 50 },
};
/** offer Y exists so the audience totals are a sum over TWO cells, not one. */
const EXPECT_Y: Record<string, Cell> = {
  all: { sends: 2, sales: 2, revenue: 7, pending: 3 },
  g1: { sends: 1, sales: 2, revenue: 7, pending: 3 },
};

interface Fixture {
  orgId: string;
  offerX: number;
  offerY: number;
  groups: Record<string, number>;
  ledgerRows: number;
}

async function seedFixture(tx: Tx): Promise<Fixture> {
  const one = async <T>(q: SQL): Promise<T> => ((await tx.execute(q)) as unknown as T[])[0];
  const tag = randomUUID().slice(0, 8);

  const { id: orgId } = await one<{ id: string }>(
    sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`,
  );
  const { id: networkId } = await one<{ id: number }>(
    sql`SELECT id FROM affiliate_networks WHERE org_id = ${orgId}::uuid ORDER BY id LIMIT 1`,
  );

  const mkOffer = async (n: string) =>
    (
      await one<{ id: number }>(sql`
        INSERT INTO offers (org_id, offer_id, name, network_id)
        VALUES (${orgId}::uuid, ${`t5-${n}-${tag}`}, ${`T5 fixture ${n} ${tag}`}, ${networkId})
        RETURNING id
      `)
    ).id;
  const offerX = await mkOffer("x");
  const offerY = await mkOffer("y");

  const groups: Record<string, number> = {};
  for (const key of [...CASES.map((c) => c.group), "all"]) {
    groups[key] = (
      await one<{ id: number }>(sql`
        INSERT INTO contact_groups (org_id, contact_group_id, name)
        VALUES (${orgId}::uuid, ${`t5-${key}-${tag}`}, ${`T5 ${key} ${tag}`})
        RETURNING id
      `)
    ).id;
  }

  // One contact per case, in its own singleton group AND in "all".
  const contactIds: Record<string, string> = {};
  for (const [i, c] of CASES.entries()) {
    const { id } = await one<{ id: string }>(sql`
      INSERT INTO contacts (org_id, phone_number)
      VALUES (${orgId}::uuid, ${`+1999${tag.slice(0, 3)}${String(1000 + i)}`})
      RETURNING id::text AS id
    `);
    contactIds[c.id] = id;
    for (const g of [groups[c.group], groups.all]) {
      await tx.execute(sql`
        INSERT INTO contact_contact_groups (org_id, contact_id, contact_group_id)
        VALUES (${orgId}::uuid, ${id}::uuid, ${g})
      `);
    }
  }

  const mkCampaign = async (offerId: number, gids: number[], label: string) => {
    const { id: campaignId } = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, offer_id, link_mode, status, audience_contact_group_ids)
      VALUES (${orgId}::uuid, ${`t5-${label}-${tag}`}, ${`T5 ${label} ${tag}`}, ${offerId}, 'tracked', 'active',
              ${sql.raw(`ARRAY[${gids.join(",")}]::int[]`)})
      RETURNING id
    `);
    const { id: stageId } = await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, status, sent_at, total_cost)
      VALUES (${orgId}::uuid, ${campaignId}, 1, 'sent', now(), 8.0000)
      RETURNING id
    `);
    return { campaignId, stageId };
  };

  // Campaign X targets every group, so each singleton cell is one recipient and
  // the "all" cell is all eight — the same sends counted twice, at two grains.
  const cx = await mkCampaign(offerX, Object.values(groups), "cx");
  // Campaign Y targets "all" and g1 only, and sends to two of the recipients.
  const cy = await mkCampaign(offerY, [groups.all, groups.g1], "cy");

  const send = async (c: { campaignId: number; stageId: number }, contactId: string) =>
    (
      await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${orgId}::uuid, ${c.campaignId}, ${c.stageId}, ${contactId}::uuid, '+19995550000', 'fixture', 'sent', now())
        RETURNING id::text AS id
      `)
    ).id;

  const sendX: Record<string, string> = {};
  for (const c of CASES) sendX[c.id] = await send(cx, contactIds[c.id]);
  const sendY1 = await send(cy, contactIds["approved-purchase"]);
  await send(cy, contactIds["no-conversion"]);

  // ── the ledger. Every money case in the spec, one recipient each. ──────────
  const ev = (o: Parameters<typeof seedConversionEvent>[1]) => seedConversionEvent(tx, o);
  const base = { orgId, campaignId: cx.campaignId, stageId: cx.stageId, offerId: offerX };

  await ev({ ...base, stageSendId: sendX["approved-purchase"], eventKey: "purchase", status: "approved", revenue: 100 });
  await ev({ ...base, stageSendId: sendX["registration"], eventKey: "registration", status: "approved", revenue: 0 });
  await ev({ ...base, stageSendId: sendX["pending"], eventKey: "purchase", status: "pending", revenue: 50 });
  await ev({ ...base, stageSendId: sendX["rejected"], eventKey: "purchase", status: "rejected", revenue: 70 });
  // Shape (a): no mapping rule matched at all.
  await ev({ ...base, stageSendId: sendX["unmapped-null"], revenue: 30 });
  // Shape (b): a "status transition only" rule — a real status, still no event
  // type (lib/conversions/build-rows.ts:5-7,140). Counts as nothing, same as (a).
  await ev({ ...base, stageSendId: sendX["unmapped-approved"], status: "approved", revenue: 40 });
  await ev({ ...base, stageSendId: sendX["two-conversions"], eventKey: "purchase", status: "approved", revenue: 25 });
  await ev({ ...base, stageSendId: sendX["two-conversions"], eventKey: "purchase", status: "approved", revenue: 35 });

  const baseY = { orgId, campaignId: cy.campaignId, stageId: cy.stageId, offerId: offerY };
  await ev({ ...baseY, stageSendId: sendY1, eventKey: "purchase", status: "approved", revenue: 7 });
  await ev({ ...baseY, stageSendId: sendY1, eventKey: "purchase", status: "pending", revenue: 3 });

  return { orgId, offerX, offerY, groups, ledgerRows: 10 };
}

// ── the run ──────────────────────────────────────────────────────────────────

class Rollback extends Error {}

interface Run {
  failed: string[];
  passed: string[];
  lines: string[];
}

async function runOnce(sqlText: string, quiet: boolean): Promise<Run> {
  const run: Run = { failed: [], passed: [], lines: [] };
  const check = (id: string, ok: boolean, detail: string) => {
    (ok ? run.passed : run.failed).push(id);
    run.lines.push(`  ${ok ? "PASS" : "FAIL"}  ${id} — ${detail}`);
  };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '180s'`);
      const fx = await seedFixture(tx);

      const seeded = (
        (await tx.execute(sql`SELECT count(*)::int AS n FROM conversion_events`)) as unknown as { n: number }[]
      )[0].n;
      if (seeded !== fx.ledgerRows) {
        throw new Error(`expected exactly ${fx.ledgerRows} ledger rows in scope, found ${seeded}`);
      }

      // Build the three matviews FROM THE MIGRATION, then refresh them — the
      // refresh is the path the cron takes, and it must agree with the CREATE.
      for (const stmt of matviewStatements(sqlText)) await tx.execute(sql.raw(stmt));
      for (const mv of ["offer_report_offer_totals_mv", "offer_group_report_mv", "audience_report_group_totals_mv"]) {
        await tx.execute(sql.raw(`REFRESH MATERIALIZED VIEW public.${mv}`));
      }

      // ── A0. the org_id join predicate (finding I1), read back from the catalog
      const defs = (await tx.execute(sql`
        SELECT matviewname, definition FROM pg_matviews
        WHERE schemaname = 'public'
          AND matviewname IN ('offer_report_offer_totals_mv', 'offer_group_report_mv')
      `)) as unknown as { matviewname: string; definition: string }[];
      const orgJoined = defs.filter((d) => /cv\.org_id\s*=\s*camp\.org_id/.test(d.definition));
      check(
        "org-scoped-join",
        defs.length === 2 && orgJoined.length === 2,
        `${orgJoined.length}/2 ledger joins carry cv.org_id = camp.org_id (CLAUDE.md §3)`,
      );

      // ── the cells
      const cells = (await tx.execute(sql`
        SELECT offer_id, group_id, sends::int AS sends, sales::int AS sales,
               revenue::float8 AS revenue, pending_revenue::float8 AS pending
        FROM offer_group_report_mv
        WHERE org_id = ${fx.orgId}::uuid AND offer_id IN (${fx.offerX}, ${fx.offerY})
      `)) as unknown as { offer_id: number; group_id: number; sends: number; sales: number; revenue: number; pending: number }[];
      const cellFor = (offer: number, group: number) => cells.find((c) => c.offer_id === offer && c.group_id === group);
      const show = (c?: Cell | { sends: number; sales: number; revenue: number; pending: number }) =>
        c ? `sends ${c.sends} · sales ${c.sales} · $${c.revenue} · pending $${c.pending}` : "NO ROW";
      const same = (a: Cell | undefined, b: Cell) =>
        !!a && a.sends === b.sends && a.sales === b.sales && a.revenue === b.revenue && a.pending === b.pending;

      for (const c of CASES) {
        const got = cellFor(fx.offerX, fx.groups[c.group]);
        const want = EXPECT_X[c.group];
        check(c.id, same(got, want), `${c.note} → ${show(got)} (want ${show(want)})`);
      }

      const gotAll = cellFor(fx.offerX, fx.groups.all);
      check(
        "all-group-cell",
        same(gotAll, EXPECT_X.all),
        `the eight recipients as one cell → ${show(gotAll)} (want ${show(EXPECT_X.all)})`,
      );

      // ── the offer footer: DISTINCT recipients, NOT the sum of the cells.
      const totals = (await tx.execute(sql`
        SELECT offer_id, attributable_sends::int AS sends, attributable_sales::int AS sales,
               attributable_revenue::float8 AS revenue, attributable_pending_revenue::float8 AS pending
        FROM offer_report_offer_totals_mv
        WHERE org_id = ${fx.orgId}::uuid AND offer_id IN (${fx.offerX}, ${fx.offerY})
      `)) as unknown as { offer_id: number; sends: number; sales: number; revenue: number; pending: number }[];
      const totX = totals.find((t) => t.offer_id === fx.offerX);
      const totY = totals.find((t) => t.offer_id === fx.offerY);
      const sumCells = (offer: number): Cell =>
        cells.filter((c) => c.offer_id === offer).reduce(
          (a, c) => ({ sends: a.sends + c.sends, sales: a.sales + c.sales, revenue: a.revenue + c.revenue, pending: a.pending + c.pending }),
          { sends: 0, sales: 0, revenue: 0, pending: 0 },
        );
      check(
        "offer-totals-x",
        same(totX, EXPECT_X.all) && sumCells(fx.offerX).revenue !== EXPECT_X.all.revenue,
        `footer ${show(totX)} = the DISTINCT truth, not the ${show(sumCells(fx.offerX))} the cells sum to ` +
          `(every recipient sits in two targeted groups)`,
      );
      check(
        "offer-totals-y",
        same(totY, EXPECT_Y.all),
        `second offer's footer → ${show(totY)} (want ${show(EXPECT_Y.all)})`,
      );

      // ── the audience totals ARE the sum of the cells, for every group.
      const [add] = (await tx.execute(sql`
        WITH s AS (
          SELECT org_id, group_id, SUM(sends) AS sends, SUM(sales) AS sales,
                 SUM(revenue) AS revenue, SUM(pending_revenue) AS pending_revenue
          FROM offer_group_report_mv GROUP BY org_id, group_id
        )
        SELECT count(*)::int AS groups,
               count(*) FILTER (
                 WHERE t.group_id IS NULL OR s.group_id IS NULL
                    OR t.sends <> s.sends OR t.sales <> s.sales
                    OR t.revenue <> s.revenue OR t.pending_revenue <> s.pending_revenue
               )::int AS mismatched
        FROM audience_report_group_totals_mv t
        FULL JOIN s ON s.org_id = t.org_id AND s.group_id = t.group_id
      `)) as unknown as { groups: number; mismatched: number }[];
      const [multi] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM (
          SELECT group_id FROM offer_group_report_mv GROUP BY org_id, group_id HAVING count(*) > 1
        ) x
      `)) as unknown as { n: number }[];
      check(
        "audience-additive",
        add.mismatched === 0 && add.groups > 0 && multi.n > 0,
        `sends/sales/revenue/pending_revenue: ${add.groups - add.mismatched}/${add.groups} groups equal their cell sums ` +
          `(${multi.n} of them summing more than one offer cell)`,
      );

      // ── sales is per-EVENT now, so a cell's Sales can exceed its Sends.
      const yg1 = cellFor(fx.offerY, fx.groups.g1);
      check(
        "sales-exceed-sends",
        !!yg1 && yg1.sales > yg1.sends && yg1.sales === EXPECT_Y.g1.sales,
        `one recipient, two purchases → ${show(yg1)}: Sales exceeds Sends by design`,
      );

      // ── the predicates the matview carries vs the ones the app imports.
      const p = migrationPredicates(sqlText);
      const [par] = (await tx.execute(sql`
        SELECT count(*)::int AS rows,
          count(*) FILTER (WHERE (${sql.raw(p.purchase)}) IS DISTINCT FROM (${purchasedClause("ce")}))::int AS d_purchase,
          count(*) FILTER (WHERE (${sql.raw(p.revenue)}) IS DISTINCT FROM (${approvedRevenueClause("ce")}))::int AS d_revenue,
          count(*) FILTER (WHERE (${sql.raw(p.pending)}) IS DISTINCT FROM (${pendingRevenueClause("ce")}))::int AS d_pending
        FROM conversion_events ce
      `)) as unknown as { rows: number; d_purchase: number; d_revenue: number; d_pending: number }[];
      check(
        "parity",
        par.rows === fx.ledgerRows && par.d_purchase === 0 && par.d_revenue === 0 && par.d_pending === 0,
        `0183's three FILTER predicates agree with purchasedClause/approvedRevenueClause/pendingRevenueClause ` +
          `on all ${par.rows} ledger rows (disagreements: ${par.d_purchase}/${par.d_revenue}/${par.d_pending})`,
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) {
      // A mutation that produces invalid SQL is a red result, not a crash — but
      // it must be visible as one, so it is attributed to every assertion the
      // mutation claimed it would break rather than silently to none.
      if (quiet) {
        run.lines.push(`  ERROR ${(e as Error).message.split("\n")[0]}`);
        return run;
      }
      throw e;
    }
  }
  return run;
}

async function main() {
  // The guard already refused every other target; this is the banner, not the check.
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const text = readFileSync(MIGRATION_PATH, "utf8");
  const red = process.argv.includes("--red");

  if (!red) {
    console.log("=== 0183's matviews, built from the file, over a seeded ledger ===");
    const run = await runOnce(text, false);
    for (const l of run.lines) console.log(l);
    console.log(`\n${run.passed.length} passed, ${run.failed.length} failed.`);
    process.exit(run.failed.length === 0 ? 0 : 1);
  }

  console.log("=== RED PROOF: every assertion, against a deliberately broken 0183 ===");
  console.log("(the migration file on disk is never written — each mutation is a string in memory)\n");
  const green = await runOnce(text, false);
  if (green.failed.length > 0) {
    console.log("FAIL: the unmutated run is not green, so nothing below means anything.");
    for (const l of green.lines) console.log(l);
    process.exit(1);
  }
  const everyId = [...green.passed];
  console.log(`baseline: ${everyId.length} assertions green\n`);

  const wentRed = new Set<string>();
  let modeFailures = 0;
  for (const m of MUTATIONS) {
    const mutated = m.apply(text);
    if (mutated === text) {
      console.log(`  BROKEN MUTATION  ${m.name} — changed nothing; the text it targets is gone`);
      modeFailures++;
      continue;
    }
    const run = await runOnce(mutated, true);
    console.log(`  ${m.name} — ${m.what}`);
    // A mutation that makes the SQL INVALID proves nothing: it shows the
    // database rejects nonsense, not that the assertion notices a wrong number.
    // So it credits no assertion and counts against the run.
    const errorLine = run.lines.find((l) => l.startsWith("  ERROR"));
    if (errorLine) {
      modeFailures++;
      console.log(`     BROKEN MUTATION — the SQL did not run, so nothing was proved:${errorLine.slice(7)}`);
      continue;
    }
    const failedSet = new Set(run.failed);
    const missing = m.expectRed.filter((id) => !failedSet.has(id));
    for (const id of run.failed) wentRed.add(id);
    if (missing.length > 0) modeFailures++;
    console.log(`     red: ${run.failed.join(", ") || "none"}  [${missing.length === 0 ? "ok" : `MISSED ${missing.join(", ")}`}]`);
  }

  const never = everyId.filter((id) => !wentRed.has(id));
  console.log(`\n${wentRed.size}/${everyId.length} assertions proved able to go red.`);
  if (never.length > 0) console.log(`NOT PROVED: ${never.join(", ")}`);
  if (modeFailures > 0) console.log(`${modeFailures} mutation(s) did not break what they claimed.`);
  process.exit(never.length === 0 && modeFailures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
