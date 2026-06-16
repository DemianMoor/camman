// TextHub SMS client. Per swagger.json the API is NOT REST-by-path: every
// operation hits `/` and is selected by a query flag; sending an SMS is a GET.
// Auth is `api_key` as a query param on every call.
//
// CRITICAL RULES (Part B of the build brief):
//   - The tracked URL goes in `text`. `long_url` is NEVER set — that's
//     TextHub's own shortener; leaving it unset is what keeps our link
//     un-rewritten.
//   - `group` is NEVER used — a group blast shares one `text`, destroying the
//     unique per-recipient URL. Always send a single `number`.

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const DEFAULT_TIMEOUT_MS = 15000;

export interface SendSmsParams {
  apiKey: string;
  text: string;
  number: string; // exactly one recipient, international format
  leadId?: string | null;
  timeoutMs?: number;
}

export interface SendSmsResult {
  ok: boolean;
  messageId: string | null; // TextHub's returned id (handle for later DLR)
  response: string | null; // their response message (parsed `response` field)
  rawBody: string | null; // verbatim response body (evidence; Workstream 3)
  error: string | null;
  status: number; // HTTP status (0 = network/timeout)
  timedOut: boolean; // true ⇒ aborted (may have landed) vs a connection failure
}

// Pure URL builder — exported so the URL contract (text + number + api_key, and
// crucially NO long_url / NO group) is testable without hitting the network.
export function buildSendUrl(params: SendSmsParams): string {
  const url = new URL(`${TEXTHUB_BASE_URL}/`);
  url.searchParams.set("api_key", params.apiKey);
  url.searchParams.set("text", params.text);
  url.searchParams.set("number", params.number);
  if (params.leadId) url.searchParams.set("lead_id", params.leadId);
  // Intentionally never set `long_url` or `group`.
  return url.toString();
}

// Send one SMS to one recipient. Returns a normalized result; never throws.
export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(buildSendUrl(params), {
      method: "GET",
      signal: controller.signal,
    });

    // Read the body ONCE as text (verbatim evidence), then try to parse it as
    // JSON. TextHub's response shape is `{response, id}`; a non-JSON body leaves
    // the parsed fields null but the raw text is still captured for the audit.
    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let body: { response?: unknown; id?: unknown } = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as typeof body;
      } catch {
        // Non-JSON body — leave parsed fields empty; rawBody is still kept.
      }
    }
    const response = typeof body.response === "string" ? body.response : null;

    if (!res.ok) {
      return {
        ok: false,
        messageId: null,
        response,
        rawBody,
        error: response ?? `TextHub HTTP ${res.status}`,
        status: res.status,
        timedOut: false,
      };
    }
    return {
      ok: true,
      messageId: body.id != null ? String(body.id) : null,
      response,
      rawBody,
      error: null,
      status: res.status,
      timedOut: false,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      messageId: null,
      response: null,
      rawBody: null,
      error: aborted ? "TextHub request timed out" : "TextHub network error",
      status: 0,
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}
