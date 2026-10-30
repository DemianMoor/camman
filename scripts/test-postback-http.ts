import nodeHttp from "node:http";
import net from "node:net";

import { classifyResponse, nextAttemptDelayMs, sendPostback, statusWithin, type SendResult } from "@/lib/partners/postbacks/http";
import { isBlockedAddress } from "@/lib/brand-landing-probe";
// Run: npx tsx --conditions=react-server scripts/test-postback-http.ts (server-only import). Live probe (H3) needs DNS and skips without it.
// Test for the postback HTTP primitives. No DB. Live probe (H3) needs DNS and skips without it.

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`}`);
}
const r = (status: number | null, blocked = false): SendResult => ({ status, error: null, blocked, durationMs: 1 });

async function main() {
  // H1 classify
  for (const s of [200, 204]) check(`H1 ${s} delivered`, classifyResponse(r(s)), "delivered");
  for (const s of [301, 302, 400, 404]) check(`H1 ${s} fail`, classifyResponse(r(s)), "fail");
  for (const s of [408, 429, 500, 503]) check(`H1 ${s} retry`, classifyResponse(r(s)), "retry");
  check("H1 null retry", classifyResponse(r(null)), "retry");
  check("H1 null blocked fail", classifyResponse(r(null, true)), "fail");

  // H2 delays
  check("H2 (1)", nextAttemptDelayMs(1), 60000);
  check("H2 (6)", nextAttemptDelayMs(6), 86400000);
  check("H2 (7)", nextAttemptDelayMs(7), null);

  // No-network refusals
  const ip = await sendPostback("https://127.0.0.1/");
  check("N1 IP literal blocked", [ip.status, ip.blocked], [null, true]);
  const http = await sendPostback("http://example.com/");
  check("N2 http refused", [http.status, http.blocked], [null, true]);
  const port = await sendPostback("https://example.com:8443/");
  check("N3 non-443 refused", [port.status, port.blocked], [null, true]);
  const bad = await sendPostback("not a url");
  check("N4 invalid url no throw", [bad.status, bad.blocked, typeof bad.error], [null, true, "string"]);

  // H4 wall-clock bound. sendPostback refuses loopback by design, so the bound is
  // tested on statusWithin (the helper sendPostback runs its request through),
  // driven by plain http to a local raw TCP server. The server sends a status line
  // and then trickles header lines every 50 ms, never ending the headers: the socket
  // is never idle, so only a WALL-CLOCK timer can end it.
  const sockets = new Set<net.Socket>();
  const trickle = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    sock.once("data", () => {
      sock.write("HTTP/1.1 200 OK\r\n");
      const t = setInterval(() => (sock.destroyed ? clearInterval(t) : sock.write("X-Drip: 1\r\n")), 50);
    });
  });
  await new Promise<void>((res) => trickle.listen(0, "127.0.0.1", res));
  const tPort = (trickle.address() as net.AddressInfo).port;
  const t0 = Date.now();
  const slow = await statusWithin((onRes) => nodeHttp.request(`http://127.0.0.1:${tPort}/`, onRes), 400);
  const elapsed = Date.now() - t0;
  check("H4 trickling server: no status", slow.status, null);
  check("H4 ...error names the wall-clock bound", slow.error?.message, "no response within 400ms");
  check("H4 ...settles near 400 ms, not later", elapsed >= 380 && elapsed < 1500, true);
  await new Promise((res) => setTimeout(res, 150));
  check("H4 ...request socket destroyed after the bound", sockets.size, 0);
  for (const s of sockets) s.destroy();
  trickle.close();

  // H5 a prompt status settles with that status; the endless body is not drained.
  const endless = nodeHttp.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write("x".repeat(1024))), 10);
  });
  await new Promise<void>((res) => endless.listen(0, "127.0.0.1", res));
  const ePort = (endless.address() as net.AddressInfo).port;
  const e0 = Date.now();
  const fast = await statusWithin((onRes) => nodeHttp.request(`http://127.0.0.1:${ePort}/`, onRes), 2000);
  check("H5 status read without draining an endless body", [fast.status, fast.error, Date.now() - e0 < 1000], [200, null, true]);
  endless.closeAllConnections();
  endless.close();

  // H3 loopback-resolving hostname
  check("H3 isBlockedAddress(127.0.0.1)", isBlockedAddress("127.0.0.1"), true);
  const live = await sendPostback("https://127.0.0.1.nip.io/", 4000);
  if (live.blocked) check("H3 live loopback host blocked", live.blocked, true);
  else console.log(`SKIP H3 live probe: DNS did not resolve to loopback in this environment (${live.error})`);

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}
main();
