// TextHub opt-out (STOP) callback registration.
//
// ⚠️ UNVERIFIED CONTRACT: swagger.json is NOT in this repo, so the exact
// registration shape is taken from the build brief, not a spec we can read:
//   GET https://api.texthub.com/v2/?api_key=<key>
//        &opt_out_callback=<url-encoded callback>
//        &keywords=STOP   (optional; comma-joined)
// Registering is a one-time call per api_key. This function returns TextHub's
// RAW response (status + body) so the operator can confirm it was accepted —
// we do NOT assume a success shape. If the live capture shows a different
// registration contract, fix it HERE (single call site).
//
// This module performs NO parsing of inbound STOP — that is Stage B, built
// against the captured payload.

const TEXTHUB_BASE_URL = "https://api.texthub.com/v2";
const DEFAULT_TIMEOUT_MS = 15000;

export interface RegisterCallbackParams {
  apiKey: string;
  callbackUrl: string;
  keywords?: string[]; // default ["STOP"]
  timeoutMs?: number;
}

export interface RegisterCallbackResult {
  ok: boolean; // HTTP-level ok (2xx). NOT a guarantee TextHub registered it.
  status: number; // HTTP status (0 = network/timeout)
  rawBody: string | null; // verbatim response body for the operator to eyeball
  error: string | null;
}

// Pure URL builder — exported so the registration contract is testable without
// hitting the network. The api_key is in the query (never logged by callers).
export function buildRegisterCallbackUrl(params: RegisterCallbackParams): string {
  const url = new URL(`${TEXTHUB_BASE_URL}/`);
  url.searchParams.set("api_key", params.apiKey);
  url.searchParams.set("opt_out_callback", params.callbackUrl);
  const keywords = params.keywords && params.keywords.length > 0 ? params.keywords : ["STOP"];
  url.searchParams.set("keywords", keywords.join(","));
  return url.toString();
}

// Register the opt-out callback URL for one api_key. Never throws; returns a
// normalized result. The raw body is surfaced to the operator because we can't
// trust an assumed success shape against an undocumented endpoint.
export async function registerOptOutCallback(
  params: RegisterCallbackParams,
): Promise<RegisterCallbackResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(buildRegisterCallbackUrl(params), {
      method: "GET",
      signal: controller.signal,
    });
    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      rawBody,
      error: res.ok ? null : `TextHub HTTP ${res.status}`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      rawBody: null,
      error: aborted ? "TextHub request timed out" : "TextHub network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
