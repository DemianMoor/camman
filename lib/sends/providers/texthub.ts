// TextHub adapter — wraps the unchanged raw client (lib/sends/texthub.ts).
import {
  buildSendUrl,
  sendSms as rawSendSms,
} from "@/lib/sends/texthub";
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

export const texthubAdapter: SmsProviderAdapter = {
  key: "texthub",
  // TextHub's number is international format already — identity conversion.
  toProviderRecipient(e164: string): string {
    return e164;
  },
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    return rawSendSms({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      leadId: p.leadId,
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    return buildSendUrl({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      leadId: p.leadId,
    });
  },
  // TextHub DLR is not polled/used (project §12) — no-ops.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};
