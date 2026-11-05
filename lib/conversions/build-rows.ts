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

// ── Global pixel (migration 0233) ───────────────────────────────────────────
// Some advertisers cannot switch their GLOBAL pixel off per offer. It never
// carries our marker; CamMan's offer-specific postback URLs always end in
// `from=<network code>` (lib/conversions/postback-urls.ts). The offer's
// global_pixel_mode says what an UNMARKED conversion counts as.
export const GLOBAL_PIXEL_MODES = ["default", "lead", "purchase", "ignore"] as const;
export type GlobalPixelMode = (typeof GLOBAL_PIXEL_MODES)[number];

export interface OfferPixelSetting {
  mode: GlobalPixelMode;
  networkCode: string | null; // affiliate_networks.network_id of the offer's network
}

export type GlobalPixelDecision =
  | { kind: "rule" } // keep the network-rule result unchanged
  | { kind: "override"; eventTypeId: number }
  | { kind: "ignore" }; // do not write the conversion

/** True when the postback carries OUR marker: `from` equals the offer's network code (case-insensitive). */
export function hasOurMarker(rawParams: Record<string, unknown> | null, networkCode: string | null): boolean {
  const from = rawParams?.from;
  if (typeof from !== "string" || !networkCode) return false;
  return from.trim().toLowerCase() === networkCode.trim().toLowerCase();
}

// Pure. Marked conversions, `default` offers and REVERSALS (a status-only rule:
// event type NULL, status set — e.g. `rejected`) always keep the rule result.
// lead / purchase replace only the event type (status stays the rule's); a type
// the org lacks, or a Keitaro type no rule maps, keeps the rule result too.
export function applyGlobalPixelMode(args: {
  setting: OfferPixelSetting | undefined;
  rawParams: Record<string, unknown> | null;
  mapping: ResolvedMapping | null;
  eventTypeIds: { lead: number | null; purchase: number | null } | undefined;
}): GlobalPixelDecision {
  const { setting, rawParams, mapping, eventTypeIds } = args;
  if (!setting || setting.mode === "default") return { kind: "rule" };
  if (hasOurMarker(rawParams, setting.networkCode)) return { kind: "rule" };
  if (mapping && mapping.eventTypeId === null) return { kind: "rule" }; // reversal
  if (setting.mode === "ignore") return { kind: "ignore" };
  if (!mapping) return { kind: "rule" };
  const target = setting.mode === "lead" ? eventTypeIds?.lead : eventTypeIds?.purchase;
  return target == null ? { kind: "rule" } : { kind: "override", eventTypeId: target };
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
  // 0233. REQUIRED (CLAUDE.md §11b): it decides what a conversion counts as,
  // which decides who is a buyer. Keyed by the STORED offer id.
  offerPixelSettings: Map<number, OfferPixelSetting>;
  // Per org: the `lead` and `purchase` event type ids the override assigns.
  pixelEventTypeIdsByOrg: Map<string, { lead: number | null; purchase: number | null }>;
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

// The offer a conversion is STORED under. When the conversion carries a Keitaro
// offer id that maps unambiguously (offersByKeitaroId drops shared ids) to an
// offer in the stage's own org, that offer wins over the stage's campaign offer,
// so a link pointing at a different offer is credited to it. Otherwise the
// campaign offer stands. Storage only: classification (resolveMapping) keeps
// using the campaign offer and its network, so who is excluded from a later
// send never changes with where a row is stored.
export function resolveConversionOffer(
  stage: { orgId: string; offerId: number | null; affiliateNetworkId: number | null },
  keitaroOfferId: number | null,
  lookups: Pick<Lookups, "offersByKeitaroId">,
): { offerId: number | null; affiliateNetworkId: number | null; source: "keitaro_offer" | "campaign" } {
  const mapped =
    keitaroOfferId !== null ? lookups.offersByKeitaroId.get(keitaroOfferId) : undefined;
  if (mapped && mapped.orgId === stage.orgId) {
    // affiliateNetworkId is the mapped offer's network (nothing reads it today) —
    // classification (resolveMapping) must NOT use it; it uses the campaign's.
    return { offerId: mapped.offerId, affiliateNetworkId: mapped.affiliateNetworkId, source: "keitaro_offer" };
  }
  return { offerId: stage.offerId, affiliateNetworkId: stage.affiliateNetworkId, source: "campaign" };
}

// Attribution, strongest first:
//   1. sub_id_1 = a stage_sends row  → recipient + that row's stage
//   2. sub_id_3 = a stage tracking id → stage only
//   3. Keitaro offer id = offers.keitaro_offer_id → offer only
//   4. none → unresolved (no org to store it under; reported, not written)
// Org and campaign come from the stage when there is one. The STORED offer is
// resolveConversionOffer's (the mapped Keitaro offer, else the campaign's);
// classification keeps the campaign's offer and network (mappingOfferId).
export function buildConversionEventRows(
  sources: readonly LedgerSourceRow[],
  lookups: Lookups,
): {
  rows: ConversionEventInsert[];
  unresolved: LedgerSourceRow[];
  // Unmarked conversions on an offer set to `ignore` — never written, so they
  // can neither add a conversion nor overwrite a stored one on the same tid.
  ignored: ConversionEventInsert[];
} {
  const rows: ConversionEventInsert[] = [];
  const unresolved: LedgerSourceRow[] = [];
  const ignored: ConversionEventInsert[] = [];

  for (const s of sources) {
    const send = s.subId1 ? lookups.stageSends.get(s.subId1) : undefined;
    const stageId =
      send?.stageId ?? (s.subId3 ? lookups.stageIdByTrackingId.get(s.subId3) : undefined);
    const stage = stageId !== undefined ? lookups.stages.get(stageId) : undefined;

    let orgId: string;
    let campaignId: number | null = null;
    let offerId: number | null; // stored offer
    let mappingOfferId: number | null; // classification offer
    let affiliateNetworkId: number | null;
    if (stage) {
      orgId = stage.orgId;
      campaignId = stage.campaignId;
      mappingOfferId = stage.offerId;
      affiliateNetworkId = stage.affiliateNetworkId;
      offerId = resolveConversionOffer(stage, s.keitaroOfferId, lookups).offerId;
    } else {
      const offer =
        s.keitaroOfferId !== null ? lookups.offersByKeitaroId.get(s.keitaroOfferId) : undefined;
      if (!offer) {
        unresolved.push(s);
        continue;
      }
      orgId = offer.orgId;
      offerId = offer.offerId;
      mappingOfferId = offer.offerId;
      affiliateNetworkId = offer.affiliateNetworkId;
    }

    const ruleMapping = resolveMapping(lookups.rulesByOrg.get(orgId) ?? [], {
      offerId: mappingOfferId,
      affiliateNetworkId,
      keitaroType: s.keitaroType,
    });
    // The global-pixel setting is read from the STORED offer (owner, 2026-11-05):
    // the offer whose advertiser actually fired the pixel.
    const pixel = applyGlobalPixelMode({
      setting: offerId !== null ? lookups.offerPixelSettings.get(offerId) : undefined,
      rawParams: s.rawParams,
      mapping: ruleMapping,
      eventTypeIds: lookups.pixelEventTypeIdsByOrg.get(orgId),
    });
    const mapping =
      pixel.kind === "override" && ruleMapping
        ? { eventTypeId: pixel.eventTypeId, status: ruleMapping.status }
        : ruleMapping;

    (pixel.kind === "ignore" ? ignored : rows).push({
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

  return { rows, unresolved, ignored };
}
