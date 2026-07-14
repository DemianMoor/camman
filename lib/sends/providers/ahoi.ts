// Ahoi (api19/CallAPI) adapter. Section 1 = skeleton: recipient conversion is
// real; send/parse are implemented in Sections 2–3.
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

// E.164 US (+1XXXXXXXXXX) or 1XXXXXXXXXX -> bare 10-digit XXXXXXXXXX.
export function toAhoiRecipient(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits; // already 10-digit (or leave as-is for non-US, handled later)
}

export const ahoiAdapter: SmsProviderAdapter = {
  key: "ahoi",
  toProviderRecipient: toAhoiRecipient,
  async send(_p: NormalizedSendParams): Promise<SendSmsResult> {
    throw new Error("ahoi.send not implemented until Section 2");
  },
  buildRedactedRequest(_p: NormalizedSendParams): string {
    throw new Error("ahoi.buildRedactedRequest not implemented until Section 2");
  },
  parseDlr(_raw: RawWebhook): DlrEvent | null {
    throw new Error("ahoi.parseDlr not implemented until Section 3");
  },
  parseInbound(_raw: RawWebhook): InboundEvent | null {
    throw new Error("ahoi.parseInbound not implemented until Section 3");
  },
};
