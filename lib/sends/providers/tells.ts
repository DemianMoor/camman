// Tells.co adapter — Phase 1 skeleton. Registered so `getAdapter("tls")`
// resolves and the drain's provider seam recognizes the key, but the send path
// is NOT implemented yet: send() returns a clean not-implemented failure result
// (never throws — mirrors the Ahoi / Text Request / SimpleTexting posture so
// classifyAttempt treats it as a miss). DLR/inbound parsing is Phase 3 and
// returns null (the interface's "not handled" signal), never a throw-stub. The
// `tls` provider row keeps supports_api_send=false until Phase 5 go-live.
//
// The key MUST equal the sms_providers.sms_provider_id value ('tls', provider
// row 855) — getAdapter throws UnknownProviderError otherwise, and the drain
// then refuses every Tells stage with `unknown_provider`.
//
// ============================================================================
// EVERYTHING BELOW IS DERIVED FROM THE LIVE PROBE, NOT THE DOC.
// docs/superpowers/specs/2026-08-12-tells-provider-design.md §5.1 is the
// contract. §2 is the pre-probe claim and is WRONG IN EIGHT PLACES — do not
// build against it. The traps that matter for Phases 2/3:
//
//   1. A BAD API KEY RETURNS HTTP 200. The failure is only in the body
//      (`{"status":"error","message":"Invalid api key."}`). Classification must
//      key off the BODY; a status-only classifier reads total auth failure as
//      success. Ahoi-shaped, not Text Request-shaped.
//   2. `metadata` is LOWERCASE on the DLR — the only lowercase field on an
//      otherwise PascalCase payload. Reading `Metadata` returns undefined on
//      every callback, and that field carries stage_send_id.
//   3. `metadata` is always present (null when unset) and ALWAYS A STRING, even
//      when a JSON object was sent. Parse it yourself, in a try/catch.
//   4. Id/To/From are NUMBERS on webhooks, STRINGS on the send response.
//   5. Tells DOES retry a failed callback (4x, 60s apart, ~3 min) and then
//      abandons the message's remaining statuses too.
//   6. `Date` is the delivery-ATTEMPT timestamp — it advances on every retry.
//      Never put it in a dedup key. Use (Id, Status).
//   7. A byte-identical repeat send gets HTTP 429 "Duplicate request detected".
//   8. The inbound webhook body contains the FULL LIVE API KEY in `Key`.
// ============================================================================
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

// Overridable via TELLS_API_BASE_URL for a different base without a code
// redeploy; the adapter works out of the box even if the env var is unset.
const TELLS_DEFAULT_BASE_URL = "https://app.tells.co/api/sms.php";

export function tellsBaseUrl(): string {
  return process.env.TELLS_API_BASE_URL ?? TELLS_DEFAULT_BASE_URL;
}

// E.164 US (+1XXXXXXXXXX) / 10-digit / 11-digit -> Tells's canonical 11-digit
// `1XXXXXXXXXX` (no `+`). Probe A1 confirmed Tells ACCEPTS both `+1…` and the
// bare form, but always ECHOES the bare 11-digit form — so we send what it
// echoes. Hand-rolled (no libphonenumber: it throws under tsx, and this is
// US-only), same posture as toAhoiRecipient / toTextrequestRecipient.
export function toTellsRecipient(e164: string): string {
  const digits = (e164 ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  return digits; // leave as-is for anything non-NANP-shaped (validated upstream)
}

// Inverse of toTellsRecipient: Tells's wire format -> our storage format
// (E.164 `+1XXXXXXXXXX`). The single entry point for "Tells wire format ->
// contacts.phone_number", used by the Phase 3 opt-out path (a STOP must
// suppress the number even if the contact doesn't exist yet, so this runs
// before any contact upsert). Mirrors ahoiSourceToE164 / textrequestPhoneToE164.
//
// Accepts a number as well as a string: `From`/`To` arrive as JSON NUMBERS on
// both webhooks (§5.1), and passing one to a string-only helper would coerce
// through `String(…)` at some random call site instead of here. Returns null
// for anything not NANP-shaped rather than guessing — a bad number must never
// become a bogus contact row on a compliance path.
export function tellsPhoneToE164(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  // Reject anything that isn't a plain phone: only digits + common formatting
  // chars. A junk string must NOT coincidentally normalize to a phone.
  if (!/^[+\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export const tellsAdapter: SmsProviderAdapter = {
  key: "tls",
  toProviderRecipient: toTellsRecipient,
  async send(_p: NormalizedSendParams): Promise<SendSmsResult> {
    // Phase 2 implements the real POST. Until then refuse cleanly — never
    // throw, never post a malformed request. Classified as a transport-side
    // miss (status 0, not timed out), same shape as Ahoi's no-sender refusal.
    return {
      ok: false,
      messageId: null,
      response: null,
      providerStatus: null,
      suppressed: false,
      rawBody: null,
      error: "tells: send not implemented (Phase 2)",
      status: 0,
      timedOut: false,
      segmentsCount: null,
    };
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    // Shape-only until Phase 2 builds the real form body. The api key is a form
    // param for Tells (not a header), so the redaction placeholder is not
    // optional here — never interpolate p.apiKey.
    return `POST ${tellsBaseUrl()}  key=<REDACTED> from=${p.senderNumber ?? ""} to=${toTellsRecipient(p.recipientE164)}`;
  },
  // Phase 3 owns both. Returning null is the interface's "not handled" signal.
  // Note for the implementer: the DLR's metadata field is lowercase, and a
  // FAILED message emits ONE `undelivered` event with no preceding `sent`,
  // while a successful one emits two.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};
