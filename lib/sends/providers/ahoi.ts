// Ahoi (api19/CallAPI) adapter. Section 1 built the skeleton (recipient
// conversion). Section 2 implements send()/buildRedactedRequest(). Section 3
// implements parseDlr()/parseInbound() (pure field extraction from
// form-encoded webhook bodies).
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
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

export const ahoiAdapter: SmsProviderAdapter = {
  key: "ahi",
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
