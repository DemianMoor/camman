// Text Request adapter — Phase 1 skeleton. Registered so `getAdapter("txr")`
// resolves and the drain's provider seam recognizes the key, but the send path
// is NOT implemented yet: send() returns a clean not-implemented failure result
// (never throws — mirrors Ahoi's / SimpleTexting's transport-side refusal so
// classifyAttempt treats it as a miss). DLR/inbound parsing is Phase 3/4 and
// returns null (the interface's "not handled" signal), never a throw-stub. The
// only live capability in Phase 1 is the non-sending healthcheck below
// (GET /dashboards), which authenticates the stored key and lists the account's
// dashboards (each Text Request dashboard is 1:1 with a sending number).
//
// Auth differs from the other adapters: Text Request uses an `x-api-key: <key>`
// HEADER (TextHub puts the key in the URL query; Ahoi sends it as a `key` form
// param; SimpleTexting uses `Authorization: Bearer`). That difference lives
// entirely inside this file — credential STORAGE is identical (an encrypted
// api_key string). HTTP semantics are normal (real status codes), unlike Ahoi's
// always-200, so classification in Phase 2 keys off BOTH the HTTP status and the
// body `status` field.
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

// Overridable via TEXTREQUEST_API_BASE_URL for a different base without a code
// redeploy; the adapter works out of the box even if the env var is unset.
const TEXTREQUEST_DEFAULT_BASE_URL = "https://api.textrequest.com/api/v3";
const DEFAULT_TIMEOUT_MS = 15000;

export function textrequestBaseUrl(): string {
  return process.env.TEXTREQUEST_API_BASE_URL ?? TEXTREQUEST_DEFAULT_BASE_URL;
}

// E.164 US (+1XXXXXXXXXX) / 10-digit / 11-digit -> Text Request's canonical
// 11-digit `1XXXXXXXXXX` (no `+`). The Phase 0 live test confirmed TR accepts
// `+1…` and echoes back the bare 11-digit form, so we send that form for both
// `from` and `to`. Hand-rolled (no libphonenumber — throws under tsx; US-only),
// same posture as toAhoiRecipient / toTexthubSender.
export function toTextrequestRecipient(e164: string): string {
  const digits = (e164 ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  return digits; // leave as-is for anything non-NANP-shaped (validated upstream)
}

// Inverse of toTextrequestRecipient: Text Request's wire format (11-digit
// `1XXXXXXXXXX`, no '+') -> our storage format (E.164 `+1XXXXXXXXXX`). The single
// entry point for "TR wire format -> contacts.phone_number", used by every
// opt-out signal in Phase 4 (a STOP must suppress the number even if the contact
// doesn't exist yet, so this runs before the contact upsert). Mirrors
// ahoiSourceToE164. Returns null for anything not NANP-shaped rather than
// guessing — a bad number must never become a bogus contact row.
export function textrequestPhoneToE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// Text Request send-time error codes that mean "this number is opted out"
// (spec §1 error vocabularies): 2100 (status webhook) / 30050 (conversation) /
// 2001 unreachable is NOT opt-out. A send rejected for one of these is recorded
// as `filtered` (a distinct, operator-visible bucket), NOT `failed` — mirroring
// TextHub's `Suppressed` handling. It does NOT itself write an opt_out; Phase 4
// opt-out intake owns that.
const OPTOUT_ERROR_CODES = new Set(["2100", "30050"]);

// Pure request-body builder — exported shape is reused for BOTH the real send
// and the redacted audit string so they can never drift. The x-api-key is a
// HEADER, never in the body, so the body is safe to log verbatim.
export interface TxrSendBody {
  from: string;
  to: string;
  body: string;
  status_callback?: string;
  sender_name?: string;
}
export function buildMessagesBody(p: NormalizedSendParams): TxrSendBody {
  const out: TxrSendBody = {
    from: toTextrequestRecipient(p.senderNumber ?? ""),
    to: toTextrequestRecipient(p.recipientE164),
    body: p.text,
  };
  if (p.statusCallbackUrl) out.status_callback = p.statusCallbackUrl;
  return out;
}

// Pure classifier for a POST /messages outcome. Text Request uses REAL HTTP
// status codes (unlike Ahoi's always-200), so classification keys off the HTTP
// status AND the body `status` field ("sending" ⇒ accepted, "error" ⇒ rejected).
// A 2xx with status="sending" and a message_id is the only success shape.
export interface TxrSendClassification {
  ok: boolean;
  messageId: string | null;
  segmentsCount: number | null;
  providerStatus: string | null; // body `status` verbatim
  suppressed: boolean;
  error: string | null;
}
export function classifyTxrSend(
  httpStatus: number,
  parsed: Record<string, unknown> | null,
): TxrSendClassification {
  const bodyStatus =
    parsed && typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : null;
  const messageId =
    parsed && (typeof parsed.message_id === "string" || typeof parsed.message_id === "number")
      ? String(parsed.message_id)
      : null;
  const segsRaw = parsed?.segments_count;
  const segmentsCount = typeof segsRaw === "number" && Number.isFinite(segsRaw) ? segsRaw : null;
  const errorCode =
    parsed && (typeof parsed.errorCode === "string" || typeof parsed.errorCode === "number")
      ? String(parsed.errorCode)
      : null;
  const message = parsed && typeof parsed.message === "string" ? parsed.message : null;
  const suppressed = errorCode != null && OPTOUT_ERROR_CODES.has(errorCode);

  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const ok = httpOk && bodyStatus !== "error" && messageId != null;

  if (ok) {
    return { ok: true, messageId, segmentsCount, providerStatus: bodyStatus, suppressed: false, error: null };
  }
  const err =
    message ??
    (errorCode ? `Text Request errorCode ${errorCode}` : null) ??
    (bodyStatus === "error" ? 'Text Request returned status="error"' : `Text Request HTTP ${httpStatus}`);
  return { ok: false, messageId: null, segmentsCount, providerStatus: bodyStatus, suppressed, error: err };
}

async function txrSendSms(p: NormalizedSendParams, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SendSmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${textrequestBaseUrl()}/messages`, {
      method: "POST",
      headers: { "x-api-key": p.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildMessagesBody(p)),
      signal: controller.signal,
    });
    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let parsed: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsed = null; // non-JSON body — classification falls back to HTTP status
      }
    }
    const c = classifyTxrSend(res.status, parsed);
    return {
      ok: c.ok,
      messageId: c.messageId,
      response: (parsed?.message as string) ?? c.providerStatus,
      providerStatus: c.providerStatus,
      suppressed: c.suppressed,
      rawBody,
      error: c.error,
      status: res.status,
      timedOut: false,
      segmentsCount: c.segmentsCount,
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
      error: aborted ? "Text Request request timed out" : "Text Request network error",
      status: 0,
      timedOut: aborted,
      segmentsCount: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const textrequestAdapter: SmsProviderAdapter = {
  key: "txr",
  descriptor: {
    displayName: "Text Request",
    blurb:
      "Text Request API v3. The key is an `x-api-key` header, and the account is dashboard-scoped — one dashboard per sending number.",
    credentialFields: [
      {
        name: "api_key",
        label: "API key",
        placeholder: "Text Request API key",
        help: "Sent as the x-api-key header. Verifying lists the account's dashboards.",
        secret: true,
      },
    ],
    // Delegates to textrequestHealthcheck below — the same client that used to
    // back the txr-only "Check connection" endpoint, which this replaced. One
    // implementation, not two. Text Request is the only provider here with real
    // HTTP semantics, so the status code is trustworthy; an unreachable host
    // still degrades to `unknown`.
    async validateCredentials(fields) {
      const apiKey = (fields.api_key ?? "").trim();
      if (!apiKey) return { state: "invalid", detail: "No API key provided." };
      const r = await textrequestHealthcheck(apiKey);
      if (r.ok) {
        const n = r.dashboards.length;
        return {
          state: "valid",
          detail: `Key authenticated. ${n} dashboard${n === 1 ? "" : "s"} on this account.`,
          // The dashboard ids are the point, not decoration: each is 1:1 with a
          // sending number and the operator pastes one into the number's
          // `dashboard_id` field. Surfacing them here is what let the old
          // txr-only healthcheck endpoint be retired without losing anything.
          discovered: { label: "Dashboards (ID — name)", items: r.dashboards },
        };
      }
      if (r.status === 0) {
        return { state: "unknown", detail: r.error ?? "Text Request did not respond." };
      }
      if (r.status === 401 || r.status === 403) {
        return { state: "invalid", detail: `Text Request rejected the key (HTTP ${r.status}).` };
      }
      // A 5xx (or any other non-2xx) is about their service, not the key.
      return {
        state: "unknown",
        detail: r.error ?? `Text Request returned HTTP ${r.status}.`,
      };
    },
  },
  toProviderRecipient: toTextrequestRecipient,
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    if (!p.senderNumber) {
      // TR requires `from` to be a number on the account; a stage with no
      // provider_phone_id can't send. Refuse cleanly (our misconfiguration —
      // status 0, not timed out), never a throw, never a malformed request.
      return {
        ok: false,
        messageId: null,
        response: null,
        providerStatus: null,
        suppressed: false,
        rawBody: null,
        error: "textrequest: no sender number configured for this stage",
        status: 0,
        timedOut: false,
        segmentsCount: null,
      };
    }
    return txrSendSms(p);
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    // Body is safe verbatim (key is a header, not in the body). Records the
    // exact JSON that was POSTed, incl. status_callback.
    return `POST ${textrequestBaseUrl()}/messages  ${JSON.stringify(buildMessagesBody(p))}`;
  },
  // DLR intake for Text Request is a per-message status_callback + an account
  // webhook + a messages poll (Phase 3); inbound STOP is assembled from four
  // signals (Phase 4). Until built, both return null (the "not handled" signal),
  // never throw. Widening DlrEvent for Text Request's error vocabulary is a
  // Phase 3 design decision, deliberately out of this skeleton.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};

// --- Non-sending healthcheck (GET /dashboards) --------------------------------
// Confirms a stored key authenticates AND surfaces the account's dashboards.
// Text Request is entirely dashboard-scoped (one dashboard per sending number),
// so the operator needs a dashboard's id to bind it to a provider_phone — this
// check both proves the key works and lists those ids. Read-only: no SMS, no
// spend. Mirrors the robustness of the send clients (AbortController timeout,
// read the body once, never throw).

export interface TextrequestDashboard {
  id: string;
  name: string;
}

export interface TextrequestHealthResult {
  ok: boolean;
  status: number; // HTTP status (0 = network/timeout)
  dashboards: TextrequestDashboard[]; // parsed from the response
  error: string | null;
  timedOut: boolean;
}

// CONFIRMED live (recon 2026-07-25, scripts/probe-textrequest-api.ts): every
// Text Request collection response is the `items` + `meta` envelope documented
// in their OpenAPI spec —
//   {"items":[{"phone":"18449903688","name":"18449903688","timeZoneId":null,
//              "id":68093}],
//    "meta":{"page":0,"page_size":100,"total_items":2}}
// Phase 1 guessed `data`/`content`/`dashboards` and so parsed ZERO dashboards
// off a perfectly healthy 200 (the auth signal was right, the list was always
// empty). `items` is the real key and is listed FIRST; the guessed aliases are
// kept only as harmless fallbacks. `id` is coerced to a string so an integer or
// GUID id both render (dashboard_id is stored as TEXT for exactly this reason).
// `name` can be the bare number, so the phone is a better label when present.
function extractDashboards(parsed: unknown): TextrequestDashboard[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).items ??
         (parsed as Record<string, unknown>).data ??
         (parsed as Record<string, unknown>).content ??
         (parsed as Record<string, unknown>).dashboards)
      : null;
  if (!Array.isArray(arr)) return [];
  const out: TextrequestDashboard[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const rawId = o.id ?? o.dashboard_id ?? o.dashboardId;
    if (typeof rawId !== "string" && typeof rawId !== "number") continue;
    const id = String(rawId);
    const nameVal = o.name ?? o.title ?? o.label;
    const label = typeof nameVal === "string" && nameVal.trim() ? nameVal : id;
    // Surface the sending number alongside the label — that's what the operator
    // matches against a provider_phone when binding dashboard_id.
    const phone = typeof o.phone === "string" && o.phone.trim() ? o.phone : null;
    const name = phone && phone !== label ? `${label} (${phone})` : label;
    out.push({ id, name });
  }
  return out;
}

export async function textrequestHealthcheck(
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TextrequestHealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${textrequestBaseUrl()}/dashboards`, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let dashboards: TextrequestDashboard[] = [];
    if (res.ok && rawBody) {
      try {
        dashboards = extractDashboards(JSON.parse(rawBody));
      } catch {
        // Non-JSON body — leave dashboards empty; ok/status still report auth.
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      dashboards,
      error: res.ok ? null : `Text Request returned HTTP ${res.status}`,
      timedOut: false,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      dashboards: [],
      error: aborted ? "Text Request request timed out" : "Text Request network error",
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}
