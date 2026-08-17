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
import { PER_NUMBER_RATE_NOTE } from "./types";

// Overridable via TELLS_API_BASE_URL for a different base without a code
// redeploy; the adapter works out of the box even if the env var is unset.
const TELLS_DEFAULT_BASE_URL = "https://app.tells.co/api/sms.php";
// Probe measured the send API at 128–733ms (§5.1). 15s matches Ahoi/TextHub —
// generous enough that a slow-but-live send isn't aborted, short enough that a
// hung request can't eat the drain's per-invocation budget. On abort we do NOT
// retry: the message may have landed.
const DEFAULT_TIMEOUT_MS = 15000;

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

interface TellsSendParams {
  apiKey: string;
  text: string;
  from: string; // bare 11-digit sending number
  to: string;   // bare 11-digit recipient
  metadata?: Record<string, unknown> | null;
  timeoutMs?: number;
}

// Pure form-body builder. Used by BOTH the real send and the redacted audit
// string (with a placeholder key), so the two can never drift — same rule as
// Ahoi's buildSendBody. `metadata` is serialized to a JSON string because Tells
// echoes it back as a string regardless (§5.1); sending a string means what we
// store and what comes back on the DLR are byte-identical.
export function buildTellsSendBody(p: TellsSendParams): URLSearchParams {
  const body = new URLSearchParams();
  body.set("key", p.apiKey);
  body.set("from", p.from);
  body.set("to", p.to);
  body.set("message", p.text);
  if (p.metadata && Object.keys(p.metadata).length > 0) {
    body.set("metadata", JSON.stringify(p.metadata));
  }
  return body;
}

// The duplicate-refusal marker, surfaced on providerStatus. NOT a new
// AttemptClassification value: `send_attempts.classification` is CHECK-
// constrained to four values (migration 0064) and feeds the reports enum in
// lib/sends/attempt-summary.ts, so a fifth would mean a migration plus a report
// ripple. A 429 is a genuine rejection envelope from them ⇒ `theirs_rejected`
// via the shared classifier, and never retried (failed rows are never
// re-claimed by the drain). This constant is the distinct, machine-readable
// handle for it.
export const TELLS_DUPLICATE_STATUS = "duplicate";

// Pure classifier — HTTP status + verbatim body in, normalized result out. No
// network, no side effects, so the whole matrix is unit-testable directly
// (scripts/test-tells-send.ts). Mirrors classifyTxrSend.
//
// ⚠️ CLASSIFY OFF THE BODY, NOT THE HTTP STATUS. Every send error — including a
// totally invalid API key — comes back as HTTP 200 with {"status":"error"}
// (§5.1). A status-only classifier reads total auth failure as success. Success
// is `status === "queued"` AND a usable `id`; nothing else counts.
export function classifyTellsSend(
  httpStatus: number,
  rawBody: string | null,
): SendSmsResult {
  let parsed: {
    id?: unknown; status?: unknown; message?: unknown; sms_count?: unknown;
  } = {};
  if (rawBody) {
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      // Non-JSON body — leave parsed empty; rawBody is still captured verbatim.
    }
  }

  const bodyStatus =
    typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : null;
  // `id` is a STRING on the send response but a NUMBER on the webhook (§5.1).
  // Coerce to string HERE so stage_sends.texthub_message_id and the DLR's
  // String(Id) compare equal — correlation that skips this silently never
  // matches. Numbers stay well under 2^53, so no precision risk.
  const messageId =
    typeof parsed.id === "string" && parsed.id.trim() !== ""
      ? parsed.id.trim()
      : typeof parsed.id === "number" && Number.isFinite(parsed.id)
        ? String(parsed.id)
        : null;
  const providerMessage =
    typeof parsed.message === "string" ? parsed.message : null;
  // Multi-segment does NOT fragment the DLR — one id, sms_count > 1 (§5.1).
  const segmentsCount =
    typeof parsed.sms_count === "number" && Number.isFinite(parsed.sms_count)
      ? parsed.sms_count
      : null;

  // Success: status "queued" + a usable id. `ok: true` marks the row SENT in
  // the drain, so it must never be returned without a real messageId.
  if (bodyStatus === "queued" && messageId) {
    return {
      ok: true, messageId, response: bodyStatus, providerStatus: bodyStatus,
      suppressed: false, // Tells has no per-send suppression status
      rawBody, error: null, status: httpStatus, timedOut: false, segmentsCount,
    };
  }

  // Duplicate refusal (the only non-200 send response observed). Q5 is closed:
  // this cannot happen in normal operation — CamMan excludes a contact from a
  // stage it has already been sent — so if it fires, the dedup upstream of here
  // is broken. The caller logs it loudly; it is OUR bug wearing their code.
  if (httpStatus === 429) {
    return {
      ok: false, messageId: null, response: providerMessage,
      providerStatus: TELLS_DUPLICATE_STATUS, suppressed: false, rawBody,
      error: providerMessage ?? "Tells refused a duplicate request",
      status: httpStatus, timedOut: false, segmentsCount: null,
    };
  }

  // Every other failure — all three HTTP-200 error shapes (bad key, missing
  // `from`, number not SMS-enabled) plus anything unparseable — normalizes to
  // one shape. ok:false keeps it out of the sent bucket; the verbatim rawBody
  // is the evidence. Mirrors Ahoi's fall-through.
  return {
    ok: false, messageId: null, response: providerMessage,
    providerStatus: bodyStatus, suppressed: false, rawBody,
    error:
      providerMessage ??
      `Tells returned status="${bodyStatus ?? "unparseable"}" with no message id`,
    status: httpStatus, timedOut: false, segmentsCount: null,
  };
}

// Send one SMS via Tells.
//
// NO RETRY, ever — not on timeout, not on the 429. A timeout may have landed
// (the drain classifies it `indeterminate` for a human to reconcile), and
// re-sending would risk a double-send.
async function tellsSendSms(p: TellsSendParams): Promise<SendSmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(tellsBaseUrl(), {
      method: "POST", // POST only — the probe never exercised GET, so we never send one
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildTellsSendBody(p),
      signal: controller.signal,
    });

    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }

    const result = classifyTellsSend(res.status, rawBody);
    if (result.providerStatus === TELLS_DUPLICATE_STATUS) {
      console.error(
        "[tells] HTTP 429 duplicate refusal — Tells rejected a byte-identical " +
          "send. CamMan's audience dedup should make this unreachable; treat as " +
          "a CamMan-side dedup bug, not expected provider behaviour. " +
          `provider_message=${JSON.stringify(result.response)}`,
      );
    }
    return result;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false, messageId: null, response: null, providerStatus: null,
      suppressed: false, rawBody: null,
      error: aborted ? "Tells request timed out" : "Tells network error",
      status: 0, timedOut: aborted, segmentsCount: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const tellsAdapter: SmsProviderAdapter = {
  key: "tls",
  descriptor: {
    displayName: "Tells",
    blurb:
      "Tells.co. The key is a `key` form parameter on a single POST endpoint; like Ahoi, failures come back as HTTP 200 with the error in the body.",
    credentialFields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Tells API key",
        help: "From the Tells dashboard. Sent as the `key` form parameter.",
        secret: true,
      },
    ],
    // validateCredentials is DELIBERATELY ABSENT — Tells exposes exactly one
    // endpoint (`sms.php`, spec §5.1) and it sends a message. There is no
    // non-sending way to prove a key, and spending money to run a "test" is not
    // one. Worse, Tells validates `from` BEFORE `key`, so a request crafted to
    // avoid sending never reaches key validation at all and would report
    // nothing useful about the credential.
    //
    // Omitting it is the honest contract: the UI must say this connection type
    // can't be verified without sending, NOT offer a check that always passes.
    // If Tells ever ships a balance/account endpoint, add it here.
    notes: [
      "This key cannot be verified without sending. Tells exposes exactly one endpoint " +
        "and it sends a message, and it validates the from-number before the key — so " +
        "even a request crafted to avoid sending never reaches key validation. There is " +
        "deliberately no Test connection button here; a test that cannot fail is worse " +
        "than none.",
      "Inbound intake is webhook-only — there is no poll to fall back on. If the webhook " +
        "stops arriving, STOP replies stop arriving with it, and nothing errors. The " +
        "silence monitors are the only detection layer.",
      "Their inbound webhook body carries the LIVE API key in its Key field. CamMan " +
        "redacts that one field before persisting the payload and before any alert, so " +
        "the credential never reaches the database, a backup, or Telegram. If the body " +
        "cannot be parsed it is stored as null rather than verbatim — losing an " +
        "unparseable body beats persisting a live key.",
      PER_NUMBER_RATE_NOTE,
    ],
  },
  toProviderRecipient: toTellsRecipient,
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    if (!p.senderNumber) {
      // Tells validates `from` BEFORE `key` (§5.1), so a missing sender would
      // come back as "From number is required." — but that costs a round trip
      // to learn something we already know. Refuse cleanly here instead: OUR
      // misconfiguration ⇒ mine_transport (status 0, not timed out). Same
      // posture as Ahoi's no-sender refusal.
      return {
        ok: false, messageId: null, response: null, providerStatus: null,
        suppressed: false, rawBody: null,
        error: "tells: no sender number configured for this stage",
        status: 0, timedOut: false, segmentsCount: null,
      };
    }
    return tellsSendSms({
      apiKey: p.apiKey,
      text: p.text,
      from: toTellsRecipient(p.senderNumber),
      to: toTellsRecipient(p.recipientE164),
      metadata: p.metadata ?? null,
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    // Built from the SAME builder the real send uses, with the key replaced by
    // the caller's placeholder — the api key is a form PARAM for Tells (not a
    // header), so redaction here is load-bearing, not cosmetic.
    const body = buildTellsSendBody({
      apiKey: p.apiKey, // already a `redacted_XXXX` placeholder at the call site
      text: p.text,
      from: p.senderNumber ? toTellsRecipient(p.senderNumber) : "",
      to: toTellsRecipient(p.recipientE164),
      metadata: p.metadata ?? null,
    });
    return `POST ${tellsBaseUrl()}  ${body.toString()}`;
  },
  // Phase 3 owns both. Returning null is the interface's "not handled" signal.
  // Note for the implementer: the DLR's metadata field is lowercase, and a
  // FAILED message emits ONE `undelivered` event with no preceding `sent`,
  // while a successful one emits two.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};
