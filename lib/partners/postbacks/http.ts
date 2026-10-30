import "server-only";

import https from "node:https";
import { isIP } from "node:net";
import { BlockedAddressError, isBlockedAddress, safeLookup } from "@/lib/brand-landing-probe";
import { RETRY_DELAYS_MS } from "./constants";

export { RETRY_DELAYS_MS, MAX_ATTEMPTS } from "./constants";

// Outbound partner postback: GET a URL a partner configured, from our server.
// Same SSRF rules as the brand landing probe: https on 443 only, address checked
// at connect time (safeLookup), redirects never followed, body discarded.

export type SendResult = { status: number | null; error: string | null; blocked: boolean; durationMs: number };

export async function sendPostback(url: string, timeoutMs = 5000): Promise<SendResult> {
  const start = performance.now();
  const done = (status: number | null, error: string | null, blocked: boolean): SendResult => ({
    status,
    error,
    blocked,
    durationMs: Math.round(performance.now() - start),
  });

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return done(null, "invalid URL", true);
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443")) {
    return done(null, "https on port 443 only", true);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) {
    return done(null, "address is private or reserved", true);
  }

  return new Promise<SendResult>((resolve) => {
    try {
      const req = https.request(
        u,
        { method: "GET", lookup: safeLookup, timeout: timeoutMs, headers: { "user-agent": "CampaignManager-Postback/1.0" } },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          resolve(done(status, null, false));
        },
      );
      req.on("timeout", () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
      req.on("error", (err) => resolve(done(null, err.message, err instanceof BlockedAddressError)));
      req.end();
    } catch (err) {
      resolve(done(null, err instanceof Error ? err.message : String(err), false));
    }
  });
}

export function classifyResponse(r: SendResult): "delivered" | "retry" | "fail" {
  if (r.blocked) return "fail";
  if (r.status === null) return "retry";
  if (r.status >= 200 && r.status < 300) return "delivered";
  if (r.status === 408 || r.status === 429 || r.status >= 500) return "retry";
  return "fail";
}

export function nextAttemptDelayMs(attemptsSoFar: number): number | null {
  return RETRY_DELAYS_MS[attemptsSoFar - 1] ?? null;
}
