import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Root-cause confirmation + fix costing for the excluded-buyers
// problem. Hypothesis: the datacenter-ASN signal is doing TWO jobs —
//   (a) Google AS15169 = SMS link scanners (correctly excluded), and
//   (b) Fastly/Cloudflare/Akamai = Apple iCloud Private Relay egress, plus
//       Google Fiber caught by the "google" org-keyword = REAL HUMANS.
// If (b) converts at a human-like rate, the exclusion rule has a precise bug.
//
// Run: npx tsx scripts/probe-epc-relay-asn-fix.ts

// iCloud Private Relay egress partners + a residential ISP swept up by the
// "google" org keyword in lib/links/datacenter-asns.ts.
const RELAY_ASNS = sql`(54113, 13335, 36183, 16591)`;
const CLOUD_ASNS = sql`(16509, 14618)`; // AWS — genuinely hosting, but VPN-capable

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

  // ── R1 ─ THE TEST: conversion rate of excluded clickers, by ASN group ─────
  console.log("\n=== R1 conversion rate among CamMan-EXCLUDED clickers, by ASN group ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id,
               bool_or(cl.classification = 'human') AS any_human,
               bool_or(cl.asn IN ${RELAY_ASNS})     AS any_relay,
               bool_or(cl.asn IN ${CLOUD_ASNS})     AS any_aws,
               bool_or(cl.asn = 15169)              AS any_google,
               ss.converted_at IS NOT NULL AS bought,
               coalesce(ss.sale_revenue, 0) AS revenue
        FROM stage_sends ss JOIN clicks cl ON cl.link_id = ss.link_id
        GROUP BY ss.id, ss.converted_at, ss.sale_revenue
      )
      SELECT CASE WHEN any_relay THEN 'relay/CDN (Fastly/CF/Akamai/GFiber)'
                  WHEN any_aws THEN 'AWS'
                  WHEN any_google THEN 'Google AS15169 (scanners)'
                  ELSE 'other excluded' END AS asn_group,
             count(*)::text AS clickers,
             count(*) FILTER (WHERE bought)::text AS buyers,
             round(100.0 * count(*) FILTER (WHERE bought) / nullif(count(*),0), 4) AS conv_pct,
             sum(revenue)::numeric(12,2) AS revenue
      FROM per_send WHERE NOT any_human
      GROUP BY 1 ORDER BY 3 DESC
    `),
  );
  console.log("   (benchmark: human clickers convert at 0.9703%)");

  // ── R2 ─ what the fix costs the denominator ──────────────────────────────
  console.log("\n=== R2 candidate rules: denominator + buyers left out ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id, ss.campaign_id, ss.contact_id,
               bool_or(cl.classification = 'human') AS any_human,
               bool_or(cl.classification <> 'human' AND cl.asn IN ${RELAY_ASNS}) AS relay_only,
               bool_or(cl.classification <> 'human' AND cl.asn IN ${CLOUD_ASNS}) AS aws_only,
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
      SELECT 'D. human OR relay/CDN  <-- proposed',
             count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_only)::text,
             count(*) FILTER (WHERE any_human OR relay_only)::text,
             count(*) FILTER (WHERE bought AND NOT (any_human OR relay_only))::text
      FROM per_send
      UNION ALL
      SELECT 'E. human OR relay/CDN OR AWS',
             count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_only OR aws_only)::text,
             count(*) FILTER (WHERE any_human OR relay_only OR aws_only)::text,
             count(*) FILTER (WHERE bought AND NOT (any_human OR relay_only OR aws_only))::text
      FROM per_send
      UNION ALL
      SELECT 'F. D + converted floor (guarantees 0)',
             count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_only OR bought)::text,
             count(*) FILTER (WHERE any_human OR relay_only OR bought)::text,
             '0'
      FROM per_send
    `),
  );

  // ── R3 ─ resulting platform EPC under each rule ──────────────────────────
  console.log("\n=== R3 platform EPC under each candidate (revenue $52,901 all-time) ===");
  console.table(
    await q(sql`
      WITH per_send AS (
        SELECT ss.id, ss.campaign_id, ss.contact_id,
               bool_or(cl.classification = 'human') AS any_human,
               bool_or(cl.classification <> 'human' AND cl.asn IN ${RELAY_ASNS}) AS relay_only,
               ss.converted_at IS NOT NULL AS bought
        FROM stage_sends ss JOIN clicks cl ON cl.link_id = ss.link_id
        GROUP BY ss.id, ss.campaign_id, ss.contact_id, ss.converted_at
      ),
      rev AS (SELECT sum(revenue) AS r FROM keitaro_stage_results),
      denom AS (
        SELECT count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human) AS a,
               count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_only) AS dd,
               count(DISTINCT (campaign_id::text||':'||contact_id::text)) FILTER (WHERE any_human OR relay_only OR bought) AS f
        FROM per_send
      )
      SELECT (SELECT r FROM rev)::numeric(12,2) AS revenue,
             denom.a::text AS denom_A, round((SELECT r FROM rev)/nullif(denom.a,0), 4) AS epc_A,
             denom.dd::text AS denom_D, round((SELECT r FROM rev)/nullif(denom.dd,0), 4) AS epc_D,
             denom.f::text AS denom_F, round((SELECT r FROM rev)/nullif(denom.f,0), 4) AS epc_F
      FROM denom
    `),
  );

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
