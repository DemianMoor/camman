import { notifyTelegram } from "@/lib/alerts/telegram";
import type { db } from "@/db/client";
import { resolveTxrPollTargets } from "@/lib/sends/textrequest-messages-poll";
import { textrequestBaseUrl } from "@/lib/sends/providers/textrequest";

// Text Request account webhooks ("hooks") — list / register / reactivate, plus
// the health check that keeps them alive.
//
// WHY this exists: Text Request DISCONNECTS a webhook after 10 consecutive
// deliveries that fail to return 2XX/3XX (documented on the `is_connected`
// field, confirmed in their OpenAPI spec). A disconnected hook is silent — no
// error, no retry, nothing arrives — and for the opt-out events (Phase 4) that
// silence is a compliance failure, not a latency problem. So a poll tick checks
// `is_connected` and reactivates via PUT, alerting either way.
//
// Path shapes (spec-confirmed):
//   GET    /dashboards/{id}/hooks              -> { items: webhook[], meta }
//   POST   /dashboards/{id}/hooks              -> 201 webhook   { target_url, event, http_verb }
//   PUT    /dashboards/{id}/hooks/{webhook_id} -> 204           "reactivates a disconnected hook" (no body)
//   DELETE /dashboards/{id}/hooks/{webhook_id} -> 204
//
// Note the read/write asymmetry in the hook object: the POST body field is
// `http_verb`, the response field is `httpVerb`.

const DEFAULT_TIMEOUT_MS = 15000;

// The subscribable event names (spec enum). Only the three CamMan consumes are
// re-exported as TXR_REQUIRED_EVENTS below.
export type TxrHookEvent =
  | "msg_sent"
  | "msg_received"
  | "contact_created"
  | "msg_status_updated"
  | "location_received"
  | "payment_status_updated"
  | "contact_updated";

// What CamMan subscribes to, and why:
//  - msg_received       inbound STOP replies (opt-out signal 1)
//  - contact_updated    Text Request's own opt-out bookkeeping, incl. STOPs it
//                       processed itself (opt-out signal 2 — carries opted_out_utc)
//  - msg_status_updated account-level delivery status; same payload shape as the
//                       per-message status_callback, and carries errorCode 2100
//                       ("contact has previously opted out")
export const TXR_REQUIRED_EVENTS: readonly TxrHookEvent[] = [
  "msg_received",
  "contact_updated",
  "msg_status_updated",
];

// Every CamMan webhook URL lives under this path prefix, which is how a hook of
// OURS is told apart from one the operator created in the portal for Zapier etc.
// (we must never reactivate or touch a third party's hook).
export const TXR_WEBHOOK_PATH_PREFIX = "/api/webhooks/textrequest/";

export interface TxrHook {
  id: number;
  target_url: string | null;
  event: string | null;
  dashboard_id: number | null;
  httpVerb: string | null;
  is_user_defined: boolean | null;
  is_connected: boolean | null;
}

function parseHooks(parsed: unknown): TxrHook[] {
  const wrapped = (parsed ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(wrapped.items) ? wrapped.items : [];
  const out: TxrHook[] = [];
  for (const item of arr as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const rawId = item.id;
    if (typeof rawId !== "number" && typeof rawId !== "string") continue;
    out.push({
      id: Number(rawId),
      target_url: typeof item.target_url === "string" ? item.target_url : null,
      event: typeof item.event === "string" ? item.event : null,
      dashboard_id:
        typeof item.dashboard_id === "number"
          ? item.dashboard_id
          : typeof item.dashboard_id === "string"
            ? Number(item.dashboard_id)
            : null,
      httpVerb: typeof item.httpVerb === "string" ? item.httpVerb : null,
      is_user_defined: typeof item.is_user_defined === "boolean" ? item.is_user_defined : null,
      is_connected: typeof item.is_connected === "boolean" ? item.is_connected : null,
    });
  }
  return out;
}

async function txrFetch(
  apiKey: string,
  path: string,
  init: { method: string; body?: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number; raw: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${textrequestBaseUrl()}${path}`, {
      method: init.method,
      headers: {
        "x-api-key": apiKey,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body,
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => null);
    return {
      status: res.status,
      raw,
      error: res.ok ? null : `Text Request HTTP ${res.status}`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: 0, raw: null, error: aborted ? "Text Request request timed out" : "Text Request network error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface TxrHookListResult {
  ok: boolean;
  status: number;
  hooks: TxrHook[];
  error: string | null;
}

export async function listTxrHooks(apiKey: string, dashboardId: string): Promise<TxrHookListResult> {
  const r = await txrFetch(apiKey, `/dashboards/${encodeURIComponent(dashboardId)}/hooks`, { method: "GET" });
  let hooks: TxrHook[] = [];
  if (r.status >= 200 && r.status < 300 && r.raw) {
    try {
      hooks = parseHooks(JSON.parse(r.raw));
    } catch {
      // Non-JSON body — leave hooks empty; status/error still report the truth.
    }
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, hooks, error: r.error };
}

// PUT with no body = "reactivates a disconnected or inactive web hook" (204).
export async function reactivateTxrHook(
  apiKey: string,
  dashboardId: string,
  hookId: number,
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const r = await txrFetch(
    apiKey,
    `/dashboards/${encodeURIComponent(dashboardId)}/hooks/${hookId}`,
    { method: "PUT" },
  );
  return { ok: r.status >= 200 && r.status < 300, status: r.status, error: r.error };
}

export interface TxrRegisterHookResult {
  ok: boolean;
  status: number;
  hook: TxrHook | null;
  error: string | null;
}

// Registers one hook. Body field is `http_verb` (snake) even though the response
// echoes `httpVerb` (camel). Defaults to POST, which is what our routes accept.
export async function registerTxrHook(
  apiKey: string,
  dashboardId: string,
  opts: { targetUrl: string; event: TxrHookEvent; httpVerb?: "POST" | "PUT" },
): Promise<TxrRegisterHookResult> {
  const r = await txrFetch(apiKey, `/dashboards/${encodeURIComponent(dashboardId)}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      target_url: opts.targetUrl,
      event: opts.event,
      http_verb: opts.httpVerb ?? "POST",
    }),
  });
  let hook: TxrHook | null = null;
  if (r.status >= 200 && r.status < 300 && r.raw) {
    try {
      const parsed = JSON.parse(r.raw) as unknown;
      hook = parseHooks(Array.isArray(parsed) || (parsed as Record<string, unknown>)?.items ? parsed : [parsed])[0] ?? null;
    } catch {
      hook = null;
    }
  }
  // TR rejects a second hook with the SAME url for the same event; surface that
  // verbatim (the message is in the body) so the caller can treat it as "already
  // registered" rather than a hard failure.
  const bodyMessage = (() => {
    if (!r.raw) return null;
    try {
      const j = JSON.parse(r.raw) as Record<string, unknown>;
      return typeof j.message === "string" ? j.message : null;
    } catch {
      return null;
    }
  })();
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    hook,
    error: r.error ? (bodyMessage ? `${r.error}: ${bodyMessage}` : r.error) : null,
  };
}

export interface TxrWebhookHealthResult {
  dashboards_checked: number;
  hooks_seen: number;
  ours: number;
  disconnected: number;
  reactivated: number;
  reactivate_failed: number;
  // Events from TXR_REQUIRED_EVENTS with no hook of ours at all, as
  // "<dashboard_id>:<event>". Expected (and NOT alerted) before go-live
  // registration has run — reported so the operator can see what's missing.
  missing: string[];
  error: string | null;
}

// Health check: for every dashboard we send from, find OUR hooks and reactivate
// any that Text Request disconnected. Alerts on a disconnect (compliance-critical
// — a silent dead opt-out hook is the failure mode this whole function exists to
// prevent) but stays quiet about `missing`, which is the normal state until the
// operator runs registration at go-live.
export async function checkTxrWebhookHealth(
  database: typeof db,
  opts?: {
    orgId?: string;
    listHooks?: typeof listTxrHooks;
    reactivate?: typeof reactivateTxrHook;
  },
): Promise<TxrWebhookHealthResult> {
  const list = opts?.listHooks ?? listTxrHooks;
  const reactivate = opts?.reactivate ?? reactivateTxrHook;
  const targets = await resolveTxrPollTargets(database, { orgId: opts?.orgId });

  const res: TxrWebhookHealthResult = {
    dashboards_checked: 0,
    hooks_seen: 0,
    ours: 0,
    disconnected: 0,
    reactivated: 0,
    reactivate_failed: 0,
    missing: [],
    error: null,
  };

  for (const t of targets) {
    res.dashboards_checked++;
    const listed = await list(t.api_key, t.dashboard_id);
    if (!listed.ok) {
      res.error = listed.error;
      console.warn(
        `[textrequest-hooks] could not list hooks for dashboard ${t.dashboard_id}: ${listed.error ?? listed.status}`,
      );
      continue;
    }
    res.hooks_seen += listed.hooks.length;

    const ours = listed.hooks.filter((h) => h.target_url?.includes(TXR_WEBHOOK_PATH_PREFIX));
    res.ours += ours.length;

    for (const ev of TXR_REQUIRED_EVENTS) {
      if (!ours.some((h) => h.event === ev)) res.missing.push(`${t.dashboard_id}:${ev}`);
    }

    for (const h of ours) {
      // Only `false` is a disconnect; null means TR didn't report the field and
      // must NOT be treated as broken (never reactivate on missing information).
      if (h.is_connected !== false) continue;
      res.disconnected++;
      const r = await reactivate(t.api_key, t.dashboard_id, h.id);
      if (r.ok) {
        res.reactivated++;
        await notifyTelegram(
          `🔌 Text Request webhook was DISCONNECTED and has been reactivated\n` +
            `dashboard ${t.dashboard_id} · event ${h.event ?? "?"} · hook ${h.id}\n` +
            `TR disconnects a hook after 10 consecutive non-2XX responses — check for an outage or a 500 in that route.`,
        ).catch(() => {});
      } else {
        res.reactivate_failed++;
        await notifyTelegram(
          `🛑 Text Request webhook is DISCONNECTED and reactivation FAILED\n` +
            `dashboard ${t.dashboard_id} · event ${h.event ?? "?"} · hook ${h.id}\n` +
            `error: ${r.error ?? r.status}\n` +
            `${h.event === "msg_received" || h.event === "contact_updated" ? "OPT-OUT INTAKE IS DEGRADED — the polls are the backstop; reconnect in the TR portal." : "Delivery-status intake is degraded; the messages poll is the backstop."}`,
        ).catch(() => {});
      }
    }
  }

  return res;
}
