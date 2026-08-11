import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon for the EPC-unification brief (§2 questions 2-4, §4 attribution).
// SELECT ONLY — this script must never UPDATE/INSERT/DELETE.
//
//   S1 timeline + row counts of each click source
//   S2 CamMan scoring coverage, month by month, all time (§2 Q2)
//   S3 dedup impact: raw taps vs unique clicker per campaign (§1 dedup default)
//   S4 Keitaro aggregate coverage: visits vs redirects, legacy-row share
//   S5 manual-mode coverage: campaigns + revenue with no tracked link (§2 Q3)
//   S6 precedence-table quantification at unique-clicker granularity (§2 Q2)
//   S7 sale -> originating-click date traceability (§4 period EPC)
//   S8 measured query cost for an on-read merged count (§2 Q4)
//
// Run: npx tsx scripts/probe-epc-merge-recon.ts

const CLEAN = sql`('bot','prefetch','suspect')`;

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
  const show = (label: string, rows: unknown[]) => {
    console.log(`\n=== ${label} ===`);
    console.table(rows);
  };
  const t0 = (label: string) => {
    const start = Date.now();
    return () => console.log(`   ⏱  ${label}: ${Date.now() - start}ms`);
  };

  // ── S1 ─ timeline of each source ───────────────────────────────────────────
  show(
    "S1 clicks table (CamMan short-link taps)",
    await q(sql`
      SELECT count(*)::bigint AS rows,
             min(clicked_at)::date AS first_click,
             max(clicked_at)::date AS last_click,
             count(*) FILTER (WHERE scored_at IS NOT NULL)::bigint AS scored,
             count(DISTINCT link_id)::bigint AS distinct_links
      FROM clicks
    `),
  );
  show(
    "S1 keitaro_stage_results (aggregate poll)",
    await q(sql`
      SELECT count(*)::bigint AS rows,
             min(stat_date) AS first_date,
             max(stat_date) AS last_date,
             sum(visit_clicks_clean)::bigint  AS visit_clean,
             sum(visit_clicks_raw)::bigint    AS visit_raw,
             sum(redirect_clicks_clean)::bigint AS redirect_clean,
             sum(redirect_clicks_raw)::bigint   AS redirect_raw,
             sum(revenue)::numeric(14,2)      AS revenue
      FROM keitaro_stage_results
    `),
  );
  show(
    "S1 links minted (tracked-mode coverage)",
    await q(sql`
      SELECT count(*)::bigint AS links,
             min(created_at)::date AS first_mint,
             max(created_at)::date AS last_mint
      FROM links
    `),
  );

  // ── S2 ─ scoring coverage month by month, all time ─────────────────────────
  show(
    "S2 CamMan click scoring coverage by ET month (all time)",
    await q(sql`
      SELECT to_char(date_trunc('month', clicked_at AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
             count(*)::bigint AS taps,
             count(*) FILTER (WHERE scored_at IS NOT NULL)::bigint AS scored,
             round(100.0 * count(*) FILTER (WHERE scored_at IS NOT NULL) / nullif(count(*),0), 1) AS scored_pct,
             count(*) FILTER (WHERE classification = 'human')::bigint    AS human,
             count(*) FILTER (WHERE classification = 'unknown')::bigint  AS unknown,
             count(*) FILTER (WHERE classification = 'bot')::bigint      AS bot,
             count(*) FILTER (WHERE classification = 'suspect')::bigint  AS suspect,
             count(*) FILTER (WHERE classification = 'prefetch')::bigint AS prefetch
      FROM clicks
      GROUP BY 1 ORDER BY 1
    `),
  );

  // ── S3 ─ dedup impact ──────────────────────────────────────────────────────
  const s3 = t0("S3 dedup scan");
  show(
    "S3 raw taps vs unique clicker (all time, CamMan side)",
    await q(sql`
      SELECT count(*)::bigint AS raw_taps,
             count(DISTINCT (l.campaign_id::text || ':' || l.contact_id::text))::bigint AS unique_clicker_per_campaign,
             count(DISTINCT l.contact_id)::bigint AS unique_contacts_overall,
             count(*) FILTER (WHERE c.classification NOT IN ${CLEAN})::bigint AS raw_taps_not_excluded
      FROM clicks c JOIN links l ON l.id = c.link_id
    `),
  );
  s3();

  // ── S4 ─ Keitaro aggregate coverage by month ──────────────────────────────
  show(
    "S4 Keitaro monthly: visits vs redirects + legacy (pre-split) rows",
    await q(sql`
      SELECT to_char(date_trunc('month', stat_date), 'YYYY-MM') AS month,
             count(*)::bigint AS rows,
             count(*) FILTER (WHERE visit_clicks_raw = 0 AND visit_clicks_clean = 0
                                AND redirect_clicks_raw = 0 AND redirect_clicks_clean = 0)::bigint AS legacy_rows,
             sum(visit_clicks_clean)::bigint    AS visit_clean,
             sum(redirect_clicks_clean)::bigint AS redirect_clean,
             sum(clean_clicks)::bigint          AS legacy_clean,
             sum(revenue)::numeric(14,2)        AS revenue
      FROM keitaro_stage_results
      GROUP BY 1 ORDER BY 1
    `),
  );

  // ── S5 ─ manual-mode coverage ─────────────────────────────────────────────
  show(
    "S5 campaigns + revenue by link_mode (all time)",
    await q(sql`
      SELECT c.link_mode,
             count(DISTINCT c.id)::bigint AS campaigns,
             count(DISTINCT l.id)::bigint AS minted_links,
             coalesce(sum(k.revenue), 0)::numeric(14,2) AS revenue,
             coalesce(sum(k.visit_clicks_clean), 0)::bigint AS keitaro_visit_clean,
             coalesce(sum(k.redirect_clicks_clean), 0)::bigint AS keitaro_redirect_clean
      FROM campaigns c
      LEFT JOIN (
        SELECT campaign_id, sum(revenue) AS revenue,
               sum(visit_clicks_clean) AS visit_clicks_clean,
               sum(redirect_clicks_clean) AS redirect_clicks_clean
        FROM keitaro_stage_results GROUP BY campaign_id
      ) k ON k.campaign_id = c.id
      LEFT JOIN links l ON l.campaign_id = c.id
      GROUP BY 1 ORDER BY revenue DESC
    `),
  );

  // ── S6 ─ precedence table at unique-clicker granularity ───────────────────
  const s6 = t0("S6 precedence scan");
  show(
    "S6 unique clickers by CamMan verdict (Keitaro vouch still unknown)",
    await q(sql`
      WITH per_clicker AS (
        SELECT l.campaign_id, l.contact_id,
               bool_or(c.classification = 'human')   AS any_human,
               bool_or(c.classification = 'unknown') AS any_unknown,
               bool_and(c.classification IN ${CLEAN}) AS all_excluded
        FROM clicks c JOIN links l ON l.id = c.link_id
        GROUP BY 1, 2
      )
      SELECT count(*)::bigint AS unique_clickers,
             count(*) FILTER (WHERE any_human)::bigint AS row2_human_counted,
             count(*) FILTER (WHERE NOT any_human AND any_unknown)::bigint AS row3or4_needs_keitaro_vouch,
             count(*) FILTER (WHERE all_excluded)::bigint AS row1_excluded_by_camman
      FROM per_clicker
    `),
  );
  s6();

  // ── S7 ─ sale -> originating-click date traceability ──────────────────────
  show(
    "S7 converted recipients: can revenue be re-dated to the click?",
    await q(sql`
      SELECT count(*)::bigint AS converted_recipients,
             count(*) FILTER (WHERE ss.link_id IS NOT NULL)::bigint AS with_link,
             count(*) FILTER (WHERE ck.first_click IS NOT NULL)::bigint AS with_camman_click,
             count(*) FILTER (WHERE ss.offer_reached_at IS NOT NULL)::bigint AS with_offer_reach,
             coalesce(sum(ss.sale_revenue), 0)::numeric(14,2) AS revenue,
             coalesce(sum(ss.sale_revenue) FILTER (WHERE ck.first_click IS NULL), 0)::numeric(14,2) AS revenue_no_click_date
      FROM stage_sends ss
      LEFT JOIN LATERAL (
        SELECT min(c.clicked_at) AS first_click FROM clicks c WHERE c.link_id = ss.link_id
      ) ck ON TRUE
      WHERE ss.converted_at IS NOT NULL
    `),
  );
  show(
    "S7 lag between originating click and conversion (ET days)",
    await q(sql`
      WITH lag AS (
        SELECT (ss.converted_at AT TIME ZONE 'America/New_York')::date
             - (ck.first_click AT TIME ZONE 'America/New_York')::date AS days,
               ss.sale_revenue
        FROM stage_sends ss
        JOIN LATERAL (
          SELECT min(c.clicked_at) AS first_click FROM clicks c WHERE c.link_id = ss.link_id
        ) ck ON TRUE
        WHERE ss.converted_at IS NOT NULL AND ck.first_click IS NOT NULL
      )
      SELECT CASE WHEN days <= 0 THEN 'same day'
                  WHEN days = 1 THEN '1 day later'
                  WHEN days <= 3 THEN '2-3 days later'
                  WHEN days <= 7 THEN '4-7 days later'
                  ELSE '8+ days later' END AS bucket,
             count(*)::bigint AS sales,
             coalesce(sum(sale_revenue), 0)::numeric(14,2) AS revenue
      FROM lag GROUP BY 1 ORDER BY 2 DESC
    `),
  );

  // ── S8 ─ on-read cost of a candidate merged count ─────────────────────────
  const s8 = t0("S8 candidate merged count (CamMan side, all time, per campaign)");
  const merged = await q(sql`
    WITH per_clicker AS (
      SELECT l.campaign_id, l.contact_id,
             bool_or(c.classification = 'human') AS any_human,
             bool_or(c.classification = 'unknown') AS any_unknown
      FROM clicks c JOIN links l ON l.id = c.link_id
      GROUP BY 1, 2
    )
    SELECT campaign_id, count(*) FILTER (WHERE any_human)::bigint AS counted
    FROM per_clicker GROUP BY 1
  `);
  s8();
  console.log(`   S8 returned ${merged.length} campaign rows`);

  const plan = await q<{ "QUERY PLAN": string }>(sql`
    EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
    WITH per_clicker AS (
      SELECT l.campaign_id, l.contact_id,
             bool_or(c.classification = 'human') AS any_human
      FROM clicks c JOIN links l ON l.id = c.link_id
      GROUP BY 1, 2
    )
    SELECT campaign_id, count(*) FILTER (WHERE any_human)::bigint FROM per_clicker GROUP BY 1
  `);
  console.log("\n=== S8 EXPLAIN ANALYZE ===");
  for (const r of plan) console.log(r["QUERY PLAN"]);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
