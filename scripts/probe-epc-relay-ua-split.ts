import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Blocking measurement before Rule D ships: relay/CDN ASNs also carry
// genuine bot traffic. Split relay-ASN clickers by user-agent plausibility and
// compare conversion rates. If the no-UA / scanner-UA subgroup converts at ~zero,
// tighten D to "relay ASN AND plausible UA".
//
// The split uses the scorer's OWN recorded reasons (lib/links/scoring.ts writes
// bot_reasons on every row) rather than re-implementing the UA regex in SQL, so
// it matches scoreClick() exactly.
//
// Run: npx tsx scripts/probe-epc-relay-ua-split.ts

const RELAY_ASNS = sql`(54113, 13335, 36183, 16591)`;
const MISSING_UA = sql`bot_reasons @> '["missing_user_agent"]'::jsonb`;
const SCANNER_UA = sql`bot_reasons @> '["scanner_or_headless_ua"]'::jsonb`;

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

  // ── U1 ─ the tap-level shape of relay-ASN traffic ────────────────────────
  console.log("\n=== U1 relay/CDN-ASN taps by UA plausibility (all time) ===");
  console.table(
    await q(sql`
      SELECT CASE WHEN ${MISSING_UA} THEN 'missing UA'
                  WHEN ${SCANNER_UA} THEN 'scanner/headless UA'
                  ELSE 'plausible UA' END AS ua_class,
             classification,
             count(*)::text AS taps
      FROM clicks WHERE asn IN ${RELAY_ASNS}
      GROUP BY 1, 2 ORDER BY count(*) DESC
    `),
  );

  // ── U2 ─ THE TEST: conversion rate by UA class, relay-ASN clickers only ──
  console.log("\n=== U2 conversion rate of relay-ASN EXCLUDED clickers, by UA class ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id,
               bool_or(cl.classification = 'human') AS any_human,
               bool_or(cl.asn IN ${RELAY_ASNS} AND NOT ${MISSING_UA} AND NOT ${SCANNER_UA}) AS relay_plausible,
               bool_or(cl.asn IN ${RELAY_ASNS} AND (${MISSING_UA} OR ${SCANNER_UA}))        AS relay_implausible,
               ss.converted_at IS NOT NULL AS bought,
               coalesce(ss.sale_revenue, 0) AS revenue
        FROM stage_sends ss JOIN clicks cl ON cl.link_id = ss.link_id
        GROUP BY ss.id, ss.converted_at, ss.sale_revenue
      )
      SELECT CASE WHEN relay_plausible THEN 'relay ASN + plausible UA'
                  WHEN relay_implausible THEN 'relay ASN + missing/scanner UA'
                  ELSE '(n/a)' END AS subgroup,
             count(*)::text AS clickers,
             count(*) FILTER (WHERE bought)::text AS buyers,
             round(100.0 * count(*) FILTER (WHERE bought) / nullif(count(*),0), 4) AS conv_pct,
             sum(revenue)::numeric(12,2) AS revenue
      FROM per_send
      WHERE NOT any_human AND (relay_plausible OR relay_implausible)
      GROUP BY 1 ORDER BY 3 DESC
    `),
  );
  console.log("   (benchmarks: human clickers 0.9703% · Google AS15169 scanners 0.0002%)");

  // ── U3 ─ revised denominator + EPC if D is tightened ─────────────────────
  console.log("\n=== U3 denominator + platform EPC: D vs D-tightened, each with F ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id, ss.campaign_id, ss.contact_id,
               bool_or(cl.classification = 'human') AS any_human,
               bool_or(cl.classification <> 'human' AND cl.asn IN ${RELAY_ASNS}) AS relay_any,
               bool_or(cl.classification <> 'human' AND cl.asn IN ${RELAY_ASNS}
                       AND NOT ${MISSING_UA} AND NOT ${SCANNER_UA}) AS relay_plausible,
               ss.converted_at IS NOT NULL AS bought
        FROM stage_sends ss JOIN clicks cl ON cl.link_id = ss.link_id
        GROUP BY ss.id, ss.campaign_id, ss.contact_id, ss.converted_at
      ),
      rev AS (SELECT sum(revenue) AS r FROM keitaro_stage_results),
      g AS (
        SELECT
          count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human) AS a,
          count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_any OR bought) AS df,
          count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_plausible OR bought) AS dtf,
          count(*) FILTER (WHERE bought AND NOT (any_human OR relay_any)) AS f_rescues_d,
          count(*) FILTER (WHERE bought AND NOT (any_human OR relay_plausible)) AS f_rescues_dt
        FROM per_send
      )
      SELECT (SELECT r FROM rev)::numeric(12,2) AS revenue,
             g.a::text AS denom_A_humanonly,
             g.df::text  AS denom_D_plus_F,   round((SELECT r FROM rev)/nullif(g.df,0), 4)  AS epc_D_plus_F,
             g.dtf::text AS denom_Dtight_plus_F, round((SELECT r FROM rev)/nullif(g.dtf,0), 4) AS epc_Dtight_plus_F,
             g.f_rescues_d::text  AS F_rescues_under_D,
             g.f_rescues_dt::text AS F_rescues_under_Dtight
      FROM g
    `),
  );

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
