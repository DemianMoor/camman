import "./_env-preload";

// One-shot backfill: store every existing conversion_events row under the offer
// live ingest would store it under today (lib/conversions/ingest.ts +
// resolveConversionOffer in lib/conversions/build-rows.ts):
//   the offer whose keitaro_offer_id equals the row's keitaro_offer_id — ONLY if
//   exactly one offer row in the WHOLE table carries that id (ingest drops ids
//   shared by >1 offer anywhere) AND that offer is in the row's org;
//   otherwise the row's campaign's offer.
// Rows with no campaign keep their offer. Moves go in BOTH directions. Only
// offer_id (+ updated_at, so the stage-day projection re-projects) changes;
// event type and status are never touched.
//
//   npx tsx --conditions=react-server scripts/backfill-conversion-offer-attribution.ts [--org <uuid>] [--links "1:62,11:76"] [--apply]
//
// (--conditions=react-server: lib/segment-rules-eval imports "server-only".)
// --links "<keitaro offer id>:<offer id>,…" (requires --org) links offers first,
// refusing a Keitaro id any offer already carries
// (UPDATE offers SET keitaro_offer_id = k WHERE id = offer AND keitaro_offer_id IS NULL).
//
// EVERYTHING runs in ONE REPEATABLE READ transaction (one snapshot; SET LOCAL lock_timeout 5s, statement_timeout
// 120s): link, compute the moves, capture targeting, move, re-capture, assert.
// It is ROLLED BACK unless --apply, and with --apply COMMITTED only if every
// assertion passed — so the dry run is the exact code path --apply runs.
// Assertions (exit 1 on any): every link updates one row; the UPDATE moves
// exactly the computed rows; targeting (purchasedOfferContacts per affected
// offer + every active made_purchase_for_offer segment rule) is identical
// before/after; per-campaign rows / sales / approved revenue are identical.
//
// Production: attended only, after the owner's explicit go (CLAUDE.md §14).

import { sql, type SQL } from "drizzle-orm";

import { db } from "../db/client";
import { approvedRevenueClause, purchasedClause, purchasedOfferContacts } from "../lib/sale-attribution";
import { ruleInnerQuery } from "../lib/segment-rules-eval";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface BackfillOptions {
  orgId: string | null;
  links: { keitaroOfferId: number; offerId: number }[];
  log: (line: string) => void;
}

export interface MoveGroup {
  orgId: string;
  fromOffer: number | null;
  toOffer: number | null;
  keitaroOfferId: number | null;
  rows: number;
  sales: number;
  approvedRevenue: string;
}

export interface TargetingCheck {
  kind: "offer" | "segment_rule";
  id: number;
  label: string;
  before: number;
  after: number;
  identical: boolean;
}

export interface BackfillResult {
  ok: boolean;
  failures: string[];
  linked: number;
  moveCount: number;
  updated: number;
  groups: MoveGroup[];
  targeting: TargetingCheck[];
  campaignsCompared: number;
  campaignTotalsIdentical: boolean;
  isolation: string;
}

const MOVES = sql.raw("pg_temp.offer_backfill_moves");

export async function runOfferBackfill(ex: Tx, opts: BackfillOptions): Promise<BackfillResult> {
  const { log } = opts;
  const rows = async <T>(q: SQL) => (await ex.execute(q)) as unknown as T[];
  const res: BackfillResult = {
    ok: false, failures: [], linked: 0, moveCount: 0, updated: 0, groups: [],
    targeting: [], campaignsCompared: 0, campaignTotalsIdentical: false, isolation: "",
  };
  const orgFilter = (alias: string) =>
    opts.orgId ? sql`AND ${sql.raw(alias)}.org_id = ${opts.orgId}::uuid` : sql``;

  await ex.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await ex.execute(sql`SET LOCAL statement_timeout = '120s'`);

  // Every read must share ONE snapshot, or a conversion ingested mid-run (the
  // */5 poll) changes a before/after pair and fails the run for nothing. Under
  // REPEATABLE READ a concurrent write to a row we move surfaces as a
  // serialization error (40001) instead, which rolls everything back.
  res.isolation = (await rows<{ i: string }>(sql`SELECT current_setting('transaction_isolation') AS i`))[0].i;
  if (res.isolation !== "repeatable read" && res.isolation !== "serializable") {
    res.failures.push(`transaction isolation is ${res.isolation}; the backfill needs repeatable read`);
    return res;
  }

  // ── 1. links ──────────────────────────────────────────────────────────────
  // Links are org-scoped: an offer id alone could name another org's offer.
  if (opts.links.length > 0 && !opts.orgId) {
    res.failures.push("--links requires --org");
    return res;
  }
  for (const l of opts.links) {
    // A Keitaro id already carried by ANY offer (any org) would become shared,
    // and ingest drops shared ids — the rows would silently stay on campaign offers.
    const carriers = await rows<{ id: number }>(sql`
      SELECT id FROM offers WHERE keitaro_offer_id = ${l.keitaroOfferId}`);
    if (carriers.length > 0) {
      res.failures.push(`link ${l.keitaroOfferId}:${l.offerId}: Keitaro offer ${l.keitaroOfferId} is already carried by offer(s) ${carriers.map((c) => c.id).join(", ")}`);
      return res;
    }
    const n = (
      await rows<{ id: number }>(sql`
        UPDATE offers o SET keitaro_offer_id = ${l.keitaroOfferId}
        WHERE o.id = ${l.offerId} AND o.org_id = ${opts.orgId}::uuid AND o.keitaro_offer_id IS NULL
        RETURNING o.id`)
    ).length;
    if (n !== 1) {
      res.failures.push(`link ${l.keitaroOfferId}:${l.offerId} updated ${n} rows (offer missing, not in --org, or already linked)`);
      return res;
    }
    res.linked++;
    log(`linked Keitaro offer ${l.keitaroOfferId} → offer ${l.offerId}`);
  }

  // ── 2. compute the moves (R1, mirrors ingest) ─────────────────────────────
  // A second run in the same transaction (the test) replaces the first's table.
  const prior = await rows<{ t: string | null }>(sql`SELECT to_regclass('pg_temp.offer_backfill_moves')::text AS t`);
  if (prior[0].t) await ex.execute(sql`DROP TABLE ${MOVES}`);
  await ex.execute(sql`
    CREATE TEMP TABLE offer_backfill_moves ON COMMIT DROP AS
    WITH kmap AS (
      SELECT keitaro_offer_id, (array_agg(id))[1] AS offer_id, (array_agg(org_id))[1] AS org_id
      FROM offers
      WHERE keitaro_offer_id IS NOT NULL
      GROUP BY keitaro_offer_id
      HAVING count(*) = 1
    )
    SELECT ce.id, ce.org_id, ce.keitaro_offer_id, ce.offer_id AS from_offer,
           CASE WHEN km.org_id = ce.org_id THEN km.offer_id ELSE ca.offer_id END AS to_offer
    FROM conversion_events ce
    JOIN campaigns ca ON ca.id = ce.campaign_id AND ca.org_id = ce.org_id
    LEFT JOIN kmap km ON km.keitaro_offer_id = ce.keitaro_offer_id
    WHERE true ${orgFilter("ce")}`);
  await ex.execute(sql`DELETE FROM ${MOVES} WHERE to_offer IS NOT DISTINCT FROM from_offer`);

  res.groups = (
    await rows<{ org_id: string; from_offer: number | null; to_offer: number | null; keitaro_offer_id: number | null; rows: number; sales: number; revenue: string }>(sql`
      SELECT m.org_id::text, m.from_offer, m.to_offer, m.keitaro_offer_id,
             count(*)::int AS rows,
             count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS sales,
             coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0)::text AS revenue
      FROM ${MOVES} m JOIN conversion_events ce ON ce.id = m.id AND ce.org_id = m.org_id
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`)
  ).map((r) => ({
    orgId: r.org_id, fromOffer: r.from_offer, toOffer: r.to_offer, keitaroOfferId: r.keitaro_offer_id,
    rows: r.rows, sales: r.sales, approvedRevenue: r.revenue,
  }));
  res.moveCount = res.groups.reduce((s, g) => s + g.rows, 0);

  const offerNames = new Map(
    (
      await rows<{ id: number; name: string }>(sql`
        SELECT o.id, o.name FROM offers o WHERE (o.org_id, o.id) IN (
          SELECT org_id, from_offer FROM ${MOVES} UNION SELECT org_id, to_offer FROM ${MOVES})`)
    ).map((r) => [r.id, r.name]),
  );
  const nm = (id: number | null) => (id === null ? "(none)" : `${id} ${offerNames.get(id) ?? "?"}`);

  log(`\nRows moving: ${res.moveCount}`);
  for (const g of res.groups) {
    log(`  org ${g.orgId}  ${nm(g.fromOffer)} → ${nm(g.toOffer)}  keitaro ${g.keitaroOfferId ?? "-"}  rows ${g.rows}  sales ${g.sales}  approved $${Number(g.approvedRevenue).toFixed(2)}`);
  }

  // Affected (org, offer) pairs — both sides of every move.
  const affected = await rows<{ org_id: string; offer_id: number }>(sql`
    SELECT DISTINCT org_id::text, offer_id FROM (
      SELECT org_id, from_offer AS offer_id FROM ${MOVES}
      UNION SELECT org_id, to_offer FROM ${MOVES}) x
    WHERE offer_id IS NOT NULL ORDER BY 1, 2`);
  const segRules = await rows<{ id: number; segment_id: number; org_id: string; operator: string; value: unknown }>(sql`
    SELECT sr.id, sr.segment_id, sr.org_id::text, sr.operator, sr.value
    FROM segment_rules sr
    WHERE sr.rule_type = 'made_purchase_for_offer' AND sr.is_active ${orgFilter("sr")}
    ORDER BY sr.id`);

  const offerStats = async () =>
    new Map(
      (
        await rows<{ org_id: string; offer_id: number; rows: number; sales: number; revenue: string }>(sql`
          SELECT ce.org_id::text, ce.offer_id, count(*)::int AS rows,
                 count(*) FILTER (WHERE ${purchasedClause("ce")})::int AS sales,
                 coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0)::text AS revenue
          FROM conversion_events ce
          WHERE (ce.org_id::text, ce.offer_id) IN (SELECT org_id::text, offer_id FROM (
            SELECT org_id, from_offer AS offer_id FROM ${MOVES} UNION SELECT org_id, to_offer FROM ${MOVES}) x)
          GROUP BY 1, 2`)
      ).map((r) => [`${r.org_id}/${r.offer_id}`, r]),
    );
  const campaignStats = async () =>
    (
      await rows<{ k: string }>(sql`
        SELECT ce.campaign_id || ':' || count(*) || ':' ||
               count(*) FILTER (WHERE ${purchasedClause("ce")}) || ':' ||
               coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause("ce")}), 0) AS k
        FROM conversion_events ce
        WHERE ce.campaign_id IS NOT NULL ${orgFilter("ce")}
        GROUP BY ce.campaign_id ORDER BY ce.campaign_id`)
    ).map((r) => r.k);
  const setOf = async (q: SQL) =>
    (
      await rows<{ n: number; h: string | null }>(sql`
        SELECT count(*)::int AS n, md5(string_agg(x.contact_id::text, ',' ORDER BY x.contact_id)) AS h
        FROM (${q}) x`)
    )[0];
  const targeting = async () => {
    const out: { kind: TargetingCheck["kind"]; id: number; label: string; n: number; h: string | null }[] = [];
    for (const a of affected) {
      const s = await setOf(purchasedOfferContacts(a.org_id, a.offer_id));
      out.push({ kind: "offer", id: a.offer_id, label: `buyers of ${nm(a.offer_id)}`, ...s });
    }
    for (const r of segRules) {
      const s = await setOf(ruleInnerQuery({ rule_type: "made_purchase_for_offer", operator: r.operator, value: r.value }, r.segment_id, r.org_id));
      out.push({ kind: "segment_rule", id: r.id, label: `segment ${r.segment_id} rule ${r.id} (offer ${String(r.value)})`, ...s });
    }
    return out;
  };

  // ── 3. BEFORE ─────────────────────────────────────────────────────────────
  const offersBefore = await offerStats();
  const campaignsBefore = await campaignStats();
  const targetingBefore = await targeting();

  // ── 4. the move ───────────────────────────────────────────────────────────
  // Re-checks from_offer so a row changed since step 2 is not moved (and the
  // count assertion fails instead).
  res.updated = (
    await rows<{ id: number }>(sql`
      UPDATE conversion_events ce SET offer_id = m.to_offer, updated_at = now()
      FROM ${MOVES} m
      WHERE ce.id = m.id AND ce.org_id = m.org_id
        AND ce.offer_id IS NOT DISTINCT FROM m.from_offer ${orgFilter("ce")}
      RETURNING ce.id`)
  ).length;
  if (res.updated !== res.moveCount) {
    res.failures.push(`UPDATE moved ${res.updated} rows, computed ${res.moveCount}`);
  }

  // ── 5. AFTER: targeting identical ─────────────────────────────────────────
  const targetingAfter = await targeting();
  log(`\nTargeting (contact sets, before / after):`);
  res.targeting = targetingBefore.map((b, i) => {
    const a = targetingAfter[i];
    const identical = b.n === a.n && b.h === a.h;
    if (!identical) res.failures.push(`targeting changed: ${b.label} ${b.n} → ${a.n}`);
    log(`  ${b.label}: before ${b.n} / after ${a.n} / ${identical ? "identical ✓" : "CHANGED ✗"}`);
    return { kind: b.kind, id: b.id, label: b.label, before: b.n, after: a.n, identical };
  });
  if (res.targeting.length === 0) log("  (nothing affected)");

  // Per-offer before → after.
  const offersAfter = await offerStats();
  log(`\nPer offer, before → after (rows / sales / approved revenue):`);
  for (const a of affected) {
    const k = `${a.org_id}/${a.offer_id}`;
    const b0 = offersBefore.get(k), a0 = offersAfter.get(k);
    const f = (s: typeof b0) => (s ? `${s.rows} / ${s.sales} / $${Number(s.revenue).toFixed(2)}` : "0 / 0 / $0.00");
    log(`  ${nm(a.offer_id)}: ${f(b0)} → ${f(a0)}`);
  }

  // ── 6. per-campaign totals identical ──────────────────────────────────────
  const campaignsAfter = await campaignStats();
  res.campaignsCompared = campaignsBefore.length;
  res.campaignTotalsIdentical = JSON.stringify(campaignsBefore) === JSON.stringify(campaignsAfter);
  if (!res.campaignTotalsIdentical) res.failures.push("per-campaign totals changed");
  log(`\nPer-campaign totals (rows, sales, approved revenue) over ${res.campaignsCompared} campaign(s): ${res.campaignTotalsIdentical ? "identical ✓" : "CHANGED ✗"}`);

  res.ok = res.failures.length === 0;
  return res;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
class Rollback extends Error {}

function parseArgs(argv: string[]) {
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const orgId = val("--org") ?? null;
  if (orgId !== null && !/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error(`--org must be a uuid`);
  const linksArg = val("--links");
  const links = (linksArg ? linksArg.split(",") : []).map((p) => {
    const m = /^\s*(\d+):(-?\d+)\s*$/.exec(p);
    if (!m) throw new Error(`--links pair "${p}" is not <keitaro offer id>:<offer id>`);
    return { keitaroOfferId: Number(m[1]), offerId: Number(m[2]) };
  });
  return { orgId, links, apply: argv.includes("--apply") };
}

// postgres-js puts the SQLSTATE on the error; drizzle may wrap it in `cause`.
function pgCode(e: unknown): string | undefined {
  for (let x: unknown = e; x && typeof x === "object"; x = (x as { cause?: unknown }).cause) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.links.length > 0 && !args.orgId) {
    console.log("FAIL: --links requires --org (an offer id alone could name another org's offer)");
    console.log("ROLLED BACK — nothing written");
    process.exit(1);
  }
  console.log(args.apply ? "APPLY — commits only if every assertion passes" : "DRY RUN — everything is rolled back (pass --apply to commit)");
  console.log(`Scope: ${args.orgId ? `org ${args.orgId}` : "all orgs"}; links: ${args.links.length ? args.links.map((l) => `${l.keitaroOfferId}:${l.offerId}`).join(",") : "none"}`);

  let result: BackfillResult | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await runOfferBackfill(tx, { orgId: args.orgId, links: args.links, log: (l) => console.log(l) });
      if (!args.apply || !result.ok) throw new Rollback();
    }, { isolationLevel: "repeatable read" });
  } catch (e) {
    if (e instanceof Rollback) {
      // expected: dry run, or a failed assertion
    } else if (pgCode(e) === "40001") {
      console.log("FAIL: serialization failure — a row this run moves was changed concurrently (live ingest?)");
      console.log("ROLLED BACK — nothing written; re-run");
      process.exit(1);
    } else {
      throw e;
    }
  }
  const r = result!;
  if (!r.ok) {
    for (const f of r.failures) console.log(`FAIL: ${f}`);
    console.log("ROLLED BACK — nothing written");
    process.exit(1);
  }
  console.log(args.apply ? `\nAPPLIED — ${r.updated} row(s) moved, ${r.linked} link(s) set` : `\nDRY RUN — rolled back (${r.moveCount} row(s) would move)`);
  process.exit(0);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/backfill-conversion-offer-attribution.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
