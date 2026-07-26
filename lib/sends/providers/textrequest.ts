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

// Phase 1 leaves the recipient format as-is (identity). Text Request accepts
// North-American 10/11-digit numbers (leading `1` optional); the exact `to`
// format the send path uses is confirmed against a live key and encoded in
// Phase 2 alongside the real send() — encoding an unverified assumption here
// would be a silent bug. Send is stubbed, so nothing depends on this yet.
export function toTextrequestRecipient(e164: string): string {
  return e164;
}

export const textrequestAdapter: SmsProviderAdapter = {
  key: "txr",
  toProviderRecipient: toTextrequestRecipient,
  async send(_p: NormalizedSendParams): Promise<SendSmsResult> {
    // Phase 2 implements POST /messages (from / to / body / sender_name +
    // per-message status_callback carrying the stage_send token). Until then,
    // refuse cleanly — a not-implemented result, never a throw. status:0
    // classifies as a transport-side miss, and supports_api_send=false on the
    // txr provider row means the drain never reaches here in the first place
    // (defense in depth).
    return {
      ok: false,
      messageId: null,
      response: null,
      providerStatus: null,
      suppressed: false,
      rawBody: null,
      error: "textrequest: send not implemented (Phase 1 skeleton)",
      status: 0,
      timedOut: false,
      // No request is issued, so there is no round-trip to time. Phase 2 must
      // set this from a clock around its POST /messages fetch — the drain
      // persists it to send_attempts.latency_ms (see lib/sends/texthub.ts).
      latencyMs: null,
    };
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    // Never includes the x-api-key header. Representative shape only — the real
    // audit string is finalized with send() in Phase 2 (incl. status_callback).
    const to = toTextrequestRecipient(p.recipientE164);
    const from = p.senderNumber ?? "";
    return `POST ${textrequestBaseUrl()}/messages  from=${from} to=${to} body=<redacted> [not-implemented Phase 1]`;
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

// Tolerant extractor: Text Request's exact GET /dashboards response shape is
// confirmed against a live key during Phase 1 verification. Until then we accept
// the common shapes — a bare array, or a { data | content | dashboards } wrapper
// — and pick an id + name off each item. `id` is coerced to a string so an
// integer or GUID id both render (dashboard_id is stored as TEXT for exactly
// this reason). If nothing parses, `dashboards` is empty but `ok` (did the key
// authenticate?) is still the real signal the healthcheck exists to report.
function extractDashboards(parsed: unknown): TextrequestDashboard[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as Record<string, unknown>).data ??
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
    const name = typeof nameVal === "string" && nameVal.trim() ? nameVal : id;
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
