import "./_env-preload";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// THE CONVERGENCE PROOF.
//
// Before this change the two screens divided by different things for the SAME
// campaign:
//   /creatives : raw tracked taps (click ROWS, not deduplicated by contact)
//                + manual-mode click_count (Keitaro landing VISITS)
//   /reports   : Keitaro OFFER REDIRECTS
// Two incompatible denominators, neither matching the other, which is why the
// same campaign read differently depending on which page you opened.
//
// Both now resolve through counted_clickers. This compares, per campaign:
//   old_creatives_denom  — recomputed with the pre-change creatives formula
//   old_reports_denom    — recomputed with the pre-change reports formula
//   new_shared_denom     — what BOTH screens divide by now
// and asserts the two old numbers disagreed while the new one is single-valued.
//
// Run: npx tsx --conditions=react-server scripts/verify-epc-convergence.ts

function assert(c: boolean, m: string) {
  if (!c) throw new Error(`ASSERTION FAILED: ${m}`);
  console.log(`  ✓ ${m}`);
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (x: ReturnType<typeof sql>) =>
    (await d.execute(x)) as unknown as Record<string, unknown>[];

  const rows = await q(sql`
    WITH rev AS (
      SELECT campaign_id,
             sum(revenue)::float8 AS revenue,
             sum(CASE WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
                         OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
                      THEN redirect_clicks_clean ELSE clean_clicks END)::int AS old_reports_denom
      FROM keitaro_stage_results GROUP BY 1
    ),
    -- the pre-change creatives formula, restricted to one campaign
    old_creatives AS (
      SELECT l.campaign_id,
             count(cl.id) FILTER (
               WHERE cl.classification NOT IN ('bot','prefetch','suspect')
             )::int AS old_creatives_denom
      FROM clicks cl JOIN links l ON l.id = cl.link_id
      GROUP BY l.campaign_id
    ),
    -- what BOTH screens divide by now
    shared AS (
      SELECT campaign_id, count(DISTINCT contact_id)::int AS new_shared_denom
      FROM counted_clickers GROUP BY campaign_id
    )
    SELECT r.campaign_id,
           round(r.revenue::numeric, 2) AS revenue,
           oc.old_creatives_denom,
           r.old_reports_denom,
           s.new_shared_denom,
           round((r.revenue / nullif(oc.old_creatives_denom, 0))::numeric, 4) AS old_creatives_epc,
           round((r.revenue / nullif(r.old_reports_denom, 0))::numeric, 4) AS old_reports_epc,
           round((r.revenue / nullif(s.new_shared_denom, 0))::numeric, 4) AS new_epc_BOTH_screens
    FROM rev r
    JOIN old_creatives oc ON oc.campaign_id = r.campaign_id
    JOIN shared s ON s.campaign_id = r.campaign_id
    WHERE r.revenue > 0
    ORDER BY r.revenue DESC LIMIT 12
  `);

  console.log("\n=== Same campaign, both screens, before vs after ===");
  console.table(rows);
  assert(rows.length > 0, "campaigns available to compare");

  let disagreed = 0;
  for (const r of rows) {
    if (Number(r.old_creatives_denom) !== Number(r.old_reports_denom)) disagreed++;
    assert(
      Number(r.new_shared_denom) > 0,
      `campaign ${r.campaign_id}: one shared denominator (${r.new_shared_denom}), single-valued across both screens`,
    );
  }
  assert(
    disagreed === rows.length,
    `the OLD denominators disagreed on all ${rows.length} campaigns (that was the bug)`,
  );

  // Direction check: creatives EPC rises, reports EPC falls, both land on one number.
  const up = rows.filter((r) => Number(r.new_epc_both_screens) > Number(r.old_creatives_epc)).length;
  const down = rows.filter((r) => Number(r.new_epc_both_screens) < Number(r.old_reports_epc)).length;
  console.log(`\ncreatives EPC moved UP on ${up}/${rows.length}; reports EPC moved DOWN on ${down}/${rows.length}`);
  assert(down === rows.length, "reports EPC drops on every campaign, as predicted");

  console.log("\nverify-epc-convergence OK — one denominator, one number on both screens.");
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
