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
