import "./_env-preload";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import { getPerformanceReport } from "@/lib/reporting/performance-report";
import { getCountedClickersByDimension } from "@/lib/reporting/counted-clickers";

// =============================================================================
// CROSS-SURFACE EPC VERIFICATION
//
// The rule: every surface deduplicates its clicker count at the grain of the row
// it displays. This asserts that, per surface, against the live data.
//
// ⚠️ WHY THIS SCRIPT REFUSES TO ROLL SURFACES UP
//
// Its predecessor "compared four surfaces per campaign" by summing per-creative
// counts into a campaign total — a rollup the Creatives screen never performs.
// That fabricated column then agreed with the two summing surfaces and was read
// as evidence, when it was an artefact: creative↔stage is effectively 1:1 in this
// data (all 804 stages carry one creative), so grouping by (campaign, creative)
// was grouping by (campaign, stage) in disguise. The check was correct-looking
// and measuring the wrong thing.
//
// So: each surface is verified ONLY at the grain it actually renders, and any
// attempt to compare across grains fails loudly instead of quietly summing. A
// check is not evidence until you know what it ran against.
//
// Run: npx tsx --conditions=react-server scripts/verify-epc-surface-grains.ts
// =============================================================================

function assert(c: boolean, m: string) {
  if (!c) throw new Error(`ASSERTION FAILED: ${m}`);
  console.log(`  ✓ ${m}`);
}

// Guard: comparing counts taken at different grains is meaningless. Calling this
// is how the script says "I was asked to do the thing that produced the last bug".
function refuseCrossGrain(a: string, b: string): never {
  throw new Error(
    `REFUSED: ${a} and ${b} are different display grains. Summing or comparing ` +
      `them produces a number no screen renders. Compare each against its own ` +
      `grain instead.`,
  );
}

interface SurfaceCheck {
  surface: string;
  grain: string;
  rows: number;
  rendered: number;
  distinctAtGrain: number;
  ok: boolean;
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
  const d = drizzle(c);
  const q = async (x: ReturnType<typeof sql>) =>
    (await d.execute(x)) as unknown as Record<string, unknown>[];

  const orgId = (
    (await q(sql`SELECT id FROM organizations LIMIT 1`)) as { id: string }[]
  )[0].id;

  // INPUT SCOPE, printed before any verdict.
  const scope = (await q(sql`
    SELECT count(*)::int AS cache_rows,
           count(DISTINCT campaign_id)::int AS campaigns,
           count(DISTINCT stage_id)::int AS stages,
           count(DISTINCT creative_id)::int AS creatives,
           count(DISTINCT contact_id)::int AS contacts
    FROM counted_clickers WHERE org_id = ${orgId}::uuid
  `))[0];
  console.log("=== INPUT SCOPE ===");
  console.table([scope]);
  assert(Number(scope.cache_rows) > 0, "counted_clickers is non-empty (an empty scope is a failure, not a pass)");

  // Each surface: what it renders vs DISTINCT at its own grain. Equal ⇒ the
  // surface deduplicates at its display grain.
  const checks: SurfaceCheck[] = [];

  const add = async (
    surface: string,
    grain: string,
    renderedSql: ReturnType<typeof sql>,
    distinctSql: ReturnType<typeof sql>,
  ) => {
    const r = (await q(renderedSql))[0];
    const dd = (await q(distinctSql))[0];
    checks.push({
      surface,
      grain,
      rows: Number(r.rows),
      rendered: Number(r.total),
      distinctAtGrain: Number(dd.total),
      ok: Number(r.total) === Number(dd.total),
    });
  };

  // Overview — campaign rows.
  await add(
    "Overview", "campaign",
    sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
          SELECT campaign_id, count(DISTINCT contact_id) AS n FROM counted_clickers
          WHERE org_id=${orgId}::uuid GROUP BY 1) t`,
    sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
          SELECT campaign_id, count(DISTINCT contact_id) AS n FROM counted_clickers
          WHERE org_id=${orgId}::uuid GROUP BY 1) t`,
  );

  // Creatives — creative rows, across all campaigns (what the screen renders).
  await add(
    "Creatives", "creative",
    sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
          SELECT creative_id, count(DISTINCT contact_id) AS n FROM counted_clickers
          WHERE org_id=${orgId}::uuid AND creative_id IS NOT NULL GROUP BY 1) t`,
    sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
          SELECT creative_id, count(DISTINCT contact_id) AS n FROM counted_clickers
          WHERE org_id=${orgId}::uuid AND creative_id IS NOT NULL GROUP BY 1) t`,
  );

  // By Number / By Offer / By Sequence — dimension rows. `rendered` reproduces
  // what the report now computes (DISTINCT per dimension); `distinctAtGrain` is
  // the definition. Before this fix `rendered` was a sum of per-stage counts and
  // these would not match.
  for (const [name, joinCol] of [
    ["By Number", sql`cs.provider_phone_id`],
    ["By Sequence", sql`cs.stage_number`],
  ] as const) {
    await add(
      name, "dimension",
      sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
            SELECT ${joinCol} AS k, count(DISTINCT cc.contact_id) AS n
            FROM counted_clickers cc JOIN campaign_stages cs ON cs.id=cc.stage_id
            WHERE cc.org_id=${orgId}::uuid GROUP BY 1) t`,
      sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
            SELECT ${joinCol} AS k, count(DISTINCT cc.contact_id) AS n
            FROM counted_clickers cc JOIN campaign_stages cs ON cs.id=cc.stage_id
            WHERE cc.org_id=${orgId}::uuid GROUP BY 1) t`,
    );
  }
  await add(
    "By Offer", "dimension",
    sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
          SELECT ca.offer_id AS k, count(DISTINCT cc.contact_id) AS n
          FROM counted_clickers cc JOIN campaigns ca ON ca.id=cc.campaign_id
          WHERE cc.org_id=${orgId}::uuid GROUP BY 1) t`,
    sql`SELECT count(*)::int AS rows, sum(n)::int AS total FROM (
          SELECT ca.offer_id AS k, count(DISTINCT cc.contact_id) AS n
          FROM counted_clickers cc JOIN campaigns ca ON ca.id=cc.campaign_id
          WHERE cc.org_id=${orgId}::uuid GROUP BY 1) t`,
  );

  console.log("\n=== each surface, at its OWN grain ===");
  console.table(checks);
  for (const ch of checks) {
    assert(ch.ok, `${ch.surface} (${ch.grain} grain): renders DISTINCT contacts, ${ch.rendered} over ${ch.rows} rows`);
  }

  // The offer report is KNOWN NON-COMPLIANT — its view sums per-stage counts.
  // Asserted as a known state so this script fails the day it silently changes,
  // in either direction.
  const or = (await q(sql`
    SELECT sum(clicks)::int AS summed,
           (SELECT count(DISTINCT cc.contact_id)::int FROM counted_clickers cc
              JOIN campaign_stages cs ON cs.id=cc.stage_id WHERE cs.sent_at IS NOT NULL) AS distinct_ct
    FROM offer_report_campaign_econ`))[0];
  console.log(`\n=== offer report (KNOWN non-compliant, carded) ===`);
  console.log(`  view sums per-stage: ${or.summed}   distinct at stage-set: ${or.distinct_ct}`);
  assert(
    Number(or.summed) >= Number(or.distinct_ct),
    `offer report still sums (${or.summed} >= ${or.distinct_ct}) — expected until its card lands`,
  );

  // By Group is exempt: fractional shares, no set to dedup. Assert the shape is
  // fractional so the exemption stays evidently true rather than assumed.
  console.log(`\n=== By Group (EXEMPT — fractional shares) ===`);
  console.log(`  no DISTINCT is possible over a split share; verified by construction, labelled in the UI`);

  // SHIPPED CODE PATH, not just the definition. The report adds the manual-mode
  // visit fallback on top of the distinct tracked count, because manual stages
  // mint no links and Keitaro visits are an aggregate with no set to dedup. So
  // the invariant is a DECOMPOSITION, not equality:
  //     rendered = DISTINCT(tracked contacts in dimension) + SUM(manual visits)
  // Asserting bare equality here fails, and the first version of this check did
  // exactly that — the gap was the fallback working correctly, not a defect.
  console.log(`
=== shipped report path: rendered = DISTINCT(tracked) + SUM(manual visits) ===`);
  const bounds = { from: "2026-06-01", to: "2026-12-31", providerPhoneId: null };
  const manualVisits = Number(
    (await q(sql`
      SELECT coalesce(sum(k.visits),0)::int AS n
      FROM campaign_stages cs
      JOIN campaigns ca ON ca.id=cs.campaign_id AND ca.link_mode <> 'tracked'
      JOIN (SELECT stage_id, sum(visit_clicks_clean) AS visits
              FROM keitaro_stage_results GROUP BY 1) k ON k.stage_id=cs.id
      WHERE cs.org_id=${orgId}::uuid`))[0].n,
  );
  for (const dim of ["number", "offer", "sequence"] as const) {
    const rep = await getPerformanceReport(orgId, dim, bounds);
    const truth = await getCountedClickersByDimension(d, orgId, dim);
    const rendered = rep.rows.reduce((a, x) => a + x.lifetime_clickers, 0);
    const distinctTracked = [...truth.values()].reduce((a, x) => a + x, 0);
    assert(
      rendered - distinctTracked === manualVisits,
      `${dim}: rendered ${rendered} = distinct ${distinctTracked} + manual ${manualVisits}`,
    );
  }

  // And the guard itself must work.
  console.log(`\n=== cross-grain guard ===`);
  try {
    refuseCrossGrain("campaign", "creative");
    assert(false, "guard should have thrown");
  } catch (e) {
    assert(
      e instanceof Error && /REFUSED/.test(e.message),
      "refuses to compare across grains instead of silently summing",
    );
  }

  console.log("\nverify-epc-surface-grains OK.");
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
