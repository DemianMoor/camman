import "server-only";

import { lookup as dnsLookup } from "node:dns";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// The brand form's "Test" button: does https://<host>/<path>/<slug> serve?
//
// ⚠️ THIS FETCHES A HOST AN ADMIN TYPED, FROM OUR SERVER. Three rules:
//   1. https only, on port 443.
//   2. The address is checked AT CONNECT TIME, inside the socket's own DNS
//      lookup — not resolved once and then fetched, which a DNS rebind between
//      the two would defeat. Private, loopback, link-local (incl. the cloud
//      metadata address 169.254.169.254), CGNAT, multicast and reserved ranges
//      are refused, IPv4 and IPv6, IPv4-mapped IPv6 included.
//   3. Redirects are reported, never followed (node:https does not follow).
// Only the status line and two headers are read; the body is discarded.

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

/** True when the address must never be fetched from the server. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return BLOCKED.check(mapped[1], "ipv4");
    return BLOCKED.check(address, "ipv6");
  }
  return BLOCKED.check(address, "ipv4");
}

export class BlockedAddressError extends Error {}

export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedAddressError(`${hostname} resolves to a private or reserved address`), "", 0);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    }
    callback(null, list[0].address, list[0].family);
  });
};

export type ProbeOutcome =
  | "serves"
  | "redirects"
  | "not_found"
  | "blocked_by_bot_protection"
  | "error_status"
  | "refused_address"
  | "unreachable";

export interface ProbeResult {
  url: string;
  outcome: ProbeOutcome;
  status: number | null;
  location: string | null;
  detail: string | null;
}

export function probeLandingUrl(url: string, timeoutMs = 8000): Promise<ProbeResult> {
  const u = new URL(url);
  if (u.protocol !== "https:" || (u.port && u.port !== "443")) {
    return Promise.resolve({ url, outcome: "refused_address", status: null, location: null, detail: "https on port 443 only" });
  }
  if (isIP(u.hostname)) {
    return Promise.resolve({ url, outcome: "refused_address", status: null, location: null, detail: "IP literals are not allowed" });
  }
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: "GET", lookup: safeLookup, timeout: timeoutMs, headers: { "user-agent": "CamMan-landing-test/1.0" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const mitigated = res.headers["x-vercel-mitigated"];
        res.destroy();
        let outcome: ProbeOutcome;
        if (status >= 200 && status < 300) outcome = "serves";
        else if (status >= 300 && status < 400) outcome = "redirects";
        else if (status === 404 || status === 410) outcome = "not_found";
        else if (mitigated || status === 429 || status === 403) outcome = "blocked_by_bot_protection";
        else outcome = "error_status";
        resolve({ url, outcome, status, location, detail: mitigated ? `x-vercel-mitigated: ${mitigated}` : null });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on("error", (err) => {
      resolve({
        url,
        outcome: err instanceof BlockedAddressError ? "refused_address" : "unreachable",
        status: null,
        location: null,
        detail: err.message,
      });
    });
    req.end();
  });
}
