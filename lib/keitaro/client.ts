// Keitaro Admin API client (read-only). All calls hit the single dedicated
// admin/API host (KEITARO_API_URL, default https://admin.gdkn.org) — never a
// brand tracking domain — authenticated with the `Api-Key` header. The key
// lives in KEITARO_API_KEY and is never logged.
//
// This module holds no DB access and never throws: every call returns a
// normalized { ok, status, ... , error } so the cron poll can log a failure
// and retry next cycle without crashing (see lib/keitaro/poll.ts).

const DEFAULT_BASE_URL = "https://admin.gdkn.org";
const DEFAULT_TIMEOUT_MS = 20000;

// ── Report shape (CENTRALIZED, documented Keitaro keys) ──────────────────────
// The grouping/metric keys below are the single place to adjust if Keitaro's
// report/build silently returns nothing for a key (the keys vary by version —
// confirm against the live Swagger / DevTools payload). Grouping by `day` +
// `sub_id_3` + `campaign_id` yields one row per (ET date, stage tracking id,
// Keitaro campaign) — the campaign dimension lets the poll separate landing-page
// VISITS from OFFER REDIRECTS (Step 5b), which share the same sub_id_3.
//
// `campaign_id` is the documented grouping key; the row carries it back under the
// same name. If a Keitaro version instead returns the campaign under `campaign`
// (the name), the poll resolves either against the campaigns list — see
// resolveCampaignClass in lib/keitaro/poll.ts.
export const KEITARO_GROUPING = ["day", "sub_id_3", "campaign_id"] as const;

// The Keitaro campaign NAME whose clicks are landing-page VISITS ("Clickers").
// Any other campaign's clicks are OFFER REDIRECTS and its conversions are SALES.
// Classify by NAME (the rebuild-safe human label), never a hardcoded numeric id.
// NOTE: in the live panel `gk-lp-visits` is the campaign's *name* — its *alias*
// is a random code (e.g. `ZttBSV`), so matching on alias finds nothing.
export const KEITARO_VISIT_CAMPAIGN_NAME = "gk-lp-visits";
export const KEITARO_METRICS = [
  "clicks", // Raw Clicks
  "campaign_unique_clicks", // Clean Clicks (bot/dup-filtered)
  "conversions", // total (leads + sales)
  "leads", // Checkouts (CI)
  "sales", // Sales (CV)
  "revenue", // total revenue
  "cost", // ad spend
  "epc", // earnings per click (primary ranking metric)
] as const;

function baseUrl(): string {
  return (process.env.KEITARO_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKey(): string | null {
  const k = process.env.KEITARO_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

export interface KeitaroReportRange {
  from: string; // "YYYY-MM-DD HH:MM:SS" in `timezone`
  to: string; // "YYYY-MM-DD HH:MM:SS" in `timezone`
  timezone: string; // IANA, e.g. "America/New_York"
}

// A report row is the grouping keys + metric keys as a flat object. Values may
// arrive as numbers or numeric strings depending on the metric — callers coerce.
export type KeitaroReportRow = Record<string, unknown>;

export interface KeitaroReportResult {
  ok: boolean;
  status: number; // 0 = network/timeout, never reached the server
  rows: KeitaroReportRow[];
  error: string | null;
}

// POST /admin_api/v1/report/build — the workhorse. Body shape per the documented
// Admin API schema: { range, grouping, metrics, filters }.
export async function buildKeitaroReport(
  range: KeitaroReportRange,
  opts?: { timeoutMs?: number },
): Promise<KeitaroReportResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, rows: [], error: "KEITARO_API_KEY is not set" };
  }

  try {
    const res = await fetch(`${baseUrl()}/admin_api/v1/report/build`, {
      method: "POST",
      headers: {
        "Api-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range,
        grouping: KEITARO_GROUPING,
        metrics: KEITARO_METRICS,
        filters: [],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        rows: [],
        error: `Keitaro report/build HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const body = (await res.json().catch(() => null)) as
      | { rows?: unknown }
      | null;
    const rows = Array.isArray(body?.rows)
      ? (body.rows as KeitaroReportRow[])
      : [];
    return { ok: true, status: res.status, rows, error: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      rows: [],
      error: aborted
        ? "Keitaro report/build timed out"
        : `Keitaro report/build network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
    };
  }
}

// ── Conversions log (per-recipient SALE attribution) ─────────────────────────
// POST /admin_api/v1/conversions/log returns ONE row per conversion (not an
// aggregate), each carrying the click's sub_id slots — so a sale's `sub_id_1`
// maps 1:1 back to the CamMan recipient (stage_sends.id, injected at redirect
// time as the `sub_id1` URL param). NOTE the spelling split, mirroring sub_id3:
// the inbound URL param is `sub_id1` (no underscore); the Keitaro token / report
// column is `sub_id_1` (underscore) — request and read it WITH the underscore.
//
// Columns confirmed against the live conversions/log schema (the 'events' report
// definition). NOTE: this endpoint returns ONLY the columns you request, and
// 400s on any name it doesn't recognize — so every entry here MUST be valid.
// Verified live: `revenue` is the revenue column (NOT `payout`, which doesn't
// exist); `event_id` is the unique per-conversion id (UUIDv7) used for dedup;
// `datetime` is the conversion time. sub_id_1 carries the recipient id (=
// stage_sends.id) once a tracked link has been clicked post-deploy.
export const KEITARO_CONVERSION_COLUMNS = [
  "event_id", // unique conversion id (dedup key)
  "sub_id_1", // = stage_sends.id (the recipient/customer id)
  "sub_id_3", // = campaign_stages.tracking_id (the stage; used by the aggregate poll)
  "status", // lead | sale | rejected | …
  "revenue", // conversion revenue
  "datetime", // conversion datetime (ET) — the date a sale is attributed to
  "click_datetime", // originating click datetime (fallback for converted_at)
] as const;

// Conversion statuses we care about. `sale` is the headline; `lead`/`rejected`
// let a recipient's row advance/correct over time. (Keitaro v11 also emits
// registration/deposit/trash, which we ignore for sale attribution.)
export const KEITARO_CONVERSION_STATUSES = ["lead", "sale", "rejected"] as const;

export interface KeitaroConversionsResult {
  ok: boolean;
  status: number; // 0 = network/timeout, never reached the server
  rows: KeitaroReportRow[];
  error: string | null;
}

// POST /admin_api/v1/conversions/log — body { range, columns, filters, order }.
// Same never-throw contract as buildKeitaroReport: a failure returns a normalized
// result so the poll logs and retries next cycle instead of crashing.
export async function fetchKeitaroConversions(
  range: KeitaroReportRange,
  opts?: { timeoutMs?: number; statuses?: readonly string[] },
): Promise<KeitaroConversionsResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, rows: [], error: "KEITARO_API_KEY is not set" };
  }

  const statuses = opts?.statuses ?? KEITARO_CONVERSION_STATUSES;

  try {
    const res = await fetch(`${baseUrl()}/admin_api/v1/conversions/log`, {
      method: "POST",
      headers: {
        "Api-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range,
        columns: KEITARO_CONVERSION_COLUMNS,
        // IN_LIST is the confirmed working operator for this Keitaro version.
        // (The endpoint rejects an `order` key — we sort latest-wins in memory.)
        filters: [
          { name: "status", operator: "IN_LIST", expression: statuses },
        ],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        rows: [],
        error: `Keitaro conversions/log HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const body = (await res.json().catch(() => null)) as
      | { rows?: unknown }
      | null;
    const rows = Array.isArray(body?.rows)
      ? (body.rows as KeitaroReportRow[])
      : [];
    return { ok: true, status: res.status, rows, error: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      rows: [],
      error: aborted
        ? "Keitaro conversions/log timed out"
        : `Keitaro conversions/log network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
    };
  }
}

// ── Clicks log (per-recipient OFFER-PAGE REACH attribution) ──────────────────
// POST /admin_api/v1/clicks/log (the 'events' report) returns ONE row per click,
// each carrying the click's sub_id slots + the Keitaro `campaign` NAME. An
// OFFER-campaign click (campaign name != KEITARO_VISIT_CAMPAIGN_NAME) that
// carries sub_id_1 means that recipient reached the offer page — the Level-2
// signal. The landing-page (gk-lp-visits) clicks are Level 1 and are dropped by
// the poll. Columns confirmed live against the 'events' report definition;
// the endpoint 400s on any unknown column, so every entry MUST be valid.
// `event_id` is the unique per-click id (dedup key). sub_id_1 = stage_sends.id.
export const KEITARO_CLICK_COLUMNS = [
  "event_id", // unique click id (dedup key)
  "sub_id_1", // = stage_sends.id (the recipient/customer id)
  "campaign", // campaign NAME — gk-lp-visits ⇒ landing (drop); else ⇒ offer
  "campaign_id", // numeric id (robustness fallback)
  "datetime", // click datetime (ET)
] as const;

export interface KeitaroClicksResult {
  ok: boolean;
  status: number; // 0 = network/timeout, never reached the server
  rows: KeitaroReportRow[];
  error: string | null;
}

// POST /admin_api/v1/clicks/log — body { range, columns, filters }. Same
// never-throw contract as fetchKeitaroConversions. Filters server-side to clicks
// carrying a recipient id (sub_id_1 != ""), so empty-sub_id rows (organic / test
// / pre-rollout traffic) never cross the wire. The poll drops gk-lp-visits rows
// by campaign name afterward.
export async function fetchKeitaroClicks(
  range: KeitaroReportRange,
  opts?: { timeoutMs?: number },
): Promise<KeitaroClicksResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, rows: [], error: "KEITARO_API_KEY is not set" };
  }

  try {
    const res = await fetch(`${baseUrl()}/admin_api/v1/clicks/log`, {
      method: "POST",
      headers: {
        "Api-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range,
        columns: KEITARO_CLICK_COLUMNS,
        // Only clicks that carry a recipient id are attributable. NOT_EQUAL ""
        // is the confirmed working operator for this Keitaro version.
        filters: [{ name: "sub_id_1", operator: "NOT_EQUAL", expression: "" }],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        rows: [],
        error: `Keitaro clicks/log HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const body = (await res.json().catch(() => null)) as
      | { rows?: unknown }
      | null;
    const rows = Array.isArray(body?.rows)
      ? (body.rows as KeitaroReportRow[])
      : [];
    return { ok: true, status: res.status, rows, error: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      rows: [],
      error: aborted
        ? "Keitaro clicks/log timed out"
        : `Keitaro clicks/log network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
    };
  }
}

export interface KeitaroCampaign {
  id: number;
  alias: string | null;
  name: string | null;
  state: string | null;
}

export interface KeitaroCampaignsResult {
  ok: boolean;
  status: number;
  campaigns: KeitaroCampaign[];
  error: string | null;
}

// GET /admin_api/v1/campaigns — Keitaro's campaign list. Not required for the
// aggregate poll (mapping is by sub_id_3 = stage tracking id), but surfaced for
// the verification/debug endpoint so an operator can sanity-check the live
// connection (e.g. the kinzeno campaign appears).
export async function fetchKeitaroCampaigns(opts?: {
  timeoutMs?: number;
}): Promise<KeitaroCampaignsResult> {
  const key = apiKey();
  if (!key) {
    return {
      ok: false,
      status: 0,
      campaigns: [],
      error: "KEITARO_API_KEY is not set",
    };
  }

  try {
    const res = await fetch(`${baseUrl()}/admin_api/v1/campaigns`, {
      method: "GET",
      headers: { "Api-Key": key },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        campaigns: [],
        error: `Keitaro campaigns HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const body = (await res.json().catch(() => null)) as unknown;
    const list = Array.isArray(body) ? body : [];
    const campaigns: KeitaroCampaign[] = list.map((c) => {
      const r = c as Record<string, unknown>;
      return {
        id: Number(r.id),
        alias: typeof r.alias === "string" ? r.alias : null,
        name: typeof r.name === "string" ? r.name : null,
        state: typeof r.state === "string" ? r.state : null,
      };
    });
    return { ok: true, status: res.status, campaigns, error: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      campaigns: [],
      error: aborted
        ? "Keitaro campaigns request timed out"
        : `Keitaro campaigns network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
    };
  }
}
