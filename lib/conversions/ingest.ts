import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  conversion_event_mappings,
  conversion_events,
  offers,
  stage_sends,
} from "@/db/schema";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import {
  buildConversionEventRows,
  type ConversionEventInsert,
  type ConversionStatus,
  type Lookups,
  type MappingRule,
} from "@/lib/conversions/build-rows";
import { parseKeitaroLedgerRow, type LedgerSourceRow } from "@/lib/conversions/keitaro-row";
import { fetchKeitaroConversionLedger, type KeitaroReportRange } from "@/lib/keitaro/client";

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOKUP_CHUNK = 1000;
// 23 bound columns per row (the two timestamps each bind the ET string plus
// CAMPAIGN_TIMEZONE) ⇒ 500 rows ≈ 11.5K params, far under Postgres's 65,535.
const UPSERT_CHUNK = 500;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function loadLookups(
  ex: Executor,
  sources: readonly LedgerSourceRow[],
): Promise<Lookups> {
  const sendIds = [...new Set(sources.map((s) => s.subId1).filter((v): v is string => !!v && UUID_RE.test(v)))];
  const trackingIds = [...new Set(sources.map((s) => s.subId3).filter((v): v is string => !!v))];
  const keitaroOfferIds = [...new Set(sources.map((s) => s.keitaroOfferId).filter((v): v is number => v !== null))];

  const stageSends: Lookups["stageSends"] = new Map();
  for (const chunk of chunks(sendIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({ id: stage_sends.id, stageId: stage_sends.stage_id, contactId: stage_sends.contact_id })
      .from(stage_sends)
      .where(inArray(stage_sends.id, chunk));
    for (const r of found) stageSends.set(r.id, { stageId: r.stageId, contactId: r.contactId });
  }

  // tracking_id is unique per org, not globally: an id seen twice is ambiguous
  // and is dropped rather than guessed.
  const stageIdByTrackingId: Lookups["stageIdByTrackingId"] = new Map();
  const ambiguous = new Set<string>();
  for (const chunk of chunks(trackingIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({ id: campaign_stages.id, trackingId: campaign_stages.tracking_id })
      .from(campaign_stages)
      .where(inArray(campaign_stages.tracking_id, chunk));
    for (const r of found) {
      if (!r.trackingId) continue;
      if (stageIdByTrackingId.has(r.trackingId)) ambiguous.add(r.trackingId);
      stageIdByTrackingId.set(r.trackingId, r.id);
    }
  }
  for (const t of ambiguous) stageIdByTrackingId.delete(t);

  const stageIds = [...new Set([...[...stageSends.values()].map((s) => s.stageId), ...stageIdByTrackingId.values()])];
  const stages: Lookups["stages"] = new Map();
  for (const chunk of chunks(stageIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({
        id: campaign_stages.id,
        campaignId: campaigns.id,
        orgId: campaigns.org_id,
        offerId: campaigns.offer_id,
        affiliateNetworkId: offers.network_id,
      })
      .from(campaign_stages)
      .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
      .leftJoin(offers, eq(offers.id, campaigns.offer_id))
      .where(inArray(campaign_stages.id, chunk));
    for (const r of found) {
      stages.set(r.id, {
        orgId: r.orgId,
        campaignId: r.campaignId,
        offerId: r.offerId ?? null,
        affiliateNetworkId: r.affiliateNetworkId ?? null,
      });
    }
  }

  const offersByKeitaroId: Lookups["offersByKeitaroId"] = new Map();
  const ambiguousOffers = new Set<number>();
  for (const chunk of chunks(keitaroOfferIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({ id: offers.id, orgId: offers.org_id, networkId: offers.network_id, keitaroOfferId: offers.keitaro_offer_id })
      .from(offers)
      .where(inArray(offers.keitaro_offer_id, chunk));
    for (const r of found) {
      if (r.keitaroOfferId === null) continue;
      if (offersByKeitaroId.has(r.keitaroOfferId)) ambiguousOffers.add(r.keitaroOfferId);
      offersByKeitaroId.set(r.keitaroOfferId, { orgId: r.orgId, offerId: r.id, affiliateNetworkId: r.networkId });
    }
  }
  for (const k of ambiguousOffers) offersByKeitaroId.delete(k);

  const orgIds = [...new Set([...[...stages.values()].map((s) => s.orgId), ...[...offersByKeitaroId.values()].map((o) => o.orgId)])];
  const rulesByOrg: Lookups["rulesByOrg"] = new Map();
  if (orgIds.length > 0) {
    const found = await ex
      .select({
        orgId: conversion_event_mappings.org_id,
        offerId: conversion_event_mappings.offer_id,
        affiliateNetworkId: conversion_event_mappings.affiliate_network_id,
        keitaroType: conversion_event_mappings.keitaro_type,
        eventTypeId: conversion_event_mappings.event_type_id,
        conversionStatus: conversion_event_mappings.conversion_status,
      })
      .from(conversion_event_mappings)
      .where(and(inArray(conversion_event_mappings.org_id, orgIds), eq(conversion_event_mappings.status, "active")));
    for (const r of found) {
      const rule: MappingRule = {
        offerId: r.offerId,
        affiliateNetworkId: r.affiliateNetworkId,
        keitaroType: r.keitaroType,
        eventTypeId: r.eventTypeId,
        conversionStatus: r.conversionStatus as ConversionStatus,
      };
      rulesByOrg.set(r.orgId, [...(rulesByOrg.get(r.orgId) ?? []), rule]);
    }
  }

  return { stageSends, stageIdByTrackingId, stages, offersByKeitaroId, rulesByOrg };
}

// ET wall-clock text → timestamptz in SQL, bound as ::text so postgres-js can't
// infer a timestamp and pre-shift it (same trick as poll-conversions.ts).
function etToTimestamptz(et: string) {
  return sql`(${et}::text || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz`;
}

function toInsertValues(r: ConversionEventInsert): PgInsertValue<typeof conversion_events> {
  return {
    org_id: r.orgId,
    keitaro_event_id: r.keitaroEventId,
    tid: r.tid,
    keitaro_click_subid: r.keitaroClickSubid,
    keitaro_status: r.keitaroStatus,
    keitaro_type: r.keitaroType,
    keitaro_version: r.keitaroVersion,
    keitaro_offer_id: r.keitaroOfferId,
    stage_send_id: r.stageSendId,
    contact_id: r.contactId,
    campaign_id: r.campaignId,
    stage_id: r.stageId,
    offer_id: r.offerId,
    event_type_id: r.eventTypeId,
    status: r.status,
    revenue: r.revenue,
    currency: r.currency,
    occurred_at: etToTimestamptz(r.occurredAtEt),
    last_postback_at: etToTimestamptz(r.lastPostbackAtEt),
    status_history: r.statusHistory,
    raw_params: r.rawParams,
  };
}

// The incoming mapping names a DIFFERENT event type than the row's locked one
// (e.g. Registration → Sale on a reused tid). The locked type stays; the
// disagreement is recorded for the monitor instead of being kept silently. A
// status-only mapping (NULL event type) or a still-unmapped row neither raises
// nor clears it; an agreeing mapping clears it.
const CONFLICTING_EVENT_TYPE = sql`CASE
  WHEN excluded.event_type_id IS NULL OR conversion_events.event_type_id IS NULL
    THEN conversion_events.conflicting_event_type_id
  WHEN excluded.event_type_id <> conversion_events.event_type_id
    THEN excluded.event_type_id
  ELSE NULL END`;
const EVENT_TYPE_CONFLICT_AT = sql`CASE
  WHEN excluded.event_type_id IS NULL OR conversion_events.event_type_id IS NULL
    THEN conversion_events.event_type_conflict_at
  WHEN excluded.event_type_id <> conversion_events.event_type_id
    THEN COALESCE(conversion_events.event_type_conflict_at, now())
  ELSE NULL END`;

// Idempotent upsert keyed on Keitaro's event_id.
//   - occurred_at is never updated (the original conversion time).
//   - event_type_id is LOCKED once set, and attribution is sticky:
//     COALESCE(existing, new), so a status-only mapping (NULL event type) can't
//     erase the type, and a later mapping/offer link fills a NULL.
//   - a mapping that disagrees with the locked type is recorded in
//     conflicting_event_type_id / event_type_conflict_at (see above).
//   - status, revenue, version and the raw keitaro_status/keitaro_type take the
//     newest values.
//   - setWhere skips no-op writes, so a re-poll of unchanged data touches nothing.
// Counts come from comparing the returned ids with the ids that already existed;
// `conflicts` = rows written this call that carry a type conflict.
// Column references in SET/WHERE are written literally (conversion_events.col) —
// ${table.col} can render unqualified.
export async function upsertConversionEvents(
  ex: Executor,
  rows: readonly ConversionEventInsert[],
): Promise<{ inserted: number; updated: number; conflicts: number }> {
  // Same event_id twice in one call would hit Postgres 21000 ("ON CONFLICT DO
  // UPDATE command cannot affect row a second time"); last occurrence wins.
  const deduped = [...new Map(rows.map((r) => [r.keitaroEventId, r])).values()];
  let inserted = 0;
  let updated = 0;
  let conflicts = 0;
  for (const chunk of chunks(deduped, UPSERT_CHUNK)) {
    const existing = new Set(
      (
        await ex
          .select({ id: conversion_events.keitaro_event_id })
          .from(conversion_events)
          .where(inArray(conversion_events.keitaro_event_id, chunk.map((r) => r.keitaroEventId)))
      ).map((r) => r.id),
    );
    const written = await ex
      .insert(conversion_events)
      .values(chunk.map(toInsertValues))
      .onConflictDoUpdate({
        target: conversion_events.keitaro_event_id,
        set: {
          tid: sql`excluded.tid`,
          keitaro_click_subid: sql`excluded.keitaro_click_subid`,
          keitaro_status: sql`excluded.keitaro_status`,
          keitaro_type: sql`excluded.keitaro_type`,
          keitaro_version: sql`excluded.keitaro_version`,
          keitaro_offer_id: sql`excluded.keitaro_offer_id`,
          stage_send_id: sql`COALESCE(conversion_events.stage_send_id, excluded.stage_send_id)`,
          contact_id: sql`COALESCE(conversion_events.contact_id, excluded.contact_id)`,
          campaign_id: sql`COALESCE(conversion_events.campaign_id, excluded.campaign_id)`,
          stage_id: sql`COALESCE(conversion_events.stage_id, excluded.stage_id)`,
          offer_id: sql`COALESCE(conversion_events.offer_id, excluded.offer_id)`,
          event_type_id: sql`COALESCE(conversion_events.event_type_id, excluded.event_type_id)`,
          conflicting_event_type_id: CONFLICTING_EVENT_TYPE,
          event_type_conflict_at: EVENT_TYPE_CONFLICT_AT,
          status: sql`excluded.status`,
          revenue: sql`excluded.revenue`,
          currency: sql`excluded.currency`,
          last_postback_at: sql`excluded.last_postback_at`,
          status_history: sql`excluded.status_history`,
          raw_params: sql`excluded.raw_params`,
          updated_at: sql`now()`,
        },
        setWhere: sql`(
          conversion_events.keitaro_version, conversion_events.keitaro_status,
          conversion_events.keitaro_type, conversion_events.status,
          conversion_events.revenue, conversion_events.event_type_id,
          conversion_events.conflicting_event_type_id, conversion_events.offer_id,
          conversion_events.stage_id, conversion_events.last_postback_at,
          conversion_events.stage_send_id, conversion_events.contact_id, conversion_events.campaign_id
        ) IS DISTINCT FROM (
          excluded.keitaro_version, excluded.keitaro_status,
          excluded.keitaro_type, excluded.status,
          excluded.revenue,
          COALESCE(conversion_events.event_type_id, excluded.event_type_id),
          ${CONFLICTING_EVENT_TYPE},
          COALESCE(conversion_events.offer_id, excluded.offer_id),
          COALESCE(conversion_events.stage_id, excluded.stage_id),
          excluded.last_postback_at,
          COALESCE(conversion_events.stage_send_id, excluded.stage_send_id),
          COALESCE(conversion_events.contact_id, excluded.contact_id),
          COALESCE(conversion_events.campaign_id, excluded.campaign_id)
        )`,
      })
      .returning({
        id: conversion_events.keitaro_event_id,
        conflict: conversion_events.conflicting_event_type_id,
      });
    for (const w of written) {
      if (existing.has(w.id)) updated++;
      else inserted++;
      if (w.conflict !== null) conflicts++;
    }
  }
  return { inserted, updated, conflicts };
}

export interface IngestResult {
  ok: boolean;
  dryRun: boolean;
  range: KeitaroReportRange;
  fetched: number;
  // Rows that failed to parse (missing event_id / conversion_type / malformed
  // datetime / non-finite revenue). Counted and sampled — never dropped silently.
  invalid: number;
  invalidSamples: string[];
  unresolved: number;
  unresolvedSamples: string[];
  rows: number;
  // Rows in this batch whose `status` is NULL — no mapping matched the
  // incoming Keitaro type at all. A status-only mapping (event type NULL,
  // status set — e.g. the seeded PsychoBook `rejected` rule) is NOT counted:
  // on an update it inherits the row's already-locked event type via
  // COALESCE, so the row isn't unmapped. A brand-new row first seen through a
  // status-only mapping IS unmapped in the table, but that case is caught by
  // table-level checks (the backfill and verify scripts query the table), not
  // by this batch count.
  unmappedInBatch: number;
  inserted: number;
  updated: number;
  unchanged: number;
  typeConflicts: number; // rows written this run whose Keitaro type now maps to a different event type
  error: string | null;
}

// Fetch one window of Keitaro conversions, attribute + classify, and upsert them
// in one transaction. dryRun does everything except the write.
export async function ingestKeitaroConversions(
  database: typeof db,
  opts: { range: KeitaroReportRange; dryRun?: boolean },
): Promise<IngestResult> {
  const dryRun = opts.dryRun ?? false;
  const base: IngestResult = {
    ok: false,
    dryRun,
    range: opts.range,
    fetched: 0,
    invalid: 0,
    invalidSamples: [],
    unresolved: 0,
    unresolvedSamples: [],
    rows: 0,
    unmappedInBatch: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    typeConflicts: 0,
    error: null,
  };

  // A failed or TRUNCATED fetch returns ok:false before anything is written, so a
  // partial window is never stored as if it were complete.
  const res = await fetchKeitaroConversionLedger(opts.range);
  if (!res.ok) return { ...base, error: res.error };

  const sources: LedgerSourceRow[] = [];
  const invalidRows: typeof res.rows = [];
  for (const raw of res.rows) {
    const parsed = parseKeitaroLedgerRow(raw);
    if (parsed) sources.push(parsed);
    else invalidRows.push(raw);
  }

  const lookups = await loadLookups(database, sources);
  const built = buildConversionEventRows(sources, lookups);
  // One row per event_id: ON CONFLICT cannot touch the same row twice in one statement.
  const rows = [...new Map(built.rows.map((r) => [r.keitaroEventId, r])).values()];

  const result: IngestResult = {
    ...base,
    ok: true,
    fetched: res.rows.length,
    invalid: invalidRows.length,
    invalidSamples: invalidRows
      .slice(0, 10)
      .map((r) => `event_id=${String(r.event_id || "∅")} conversion_type=${String(r.conversion_type || "∅")} datetime=${String(r.datetime || "∅")} revenue=${String(r.revenue ?? "∅")}`),
    unresolved: built.unresolved.length,
    unresolvedSamples: built.unresolved
      .slice(0, 10)
      .map((s) => `${s.eventId} sub_id_3=${s.subId3 ?? "∅"} keitaro_offer=${s.keitaroOfferId ?? "∅"} type=${s.keitaroType}`),
    rows: rows.length,
    unmappedInBatch: rows.filter((r) => r.status === null).length,
  };
  if (dryRun || rows.length === 0) return result;

  const { inserted, updated, conflicts } = await database.transaction((tx) =>
    upsertConversionEvents(tx, rows),
  );
  return {
    ...result,
    inserted,
    updated,
    unchanged: rows.length - inserted - updated,
    typeConflicts: conflicts,
  };
}
