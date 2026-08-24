// Unit tests for the scheduled report's send policy (no DB, no real network —
// globalThis.fetch is stubbed). Run: npx tsx scripts/test-telegram-send-policy.ts
//
// The bug these pin down (Warsaw 22:00, 2026-08-24): the report was delivered
// TWICE and the job still alerted "failed". Telegram had accepted both POSTs;
// the 8s client-side AbortSignal.timeout fired before either response arrived,
// and the retry loop re-POSTed a NON-IDEMPOTENT sendMessage on an error that
// says nothing about whether the server acted. A retry is only safe when
// Telegram told us it did NOT send.
import {
  reportSendTimeoutMs,
  sendTelegramReport,
} from "@/lib/alerts/telegram";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "-100123";
// Keep the aborts fast; the real default is 20s.
process.env.TELEGRAM_SEND_TIMEOUT_MS = "150";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}\n      expected ${e}\n      got      ${a}`);
  }
}

const realFetch = globalThis.fetch;
let calls = 0;

// Replaces fetch with a scripted sequence of per-call behaviours.
type Behaviour =
  | { kind: "status"; status: number; body?: string }
  // Server accepted the request but the response never arrives in time — the
  // production failure. Honours the abort signal exactly as undici does.
  | { kind: "hang" }
  // undici's wrapper for a socket-level failure with no response.
  | { kind: "network" };

function stubFetch(seq: Behaviour[]) {
  calls = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const b = seq[Math.min(calls, seq.length - 1)];
    calls++;
    if (b.kind === "status") {
      return Promise.resolve(
        new Response(b.body ?? "{\"ok\":true}", { status: b.status }),
      );
    }
    if (b.kind === "network") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      // A real in-flight socket keeps the event loop alive; AbortSignal.timeout's
      // timer is unref'd, so without this the process would just exit mid-test.
      const keepAlive = setTimeout(() => {}, 60000);
      signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      });
    });
  }) as typeof fetch;
}

async function run() {
  console.log("\nsendTelegramReport — a timed-out send is NEVER retried:");
  stubFetch([{ kind: "hang" }]);
  let outcome = await sendTelegramReport("<b>report</b>");
  eq(calls, 1, "hanging Telegram ⇒ exactly ONE POST (no duplicate report)");
  eq(outcome.status, "unknown", "outcome is 'unknown', not 'failed'");
  eq(outcome.attempts, 1, "one attempt recorded");

  console.log("\n  …same for a socket error with no response:");
  stubFetch([{ kind: "network" }]);
  outcome = await sendTelegramReport("<b>report</b>");
  eq(calls, 1, "network error ⇒ ONE POST");
  eq(outcome.status, "unknown", "no response ⇒ unknown outcome");

  console.log("\nsendTelegramReport — a KNOWN non-delivery is retried:");
  stubFetch([{ kind: "status", status: 500 }, { kind: "status", status: 200 }]);
  outcome = await sendTelegramReport("<b>report</b>");
  eq(calls, 2, "HTTP 500 then 200 ⇒ retried once");
  eq(outcome.status, "sent", "recovers to 'sent'");
  eq(outcome.attempts, 2, "two attempts recorded");

  stubFetch([{ kind: "status", status: 429 }, { kind: "status", status: 200 }]);
  outcome = await sendTelegramReport("<b>report</b>");
  eq(calls, 2, "HTTP 429 is retried too");
  eq(outcome.status, "sent", "recovers to 'sent'");

  console.log("\nsendTelegramReport — definite failures THROW (real alert):");
  stubFetch([{ kind: "status", status: 500 }]);
  let threw: string | null = null;
  try {
    await sendTelegramReport("<b>report</b>");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  eq(calls, 2, "persistent 500 ⇒ retried once then gives up (capped at 2)");
  eq(threw !== null && threw.includes("500"), true, "throws, message names HTTP 500");

  stubFetch([{ kind: "status", status: 400, body: "can't parse entities" }]);
  threw = null;
  try {
    await sendTelegramReport("<b>report</b>");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  eq(calls, 1, "HTTP 400 is permanent ⇒ NOT retried");
  eq(threw !== null && threw.includes("400"), true, "throws, message names HTTP 400");

  console.log(
    "\nsendTelegramReport — a retry that cannot fit the total budget is skipped:",
  );
  // Per-attempt 30s > the 25s total cap, so even a retryable 500 gets one shot.
  // Keeps the route's build+send+alert budget under Vercel's maxDuration=60.
  process.env.TELEGRAM_SEND_TIMEOUT_MS = "30000";
  stubFetch([{ kind: "status", status: 500 }, { kind: "status", status: 200 }]);
  threw = null;
  try {
    await sendTelegramReport("<b>report</b>");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  eq(calls, 1, "retry skipped when it could not finish inside the budget");
  eq(threw !== null, true, "still a definite failure (Telegram answered 500)");
  process.env.TELEGRAM_SEND_TIMEOUT_MS = "150";

  console.log("\nsendTelegramReport — happy path:");
  stubFetch([{ kind: "status", status: 200 }]);
  outcome = await sendTelegramReport("<b>report</b>");
  eq(calls, 1, "one POST");
  eq(outcome.status, "sent", "sent");
  eq(outcome.attempts, 1, "one attempt");

  console.log("\nreportSendTimeoutMs — configurable, with a safe fallback:");
  const saved = process.env.TELEGRAM_SEND_TIMEOUT_MS;
  delete process.env.TELEGRAM_SEND_TIMEOUT_MS;
  eq(reportSendTimeoutMs(), 20000, "default 20s (was 8s — too tight for Telegram)");
  process.env.TELEGRAM_SEND_TIMEOUT_MS = "35000";
  eq(reportSendTimeoutMs(), 35000, "env override honoured");
  process.env.TELEGRAM_SEND_TIMEOUT_MS = "not-a-number";
  eq(reportSendTimeoutMs(), 20000, "garbage falls back to the default");
  process.env.TELEGRAM_SEND_TIMEOUT_MS = "0";
  eq(reportSendTimeoutMs(), 20000, "non-positive falls back to the default");
  process.env.TELEGRAM_SEND_TIMEOUT_MS = saved;

  globalThis.fetch = realFetch;
  if (failures > 0) {
    console.error(`\n${failures} failing assertion(s)\n`);
    process.exit(1);
  }
  console.log("\nAll telegram send-policy tests passed\n");
}

void run();
