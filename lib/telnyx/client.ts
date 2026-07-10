import "server-only";

import { validatePhone } from "@/lib/phone-validation";

import type {
  TelnyxBalanceResponse,
  TelnyxBalanceResult,
  TelnyxLookupResult,
  TelnyxNumberLookupResponse,
} from "./types";

// Telnyx HTTP client. Never throws — every method returns a normalized result
// (mirrors lib/keitaro/client.ts + lib/spam/providers/classifier.ts). The worker
// decides backoff/retry from the `retryable` flag. API key + base URL from env;
// with the key unset every call returns a soft failure so the worker no-ops.

const DEFAULT_BASE_URL = "https://api.telnyx.com";
const DEFAULT_TIMEOUT_MS = 20_000;
// Account-level feature gate (Number Lookup not permitted). Must NOT be retried.
const FEATURE_GATE_CODE = "10038";

function baseUrl(): string {
  return (process.env.TELNYX_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKey(): string | null {
  const k = process.env.TELNYX_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

interface FetchOutcome {
  status: number | null;
  json: unknown;
  networkError: string | null;
}

async function doGet(path: string, timeoutMs: number): Promise<FetchOutcome> {
  const key = apiKey();
  if (!key) {
    return { status: null, json: null, networkError: "TELNYX_API_KEY is not set" };
  }
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, networkError: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: null, json: null, networkError: msg };
  }
}

// Extract the first Telnyx error `{ code, title, detail }` from an error envelope.
function firstError(
  json: unknown,
): { code: string | null; detail: string } | null {
  if (
    json &&
    typeof json === "object" &&
    "errors" in json &&
    Array.isArray((json as { errors: unknown[] }).errors) &&
    (json as { errors: unknown[] }).errors.length > 0
  ) {
    const e = (json as { errors: Array<Record<string, unknown>> }).errors[0];
    const code = e.code != null ? String(e.code) : null;
    const detail =
      (typeof e.detail === "string" && e.detail) ||
      (typeof e.title === "string" && e.title) ||
      "Telnyx error";
    return { code, detail };
  }
  return null;
}

// GET /v2/number_lookup/{+E164}?type=carrier. Normalizes the phone to E.164 first
// (defense in depth — the cache key MUST match contacts.phone_number's format).
export async function telnyxNumberLookup(
  rawPhone: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TelnyxLookupResult> {
  const parsed = validatePhone(rawPhone);
  if (!parsed.valid || !parsed.normalized) {
    return {
      ok: false,
      status: null,
      error: parsed.error ?? "Invalid phone number",
      retryable: false, // a bad number will never succeed
    };
  }

  const path = `/v2/number_lookup/${encodeURIComponent(parsed.normalized)}?type=carrier`;
  const { status, json, networkError } = await doGet(path, timeoutMs);

  // Transport failure (timeout / network) — retryable.
  if (status === null) {
    return {
      ok: false,
      status: null,
      error: networkError ?? "Network error",
      retryable: apiKey() !== null, // don't "retry" a missing key
    };
  }

  if (status >= 200 && status < 300) {
    const data = (json as TelnyxNumberLookupResponse | null)?.data;
    if (!data) {
      return { ok: false, status, error: "Empty lookup payload", retryable: true };
    }
    return { ok: true, data };
  }

  const err = firstError(json);

  // Account feature gate — alert, never retry (should not recur once enabled).
  if (status === 403 && err?.code === FEATURE_GATE_CODE) {
    return {
      ok: false,
      status,
      error: `Feature not permitted (10038): ${err.detail}`,
      retryable: false,
    };
  }

  // Rate limited — retryable with backoff (handled by the worker).
  if (status === 429) {
    return { ok: false, status, error: "Rate limited (429)", retryable: true };
  }

  // Balance/payment class — pause + alert, never retry-loop.
  if (status === 402) {
    return {
      ok: false,
      status,
      error: `Payment required (402): ${err?.detail ?? "balance"}`,
      retryable: false,
    };
  }

  // Other 4xx (e.g. invalid number Telnyx rejected) — not retryable.
  if (status >= 400 && status < 500) {
    return {
      ok: false,
      status,
      error: err?.detail ?? `Client error ${status}`,
      retryable: false,
    };
  }

  // 5xx — retryable.
  return {
    ok: false,
    status,
    error: err?.detail ?? `Server error ${status}`,
    retryable: true,
  };
}

// GET /v2/balance. Fields are STRINGS in the API — parsed to numbers here.
export async function telnyxBalance(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TelnyxBalanceResult> {
  const { status, json, networkError } = await doGet("/v2/balance", timeoutMs);
  if (status === null) {
    return { ok: false, status: null, error: networkError ?? "Network error" };
  }
  if (status < 200 || status >= 300) {
    const err = firstError(json);
    return { ok: false, status, error: err?.detail ?? `Balance error ${status}` };
  }
  const data = (json as TelnyxBalanceResponse | null)?.data;
  if (!data) return { ok: false, status, error: "Empty balance payload" };
  const availableCredit = Number.parseFloat(data.available_credit ?? "");
  const balance = Number.parseFloat(data.balance ?? "");
  if (Number.isNaN(availableCredit)) {
    return { ok: false, status, error: "Unparseable balance fields" };
  }
  return {
    ok: true,
    availableCredit,
    balance: Number.isNaN(balance) ? availableCredit : balance,
    currency: data.currency ?? "USD",
  };
}
