import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import {
  rebuildCountedClickers,
  getCountedClickers,
  getTotalCountedClickers,
  getRuleFRescueCount,
  HUMAN_CLICK,
} from "@/lib/reporting/counted-clickers";
import { rescueSendIds } from "@/lib/sale-attribution";

// Rebuilds the counted-clicker cache and asserts it reproduces the denominators
// measured independently during recon. Those numbers were derived by direct
// queries over clicks/links BEFORE this table existed, so agreement is a real
// cross-check, not a tautology.
//
// Expected (measured 2026-08-11, post-scorer-fix):
//   campaign grain : 57,576   stage grain : 72,149   Rule-F rescues : 8
//
// Run: npx tsx scripts/verify-counted-clickers.ts

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const orgRows = (await d.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
  const orgId = orgRows[0].id;

  console.log("Rebuilding cache...");
  const r = await rebuildCountedClickers(d);
  console.log(`  rows=${r.rows} rescued=${r.rescuedByConversion} in ${r.durationMs}ms\n`);

  console.log("Cache reproduces the independently-measured denominators:");
  const campaign = await getCountedClickers(d, orgId, "campaign");
  const stage = await getCountedClickers(d, orgId, "stage");
  const creative = await getCountedClickers(d, orgId, "creative");
  const totalCampaignGrain = await getTotalCountedClickers(d, orgId);
  const rescues = await getRuleFRescueCount(d, orgId);

  const sumStage = [...stage.values()].reduce((a, b) => a + b, 0);
  console.log(`  campaign-grain total (distinct campaign:contact) = ${totalCampaignGrain}`);
  console.log(`  stage-grain total (sum of per-stage)             = ${sumStage}`);
  console.log(`  campaigns with clickers=${campaign.size} stages=${stage.size} creatives=${creative.size}`);
  console.log(`  Rule-F rescues = ${rescues}`);

  // Cross-check against a FRESHLY COMPUTED direct query rather than a hardcoded
  // constant. Production keeps accruing clicks, so a fixed expectation goes
  // stale within hours; recomputing the definition independently is the real
  // check anyway — it proves the cache agrees with the definition, not with a
  // number someone wrote down once. A small tolerance absorbs clicks that land
  // between the rebuild and this query.
  //
  // ⚠️ BOTH PREDICATES COME FROM THE MODULES THAT DEFINE THEM — HUMAN_CLICK and
  // rescueSendIds — never from a hand-copy. This query used to inline
  // `ck.classification = 'human'`, so the moment that definition gained its
  // `scored_at IS NOT NULL` clause the "independent cross-check" started failing
  // with a 4,597-row gap that was the FIX working, not a defect. The Rule F half
  // used to inline `ss.converted_at IS NOT NULL` and had exactly the same defect
  // waiting in it: after the Phase 3 switch the cache rescues off the
  // conversion_events ledger, so the first REJECTED or UNMAPPED conversion to
  // arrive would have turned this check red for correct behaviour.
  //
  // WHAT IS INDEPENDENT HERE AND WHAT IS NOT. The comparison is PARTIAL, and
  // reading it as total is how a guard comes to be trusted for more than it
  // proves:
  //   • The CLICK half IS re-derived independently: one pass over the base tables
  //     (JOIN + GROUP BY) against the cache's DISTINCT ON with a min() window
  //     function and an ON CONFLICT DO NOTHING, and the dedup here is a
  //     count(DISTINCT campaign:contact) against the table's own
  //     (stage_id, contact_id) unique constraint. Different machinery, same
  //     answer — that is a real cross-check.
  //   • The RESCUE half is NOT independent: `FROM stage_sends ss JOIN
  //     (rescueSendIds(…)) r ON r.stage_send_id = ss.id` below is the SAME join
  //     shape the cache's own rescue INSERT runs (lib/reporting/counted-clickers.ts,
  //     which additionally LEFT JOINs links for the creative and coalesces a click
  //     time). What it does still catch is the asymmetry that matters
  //     operationally: this query passes NO `window`, so it sees EVERY
  //     rescue-eligible recipient, while the incremental pass only sees those
  //     whose ce.updated_at falls inside the lookback. A rescue the incremental
  //     pass missed and never wrote shows up here as a gap — and as an orphan in
  //     the invariant below, which compares the rescue set against the table's
  //     CONTENTS rather than against a second copy of the rule.
  //   • The two DEFINITIONS (HUMAN_CLICK, rescueSendIds) are shared on purpose,
  //     which is the whole point of exporting them: a guard that retypes a
  //     definition stops testing the code and starts testing the typist.
  const direct = (await d.execute(sql`
    WITH counted AS (
      SELECT l.campaign_id, l.stage_id, l.contact_id
      FROM clicks ck JOIN links l ON l.id = ck.link_id
      WHERE ${HUMAN_CLICK}
      GROUP BY 1, 2, 3
      UNION
      SELECT ss.campaign_id, ss.stage_id, ss.contact_id
      FROM stage_sends ss
      JOIN (${rescueSendIds(null)}) r ON r.stage_send_id = ss.id
    )
    SELECT count(DISTINCT (campaign_id::text || ':' || contact_id::text))::int AS campaign_grain,
           count(*)::int AS stage_grain
    FROM counted
  `)) as unknown as { campaign_grain: number; stage_grain: number }[];
  const TOL = 100; // in-flight clicks between rebuild and this read
  assert(
    Math.abs(totalCampaignGrain - Number(direct[0].campaign_grain)) <= TOL,
    `campaign grain matches a direct recomputation (cache ${totalCampaignGrain} vs direct ${direct[0].campaign_grain})`,
  );
  assert(
    Math.abs(sumStage - Number(direct[0].stage_grain)) <= TOL,
    `stage grain matches a direct recomputation (cache ${sumStage} vs direct ${direct[0].stage_grain})`,
  );
  // Sanity band against the 2026-08-11 baseline: monotonic growth is expected,
  // a collapse or a blow-up is not.
  assert(
    totalCampaignGrain >= 57576 && totalCampaignGrain <= 57576 * 1.5,
    `campaign grain within a sane band of the 2026-08-11 baseline 57,576 (got ${totalCampaignGrain})`,
  );
  assert(rescues >= 5 && rescues <= 20, `Rule-F rescues near baseline 8 (got ${rescues})`);

  console.log("\nNon-additivity holds (this is expected, not a bug):");
  const sumCampaign = [...campaign.values()].reduce((a, b) => a + b, 0);
  assert(sumStage > sumCampaign, `stage-grain sum (${sumStage}) EXCEEDS campaign-grain sum (${sumCampaign})`);
  assert(sumCampaign >= totalCampaignGrain, `per-campaign sum (${sumCampaign}) >= org distinct (${totalCampaignGrain})`);

  console.log("\nEvery buyer is inside the denominator (Rule F invariant):");
  // The invariant is about the RESCUE-ELIGIBLE set, not "anyone with a
  // conversion": a rejected conversion is a refund and an unmapped row counts as
  // nothing, so neither belongs in the denominator and neither is a violation.
  // rescueSendIds is the same definition the cache rescues on, so this asserts
  // the rule against the table's CONTENTS (did every eligible recipient actually
  // get written?), not against a second copy of the rule — see the note above on
  // which halves of this script are independent and which are not.
  const orphan = (await d.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends ss
    JOIN (${rescueSendIds(null)}) r ON r.stage_send_id = ss.id
    WHERE NOT EXISTS (
        SELECT 1 FROM counted_clickers cc
        WHERE cc.stage_id = ss.stage_id AND cc.contact_id = ss.contact_id
      )
  `)) as unknown as { n: number }[];
  assert(
    Number(orphan[0].n) === 0,
    `zero rescue-eligible recipients outside the denominator (got ${orphan[0].n})`,
  );

  console.log("\nIdempotent rebuild:");
  const r2 = await rebuildCountedClickers(d);
  assert(Math.abs(r2.rows - r.rows) <= 60, `second rebuild yields the same row count (${r.rows} -> ${r2.rows})`);

  console.log("\nverify-counted-clickers OK.");
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
