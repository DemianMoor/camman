import { resolveMapping, type MappingRule } from "@/lib/conversions/build-rows";
import {
  STANDARD_EVENT_MODEL,
  type StandardEvent,
} from "@/lib/conversions/standard-model";

// Per-event Keitaro postback URLs and the advertiser spec built from them, both
// generated from STANDARD_EVENT_MODEL. Pure — no env, no DB — so
// scripts/test-postback-urls.ts checks every rule.
//
// The base is KEITARO_POSTBACK_URL (server env): Keitaro's postback endpoint
// incl. its postback key, e.g. https://<tracker host>/<key>/postback. The
// placeholders are for the ADVERTISER to swap for their own macros.

export const PLACEHOLDERS = {
  clickId: "{CLICK_ID}",
  transactionId: "{TRANSACTION_ID}",
  originalTransactionId: "{ORIGINAL_TRANSACTION_ID}",
  payout: "{PAYOUT}",
} as const;

export type BaseUrlCheck = { ok: true; base: string } | { ok: false; reason: string };

/** The env value must be an absolute https URL with no query string. */
export function checkPostbackBase(raw: string | undefined): BaseUrlCheck {
  const v = raw?.trim();
  if (!v) return { ok: false, reason: "KEITARO_POSTBACK_URL is not set" };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, reason: "KEITARO_POSTBACK_URL is not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "KEITARO_POSTBACK_URL must use https" };
  if (u.search || u.hash) {
    return { ok: false, reason: "KEITARO_POSTBACK_URL must not carry a query string" };
  }
  return { ok: true, base: v.replace(/\/+$/, "") };
}

export interface PostbackUrl {
  keitaroType: StandardEvent["keitaroType"];
  label: string;
  countsAs: string;
  url: string;
}

// Placeholders are left literal (not percent-encoded) so the advertiser can
// search-and-replace them. A reversal carries the ORIGINAL event's tid and no
// payout: Keitaro updates that conversion in place, and CamMan excludes a
// rejected conversion's revenue.
export function buildPostbackUrls(base: string, networkCode: string): PostbackUrl[] {
  const from = encodeURIComponent(networkCode);
  return STANDARD_EVENT_MODEL.map((e) => {
    const params =
      e.keitaroType === "rejected"
        ? [
            `subid=${PLACEHOLDERS.clickId}`,
            `tid=${PLACEHOLDERS.originalTransactionId}`,
            `status=rejected`,
          ]
        : [
            `subid=${PLACEHOLDERS.clickId}`,
            `tid=${PLACEHOLDERS.transactionId}`,
            `payout=${PLACEHOLDERS.payout}`,
            `status=${e.keitaroType}`,
          ];
    return {
      keitaroType: e.keitaroType,
      label: e.advertiserLabel,
      countsAs: e.countsAs,
      url: `${base}?${[...params, `from=${from}`].join("&")}`,
    };
  });
}

/** The one-page plain-text advertiser postback spec. */
export function buildAdvertiserSpec(networkName: string, urls: readonly PostbackUrl[]): string {
  const lines = [
    `POSTBACK SPEC — ${networkName}`,
    "",
    "Fire one server-to-server GET per event, to the URL for that event below.",
    "",
    "RULES",
    `1. ${PLACEHOLDERS.clickId}: the click id we passed you on the offer link (our subid). Required on every postback.`,
    `2. ${PLACEHOLDERS.transactionId}: a NEW unique id for every new event — a registration, a sale and a deposit on the same click each get their own.`,
    `3. ${PLACEHOLDERS.originalTransactionId}: a reversal (refund, chargeback, decline) REUSES the transaction id of the event it reverses. A reversal with a new id cannot be matched and removes nothing.`,
    `4. ${PLACEHOLDERS.payout}: the payout for THIS event only, in USD — never a running total for the click.`,
    "5. Do not send the same event twice with a new transaction id; a repeat with the same id is safe.",
    "",
    "EVENTS",
  ];
  for (const u of urls) {
    lines.push("", `${u.label} — we count it as ${u.countsAs}.`, u.url);
  }
  lines.push(
    "",
    "EXAMPLE (one click, three events)",
    "  registration  tid=A1  payout=0",
    "  sale          tid=A2  payout=40.00",
    "  deposit       tid=A3  payout=15.00",
    "  refund of the sale: the Rejection URL with tid=A2",
  );
  return lines.join("\n");
}

export interface SimulationRule {
  keitaro_type: string;
  event_type_id: number | null;
  conversion_status: "approved" | "pending" | "rejected";
}

export interface SimulationEventType {
  id: number;
  label: string;
  is_purchase: boolean;
  counts_revenue: boolean;
}

export type SimulationResult =
  | { kind: "unmapped"; text: string }
  | { kind: "status_only"; status: string; text: string }
  | { kind: "mapped"; eventLabel: string; status: string; text: string };

/**
 * What CamMan would record for a postback of `keitaroType` on this network —
 * resolveMapping, the function ingest uses, on the network's live rules. No
 * Keitaro call, no ledger write. Offer-level rules (none exist today) would win
 * over these, and are not simulated.
 */
export function simulateConversion(
  networkId: number,
  keitaroType: string,
  rules: readonly SimulationRule[],
  eventTypes: readonly SimulationEventType[],
): SimulationResult {
  const mappingRules: MappingRule[] = rules.map((r) => ({
    offerId: null,
    affiliateNetworkId: networkId,
    keitaroType: r.keitaro_type,
    eventTypeId: r.event_type_id,
    conversionStatus: r.conversion_status,
  }));
  const m = resolveMapping(mappingRules, { offerId: null, affiliateNetworkId: networkId, keitaroType });
  if (!m) {
    return {
      kind: "unmapped",
      text: "No rule — it would be stored unclassified, count as nothing, and page Telegram.",
    };
  }
  if (m.eventTypeId === null) {
    return {
      kind: "status_only",
      status: m.status,
      text: `Keeps the original event's type; status → ${m.status}. ${m.status === "rejected" ? "Its revenue and sale are removed. " : ""}Without an earlier event on the same tid it lands unclassified.`,
    };
  }
  const et = eventTypes.find((e) => e.id === m.eventTypeId);
  if (!et) return { kind: "unmapped", text: "The rule names an event type this org does not have." };
  const counted =
    m.status === "rejected"
      ? "counts as nothing (rejected)"
      : [
          et.is_purchase ? "a sale" : "not a sale",
          et.counts_revenue
            ? m.status === "approved"
              ? "payout counted as revenue"
              : "payout held as pending revenue"
            : "no revenue",
        ].join(", ");
  return { kind: "mapped", eventLabel: et.label, status: m.status, text: `${et.label} · ${m.status} — ${counted}.` };
}
