import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { isDatacenterAsn } from "@/lib/links/datacenter-asns";
import { scoreClick } from "@/lib/links/scoring";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Enrichment for one IP. Injectable so scripts/verify-scoring.ts can supply a
// deterministic fake instead of hitting MaxMind.
export type Enricher = (
  ip: string | null,
) => Promise<{ asn: number | null; asnOrg: string | null; country: string | null }>;

// Default = the real GeoLite2 lookup, lazy-imported so this module stays
// importable from plain tsx scripts (geoip.ts is `server-only`; loading it
// eagerly would break the verify script even when it injects a fake enricher).
const defaultEnricher: Enricher = async (ip) =>
  (await import("@/lib/links/geoip")).lookupIp(ip);

export type ScoreMode = "pending" | "rescore";

export interface ScoreClicksOptions {
  // 'pending' (default) scores only rows with scored_at IS NULL; 'rescore'
  // re-scores ALL rows (used after retuning weights). Idempotent either way.
  mode?: ScoreMode;
  // Safety cap per invocation so the cron stays within the function timeout.
  maxRows?: number;
  batchSize?: number;
  enricher?: Enricher;
}

export interface ScoreClicksResult {
  scored: number;
  byClassification: Record<string, number>;
  // True if the cap was hit and rows likely remain (run again).
  capped: boolean;
}

interface ClickRow {
  id: number;
  ip: string | null;
  user_agent: string | null;
  classification: string;
}

// Score clicks in id-ordered batches. Each row: enrich (ASN/country) → derive
// is_datacenter → score (pure) → write enrichment + bot_score + bot_reasons +
// refined classification + scored_at. Re-runnable: enrichment and scoreClick
// are deterministic, and prefetch is a fixed point, so re-scoring an already-
// scored row converges to the same verdict.
export async function scoreClicks(
  dbc: DbOrTx,
  opts: ScoreClicksOptions = {},
): Promise<ScoreClicksResult> {
  const mode = opts.mode ?? "pending";
  const maxRows = opts.maxRows ?? 2000;
  const batchSize = opts.batchSize ?? 500;
  const enrich = opts.enricher ?? defaultEnricher;

  const byClassification: Record<string, number> = {};
  let scored = 0;
  let cursor = 0;
  let capped = false;

  while (scored < maxRows) {
    const remaining = maxRows - scored;
    const limit = Math.min(batchSize, remaining);

    const rows = (await dbc.execute(sql`
      SELECT id, ip, user_agent, classification
      FROM clicks
      WHERE id > ${cursor}
        ${mode === "pending" ? sql`AND scored_at IS NULL` : sql``}
      ORDER BY id
      LIMIT ${limit}
    `)) as unknown as ClickRow[];

    if (rows.length === 0) break;

    for (const row of rows) {
      const geo = await enrich(row.ip);
      // null when we couldn't look up an ASN at all (e.g. geoip not configured)
      // — distinct from "looked it up, not a datacenter" (false).
      const isDatacenter =
        geo.asn == null && geo.asnOrg == null
          ? null
          : isDatacenterAsn(geo.asn, geo.asnOrg);

      const result = scoreClick({
        firstPassClassification: row.classification,
        userAgent: row.user_agent,
        asn: geo.asn,
        asnOrg: geo.asnOrg,
        isDatacenter,
      });

      await dbc.execute(sql`
        UPDATE clicks SET
          asn = ${geo.asn},
          asn_org = ${geo.asnOrg},
          country = ${geo.country},
          is_datacenter = ${isDatacenter},
          bot_score = ${result.score},
          bot_reasons = ${JSON.stringify(result.reasons)}::jsonb,
          classification = ${result.classification},
          scored_at = now()
        WHERE id = ${row.id}
      `);

      scored++;
      byClassification[result.classification] =
        (byClassification[result.classification] ?? 0) + 1;
      cursor = Number(row.id);
    }

    if (rows.length < limit) break; // drained
    if (scored >= maxRows) {
      capped = true;
      break;
    }
  }

  return { scored, byClassification, capped };
}
