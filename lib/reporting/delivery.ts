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
// getDeliveryByStage() returns (STAGE, PHONE) grain and nothing else. Every
// surface aggregates those rows at its OWN display grain — provider, number,
// campaign, stage, or one batch for the tripwire; no surface consumes another
// surface's aggregated output.
//
// ⚠️ These rows ARE safely additive, and it is worth being precise about why,
// because "counts aren't additive" is a note that has been misapplied in both
// directions on this codebase. A message belongs to EXACTLY ONE (stage, number)
// pair, and the fold to one terminal status per message already happened inside
// the query below. Provider, number, campaign and stage totals are therefore
// sums over DISJOINT message sets — unlike counted clickers, which are
// deduplicated sets that overlap across dimension keys and genuinely cannot be
// summed.
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
// (STAGE, PHONE)-GRAIN QUERY
// ---------------------------------------------------------------------------
//
// ⚠️ WHY THE PHONE IS ON THE PRIMITIVE AND NOT DERIVED FROM THE STAGE.
//
// It is TRUE that no stage currently has sends across more than one number
// (0 of 882, all 2,954,934 sent rows, verified 2026-08-13). It is NOT
// STRUCTURAL, and the difference matters:
//
//   · stage_sends.provider_phone_id is stamped from the stage row, read ONCE per
//     materialization INVOCATION (lib/sends/kickoff.ts) and reused across windows;
//   · materialization is RESUMABLE across invocations — a budget-capped run
//     commits its windows, leaves materialized_at NULL, and a later tick re-reads
//     the stage row;
//   · nothing guards campaign_stages.provider_phone_id against being edited in
//     between (the stage PATCH locks scheduled_at only);
//   · partially-materialized stages genuinely occur (2 at time of writing).
//
// Edit a stage's number between two windows and its sends split across two
// numbers. Deriving the phone from the stage would then misattribute every send
// in that stage — silently, and exactly on the number whose deliverability
// someone was investigating. So the phone comes from the SEND's own stamped
// column. Costs +8.4% (238ms → 258ms, measured same-session).
//
// The campaign, by contrast, IS derived from the stage — that one is structural
// (FK, exactly one campaign per stage).

export interface DeliveryStageRow {
  stage_id: number;
  /** From the SEND's stamped column, not the stage's. Null only for pre-0112 rows. */
  provider_phone_id: number | null;
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

// PERF (measured against prod, 3.07M-row / 2601 MB stage_sends). The `sends`
// scan is the entire cost — the DLR side is ~6 ms against a ~540-row build side.
//   7-day window:  ~832 ms WARM (stable over 4 identical runs), ~2.5 s COLD
//   30-day window: 11.0 s  ⇒ the route caps the range at 14 days
// ⚠️ Size decisions off the COLD figure. An earlier note here read "473 ms",
// which was one warm measurement on a smaller window and made the 14-day cap
// look roomier than it is.
// stage_sends_org_sent_at_idx is (org_id, sent_at), so status/stage_id/
// provider_phone_id are heap fetches; a covering index would fix it but is a
// migration (ClickUp 869ehwae3).
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
      SELECT id, stage_id, provider_phone_id
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
    SELECT s.stage_id, s.provider_phone_id,
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
    GROUP BY 1, 2
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    stage_id: Number(r.stage_id),
    provider_phone_id: r.provider_phone_id == null ? null : Number(r.provider_phone_id),
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
}

// Stage → campaign only. The PROVIDER is deliberately NOT resolved here any
// more: it now comes from the send's own provider_phone_id via the phone
// directory below, so a stage whose number changed mid-materialization cannot
// misattribute its sends. Campaign stays on the stage — that link is structural.
export async function getStageDirectory(orgId: string): Promise<Map<number, StageMeta>> {
  const rows = (await db.execute(sql`
    SELECT cs.id, cs.campaign_id
    FROM campaign_stages cs
    WHERE cs.org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];
  return new Map(
    rows.map((r) => [Number(r.id), { campaign_id: Number(r.campaign_id) }]),
  );
}

export interface PhoneMeta {
  provider_phone_id: number;
  phone_number: string | null;
  /** 'short_code' | 'toll_free' | '10dlc' | … — the TFN-vs-shortcode split. */
  number_type: string | null;
  /** sms_providers.sms_provider_id — the capability key. */
  provider_key: string | null;
}

// provider_phones is ~35 rows, so this is free. One number belongs to exactly
// one provider (FK), which is what makes phone → provider rollup lossless.
export async function getPhoneDirectory(orgId: string): Promise<Map<number, PhoneMeta>> {
  const rows = (await db.execute(sql`
    SELECT pp.id, pp.phone_number, pp.number_type, sp.sms_provider_id AS provider_key
    FROM provider_phones pp
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    WHERE pp.org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        provider_phone_id: Number(r.id),
        phone_number: (r.phone_number as string) ?? null,
        number_type: (r.number_type as string) ?? null,
        provider_key: (r.provider_key as string) ?? null,
      },
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

// The DLR columns are deliberately `| null`, not `| 0`, on both row types. The
// type is the gate: a caller cannot render a non-capable row as 0% without first
// handling null.
interface DeliveryCells {
  /** false ⇒ delivered/undelivered/no_receipt/pct are all null. */
  dlr_capable: boolean;
  /** Populated for EVERY row, capable or not. */
  sent: number;
  delivered: number | null;
  undelivered: number | null;
  no_receipt: number | null;
  delivered_pct: number | null;
}

/** One number under a provider. Same columns, plus the number and its type. */
export interface DeliveryPhoneRow extends DeliveryCells {
  provider_phone_id: number | null;
  phone_number: string | null;
  number_type: string | null;
}

export interface DeliveryProviderRow extends DeliveryCells {
  provider_key: string;
  name: string;
  color: string | null;
  archived: boolean;
  /** Per-number breakdown, sent desc. Sums exactly to this row. */
  numbers: DeliveryPhoneRow[];
}

// Apply the capability gate to a counts bucket.
function cellsFor(c: DeliveryCounts, providerKey: string | null): DeliveryCells {
  const capable = isDlrCapable(providerKey);
  return {
    dlr_capable: capable,
    sent: c.sent,
    delivered: capable ? c.delivered : null,
    undelivered: capable ? c.undelivered : null,
    no_receipt: capable ? c.no_receipt : null,
    delivered_pct: capable ? deliveredPct(c) : null,
  };
}

// A send with no stamped number. Zero of 2,954,934 rows today (the 0112 backfill
// covered all history), but the column is nullable, so these are bucketed
// EXPLICITLY rather than dropped — silently discarding them would break the
// invariant that provider totals reconcile with stage totals, and that
// reconciliation is what the verify script checks.
export const NO_NUMBER_KEY = "__no_number__";

// Group (stage, phone) rows by PROVIDER, with a per-number breakdown nested
// under each. Provider attribution comes from the send's own stamped phone —
// see the note on DeliveryStageRow for why not from the stage.
export function rollupByProvider(
  rows: DeliveryStageRow[],
  phones: Map<number, PhoneMeta>,
  registry: ProviderInfo[],
): DeliveryProviderRow[] {
  const acc = new Map<string, DeliveryCounts>();
  // provider_key → (phone id | NO_NUMBER_KEY) → counts
  const byPhone = new Map<string, Map<string, DeliveryCounts>>();

  for (const r of rows) {
    const meta = r.provider_phone_id == null ? null : phones.get(r.provider_phone_id);
    const key = meta?.provider_key;
    if (!key) continue;
    acc.set(key, add(acc.get(key) ?? ZERO, r));
    const phoneKey = r.provider_phone_id == null ? NO_NUMBER_KEY : String(r.provider_phone_id);
    if (!byPhone.has(key)) byPhone.set(key, new Map());
    const inner = byPhone.get(key)!;
    inner.set(phoneKey, add(inner.get(phoneKey) ?? ZERO, r));
  }
  return registry
    .map((p) => {
      const c = acc.get(p.provider_key) ?? ZERO;
      const numbers: DeliveryPhoneRow[] = [...(byPhone.get(p.provider_key) ?? new Map())]
        .map(([phoneKey, pc]) => {
          const meta = phoneKey === NO_NUMBER_KEY ? null : phones.get(Number(phoneKey));
          return {
            provider_phone_id: meta?.provider_phone_id ?? null,
            phone_number: meta?.phone_number ?? null,
            number_type: meta?.number_type ?? null,
            // Capability is per-PROVIDER, so every number under a provider
            // inherits it. Two numbers on the same provider can differ wildly in
            // deliverability (the TFN-vs-short-code case this breakdown exists
            // for) but never in whether it is MEASURABLE.
            ...cellsFor(pc, p.provider_key),
          };
        })
        .sort((a, b) => b.sent - a.sent);
      return {
        provider_key: p.provider_key,
        name: p.name,
        color: p.color,
        archived: p.archived,
        numbers,
        ...cellsFor(c, p.provider_key),
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
  phones: Map<number, PhoneMeta>,
): Map<number, DeliveryCell> {
  const capable = new Map<number, DeliveryCounts>();
  const totalSent = new Map<number, number>();
  for (const r of rows) {
    const meta = stages.get(r.stage_id);
    if (!meta) continue;
    totalSent.set(meta.campaign_id, (totalSent.get(meta.campaign_id) ?? 0) + r.sent);
    // Capability now resolves through the SEND's number, not the stage's.
    const providerKey =
      r.provider_phone_id == null ? null : phones.get(r.provider_phone_id)?.provider_key ?? null;
    if (!isDlrCapable(providerKey)) continue;
    capable.set(meta.campaign_id, add(capable.get(meta.campaign_id) ?? ZERO, r));
  }
  const out = new Map<number, DeliveryCell>();
  for (const [campaignId, total] of totalSent) {
    out.set(campaignId, cellOf(capable.get(campaignId) ?? ZERO, total));
  }
  return out;
}

// Per-stage cells for the Overview column.
//
// ⚠️ Must SUM the (stage, phone) rows — a stage can now legitimately produce
// more than one row. Coverage is 0% or 100% for every stage in practice, but it
// is computed rather than assumed: a stage whose number was edited between
// materialization windows can be genuinely mixed, and if that ever happens the
// UI's coverage label handles it instead of the number silently being wrong.
export function rollupByStage(
  rows: DeliveryStageRow[],
  phones: Map<number, PhoneMeta>,
): Map<number, DeliveryCell> {
  const capable = new Map<number, DeliveryCounts>();
  const totalSent = new Map<number, number>();
  for (const r of rows) {
    totalSent.set(r.stage_id, (totalSent.get(r.stage_id) ?? 0) + r.sent);
    const providerKey =
      r.provider_phone_id == null ? null : phones.get(r.provider_phone_id)?.provider_key ?? null;
    if (!isDlrCapable(providerKey)) continue;
    capable.set(r.stage_id, add(capable.get(r.stage_id) ?? ZERO, r));
  }
  const out = new Map<number, DeliveryCell>();
  for (const [stageId, total] of totalSent) {
    out.set(stageId, cellOf(capable.get(stageId) ?? ZERO, total));
  }
  return out;
}
