import "server-only";

import type { ClientRequest, IncomingMessage } from "node:http";
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

  const r = await statusWithin(
    (onResponse) =>
      https.request(
        u,
        { method: "GET", lookup: safeLookup, headers: { "user-agent": "CampaignManager-Postback/1.0" } },
        onResponse,
      ),
    timeoutMs,
  );
  return done(r.status, r.error?.message ?? null, r.error instanceof BlockedAddressError);
}

/**
 * Run one request and settle with its status line, bounded by WALL-CLOCK
 * `timeoutMs` (a socket idle timeout alone lets a server that trickles bytes hold
 * the request open indefinitely). Settles exactly once. The response is destroyed
 * as soon as the status is read: the body is never wanted.
 *
 * Exported for the test, which drives it over plain http to a local server
 * (sendPostback itself refuses loopback).
 */
export function statusWithin(
  start: (onResponse: (res: IncomingMessage) => void) => ClientRequest,
  timeoutMs: number,
): Promise<{ status: number | null; error: Error | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    const finish = (status: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, error });
    };
    const timer = setTimeout(() => {
      const err = new Error(`no response within ${timeoutMs}ms`);
      finish(null, err);
      req?.destroy(err);
    }, timeoutMs);
    try {
      req = start((res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        finish(status, null);
      });
      req.on("error", (err) => finish(null, err));
      req.end();
    } catch (err) {
      finish(null, err instanceof Error ? err : new Error(String(err)));
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
