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
//
// PAGINATION (added 2026-07-21): TextHub switched the inbox from a flat
// ~200-most-recent list to a paginated, RETAINED ~1,500-message window, newest
// first: {status:200, page, per_page:200, total_count, total_pages, data:[...]}
// selected with `&page=N`. Reading only page 1 stranded any backlog on pages
// 2..N (a high-volume account that fell behind never caught up). fetchInbox now
// takes a `page` and returns `page`/`totalPages`; the poller walks pages until
// caught up (see pollCredential).

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
  page: number; // echoed page (1 when absent)
  totalPages: number; // 1 when absent (pre-pagination / empty inbox)
  error: string | null;
}

// Pure URL builder — testable without the network. api_key rides in the query;
// callers must never log the returned URL. `page` (1-based) selects the inbox
// page; page 1 omits the param so the URL is unchanged from the pre-pagination
// call (keeps the empty-inbox / single-page behavior byte-identical).
export function buildInboxUrl(apiKey: string, page = 1): string {
  const url = new URL(`${TEXTHUB_BASE_URL}/`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("inbox", "true");
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

// Pagination control for the poller's per-credential page walk. Returns whether
// to fetch the NEXT page, given the page just processed. Stops (returns false)
// when: caught up (0 newly-claimed on this page ⇒ this and every OLDER page are
// already ingested, since the inbox is newest-first and claiming is monotonic),
// the window is exhausted (page ≥ totalPages), the per-tick page cap is hit, or
// the per-credential time budget is spent. Pure + deterministic so the
// termination logic is unit-testable without the network or DB.
export function shouldFetchNextInboxPage(args: {
  page: number; // page just processed (1-based)
  newlyClaimedThisPage: number;
  totalPages: number;
  maxPages: number; // per-tick page cap
  elapsedMs: number;
  budgetMs: number; // per-credential time budget
}): boolean {
  if (args.newlyClaimedThisPage === 0) return false; // caught up
  if (args.page >= args.totalPages) return false; // window exhausted
  if (args.page >= args.maxPages) return false; // per-tick page cap
  if (args.elapsedMs >= args.budgetMs) return false; // time budget spent
  return true;
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

// Fetch one page of the inbound message list for one api_key. Never throws;
// returns a normalized result. `ok` requires HTTP 2xx AND body.status === 200
// (or the empty-inbox shape). `page` defaults to 1.
export async function fetchInbox(opts: {
  apiKey: string;
  page?: number;
  timeoutMs?: number;
}): Promise<FetchInboxResult> {
  const page = opts.page ?? 1;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(buildInboxUrl(opts.apiKey, page), {
      method: "GET",
      signal: controller.signal,
    });

    let body: {
      status?: unknown;
      data?: unknown;
      response?: unknown;
      page?: unknown;
      total_pages?: unknown;
    } = {};
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
      page: typeof body.page === "number" ? body.page : page,
      totalPages: typeof body.total_pages === "number" ? body.total_pages : 1,
      error: ok
        ? null
        : `TextHub inbox returned HTTP ${res.status} / status ${bodyStatus ?? "?"}`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      httpStatus: 0,
      bodyStatus: null,
      messages: [],
      page,
      totalPages: 1,
      error: aborted
        ? "TextHub inbox request timed out"
        : "TextHub inbox network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
