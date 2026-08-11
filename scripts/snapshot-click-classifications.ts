import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. Pre-backfill snapshot of clicks.classification, emitted as
// markdown for the ClickUp card. The rescore backfill rewrites historical
// classifications and is the only irreversible step in the EPC-unification
// workstream — this is the record that makes it reconstructable afterwards.
//
// Captures: totals, by ET month, by classification, and by ASN group.
//
// Run: npx tsx scripts/snapshot-click-classifications.ts > snapshot.md

const RELAY = sql`(54113, 13335, 36183, 16591)`;
const COLO_FALSE_POSITIVES = sql`(32307, 27235, 18693)`;

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_(no rows)_\n";
  const cols = Object.keys(rows[0]);
  const head = `| ${cols.join(" | ")} |`;
  const sep = `|${cols.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}\n`;
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (query: ReturnType<typeof sql>) => {
    let out: Record<string, unknown>[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as Record<string, unknown>[];
    });
    return out;
  };

  const stamp = (await q(sql`SELECT now() AT TIME ZONE 'America/New_York' AS t`))[0].t;
  console.log(`# Pre-backfill snapshot — clicks.classification\n`);
  console.log(`Captured: **${stamp} ET**. Source: \`scripts/snapshot-click-classifications.ts\` (read-only).\n`);
  console.log(`This is the state immediately BEFORE the datacenter-ASN rescore backfill.\n`);

  console.log(`## Totals\n`);
  console.log(table(await q(sql`
    SELECT count(*)::text AS rows,
           count(*) FILTER (WHERE scored_at IS NOT NULL)::text AS scored,
           count(*) FILTER (WHERE is_datacenter IS TRUE)::text AS is_datacenter_true,
           count(*) FILTER (WHERE is_datacenter IS FALSE)::text AS is_datacenter_false,
           count(*) FILTER (WHERE is_datacenter IS NULL)::text AS is_datacenter_null,
           min(clicked_at)::date::text AS first_click,
           max(clicked_at)::date::text AS last_click
    FROM clicks
  `)));

  console.log(`## By classification\n`);
  console.log(table(await q(sql`
    SELECT classification,
           count(*)::text AS taps,
           round(100.0 * count(*) / sum(count(*)) OVER (), 3)::text AS pct,
           count(*) FILTER (WHERE is_datacenter IS TRUE)::text AS datacenter_true
    FROM clicks GROUP BY 1 ORDER BY count(*) DESC
  `)));

  console.log(`## By ET month × classification\n`);
  console.log(table(await q(sql`
    SELECT to_char(date_trunc('month', clicked_at AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
           count(*)::text AS taps,
           count(*) FILTER (WHERE classification = 'human')::text    AS human,
           count(*) FILTER (WHERE classification = 'suspect')::text  AS suspect,
           count(*) FILTER (WHERE classification = 'bot')::text      AS bot,
           count(*) FILTER (WHERE classification = 'prefetch')::text AS prefetch,
           count(*) FILTER (WHERE classification = 'unknown')::text  AS unknown
    FROM clicks GROUP BY 1 ORDER BY 1
  `)));

  console.log(`## By ASN group (the rows the backfill targets)\n`);
  console.log(table(await q(sql`
    SELECT CASE WHEN asn IN ${RELAY} THEN 'consumer relay (Fastly/CF/Akamai/GFiber)'
                WHEN asn IN ${COLO_FALSE_POSITIVES} THEN 'Colorado false positives (colo substring)'
                WHEN asn = 15169 THEN 'Google AS15169 (scanner mass)'
                WHEN is_datacenter IS TRUE THEN 'other datacenter'
                ELSE 'not datacenter' END AS asn_group,
           count(*)::text AS taps,
           count(*) FILTER (WHERE classification = 'human')::text   AS human,
           count(*) FILTER (WHERE classification = 'suspect')::text AS suspect,
           count(*) FILTER (WHERE classification = 'bot')::text     AS bot
    FROM clicks GROUP BY 1 ORDER BY count(*) DESC
  `)));

  console.log(`## Top ASNs by volume\n`);
  console.log(table(await q(sql`
    SELECT coalesce(asn::text, '(null)') AS asn,
           coalesce(asn_org, '(null)') AS asn_org,
           count(*)::text AS taps,
           count(*) FILTER (WHERE classification = 'human')::text AS human,
           count(*) FILTER (WHERE is_datacenter IS TRUE)::text AS datacenter_true
    FROM clicks GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 20
  `)));

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
