// Contract checks for notifyTelegram's delivery boolean.
// Run: npx tsx scripts/test-telegram-delivery-contract.ts
//
// No DB, no network: global fetch is stubbed so the 2xx / non-2xx / throw paths
// are deterministic. The env is saved and restored around every case.
//
// ⚠️ THE BOOLEAN IS THE ONLY SIGNAL OF DELIVERY. notifyTelegram never throws, so
// a caller that gates state on "was a human told" has nothing else to read. These
// checks pin that contract — if they go soft, lib/alerts/alert-state.ts silently
// starts latching alerts it never delivered, which is the bug this branch exists
// to remove.
import { notifyTelegram } from "@/lib/alerts/telegram";

let pass = 0,
  fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const realFetch = globalThis.fetch;
const realToken = process.env.TELEGRAM_BOT_TOKEN;
const realChat = process.env.TELEGRAM_CHAT_ID;

function configure() {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "test-chat";
}
function restore() {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = realToken;
  if (realChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = realChat;
}

async function main() {
  try {
    // ── unset config counts as NOT SENT ────────────────────────────────────
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    let calledFetch = false;
    globalThis.fetch = (async () => {
      calledFetch = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    ok((await notifyTelegram("x")) === false, "⭐ unset TELEGRAM_* -> false (not sent)");
    ok(!calledFetch, "unset config returns before any fetch (the retry is near-free)");

    // ── a 2xx response is the ONLY true ────────────────────────────────────
    configure();
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    ok((await notifyTelegram("x")) === true, "⭐ HTTP 200 -> true (delivered)");

    // ── every failure mode is false ────────────────────────────────────────
    configure();
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    ok((await notifyTelegram("x")) === false, "⭐ HTTP 500 -> false");

    configure();
    globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
    ok((await notifyTelegram("x")) === false, "HTTP 401 (bad token) -> false");

    configure();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    ok((await notifyTelegram("x")) === false, "⭐ network error -> false, and does NOT throw");

    configure();
    globalThis.fetch = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as typeof fetch;
    ok((await notifyTelegram("x")) === false, "timeout -> false, and does NOT throw");
  } finally {
    restore();
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
