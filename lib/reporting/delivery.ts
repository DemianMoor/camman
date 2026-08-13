import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";

// SINGLE SOURCE OF TRUTH for delivery-receipt (DLR) metrics. The /reports/delivery
// page, the Delivered % column on the Overview report, and the undelivered
// tripwire in lib/sends/tells-monitors.ts ALL read from here — so the human view
// and the automated alert cannot disagree. That is the whole point; do not add a
// second delivery query elsewhere.
//
// Design + the measured recon this is built on:
// docs/superpowers/specs/2026-08-13-delivery-report-design.md
//
// ---------------------------------------------------------------------------
// GRAIN (stated in code, per the EPC workstream's lesson)
// ---------------------------------------------------------------------------
// getDeliveryByStage() returns STAGE grain and nothing else. Every surface
// aggregates those rows at its OWN display grain; no surface consumes another
// surface's aggregated output.
//
// ⚠️ These stage rows ARE safely additive, and it is worth being precise about
// why, because "counts aren't additive" is a note that has been misapplied in
// both directions on this codebase. A message belongs to EXACTLY ONE stage, and
// the fold to one terminal status per message already happened inside the query
// below. Provider and campaign totals are therefore sums over DISJOINT message
// sets — unlike counted clickers, which are deduplicated sets that overlap
// across dimension keys and genuinely cannot be summed.
//
// Definitions, fixed across every surface:
//   sent        = stage_sends.status = 'sent'   (the project's shared
//                 definition of "was messaged" — same one the reports rollup,
//                 the send breakers, and the sent_from_provider_phone rule use)
//   delivered   = the message has a terminal 'delivered' receipt
//   undelivered = terminal 'undelivered' AND no 'delivered'   (delivered wins)
//   no_receipt  = sent AND NOT (delivered OR undelivered)     (see trap 2)
//   Delivered % = delivered / sent    — accepted sends as the denominator.
//                 no_receipt is DISPLAYED, never folded into the percentage.

// ---------------------------------------------------------------------------
// CAPABILITY DECLARATION
// ---------------------------------------------------------------------------
// Report ROWS come from the sms_providers REGISTRY (every current and future
// provider). CAPABILITY comes from this map, whose DEFAULT is "no DLR source".
//
// Consequences, both intended:
//   · a provider row added to the registry tomorrow appears immediately as "—",
//     needing no change to the report;
//   · when a provider's DLR intake becomes real, registering it HERE lights its
//     cells up — also with no change to the report.
//
// Keyed on sms_providers.sms_provider_id — the SHORT DB code ('ahi', not
// 'ahoi'). Getting this wrong silently yields a provider that never matches.

export interface DlrSource {
  /** Capture table holding this provider's delivery receipts. */
  table: string;
  /** SQL expression yielding the stage_sends id this event belongs to. */
  key: string;
  /** Extra predicate, when the table holds more than delivery receipts. */
  filter?: string;
}

export const DLR_SOURCES: Record<string, DlrSource> = {
  // ONE table with a `kind` discriminator (inbound replies live here too).
  tls: {
    table: "tells_webhook_events",
    key: "matched_stage_send_id",
    filter: "kind = 'dlr'",
  },
  // ⚠️ TWO write paths land in this table for the SAME message: the per-message
  // status_callback (method='POST') and the reconcile poll (method='poll').
  // Measured 2026-08-13: 158 event rows covering 50 messages — a 3.2×
  // inflation. The GROUP BY in the terminal CTE is what collapses them; without
  // it the report shows 149 delivered against 50 sent (298%).
  txr: {
    table: "textrequest_dlr_events",
    key: "coalesce(matched_stage_send_id, stage_send_id)",
  },
  ahi: {
    table: "ahoi_dlr_events",
    key: "matched_stage_send_id",
  },
  // ABSENT BY DESIGN — do not add without a real, trusted intake:
  //   txh / txh2  TextHub has NO DLR table at all. texthub_inbound_events is
  //               reply/STOP intake with no status column. A delivery-report
  //               endpoint exists on their side (?dlr=true&id=…, see
  //               scripts/probe-texthub-status.ts) but nothing polls or stores
  //               it. Together these carry ~99.9% of platform volume, so an
  //               ungated computation renders 568,659 sends as "0.0% delivered"
  //               — which reads as a total outage. This is exactly why the gate
  //               below produces null, not a computed zero.
  //   snx / smpl  no API send path.
};

/** Human-readable note for a provider with no DLR intake, shown in the UI. */
export const NO_DLR_NOTE = "no reliable DLR";

export function isDlrCapable(providerKey: string | null | undefined): boolean {
  return providerKey != null && providerKey in DLR_SOURCES;
}

// ---------------------------------------------------------------------------
// STAGE-GRAIN QUERY
// ---------------------------------------------------------------------------

export interface DeliveryStageRow {
  stage_id: number;
  sent: number;
  delivered: number;
  undelivered: number;
  no_receipt: number;
}

export interface DeliveryRange {
  /** ET day, inclusive (yyyy-MM-dd). */
  from: string;
  /** ET day, inclusive (yyyy-MM-dd). */
  to: string;
}

function addOneDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// One terminal row per MESSAGE, per registered source, UNION ALL'd.
//
// ⚠️ The GROUP BY must happen HERE, before the join to sends. Folding after the
// join reintroduces the txr 3.2× row inflation documented above.
//
// sql.raw() is used for the table/key/filter fragments: they come from the
// DLR_SOURCES constant above and never from request input.
function terminalCte() {
  const blocks = Object.values(DLR_SOURCES).map(
    (s) => sql`
      SELECT ${sql.raw(s.key)} AS ss_id,
             bool_or(lower(status) = 'delivered')   AS d,
             bool_or(lower(status) = 'undelivered') AS u
      FROM ${sql.raw(s.table)}
      WHERE lower(status) IN ('delivered', 'undelivered')
        AND ${sql.raw(s.key)} IS NOT NULL
        ${s.filter ? sql`AND ${sql.raw(s.filter)}` : sql``}
      GROUP BY 1`,
  );
  return sql.join(blocks, sql` UNION ALL `);
}

// PERF (measured against prod 2026-08-13, 3.07M-row / 2601 MB stage_sends):
// the `sends` scan is the entire cost — the DLR side is ~4 ms against a ~490-row
// build side. 7-day window: 0.31–1.31 s. 30-day window: 11.0 s, which is why the
// route caps the range at 14 days. stage_sends_org_sent_at_idx is (org_id,
// sent_at), so status/stage_id are heap fetches; a covering index would fix it
// but is a migration (ClickUp 869ehwae3).
export async function getDeliveryByStage(
  orgId: string,
  range: DeliveryRange,
): Promise<DeliveryStageRow[]> {
  return queryDeliveryByStage(db, orgId, {
    fromUtc: fromZonedTime(`${range.from}T00:00:00`, CAMPAIGN_TIMEZONE),
    toExclusiveUtc: fromZonedTime(`${addOneDay(range.to)}T00:00:00`, CAMPAIGN_TIMEZONE),
  });
}

/** Any drizzle executor — the top-level client or a transaction handle. */
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DeliveryQueryBounds {
  fromUtc: Date;
  toExclusiveUtc: Date;
  /**
   * Exclude sends newer than this instant. The REPORT does not set it (it shows
   * `no_receipt` as a count and lets the reader judge); the TRIPWIRE must, or
   * every freshly-sent message counts as undelivered-pending and the rate is
   * meaningless.
   */
  maturedBefore?: Date;
  /**
   * Restrict to these stages. Narrows the scan to stage_sends_stage_id_idx
   * instead of the org-wide (org_id, sent_at) index — which is what keeps the
   * monitor cheap. Omit for the whole org.
   */
  stageIds?: number[];
}

// THE query. Both the report (ET date range, whole org) and the tripwire
// (rolling hours, matured, tls stages only) come through here, so the page and
// the alert cannot compute delivery differently.
export async function queryDeliveryByStage(
  dbc: DbOrTx,
  orgId: string,
  b: DeliveryQueryBounds,
): Promise<DeliveryStageRow[]> {
  if (b.stageIds?.length === 0) return [];

  // Dates are passed as ISO strings with an explicit cast: postgres-js does not
  // serialize a Date bound through drizzle's raw-SQL path (it does through the
  // query builder), and the failure is a runtime TypeError, not a bad result.
  const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

  const rows = (await dbc.execute(sql`
    WITH sends AS (
      SELECT id, stage_id
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid
        AND status = 'sent'
        AND sent_at >= ${ts(b.fromUtc)} AND sent_at < ${ts(b.toExclusiveUtc)}
        ${b.maturedBefore ? sql`AND sent_at < ${ts(b.maturedBefore)}` : sql``}
        ${
          b.stageIds
            ? sql`AND stage_id IN (${sql.join(
                b.stageIds.map((id) => sql`${id}`),
                sql`, `,
              )})`
            : sql``
        }
    ),
    terminal AS (${terminalCte()})
    SELECT s.stage_id,
           count(*)::int                                                 AS sent,
           count(*) FILTER (WHERE t.d)::int                              AS delivered,
           count(*) FILTER (WHERE t.u AND NOT COALESCE(t.d, false))::int AS undelivered,
           -- ⚠️ NOT "no joined row". A tls message emits a non-terminal 'sent'
           -- event before 'delivered', so a message can HAVE an event row and
           -- still have NO receipt. Defining this as a missing join reported 0
           -- where the truth was 14.
           count(*) FILTER (WHERE NOT COALESCE(t.d OR t.u, false))::int  AS no_receipt
    FROM sends s
    LEFT JOIN terminal t ON t.ss_id = s.id
    GROUP BY 1
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    stage_id: Number(r.stage_id),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    undelivered: Number(r.undelivered),
    no_receipt: Number(r.no_receipt),
  }));
}

// ---------------------------------------------------------------------------
// STAGE DIRECTORY + PROVIDER REGISTRY
// ---------------------------------------------------------------------------

export interface StageMeta {
  campaign_id: number;
  /** sms_providers.sms_provider_id, or null when the stage has no phone. */
  provider_key: string | null;
}

// A stage maps to exactly ONE provider: verified 2026-08-13 that no stage has
// sends across more than one provider_phone_id (0 of 882), and that
// stage_sends.provider_phone_id→provider_id agrees with
// campaign_stages.sms_provider_id on all 2,954,934 sent rows. So resolving the
// provider once per stage (1,020 rows) is lossless AND avoids widening the
// multi-million-row scan above.
export async function getStageDirectory(orgId: string): Promise<Map<number, StageMeta>> {
  const rows = (await db.execute(sql`
    SELECT cs.id, cs.campaign_id, sp.sms_provider_id AS provider_key
    FROM campaign_stages cs
    LEFT JOIN provider_phones pp ON pp.id = cs.provider_phone_id
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    WHERE cs.org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];
  return new Map(
    rows.map((r) => [
      Number(r.id),
      { campaign_id: Number(r.campaign_id), provider_key: (r.provider_key as string) ?? null },
    ]),
  );
}

export interface ProviderInfo {
  provider_key: string;
  name: string;
  color: string | null;
  archived: boolean;
}

// Every non-archived provider, plus any archived provider that still has stages
// with sends — so history does not silently vanish when a provider is retired
// (SendNexus was archived 2026-08-13 with 0 API sends; a future retirement of a
// provider with real volume must not blank its past rows).
export async function getProviderRegistry(orgId: string): Promise<ProviderInfo[]> {
  const rows = (await db.execute(sql`
    SELECT sp.sms_provider_id AS provider_key, sp.name, sp.color,
           (sp.status = 'archived') AS archived
    FROM sms_providers sp
    WHERE sp.org_id = ${orgId}::uuid
      AND (sp.status <> 'archived' OR EXISTS (
        SELECT 1 FROM provider_phones pp
        JOIN campaign_stages cs ON cs.provider_phone_id = pp.id
        WHERE pp.provider_id = sp.id AND cs.sent_at IS NOT NULL
      ))
    ORDER BY sp.name
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    provider_key: r.provider_key as string,
    name: r.name as string,
    color: (r.color as string) ?? null,
    archived: Boolean(r.archived),
  }));
}

// ---------------------------------------------------------------------------
// PURE AGGREGATORS — no DB, unit-testable (scripts/test-delivery-rollups.ts)
// ---------------------------------------------------------------------------

export interface DeliveryCounts {
  sent: number;
  delivered: number;
  undelivered: number;
  no_receipt: number;
}

const ZERO: DeliveryCounts = { sent: 0, delivered: 0, undelivered: 0, no_receipt: 0 };

function add(a: DeliveryCounts, b: DeliveryCounts): DeliveryCounts {
  return {
    sent: a.sent + b.sent,
    delivered: a.delivered + b.delivered,
    undelivered: a.undelivered + b.undelivered,
    no_receipt: a.no_receipt + b.no_receipt,
  };
}

/** delivered / sent, as a percentage. null when the denominator is 0. */
export function deliveredPct(c: DeliveryCounts): number | null {
  if (c.sent <= 0) return null;
  return (c.delivered / c.sent) * 100;
}

/** undelivered / sent, as a percentage. null when the denominator is 0. */
export function undeliveredPct(c: DeliveryCounts): number | null {
  if (c.sent <= 0) return null;
  return (c.undelivered / c.sent) * 100;
}

export interface DeliveryProviderRow {
  provider_key: string;
  name: string;
  color: string | null;
  archived: boolean;
  /** false ⇒ delivered/undelivered/no_receipt/pct are all null. */
  dlr_capable: boolean;
  /** Populated for EVERY provider, capable or not. */
  sent: number;
  // Deliberately `| null`, not `| 0`. The type is the gate: a caller cannot
  // render a non-capable provider as 0% without first handling null.
  delivered: number | null;
  undelivered: number | null;
  no_receipt: number | null;
  delivered_pct: number | null;
}

// Group stage rows by provider. A non-capable provider reports its `sent` count
// and NULL for everything DLR-derived — never 0, and never a value computed from
// whatever rows happen to exist. The gate is structural: even if some future
// path wrote fabricated receipts for a provider absent from DLR_SOURCES, they
// could not reach this output.
export function rollupByProvider(
  rows: DeliveryStageRow[],
  stages: Map<number, StageMeta>,
  registry: ProviderInfo[],
): DeliveryProviderRow[] {
  const acc = new Map<string, DeliveryCounts>();
  for (const r of rows) {
    const key = stages.get(r.stage_id)?.provider_key;
    if (!key) continue;
    acc.set(key, add(acc.get(key) ?? ZERO, r));
  }
  return registry
    .map((p) => {
      const c = acc.get(p.provider_key) ?? ZERO;
      const capable = isDlrCapable(p.provider_key);
      return {
        provider_key: p.provider_key,
        name: p.name,
        color: p.color,
        archived: p.archived,
        dlr_capable: capable,
        sent: c.sent,
        delivered: capable ? c.delivered : null,
        undelivered: capable ? c.undelivered : null,
        no_receipt: capable ? c.no_receipt : null,
        delivered_pct: capable ? deliveredPct(c) : null,
      };
    })
    .sort((a, b) => b.sent - a.sent);
}

export interface DeliveryCell {
  /** Counts over DLR-CAPABLE sends only. */
  delivered: number;
  undelivered: number;
  no_receipt: number;
  /** Sends from DLR-capable providers. The percentage's denominator. */
  capable_sent: number;
  /** All sends at this grain, capable or not. The coverage denominator. */
  total_sent: number;
  /** delivered / capable_sent, or null when nothing is capable. */
  delivered_pct: number | null;
  /** capable_sent / total_sent as a percentage. 100 ⇒ no label needed. */
  coverage_pct: number | null;
}

function cellOf(capable: DeliveryCounts, totalSent: number): DeliveryCell {
  return {
    delivered: capable.delivered,
    undelivered: capable.undelivered,
    no_receipt: capable.no_receipt,
    capable_sent: capable.sent,
    total_sent: totalSent,
    delivered_pct: deliveredPct(capable),
    coverage_pct: totalSent > 0 ? (capable.sent / totalSent) * 100 : null,
  };
}

// Per-campaign cells for the Overview column.
//
// ⚠️ MIXED-PROVIDER CAMPAIGNS ARE REAL: 4 of 212 campaigns with sends span more
// than one provider (measured 2026-08-13). The percentage is computed over the
// DLR-capable subset only, and coverage_pct is carried so the UI can LABEL it.
// A 4%-coverage figure and a 100%-coverage figure are otherwise
// indistinguishable, which is the whole failure this label prevents.
export function rollupByCampaign(
  rows: DeliveryStageRow[],
  stages: Map<number, StageMeta>,
): Map<number, DeliveryCell> {
  const capable = new Map<number, DeliveryCounts>();
  const totalSent = new Map<number, number>();
  for (const r of rows) {
    const meta = stages.get(r.stage_id);
    if (!meta) continue;
    totalSent.set(meta.campaign_id, (totalSent.get(meta.campaign_id) ?? 0) + r.sent);
    if (!isDlrCapable(meta.provider_key)) continue;
    capable.set(meta.campaign_id, add(capable.get(meta.campaign_id) ?? ZERO, r));
  }
  const out = new Map<number, DeliveryCell>();
  for (const [campaignId, total] of totalSent) {
    out.set(campaignId, cellOf(capable.get(campaignId) ?? ZERO, total));
  }
  return out;
}

// Per-stage cells for the Overview column. A stage is single-provider, so
// coverage is always 0% or 100% here and the UI never labels a stage row.
export function rollupByStage(
  rows: DeliveryStageRow[],
  stages: Map<number, StageMeta>,
): Map<number, DeliveryCell> {
  const out = new Map<number, DeliveryCell>();
  for (const r of rows) {
    const capable = isDlrCapable(stages.get(r.stage_id)?.provider_key);
    out.set(r.stage_id, cellOf(capable ? r : ZERO, r.sent));
  }
  return out;
}
