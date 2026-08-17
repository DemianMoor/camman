// TextHub adapter — wraps the unchanged raw client (lib/sends/texthub.ts).
import {
  buildSendUrl,
  sendSms as rawSendSms,
  toTexthubSender,
} from "@/lib/sends/texthub";
import { fetchInbox } from "@/lib/sends/texthub-inbox";
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

export const texthubAdapter: SmsProviderAdapter = {
  key: "txh",
  descriptor: {
    displayName: "TextHub",
    blurb:
      "TextHub API. Every operation hits one endpoint and is selected by a query flag; the api_key rides in the query string.",
    credentialFields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "TextHub api_key",
        help: "From the TextHub dashboard. Used for sending and for the STOP inbox poll.",
        secret: true,
      },
    ],
    // The two provider-specific actions are TextHub-only because both routes
    // call TextHub's client directly (see the flag notes in types.ts).
    supportsTestSend: true,
    supportsOptOutCallbackRegistration: true,
    // Reuses the inbox poller's fetch rather than a second client: it already
    // encodes both TextHub quirks — HTTP codes are unreliable (a failure
    // envelope can arrive as 404) so success keys off body `status === 200`,
    // and the EMPTY-inbox shape ({"response":"No new messages"}, no `status`
    // field) is a HEALTHY poll, not a failure. Read-only, no spend: the inbox
    // is a retained newest-first window and "claiming" is CamMan-side.
    async validateCredentials(fields) {
      const apiKey = (fields.api_key ?? "").trim();
      if (!apiKey) return { state: "invalid", detail: "No API key provided." };
      const r = await fetchInbox({ apiKey });
      if (r.ok) {
        return { state: "valid", detail: "Key authenticated against the TextHub inbox." };
      }
      // status 0 ⇒ we never got an answer, so we cannot judge the key.
      if (r.httpStatus === 0) {
        return { state: "unknown", detail: r.error ?? "TextHub did not respond." };
      }
      return {
        state: "invalid",
        detail: r.error ?? `TextHub rejected the key (HTTP ${r.httpStatus}).`,
      };
    },
  },
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
