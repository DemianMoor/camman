// TextHub inbound-message polling (`?inbox=true`).
//
// This is the opt-out intake path. The push `opt_out_callback` registration is
// broken on TextHub's side (returns status:0 for any URL, including
// example.com), so we POLL the inbox instead. Confirmed shape (probed live):
//   GET https://api.texthub.com/v2/?api_key=<key>&inbox=true
//   -> 200 {"status":200,"response":<n>,"data":[
//        {"id":"13899963","message":"STOP ✋️","phone":"+19152828203",
//         "received_at":"2026-06-04 03:54:10"}, ... ]}
// Success is signaled by body.status === 200 (TextHub's HTTP codes are
// unreliable — registration returns 404 on a failure envelope), so we key off
// the body, not the HTTP status alone.
// EMPTY inbox is a DIFFERENT healthy shape: HTTP 200 {"response":"No new
// messages"} with NO status field (probed live 2026-07-20). fetchInbox treats
// it as a successful poll with messages:[], not a failure — see below.

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const DEFAULT_TIMEOUT_MS = 20000;

export interface InboxMessage {
  id: string;
  message: string;
  phone: string;
  received_at: string | null;
}

export interface FetchInboxResult {
  ok: boolean;
  httpStatus: number; // 0 = network/timeout
  bodyStatus: number | null; // TextHub's body `status` field
  messages: InboxMessage[];
  error: string | null;
}

// Pure URL builder — testable without the network. api_key rides in the query;
// callers must never log the returned URL.
export function buildInboxUrl(apiKey: string): string {
  const url = new URL(`${TEXTHUB_BASE_URL}/`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("inbox", "true");
  return url.toString();
}

function coerceMessages(data: unknown): InboxMessage[] {
  if (!Array.isArray(data)) return [];
  const out: InboxMessage[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.id == null || r.phone == null) continue;
    out.push({
      id: String(r.id),
      message: typeof r.message === "string" ? r.message : "",
      phone: String(r.phone),
      received_at: r.received_at != null ? String(r.received_at) : null,
    });
  }
  return out;
}

// Fetch the inbound message list for one api_key. Never throws; returns a
// normalized result. `ok` requires HTTP 2xx AND body.status === 200.
export async function fetchInbox(opts: {
  apiKey: string;
  timeoutMs?: number;
}): Promise<FetchInboxResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(buildInboxUrl(opts.apiKey), {
      method: "GET",
      signal: controller.signal,
    });

    let body: { status?: unknown; data?: unknown; response?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    const bodyStatus = typeof body.status === "number" ? body.status : null;

    // When messages exist TextHub returns {status:200, data:[...]}. When the
    // inbox is EMPTY it returns a bare {"response":"No new messages"} (HTTP 200,
    // NO status field) — a healthy poll with nothing to ingest, not a failure.
    // Without this branch the empty response fell through to ok:false and fired
    // the "Opt-out poller FAILED" alert on every quiet poll (false positive).
    // Treat it as a successful empty poll (messages:[]). Genuine failures
    // (non-2xx, network, a status:0 error envelope) still return ok:false.
    const emptyInbox =
      res.ok &&
      bodyStatus === null &&
      typeof body.response === "string" &&
      body.response.toLowerCase().includes("no new messages");

    const ok = (res.ok && bodyStatus === 200) || emptyInbox;

    return {
      ok,
      httpStatus: res.status,
      bodyStatus,
      messages: ok ? coerceMessages(body.data) : [],
      error: ok ? null : `TextHub inbox returned HTTP ${res.status} / status ${bodyStatus ?? "?"}`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      httpStatus: 0,
      bodyStatus: null,
      messages: [],
      error: aborted ? "TextHub inbox request timed out" : "TextHub inbox network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
