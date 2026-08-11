import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Final impact under the settled rule (D-tight + F):
//   counted clicker = any human click
//                   OR (relay/CDN ASN AND plausible UA)
//                   OR converted
// deduped at the grain of the row displayed.
//
//   F1 top-20 campaigns by revenue: before/after EPC (campaign grain)
//   F2 creatives picker: does `epc desc` ordering change materially?
//
// Run: npx tsx scripts/probe-epc-final-impact.ts

const RELAY = sql`(54113, 13335, 36183, 16591)`;
const PLAUSIBLE_UA = sql`NOT (bot_reasons @> '["missing_user_agent"]'::jsonb)
                     AND NOT (bot_reasons @> '["scanner_or_headless_ua"]'::jsonb)`;
// The settled per-click "counts" predicate.
const COUNTS = sql`(cl.classification = 'human' OR (cl.asn IN ${RELAY} AND ${PLAUSIBLE_UA}))`;

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) => {
    let out: T[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as T[];
    });
    return out;
  };

  // ── F1 ─ top-20 campaigns, before/after ──────────────────────────────────
  console.log("\n=== F1 top-20 campaigns by revenue — EPC before/after (final rule) ===");
  console.table(
    await q(sql`
      WITH k AS (
        SELECT campaign_id, sum(revenue) AS revenue,
               sum(CASE WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
                           OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
                        THEN redirect_clicks_clean ELSE clean_clicks END) AS redirect_clean
        FROM keitaro_stage_results GROUP BY campaign_id
      ),
      counted AS (
        SELECT l.campaign_id, l.contact_id
        FROM clicks cl JOIN links l ON l.id = cl.link_id
        WHERE ${COUNTS}
        GROUP BY 1, 2
        UNION
        SELECT ss.campaign_id, ss.contact_id
        FROM stage_sends ss WHERE ss.converted_at IS NOT NULL
      ),
      m AS (SELECT campaign_id, count(*)::bigint AS clickers FROM counted GROUP BY 1)
      SELECT ca.id::text AS campaign, left(ca.name, 24) AS name,
             k.revenue::numeric(12,2) AS revenue,
             coalesce(k.redirect_clean,0)::text AS denom_before,
             coalesce(m.clickers,0)::text       AS denom_after,
             round(k.revenue / nullif(k.redirect_clean,0), 4) AS epc_before,
             round(k.revenue / nullif(m.clickers,0), 4)       AS epc_after,
             round((k.revenue / nullif(m.clickers,0)) / nullif(k.revenue / nullif(k.redirect_clean,0),0), 3) AS ratio
      FROM k JOIN campaigns ca ON ca.id = k.campaign_id
      LEFT JOIN m ON m.campaign_id = k.campaign_id
      WHERE k.revenue > 0 ORDER BY k.revenue DESC LIMIT 20
    `),
  );

  // ── F2 ─ creatives picker ordering ───────────────────────────────────────
  // BEFORE mirrors app/api/creatives/list/route.ts: 30d window, denominator =
  // manual-mode stage click_count + tracked clicks NOT IN (bot,prefetch,suspect).
  // AFTER = same numerator, merged count at CREATIVE grain, same 30d window.
  console.log("\n=== F2 creatives picker — `epc desc` ordering, before vs after (30d) ===");
  const rows = await q<Record<string, string>>(sql`
    WITH win AS (SELECT now() - interval '30 days' AS t0),
    payout AS (
      SELECT cs.creative_id,
             sum((SELECT coalesce(sum(ksr.revenue),0) FROM keitaro_stage_results ksr
                   WHERE ksr.stage_id = cs.id)) AS revenue,
             sum(cs.click_count) FILTER (WHERE ca.link_mode = 'manual') AS manual_clean
      FROM campaign_stages cs
      JOIN campaigns ca ON ca.id = cs.campaign_id, win
      WHERE cs.creative_id IS NOT NULL AND cs.created_at >= win.t0
      GROUP BY cs.creative_id
    ),
    before_tracked AS (
      SELECT l.creative_id, count(*)::bigint AS n
      FROM clicks cl JOIN links l ON l.id = cl.link_id, win
      WHERE l.creative_id IS NOT NULL AND cl.clicked_at >= win.t0
        AND cl.classification NOT IN ('bot','prefetch','suspect')
      GROUP BY 1
    ),
    after_counted AS (
      SELECT creative_id, count(*)::bigint AS n FROM (
        SELECT l.creative_id, l.contact_id
        FROM clicks cl JOIN links l ON l.id = cl.link_id, win
        WHERE l.creative_id IS NOT NULL AND cl.clicked_at >= win.t0 AND ${COUNTS}
        GROUP BY 1, 2
        UNION
        SELECT l.creative_id, ss.contact_id
        FROM stage_sends ss JOIN links l ON l.id = ss.link_id, win
        WHERE ss.converted_at IS NOT NULL AND l.creative_id IS NOT NULL AND ss.converted_at >= win.t0
      ) t GROUP BY 1
    )
    SELECT p.creative_id::text AS creative,
           p.revenue::numeric(12,2) AS revenue,
           (coalesce(p.manual_clean,0) + coalesce(b.n,0))::text AS denom_before,
           coalesce(a.n,0)::text AS denom_after,
           round(p.revenue / nullif(coalesce(p.manual_clean,0) + coalesce(b.n,0), 0), 4) AS epc_before,
           round(p.revenue / nullif(a.n, 0), 4) AS epc_after,
           rank() OVER (ORDER BY p.revenue / nullif(coalesce(p.manual_clean,0) + coalesce(b.n,0), 0) DESC NULLS LAST)::int AS rank_before,
           rank() OVER (ORDER BY p.revenue / nullif(a.n, 0) DESC NULLS LAST)::int AS rank_after
    FROM payout p
    LEFT JOIN before_tracked b ON b.creative_id = p.creative_id
    LEFT JOIN after_counted  a ON a.creative_id = p.creative_id
    WHERE p.revenue > 0
    ORDER BY rank_before LIMIT 25
  `);
  console.table(rows);

  const moves = rows.map((r) => Math.abs(Number(r.rank_before) - Number(r.rank_after)));
  const top10Before = new Set(rows.filter((r) => Number(r.rank_before) <= 10).map((r) => r.creative));
  const top10After = new Set(rows.filter((r) => Number(r.rank_after) <= 10).map((r) => r.creative));
  const churn = [...top10Before].filter((x) => !top10After.has(x));
  console.log(`\nranked creatives compared: ${rows.length}`);
  console.log(`mean |rank change|: ${(moves.reduce((a, b) => a + b, 0) / (moves.length || 1)).toFixed(2)}`);
  console.log(`max  |rank change|: ${Math.max(0, ...moves)}`);
  console.log(`top-10 membership leaving on the new denominator: ${churn.length} (${churn.join(", ") || "none"})`);

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
