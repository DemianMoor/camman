// The provider contract. SendSmsResult is the existing normalized send result;
// re-export it from the raw TextHub client to avoid a breaking move (G2).
export type { SendSmsResult } from "@/lib/sends/texthub";

export type NormalizedSendParams = {
  apiKey: string;
  text: string;
  recipientE164: string;      // drain speaks E.164; adapter converts inward
  senderNumber: string | null; // provider_phone as send-from number: Ahoi's source, TextHub's sender
  leadId?: string | null;
  // Optional per-message delivery callback URL. Text Request sets `status_callback`
  // PER SEND (not just per account), letting the drain embed the stage_send token
  // in the path for direct attribution. Built by the drain (origin + the stable
  // per-credential inbound_webhook_token + the stage_send id); adapters that have
  // no per-message callback (TextHub, Ahoi) ignore it. Additive + optional so
  // those adapters are untouched. Populated by the drain in Phase 2.
  statusCallbackUrl?: string;
  // Opaque per-message bag echoed back by the provider on its delivery webhook.
  // Tells's `metadata` param: the ONLY correlation handle its DLR carries, so
  // the drain populates it with `{ stage_send_id }`. Additive + optional —
  // adapters without an equivalent (TextHub, Ahoi, Text Request) ignore it.
  //
  // ⚠️ Tells returns it as an escaped JSON STRING even when an object went out,
  // and under the LOWERCASE key `metadata` (spec §5.1). Phase 3 must JSON.parse
  // it inside a try/catch.
  metadata?: Record<string, unknown> | null;
};

export type RawWebhook = {
  query: Record<string, string>;
  body: string;
  headers: Record<string, string>;
};

export type DlrEvent = {
  providerUuid: string;
  sendStatus: string;
  status: string;
  smppStatus: string | null;
  smppCode: string | null;
  error: string | null;
};

export type InboundEvent = {
  source: string;
  destination: string;
  message: string;
  type: string;
  cost: string | null;
};

import type { SendSmsResult } from "@/lib/sends/texthub";
export interface SmsProviderAdapter {
  key: "txh" | "ahi" | "txr" | "tls";
  send(p: NormalizedSendParams): Promise<SendSmsResult>;
  buildRedactedRequest(p: NormalizedSendParams): string;
  toProviderRecipient(e164: string): string;
  parseDlr(raw: RawWebhook): DlrEvent | null;
  parseInbound(raw: RawWebhook): InboundEvent | null;
}
