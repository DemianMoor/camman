import type { LedgerSourceRow } from "@/lib/conversions/keitaro-row";

export type ConversionStatus = "pending" | "approved" | "rejected";

// One conversion_event_mappings row. Exactly one of offerId / affiliateNetworkId
// is set. eventTypeId null = "status transition only" (the ledger keeps the
// row's existing event type — see upsertConversionEvents).
export interface MappingRule {
  offerId: number | null;
  affiliateNetworkId: number | null;
  keitaroType: string;
  eventTypeId: number | null;
  conversionStatus: ConversionStatus;
}

export interface ResolvedMapping {
  eventTypeId: number | null;
  status: ConversionStatus;
}

// An offer rule beats a network rule. No rule ⇒ null: the conversion is stored
// unmapped (NULL event type + status) and is never counted as a purchase.
export function resolveMapping(
  rules: readonly MappingRule[],
  key: { offerId: number | null; affiliateNetworkId: number | null; keitaroType: string },
): ResolvedMapping | null {
  const byOffer =
    key.offerId === null
      ? undefined
      : rules.find((r) => r.offerId === key.offerId && r.keitaroType === key.keitaroType);
  const rule =
    byOffer ??
    (key.affiliateNetworkId === null
      ? undefined
      : rules.find(
          (r) =>
            r.offerId === null &&
            r.affiliateNetworkId === key.affiliateNetworkId &&
            r.keitaroType === key.keitaroType,
        ));
  return rule ? { eventTypeId: rule.eventTypeId, status: rule.conversionStatus } : null;
}

export interface Lookups {
  stageSends: Map<string, { stageId: number; contactId: string }>;
  stageIdByTrackingId: Map<string, number>; // ambiguous tracking ids omitted
  stages: Map<
    number,
    { orgId: string; campaignId: number; offerId: number | null; affiliateNetworkId: number | null }
  >;
  offersByKeitaroId: Map<number, { orgId: string; offerId: number; affiliateNetworkId: number }>;
  rulesByOrg: Map<string, MappingRule[]>;
}

export interface ConversionEventInsert {
  orgId: string;
  keitaroEventId: string;
  tid: string | null;
  keitaroClickSubid: string | null;
  keitaroStatus: string;
  keitaroType: string;
  keitaroVersion: number | null;
  keitaroOfferId: number | null;
  stageSendId: string | null;
  contactId: string | null;
  campaignId: number | null;
  stageId: number | null;
  offerId: number | null;
  eventTypeId: number | null;
  status: ConversionStatus | null;
  revenue: string;
  currency: string | null;
  occurredAtEt: string;
  lastPostbackAtEt: string;
  statusHistory: string | null;
  rawParams: Record<string, unknown> | null;
}

// Attribution, strongest first:
//   1. sub_id_1 = a stage_sends row  → recipient + that row's stage
//   2. sub_id_3 = a stage tracking id → stage only
//   3. Keitaro offer id = offers.keitaro_offer_id → offer only
//   4. none → unresolved (no org to store it under; reported, not written)
// Org, campaign, offer and network come from the stage when there is one.
export function buildConversionEventRows(
  sources: readonly LedgerSourceRow[],
  lookups: Lookups,
): { rows: ConversionEventInsert[]; unresolved: LedgerSourceRow[] } {
  const rows: ConversionEventInsert[] = [];
  const unresolved: LedgerSourceRow[] = [];

  for (const s of sources) {
    const send = s.subId1 ? lookups.stageSends.get(s.subId1) : undefined;
    const stageId =
      send?.stageId ?? (s.subId3 ? lookups.stageIdByTrackingId.get(s.subId3) : undefined);
    const stage = stageId !== undefined ? lookups.stages.get(stageId) : undefined;

    let orgId: string;
    let campaignId: number | null = null;
    let offerId: number | null;
    let affiliateNetworkId: number | null;
    if (stage) {
      orgId = stage.orgId;
      campaignId = stage.campaignId;
      offerId = stage.offerId;
      affiliateNetworkId = stage.affiliateNetworkId;
    } else {
      const offer =
        s.keitaroOfferId !== null ? lookups.offersByKeitaroId.get(s.keitaroOfferId) : undefined;
      if (!offer) {
        unresolved.push(s);
        continue;
      }
      orgId = offer.orgId;
      offerId = offer.offerId;
      affiliateNetworkId = offer.affiliateNetworkId;
    }

    const mapping = resolveMapping(lookups.rulesByOrg.get(orgId) ?? [], {
      offerId,
      affiliateNetworkId,
      keitaroType: s.keitaroType,
    });

    rows.push({
      orgId,
      keitaroEventId: s.eventId,
      tid: s.tid,
      keitaroClickSubid: s.clickSubid,
      keitaroStatus: s.keitaroStatus,
      keitaroType: s.keitaroType,
      keitaroVersion: s.version,
      keitaroOfferId: s.keitaroOfferId,
      stageSendId: stage && send ? s.subId1 : null,
      contactId: stage && send ? send.contactId : null,
      campaignId,
      stageId: stage ? (stageId ?? null) : null,
      offerId,
      eventTypeId: mapping?.eventTypeId ?? null,
      status: mapping?.status ?? null,
      revenue: s.revenue,
      currency: s.currency,
      occurredAtEt: s.occurredAtEt,
      lastPostbackAtEt: s.lastPostbackAtEt,
      statusHistory: s.statusHistory,
      rawParams: s.rawParams,
    });
  }

  return { rows, unresolved };
}
