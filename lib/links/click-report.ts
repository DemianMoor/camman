import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Per-stage click reporting, keyed off campaigns.link_mode so tracked and
// manual campaigns never blend into one "click" number:
//   * tracked → derived at read time from the `clicks` table. raw = all clicks;
//     clean = bot/prefetch/suspect EXCLUDED. Full per-class breakdown + how many
//     are still unscored. Classify-don't-delete: nothing is filtered out of the
//     table, only out of the clean count.
//   * manual  → the existing campaign_stages.click_count / late_click_count
//     (CSV/manual import), which stay authoritative for manual campaigns.
//
// The `source` field is what the UI keys its (loud, unmissable) source badge
// off — CSV vs tracked must be obvious at a glance, never a footnote.

export interface TrackedStageRow {
  stage_id: number;
  stage_number: number;
  raw: number;
  clean: number;
  human: number;
  suspect: number;
  bot: number;
  prefetch: number;
  unknown: number;
  unscored: number;
  // Enrichment canary: clicks that resolved an ASN. A drop in enriched/raw (or
  // a climbing unscored) flags that MaxMind enrichment is degraded.
  enriched: number;
}

export interface ManualStageRow {
  stage_id: number;
  stage_number: number;
  click_count: number;
  late_click_count: number;
}

export type ClickReport =
  | { source: "tracked"; stages: TrackedStageRow[] }
  | { source: "csv"; stages: ManualStageRow[] }
  | null;

export async function getCampaignClickReport(
  dbc: DbOrTx,
  orgId: string,
  campaignId: number,
): Promise<ClickReport> {
  const campaign = (await dbc.execute(sql`
    SELECT link_mode FROM campaigns
    WHERE id = ${campaignId} AND org_id = ${orgId}
    LIMIT 1
  `)) as unknown as { link_mode: string }[];

  if (!campaign[0]) return null;

  if (campaign[0].link_mode === "tracked") {
    const rows = (await dbc.execute(sql`
      SELECT
        cs.id AS stage_id,
        cs.stage_number AS stage_number,
        count(c.id)::int AS raw,
        count(c.id) FILTER (WHERE c.classification = 'human')::int    AS human,
        count(c.id) FILTER (WHERE c.classification = 'suspect')::int  AS suspect,
        count(c.id) FILTER (WHERE c.classification = 'bot')::int      AS bot,
        count(c.id) FILTER (WHERE c.classification = 'prefetch')::int AS prefetch,
        count(c.id) FILTER (WHERE c.classification = 'unknown')::int  AS unknown,
        count(c.id) FILTER (WHERE c.scored_at IS NULL)::int           AS unscored,
        count(c.id) FILTER (WHERE c.asn IS NOT NULL)::int             AS enriched
      FROM campaign_stages cs
      LEFT JOIN links l  ON l.stage_id = cs.id
      LEFT JOIN clicks c ON c.link_id = l.id
      WHERE cs.campaign_id = ${campaignId} AND cs.org_id = ${orgId}
      GROUP BY cs.id, cs.stage_number
      ORDER BY cs.stage_number
    `)) as unknown as Array<{
      stage_id: number;
      stage_number: number;
      raw: number;
      human: number;
      suspect: number;
      bot: number;
      prefetch: number;
      unknown: number;
      unscored: number;
      enriched: number;
    }>;

    return {
      source: "tracked",
      stages: rows.map((r) => ({
        stage_id: Number(r.stage_id),
        stage_number: Number(r.stage_number),
        raw: Number(r.raw),
        // clean excludes bot/prefetch/suspect (leaves human + unknown).
        clean: Number(r.raw) - Number(r.bot) - Number(r.prefetch) - Number(r.suspect),
        human: Number(r.human),
        suspect: Number(r.suspect),
        bot: Number(r.bot),
        prefetch: Number(r.prefetch),
        unknown: Number(r.unknown),
        unscored: Number(r.unscored),
        enriched: Number(r.enriched),
      })),
    };
  }

  const rows = (await dbc.execute(sql`
    SELECT id AS stage_id, stage_number, click_count, late_click_count
    FROM campaign_stages
    WHERE campaign_id = ${campaignId} AND org_id = ${orgId}
    ORDER BY stage_number
  `)) as unknown as Array<{
    stage_id: number;
    stage_number: number;
    click_count: number;
    late_click_count: number;
  }>;

  return {
    source: "csv",
    stages: rows.map((r) => ({
      stage_id: Number(r.stage_id),
      stage_number: Number(r.stage_number),
      click_count: Number(r.click_count),
      late_click_count: Number(r.late_click_count),
    })),
  };
}
