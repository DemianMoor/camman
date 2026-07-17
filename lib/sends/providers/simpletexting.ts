// SimpleTexting adapter — Phase 1 skeleton. Registered so `getAdapter("smpl")`
// resolves and the drain's provider seam recognizes the key, but the send path
// is NOT implemented yet: send() returns a clean not-implemented failure result
// (never throws — mirrors Ahoi's no-sender refusal so classifyAttempt treats it
// as a transport-side miss). DLR/inbound parsing is Phase 3/4 and returns null
// (the interface's "not handled" signal), never a throw-stub. The only live
// capability in Phase 1 is the non-sending healthcheck below (GET /api/phones),
// which authenticates the stored token and lists usable sender numbers.
//
// Auth differs from the other adapters: SimpleTexting uses an
// `Authorization: Bearer <token>` HEADER (TextHub puts the key in the URL query;
// Ahoi sends it as a `key` form param). That difference lives entirely inside
// this file — credential STORAGE is identical (an encrypted api_key string).
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

// Overridable via SIMPLETEXTING_API_BASE_URL for a different base without a
// code redeploy; the adapter works out of the box even if the env var is unset.
const SIMPLETEXTING_DEFAULT_BASE_URL = "https://api-app2.simpletexting.com/v2";
const DEFAULT_TIMEOUT_MS = 15000;

export function simpletextingBaseUrl(): string {
  return process.env.SIMPLETEXTING_API_BASE_URL ?? SIMPLETEXTING_DEFAULT_BASE_URL;
}

// Phase 1 leaves the recipient format as-is (identity). SimpleTexting's exact
// contactPhone/accountPhone format (E.164 vs bare 10-digit) is confirmed and
// encoded in Phase 2 alongside the real send() — encoding an unverified
// assumption here would be a silent bug. Send is stubbed, so nothing depends
// on this conversion yet.
export function toSimpletextingRecipient(e164: string): string {
  return e164;
}

export const simpletextingAdapter: SmsProviderAdapter = {
  key: "smpl",
  toProviderRecipient: toSimpletextingRecipient,
  async send(_p: NormalizedSendParams): Promise<SendSmsResult> {
    // Phase 2 implements POST /api/messages (contactPhone / accountPhone /
    // text / mode). Until then, refuse cleanly — a not-implemented result,
    // never a throw. status:0 classifies as a transport-side miss, and
    // supports_api_send=false on the smpl provider row means the drain never
    // reaches here in the first place (defense in depth).
    return {
      ok: false,
      messageId: null,
      response: null,
      providerStatus: null,
      suppressed: false,
      rawBody: null,
      error: "simpletexting: send not implemented (Phase 1 skeleton)",
      status: 0,
      timedOut: false,
    };
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    // Never includes the Bearer token. Representative shape only — the real
    // audit string is finalized with send() in Phase 2.
    const to = toSimpletextingRecipient(p.recipientE164);
    const from = p.senderNumber ?? "";
    return `POST ${simpletextingBaseUrl()}/api/messages  contactPhone=${to} accountPhone=${from} text=<redacted> [not-implemented Phase 1]`;
  },
  // DLR + inbound STOP intake are webhook-only for SimpleTexting (Phases 3/4).
  // There is no CDR-polling backstop on this provider — expressed by the
  // absence of any poll method on the interface, not a stub. Until built, both
  // return null (the "not handled" signal), never throw.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};

// --- Non-sending healthcheck (GET /api/phones) --------------------------------
// Confirms a stored token authenticates AND surfaces the account's usable
// sender numbers. Read-only: no SMS, no spend. Mirrors the robustness of the
// send clients (AbortController timeout, read the body once, never throw).

export interface SimpletextingHealthResult {
  ok: boolean;
  status: number; // HTTP status (0 = network/timeout)
  numbers: string[]; // usable sender numbers parsed from the response
  error: string | null;
  timedOut: boolean;
}

// Tolerant extractor: SimpleTexting's exact GET /api/phones response shape is
// confirmed against a live token during Phase 1 verification. Until then we
// accept the common shapes — a bare array, or a { data | content | phones }
// wrapper — and pick a phone-ish field off object items. If nothing parses,
// `numbers` is empty but `ok` (did the token authenticate?) is still the real
// signal the healthcheck exists to report.
function extractPhoneNumbers(parsed: unknown): string[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).data ??
         (parsed as Record<string, unknown>).content ??
         (parsed as Record<string, unknown>).phones)
      : null;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      out.push(item);
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const v = o.phone ?? o.number ?? o.phoneNumber ?? o.phone_number;
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

export async function simpletextingHealthcheck(
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SimpletextingHealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${simpletextingBaseUrl()}/api/phones`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let numbers: string[] = [];
    if (res.ok && rawBody) {
      try {
        numbers = extractPhoneNumbers(JSON.parse(rawBody));
      } catch {
        // Non-JSON body — leave numbers empty; ok/status still report the auth.
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      numbers,
      error: res.ok ? null : `SimpleTexting returned HTTP ${res.status}`,
      timedOut: false,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      numbers: [],
      error: aborted ? "SimpleTexting request timed out" : "SimpleTexting network error",
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}
