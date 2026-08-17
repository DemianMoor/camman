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

// ── Connection-type descriptor (869egmakh P1) ────────────────────────────────
// Static, secret-free metadata describing what a connection type IS and what it
// needs, so the provider-create UI can be driven by the adapter registry instead
// of a free-text code the operator has to know. Never contains a credential.

// One operator-entered field. Used for BOTH credential fields and per-number
// setting fields — a credential field is just a field with `secret: true`.
export type FieldSpec = {
  name: string;        // wire key, e.g. "api_key"
  label: string;
  placeholder?: string;
  help?: string;
  secret?: boolean;    // true ⇒ masked in UI, never echoed back by the API
};

// THREE states, deliberately. `unknown` is NOT a soft failure and must never be
// collapsed into `valid` or `invalid` by a caller or by the UI — it means the
// provider answered in a shape we do not recognize, so we genuinely do not know.
//
// This exists because two of our providers (Ahoi/api19, Tells) return HTTP 200
// for authentication failures and signal the real outcome only in the body. If
// one of them changes its error envelope, the classifier stops recognizing the
// failure — and the safe degradation is "couldn't verify", never a false green.
// Surface it in the UI as its own state (e.g. "Couldn't verify — provider
// response unrecognized"), distinct from both pass and fail.
// Optional structured data a successful check discovered about the account.
// Text Request's check lists the account's dashboards, and those ids are not
// trivia — a dashboard is 1:1 with a sending number and the operator needs the
// id to bind it on the number's form. Carrying it here keeps that capability on
// the uniform path instead of requiring a second provider-specific endpoint.
export type DiscoveredItems = {
  label: string; // e.g. "Dashboards (ID — name)"
  items: { id: string; name: string }[];
};

export type ValidateCredentialsResult =
  | { state: "valid"; detail: string | null; discovered?: DiscoveredItems }
  | { state: "invalid"; detail: string }
  | { state: "unknown"; detail: string };

export type ProviderDescriptor = {
  displayName: string;
  blurb: string;
  // Everything needed to authenticate one account. All four providers today
  // take exactly one opaque secret; the array shape is what lets a future
  // provider need account_id + secret without a schema change.
  credentialFields: FieldSpec[];
  // Non-sending reachability + auth check for a set of entered/stored field
  // values. Omitted ⇒ this connection type cannot be verified without sending,
  // and the UI must say so rather than offering a test that can't fail.
  // MUST NOT throw: network/timeout is a `unknown`, not an exception.
  validateCredentials?: (
    fields: Record<string, string>,
  ) => Promise<ValidateCredentialsResult>;

  // ── Provider-specific action capabilities (869egmakh P2) ──────────────────
  // These gate the two pre-existing, TextHub-IMPLEMENTED routes. Both were
  // previously gated only in the client component, so a direct request with any
  // provider's credential reached TextHub's API regardless of who that
  // credential belonged to. The routes now re-check these server-side.
  //
  // ⚠️ A flag means "the existing route works for this connection type", NOT
  // "this provider has such a feature". The routes call TextHub's client
  // directly; enabling a new provider means implementing its branch in the
  // route, not flipping the flag.

  // Ad-hoc single test send. SPENDS MONEY — kept separate from the non-sending
  // Test-connection action on purpose, and still gated by SEND_ENABLED.
  supportsTestSend?: boolean;
  // Registering the inbound STOP callback with the provider over their API.
  // MUTATES REMOTE STATE at the provider, so likewise a separate action.
  supportsOptOutCallbackRegistration?: boolean;

  // ── Seams: declared now, intentionally unset on every adapter ─────────────
  // No speculative values — a provider only gets one when its real requirement
  // is known. Absent behaves exactly as today.

  // Footer wording this connection type REQUIRES. Consumer: card 869ej8r1y Q3
  // (precedence number.opt_out_footer > this > stage.stop_text > 'Stop to END').
  defaultOptOutFooter?: string;
  // True ⇒ the provider appends its own opt-out text, so CamMan must append
  // NOTHING and the kickoff gate validates against the provider's known text.
  // Consumer: card 869ej8r1y Q3.
  appendsOwnOptOut?: boolean;
  // Per-number provider-specific settings (the `dashboard_id` generalization).
  // Consumer: card 869ej8r00 Q2 — blocked on adapter_code (card 869ej8qzk).
  phoneSettingFields?: FieldSpec[];

  // ── Operator-facing notes (R3) ────────────────────────────────────────────
  // The "About this provider" copy rendered on /settings/providers. CODE-OWNED,
  // not a DB column, deliberately: these describe how a CONNECTION TYPE behaves,
  // which is a property of the adapter and changes only when the adapter does. A
  // DB column would let the two drift, and an operator editing "TextHub returns
  // failures as 404" would be editing a fact, not a preference.
  //
  // Rules for anything added here:
  //   • it must be TRUE of this connection type and verifiable from the code or
  //     a probe script — this is documentation an operator will act on;
  //   • it must be operationally USEFUL (something that changes what they do),
  //     not adapter trivia;
  //   • never a secret, and never a value — descriptors are secret-free.
  notes?: string[];
};

// True of every connection type, so it is defined ONCE and spread into each
// descriptor rather than retyped four times (or rendered as a footnote the
// panel would have to special-case). Operators reliably look for the rate limit
// on the provider, and it is not there.
export const PER_NUMBER_RATE_NOTE =
  "Per-second send rate is a property of the NUMBER, not this account: it lives on " +
  "each sending number's max_sends_per_second. The account-level caps here are the " +
  "per-run, per-minute and 24-hour volume ceilings.";

import type { SendSmsResult } from "@/lib/sends/texthub";
export interface SmsProviderAdapter {
  key: "txh" | "ahi" | "txr" | "tls";
  // Optional so adding it broke no adapter at introduction; every adapter that
  // exists today sets it. Read it through the registry's getDescriptor(), which
  // is keyed on the REGISTRY key — `adapter.key` misreports for the txh2 alias.
  descriptor?: ProviderDescriptor;
  send(p: NormalizedSendParams): Promise<SendSmsResult>;
  buildRedactedRequest(p: NormalizedSendParams): string;
  toProviderRecipient(e164: string): string;
  parseDlr(raw: RawWebhook): DlrEvent | null;
  parseInbound(raw: RawWebhook): InboundEvent | null;
}
