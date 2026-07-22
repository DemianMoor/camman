// TextHub adapter — wraps the unchanged raw client (lib/sends/texthub.ts).
import {
  buildSendUrl,
  sendSms as rawSendSms,
  toTexthubSender,
} from "@/lib/sends/texthub";
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

export const texthubAdapter: SmsProviderAdapter = {
  key: "txh",
  // TextHub's number is international format already — identity conversion.
  toProviderRecipient(e164: string): string {
    return e164;
  },
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    if (!p.senderNumber) {
      // The org chose to block rather than fall back to TextHub's account
      // default sender. A stage with no provider_phone_id can't send. Refuse
      // cleanly (never throw, never post) — OUR misconfiguration, so it
      // classifies as mine_transport (status 0, not timed out). Mirrors Ahoi.
      return {
        ok: false,
        messageId: null,
        response: null,
        providerStatus: null,
        suppressed: false,
        rawBody: null,
        error: "texthub: no sender number configured for this stage",
        status: 0,
        timedOut: false,
      };
    }
    return rawSendSms({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      sender: toTexthubSender(p.senderNumber),
      leadId: p.leadId,
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    return buildSendUrl({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      sender: p.senderNumber ? toTexthubSender(p.senderNumber) : undefined,
      leadId: p.leadId,
    });
  },
  // TextHub DLR is not polled/used (project §12) — no-ops.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};
