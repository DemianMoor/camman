import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Diagnostic for the 89 buyers excluded from the merged denominator.
// Why are they excluded, and is the exclusion rule salvageable?
//
//   D1 conversion rate: human clickers vs CamMan-excluded clickers
//   D2 what the 89 buyers' clicks actually look like (classification/ASN/UA)
//   D3 would a "Keitaro non-bot visit rescues a CamMan exclusion" rule fix it,
//      and what would that cost the denominator?
//
// Run: npx tsx scripts/probe-epc-excluded-buyers-detail.ts

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

  // ── D1 ─ do excluded clickers convert like bots, or like people? ──────────
  console.log("\n=== D1 conversion rate by CamMan verdict (recipient grain) ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id,
               bool_or(cl.classification = 'human') AS any_human,
               count(cl.id) AS taps,
               ss.converted_at IS NOT NULL AS bought,
               coalesce(ss.sale_revenue, 0) AS revenue
        FROM stage_sends ss
        JOIN clicks cl ON cl.link_id = ss.link_id
        GROUP BY ss.id, ss.converted_at, ss.sale_revenue
      )
      SELECT CASE WHEN any_human THEN 'human clicker' ELSE 'CamMan-excluded clicker' END AS verdict,
             count(*)::text AS clickers,
             count(*) FILTER (WHERE bought)::text AS buyers,
             round(100.0 * count(*) FILTER (WHERE bought) / nullif(count(*), 0), 4) AS conv_pct,
             sum(revenue)::numeric(12,2) AS revenue
      FROM per_send GROUP BY 1 ORDER BY 2 DESC
    `),
  );

  // ── D2 ─ anatomy of the excluded buyers' clicks ──────────────────────────
  console.log("\n=== D2 the excluded buyers' clicks: classification × ASN ===");
  console.table(
    await q(sql`
      WITH excluded_buyers AS (
        SELECT ss.id, ss.link_id
        FROM stage_sends ss
        JOIN clicks cl ON cl.link_id = ss.link_id
        WHERE ss.converted_at IS NOT NULL
        GROUP BY ss.id, ss.link_id
        HAVING bool_or(cl.classification = 'human') IS NOT TRUE
      )
      SELECT cl.classification,
             coalesce(cl.asn_org, '(null)') AS asn_org,
             cl.asn,
             count(*)::text AS taps,
             count(DISTINCT eb.id)::text AS buyers
      FROM excluded_buyers eb JOIN clicks cl ON cl.link_id = eb.link_id
      GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 15
    `),
  );

  console.log("\n=== D2b taps per excluded buyer + user-agent shape ===");
  console.table(
    await q(sql`
      WITH excluded_buyers AS (
        SELECT ss.id, ss.link_id
        FROM stage_sends ss
        JOIN clicks cl ON cl.link_id = ss.link_id
        WHERE ss.converted_at IS NOT NULL
        GROUP BY ss.id, ss.link_id
        HAVING bool_or(cl.classification = 'human') IS NOT TRUE
      )
      SELECT count(DISTINCT eb.id)::text AS excluded_buyers,
             count(cl.id)::text AS total_taps,
             round(count(cl.id)::numeric / nullif(count(DISTINCT eb.id), 0), 2) AS taps_per_buyer,
             count(*) FILTER (WHERE cl.user_agent ILIKE '%iPhone%' OR cl.user_agent ILIKE '%Android%')::text AS mobile_ua_taps,
             count(*) FILTER (WHERE cl.user_agent IS NULL OR cl.user_agent = '')::text AS missing_ua_taps
      FROM excluded_buyers eb JOIN clicks cl ON cl.link_id = eb.link_id
    `),
  );

  // ── D3 ─ cost of the candidate fix: count every recipient CamMan excluded
  // but who has a conversion OR (separately) any non-'bot' classification.
  console.log("\n=== D3 candidate denominator repairs ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id, ss.campaign_id, ss.contact_id,
               bool_or(cl.classification = 'human')   AS any_human,
               bool_or(cl.classification = 'suspect') AS any_suspect,
               bool_or(cl.classification = 'bot')     AS any_bot,
               ss.converted_at IS NOT NULL AS bought
        FROM stage_sends ss JOIN clicks cl ON cl.link_id = ss.link_id
        GROUP BY ss.id, ss.campaign_id, ss.contact_id, ss.converted_at
      )
      SELECT 'A. human only (brief as written)' AS rule,
             count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human)::text AS campaign_grain,
             count(*) FILTER (WHERE any_human)::text AS recipient_grain,
             count(*) FILTER (WHERE bought AND NOT any_human)::text AS buyers_left_out
      FROM per_send
      UNION ALL
      SELECT 'B. human OR converted (numerator floor)',
             count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR bought)::text,
             count(*) FILTER (WHERE any_human OR bought)::text,
             '0'
      FROM per_send
      UNION ALL
      SELECT 'C. human OR suspect (drop the suspect band)',
             count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR any_suspect)::text,
             count(*) FILTER (WHERE any_human OR any_suspect)::text,
             count(*) FILTER (WHERE bought AND NOT (any_human OR any_suspect))::text
      FROM per_send
    `),
  );

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
