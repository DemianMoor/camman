import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { isDatacenterAsn } from "@/lib/links/datacenter-asns";
import { scoreClick } from "@/lib/links/scoring";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Enrichment for one IP. Injectable so scripts can supply a deterministic fake
// instead of hitting MaxMind. Country was dropped (display-only, unused by
// scoreClick) — see geoip.ts.
export type Enricher = (
  ip: string | null,
) => Promise<{ asn: number | null; asnOrg: string | null }>;

// Default = the real GeoLite2 lookup, lazy-imported so this module stays
// importable from plain tsx scripts (geoip.ts is `server-only`).
const defaultEnricher: Enricher = async (ip) =>
  (await import("@/lib/links/geoip")).lookupIp(ip);

// Per-run enrichment health probe. Decides, ONCE per run, whether we can
// resolve ASNs at all. When unavailable we must NOT score (see below).
export type StatusCheck = () => Promise<{
  available: boolean;
  reason: string;
  source: string;
}>;
const defaultStatusCheck: StatusCheck = async () =>
  (await import("@/lib/links/geoip")).getEnrichmentStatus();

export type ScoreMode = "pending" | "rescore";

export interface ScoreClicksOptions {
  // 'pending' (default) scores only rows with scored_at IS NULL; 'rescore'
  // re-scores ALL rows (used after retuning weights). Idempotent either way.
  mode?: ScoreMode;
  // Safety cap per invocation so the cron stays within the function timeout.
  maxRows?: number;
  batchSize?: number;
  enricher?: Enricher;
  statusCheck?: StatusCheck;
}

export interface EnrichmentSummary {
  available: boolean;
  reason: string;
  source: string;
  // Rows we ran a lookup on this run, and how many resolved an ASN. withAsn/
  // attempted is a health ratio; a drop toward 0 means enrichment is failing.
  attempted: number;
  withAsn: number;
}

export interface ScoreClicksResult {
  scored: number;
  byClassification: Record<string, number>;
  // True if the cap was hit and rows likely remain (run again).
  capped: boolean;
  // True if enrichment was unavailable so NO rows were scored (left pending).
  degraded: boolean;
  enrichment: EnrichmentSummary;
}

interface ClickRow {
  id: number;
  ip: string | null;
  user_agent: string | null;
  classification: string;
}

// Score clicks in id-ordered batches. Each row: enrich (ASN) → derive
// is_datacenter → score (pure) → write enrichment + bot_score + bot_reasons +
// refined classification + scored_at.
//
// CRITICAL — the correctness landmine this guards: if ASN enrichment is
// unavailable (no key, MaxMind 429 with no cached copy, etc.) we DO NOT score
// any rows. Previously a degraded run wrote scored_at = now() with the
// datacenter check off, permanently marking real bot/datacenter traffic as
// "human, done" and never revisiting it. Instead we leave rows PENDING
// (scored_at stays NULL) so a healthy run after the cap resets scores them
// properly — reusing the existing "scored_at IS NULL = not yet scored"
// semantics, making degradation self-healing with no manual rescore.
export async function scoreClicks(
  dbc: DbOrTx,
  opts: ScoreClicksOptions = {},
): Promise<ScoreClicksResult> {
  const mode = opts.mode ?? "pending";
  const maxRows = opts.maxRows ?? 2000;
  const batchSize = opts.batchSize ?? 500;
  const enrich = opts.enricher ?? defaultEnricher;
  const checkStatus = opts.statusCheck ?? defaultStatusCheck;

  const status = await checkStatus();
  if (!status.available) {
    // Loud, and score nothing — rows stay pending and self-heal later.
    console.error(
      `[geoip][DEGRADED] scoreClicks skipped: enrichment unavailable ` +
        `(reason=${status.reason}). Clicks left PENDING (scored_at NULL).`,
    );
    return {
      scored: 0,
      byClassification: {},
      capped: false,
      degraded: true,
      enrichment: { ...status, attempted: 0, withAsn: 0 },
    };
  }

  const byClassification: Record<string, number> = {};
  let scored = 0;
  let attempted = 0;
  let withAsn = 0;
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
      attempted++;
      if (geo.asn != null) withAsn++;
      // With enrichment available, a null ASN is the genuine answer for this IP
      // (not "couldn't look up"), so is_datacenter is a real false, not unknown.
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

  return {
    scored,
    byClassification,
    capped,
    degraded: false,
    enrichment: { ...status, attempted, withAsn },
  };
}
