// Ahoi (api19/CallAPI) adapter. Section 1 built the skeleton (recipient
// conversion). Section 2 implements send()/buildRedactedRequest(). Section 3
// implements parseDlr()/parseInbound() (pure field extraction from
// form-encoded webhook bodies).
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter, ValidateCredentialsResult,
} from "./types";

// Recon default (Phase 0). Overridable via AHOI_API_BASE_URL for a different
// white-label account/base without a redeploy of code, but the adapter works
// out of the box even if the env var is never set.
const AHOI_DEFAULT_BASE_URL = "https://v1.api19.com";
const DEFAULT_TIMEOUT_MS = 15000;

export function ahoiBaseUrl(): string {
  return process.env.AHOI_API_BASE_URL ?? AHOI_DEFAULT_BASE_URL;
}

// E.164 US (+1XXXXXXXXXX) or 1XXXXXXXXXX -> bare 10-digit XXXXXXXXXX.
export function toAhoiRecipient(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits; // already 10-digit (or leave as-is for non-US, handled later)
}

// Inverse of toAhoiRecipient: Ahoi's 10-digit inbound source_number -> E.164.
// Self-contained (NOT via validatePhone/libphonenumber — that lib throws under
// tsx, and an Ahoi inbound source is already a real number). Contacts are
// stored E.164 (+1XXXXXXXXXX), so this is the normalization used on BOTH the
// contact-match and upsert-contact paths in Section 4.
export function ahoiSourceToE164(source: string): string | null {
  const s = (source ?? "").trim();
  // Reject anything that isn't a plain phone: only digits + common formatting
  // chars (+, space, -, (, ), .). A junk string like "+1zzztest…" must NOT
  // coincidentally normalize to a phone (opt-out is compliance-sensitive).
  if (!/^[+\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // not a NANP-shaped number
}

// Merge query params + form-decoded body into one flat field map. Body wins
// on key collision (Ahoi's confirmed shape is POST form-encoded; query is a
// defensive fallback in case a future callback arrives as GET). Used by both
// parseDlr/parseInbound (which need the typed subset) AND the capture
// functions in lib/sends/ahoi-dlr.ts / lib/sends/ahoi-inbound.ts (which
// archive raw source/destination fields that DlrEvent doesn't carry) — so
// both paths extract fields identically and can never disagree.
export function extractAhoiWebhookFields(raw: RawWebhook): Record<string, string> {
  const out: Record<string, string> = { ...raw.query };
  if (raw.body) {
    const params = new URLSearchParams(raw.body);
    params.forEach((v, k) => {
      out[k] = v;
    });
  }
  return out;
}

interface AhoiSendParams {
  apiKey: string;
  text: string;
  source: string; // 10-digit sending number
  destination: string; // 10-digit recipient number
  timeoutMs?: number;
}

// Pure form-body builder — exported shape (key/source/destination/message,
// no extras) is reused for BOTH the real send and the redacted audit string,
// so they can never drift apart.
function buildSendBody(p: AhoiSendParams): URLSearchParams {
  const body = new URLSearchParams();
  body.set("key", p.apiKey);
  body.set("source", p.source);
  body.set("destination", p.destination);
  body.set("message", p.text);
  return body;
}

// Send one SMS via Ahoi. Ahoi ALWAYS returns HTTP 200 (Phase 0 fact) — the
// real result is the body `status` field. Classification is off the body,
// not the HTTP status; a non-200 HTTP status is still handled defensively
// (never throws) even though it isn't observed in practice. Mirrors
// lib/sends/texthub.ts's robustness: AbortController timeout, read the body
// once as text (verbatim evidence), never throw.
async function ahoiSendSms(p: AhoiSendParams): Promise<SendSmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${ahoiBaseUrl()}/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildSendBody(p),
      signal: controller.signal,
    });

    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let parsed: { status?: unknown; uuid?: unknown; error?: unknown } = {};
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        // Non-JSON body — leave parsed fields empty; rawBody is still captured.
      }
    }
    const bodyStatus = typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : null;
    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : null;
    const errorMsg = typeof parsed.error === "string" ? parsed.error : null;

    if (bodyStatus === "ok" && uuid) {
      return {
        ok: true,
        messageId: uuid,
        response: bodyStatus,
        providerStatus: bodyStatus,
        suppressed: false, // Ahoi has no per-send suppressed status (spec §4)
        rawBody,
        error: null,
        status: res.status,
        timedOut: false,
      };
    }
    return {
      ok: false,
      messageId: null,
      response: errorMsg,
      providerStatus: bodyStatus,
      suppressed: false,
      rawBody,
      error: errorMsg ?? `Ahoi returned status="${bodyStatus ?? "unknown"}"`,
      status: res.status,
      timedOut: false,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      messageId: null,
      response: null,
      providerStatus: null,
      suppressed: false,
      rawBody: null,
      error: aborted ? "Ahoi request timed out" : "Ahoi network error",
      status: 0,
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Redacted form-body string for the send_attempts audit log — built from the
// SAME buildSendBody the real send uses, with the api_key replaced by the
// caller-supplied redacted placeholder (never the real key).
function buildRedactedBody(p: NormalizedSendParams): string {
  const body = buildSendBody({
    apiKey: p.apiKey,
    text: p.text,
    source: p.senderNumber ? toAhoiRecipient(p.senderNumber) : "",
    destination: toAhoiRecipient(p.recipientE164),
  });
  return `POST ${ahoiBaseUrl()}/sms/send  ${body.toString()}`;
}

// --- Non-sending credential check (GET /cdrs/download/csv) --------------------
// Ahoi has NO dedicated auth/ping endpoint — Phase 0 recon established that the
// CDR download is the only documented endpoint besides /sms/send. So the cheapest
// authenticated read is a same-day CDR pull: read-only, no SMS, no spend.
//
// ⚠️ MEASURED 2026-08-14 (scripts/probe-ahoi-badkey.ts, kept as the regression
// reference). api19 returns **HTTP 200 for every case** — valid key, wrong key,
// bogus key, empty key — AND `Content-Type: text/html` even for the successful
// CSV. Neither the status code nor the content type can classify. The BODY is
// the only discriminator:
//     valid key  -> body begins with the CSV header `date,your_cost,…`
//                   (117 bytes when the day has no traffic — header only)
//     wrong key  -> {"status":"error","error":"not logged in"}
//     empty key  -> {"status":"error","error":"invalid key","verbose":"none"}
//
// Two traps encoded below:
//   1. Key off the JSON `status` field, NEVER the message string — the two
//      failure modes use different messages for the same verdict.
//   2. NEVER classify on CSV row count. A valid key on a zero-traffic day
//      returns 0 data rows, which is row-identical to a failure.
// Anything that matches neither shape is `unknown`, not a pass: if api19 ever
// changes its envelope this must degrade to "couldn't verify", never false-green.

// Same-day ET window — the cheapest possible CDR request. Inlined (rather than
// importing computeCdrPollWindow from lib/sends/ahoi-cdr-poll.ts) to keep the
// adapter free of that module's db/Papa/telegram imports; the drain loads this file.
function ahoiTodayEt(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(new Date());
}

// Prefix-match the first two CSV columns rather than the full 14-column header:
// tolerant of api19 appending a column, still specific enough that arbitrary
// text can't be mistaken for a successful pull.
const AHOI_CDR_HEADER_PREFIX = "date,your_cost,";

export function classifyAhoiCdrBody(body: string): ValidateCredentialsResult {
  const trimmed = (body ?? "").trim();
  if (!trimmed) {
    return { state: "unknown", detail: "Ahoi returned an empty body." };
  }
  // 1) JSON error envelope ⇒ the key was rejected.
  try {
    const parsed = JSON.parse(trimmed) as { status?: unknown; error?: unknown };
    if (parsed && typeof parsed === "object" && parsed.status === "error") {
      const msg = typeof parsed.error === "string" ? parsed.error : "rejected";
      return { state: "invalid", detail: `Ahoi rejected the key: ${msg}.` };
    }
    // Parsed as JSON but not the known error envelope — unrecognized, not a pass.
    return {
      state: "unknown",
      detail: "Ahoi returned an unrecognized JSON response.",
    };
  } catch {
    // Not JSON — fall through to the CSV check.
  }
  // 2) CSV header ⇒ authenticated (0 data rows is normal on a quiet day).
  if (trimmed.toLowerCase().startsWith(AHOI_CDR_HEADER_PREFIX)) {
    return { state: "valid", detail: "Key authenticated against the Ahoi CDR export." };
  }
  // 3) Neither shape.
  return {
    state: "unknown",
    detail: "Ahoi returned a response in an unrecognized format.",
  };
}

async function ahoiValidateCredentials(
  fields: Record<string, string>,
): Promise<ValidateCredentialsResult> {
  const apiKey = (fields.api_key ?? "").trim();
  if (!apiKey) return { state: "invalid", detail: "No API key provided." };

  const day = ahoiTodayEt();
  const url =
    `${ahoiBaseUrl()}/cdrs/download/csv?record_type=sms` +
    `&startdate=${encodeURIComponent(day)}&enddate=${encodeURIComponent(day)}` +
    `&key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const body = await res.text();
    return classifyAhoiCdrBody(body);
  } catch (err) {
    // Never throw, and never guess: no answer means we cannot judge the key.
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      state: "unknown",
      detail: aborted ? "Ahoi request timed out." : "Could not reach Ahoi.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export const ahoiAdapter: SmsProviderAdapter = {
  key: "ahi",
  descriptor: {
    displayName: "Ahoi",
    blurb:
      "Ahoi, a white-label of the api19/CallAPI platform. The key is sent as a `key` parameter; the API answers HTTP 200 for everything, so results are read from the response body.",
    credentialFields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Ahoi api19 key",
        help: "The `key` parameter value from the Ahoi/api19 portal.",
        secret: true,
      },
    ],
    validateCredentials: ahoiValidateCredentials,
  },
  toProviderRecipient: toAhoiRecipient,
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    if (!p.senderNumber) {
      // Ahoi requires a `source` number; a stage with no provider_phone_id
      // assigned can't send. Refuse cleanly (never throw, never post a
      // malformed request) — this is OUR misconfiguration, not theirs, so it
      // classifies as mine_transport (status 0, not timed out).
      return {
        ok: false,
        messageId: null,
        response: null,
        providerStatus: null,
        suppressed: false,
        rawBody: null,
        error: "ahoi: no sender number configured for this stage",
        status: 0,
        timedOut: false,
      };
    }
    return ahoiSendSms({
      apiKey: p.apiKey,
      text: p.text,
      source: toAhoiRecipient(p.senderNumber),
      destination: toAhoiRecipient(p.recipientE164),
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    return buildRedactedBody(p);
  },
  parseDlr(raw: RawWebhook): DlrEvent | null {
    const f = extractAhoiWebhookFields(raw);
    const uuid = f.uuid?.trim();
    if (!uuid) return null; // nothing to reconcile against
    return {
      providerUuid: uuid,
      sendStatus: (f.send_status ?? "").trim(),
      status: (f.status ?? "").trim(),
      smppStatus: f.smpp_status?.trim() || null,
      smppCode: f.smpp_code?.trim() || null,
      error: f.error?.trim() || null,
    };
  },
  parseInbound(raw: RawWebhook): InboundEvent | null {
    const f = extractAhoiWebhookFields(raw);
    const source = f.source?.trim();
    const destination = f.destination?.trim();
    if (!source || !destination) return null;
    return {
      source,
      destination,
      message: f.message ?? "",
      type: (f.type ?? "sms").trim(),
      cost: f.cost?.trim() || null,
    };
  },
};
