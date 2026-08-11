import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Completes the EPC-unification recon:
//   A  revenue by link_mode, WITHOUT the join fanout that broke the first pass
//   B  CamMan bot_reasons distribution (what drives the 'suspect' bucket)
//   C  §6 before/after EPC for the top 20 campaigns by revenue
//   D  platform-wide before/after totals
//
// Run: npx tsx scripts/probe-epc-before-after.ts

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

  // ── A ─ revenue by link_mode (aggregate first, then join: no fanout) ───────
  console.log("\n=== A revenue + click coverage by link_mode (all time) ===");
  console.table(
    await q(sql`
      WITH k AS (
        SELECT campaign_id, sum(revenue) AS revenue,
               sum(visit_clicks_clean) AS visit_clean,
               sum(CASE WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
                           OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
                        THEN redirect_clicks_clean ELSE clean_clicks END) AS redirect_clean
        FROM keitaro_stage_results GROUP BY campaign_id
      ),
      lk AS (SELECT campaign_id, count(*) AS links FROM links GROUP BY campaign_id)
      SELECT c.link_mode,
             count(*)::text AS campaigns,
             coalesce(sum(lk.links), 0)::text AS minted_links,
             coalesce(sum(k.revenue), 0)::numeric(14,2) AS revenue,
             round(100.0 * coalesce(sum(k.revenue),0) / nullif((SELECT sum(revenue) FROM keitaro_stage_results),0), 2) AS revenue_pct,
             coalesce(sum(k.visit_clean), 0)::text AS keitaro_visit_clean,
             coalesce(sum(k.redirect_clean), 0)::text AS keitaro_redirect_clean
      FROM campaigns c
      LEFT JOIN k  ON k.campaign_id = c.id
      LEFT JOIN lk ON lk.campaign_id = c.id
      GROUP BY 1 ORDER BY revenue DESC
    `),
  );

  // ── B ─ what drives 'suspect'? ────────────────────────────────────────────
  console.log("\n=== B CamMan scoring reasons (all time) ===");
  console.table(
    await q(sql`
      SELECT classification, bot_reasons::text AS reasons, count(*)::text AS taps,
             round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct
      FROM clicks GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 12
    `),
  );

  // ── C ─ before/after EPC, top 20 campaigns by revenue ─────────────────────
  // before = revenue / Keitaro offer redirects (today's denominator)
  // after   = revenue / merged count (CamMan human unique clickers per campaign;
  //           Keitaro can only ADD where CamMan has no row — see recon §1)
  const rows = await q<Record<string, string>>(sql`
    WITH k AS (
      SELECT campaign_id,
             sum(revenue) AS revenue,
             sum(CASE WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
                         OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
                      THEN redirect_clicks_clean ELSE clean_clicks END) AS redirect_clean,
             sum(visit_clicks_clean) AS visit_clean
      FROM keitaro_stage_results GROUP BY campaign_id
    ),
    merged AS (
      SELECT l.campaign_id, count(*)::bigint AS clickers
      FROM (
        SELECT l.campaign_id, l.contact_id, bool_or(c.classification = 'human') AS any_human
        FROM clicks c JOIN links l ON l.id = c.link_id
        GROUP BY 1, 2
      ) l
      WHERE l.any_human GROUP BY 1
    )
    SELECT ca.id::text AS campaign, left(ca.name, 26) AS name, ca.link_mode,
           k.revenue::numeric(12,2) AS revenue,
           coalesce(k.redirect_clean, 0)::text AS before_denom,
           coalesce(m.clickers, 0)::text       AS after_denom,
           round(k.revenue / nullif(k.redirect_clean, 0), 4) AS epc_before,
           round(k.revenue / nullif(m.clickers, 0), 4)       AS epc_after,
           round((k.revenue / nullif(m.clickers, 0)) / nullif(k.revenue / nullif(k.redirect_clean, 0), 0), 3) AS ratio
    FROM k
    JOIN campaigns ca ON ca.id = k.campaign_id
    LEFT JOIN merged m ON m.campaign_id = k.campaign_id
    WHERE k.revenue > 0
    ORDER BY k.revenue DESC LIMIT 20
  `);
  console.log("\n=== C before/after EPC — top 20 campaigns by revenue (all time) ===");
  console.table(rows);

  // ── D ─ platform-wide ─────────────────────────────────────────────────────
  console.log("\n=== D platform-wide before/after ===");
  console.table(
    await q(sql`
      WITH k AS (
        SELECT sum(revenue) AS revenue,
               sum(CASE WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
                           OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
                        THEN redirect_clicks_clean ELSE clean_clicks END) AS redirect_clean,
               sum(visit_clicks_clean) AS visit_clean
        FROM keitaro_stage_results
      ),
      m AS (
        SELECT count(*)::bigint AS clickers FROM (
          SELECT l.campaign_id, l.contact_id, bool_or(c.classification = 'human') AS any_human
          FROM clicks c JOIN links l ON l.id = c.link_id GROUP BY 1, 2
        ) t WHERE any_human
      )
      SELECT k.revenue::numeric(14,2) AS revenue,
             k.redirect_clean::text AS denom_now_redirects,
             k.visit_clean::text    AS keitaro_visits,
             m.clickers::text       AS denom_merged_camman_human,
             round(k.revenue / nullif(k.redirect_clean,0), 4) AS epc_now,
             round(k.revenue / nullif(m.clickers,0), 4)       AS epc_merged,
             round((k.revenue / nullif(m.clickers,0)) / nullif(k.revenue / nullif(k.redirect_clean,0),0), 3) AS ratio
      FROM k, m
    `),
  );

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
