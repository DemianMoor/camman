// Tier-1 alerting over Telegram. BEST-EFFORT by contract: a failure here — a
// missing token, a network error, a timeout, a non-200 from Telegram — is
// swallowed and logged, NEVER thrown. An alert must never break or block the
// drain/poller it watches (the same discipline as click-logging never blocking
// the redirect — see lib/links/resolve-click.ts).
//
// Returns a promise that NEVER rejects. Callers may await it (to ensure delivery
// before a serverless invocation ends) without any risk of it throwing, or fire
// it and move on. Config: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. Unset ⇒ no-op.

const TELEGRAM_API = "https://api.telegram.org";
const TIMEOUT_MS = 4000;

/**
 * Best-effort Telegram alert. NEVER THROWS.
 *
 * @returns `true` only when Telegram accepted the message (HTTP 2xx).
 *          `false` for unset config, a non-2xx response, a network error, or
 *          the timeout.
 *
 * ⚠️ THE RETURN VALUE IS THE ONLY SIGNAL OF DELIVERY. Because this function
 * swallows every failure, a caller that needs to know whether a human was
 * actually told has nothing else to read — and silence here is
 * indistinguishable between "sent" and "your token is wrong".
 *
 * MOST CALLERS ARE RIGHT TO IGNORE IT: a one-off best-effort notification with
 * no state riding on it should stay fire-and-forget, and ~20 call sites do
 * exactly that. But if you are about to LATCH, SUPPRESS, or otherwise gate
 * state on "we told someone", you MUST check this boolean — see
 * lib/alerts/alert-state.ts for the worked example. Ignoring it there is
 * precisely the bug that made a failed send lose an alert permanently.
 */
export async function notifyTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false; // not configured — nobody was told

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[telegram] alert POST failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Swallow EVERYTHING — never let an alert failure propagate.
    console.error("[telegram] alert error (swallowed):", err);
    return false;
  }
}

// Non-swallowing counterpart backing the scheduled performance report (callers
// go through sendTelegramReport below, which adds the retry policy — a raw call
// gets ONE attempt and no outcome classification). Unlike notifyTelegram, this THROWS on any
// failure (missing config, network error, non-200 from Telegram) so the cron
// handler can return 500 and the scheduler's failure monitoring catches a
// broken report. Sends with parse_mode "HTML" — callers must escape dynamic
// substrings (see escapeHtml below). `timeoutMs` defaults to the best-effort
// TIMEOUT_MS; the report passes a longer budget since it retries and losing a
// whole hour is worse than a slightly longer invocation.
export async function sendTelegramHtml(
  text: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      "Telegram not configured: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required",
    );
  }

  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramHttpError(res.status, body);
  }
}

// Telegram answered and refused. The distinction that matters to the report's
// retry policy: a TelegramHttpError PROVES the message was not delivered, so
// re-POSTing is safe. Any other error means no response came back at all.
export class TelegramHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Telegram sendMessage failed: HTTP ${status} ${body}`);
    this.name = "TelegramHttpError";
  }
}

// Minimal HTML escaping for Telegram parse_mode "HTML" — only the three chars
// Telegram treats as markup need escaping (&, <, >).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── scheduled-report send ───────────────────────────────────────────
// The hourly report fires once per hour with no natural recovery until the next
// tick, so it is worth retrying a send that we KNOW did not land. But
// sendMessage is NOT idempotent and Telegram offers no idempotency key, so a
// retry on an error that says nothing about the server's outcome delivers the
// report twice.
//
// That is exactly what happened at Warsaw 22:00 on 2026-08-24: the 8s
// AbortSignal.timeout fired before Telegram's response arrived on BOTH attempts,
// the chat got the report twice, and the job then alerted "failed" for a report
// that had in fact been delivered. Hence the rule below — retry only on a
// TelegramHttpError that proves non-delivery; everything else stops at one POST
// and reports an UNKNOWN outcome rather than a failure.

// Per-attempt budget. 20s because Telegram's sendMessage is occasionally slow
// and aborting early is unrecoverable for a non-idempotent POST — the old 8s was
// tight enough to abort requests Telegram had already acted on. Still far below
// the route's own budget. Override with TELEGRAM_SEND_TIMEOUT_MS.
const REPORT_TIMEOUT_MS = 20000;
const REPORT_MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1000;
// Hard cap on ALL attempts together, so the caller can budget around this call.
// A retry is skipped when it could not finish inside the cap — the realistic
// retry case (a 429/5xx answered in well under a second) still gets its retry.
const REPORT_TOTAL_BUDGET_MS = 25000;

export function reportSendTimeoutMs(): number {
  const raw = Number(process.env.TELEGRAM_SEND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : REPORT_TIMEOUT_MS;
}

export type TelegramReportOutcome =
  | { status: "sent"; attempts: number; ms: number }
  // No response came back. The report may or may not have been delivered, and we
  // deliberately do not re-POST to find out. NOT a failure.
  | { status: "unknown"; attempts: number; ms: number; detail: string };

type FailureKind = "retryable" | "permanent" | "unknown";

function classify(err: unknown): FailureKind {
  // Telegram answered ⇒ the message was definitely not sent. 429/5xx are
  // transient, everything else (400 bad HTML, 403 kicked from the chat) is not.
  if (err instanceof TelegramHttpError) {
    return err.status === 429 || err.status >= 500 ? "retryable" : "permanent";
  }
  // fetch never produced a response: AbortSignal.timeout ("The operation was
  // aborted due to timeout"), an abort, or undici's TypeError wrapper for a
  // socket-level failure. The request may still have been processed.
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      err.name === "TypeError")
  ) {
    return "unknown";
  }
  // Anything else is a local, pre-request problem (e.g. missing config).
  return "permanent";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sends the scheduled performance report. Returns "sent" or "unknown"; THROWS
// only on a definite failure, so the caller can alert on real breakage without
// crying wolf over a slow response.
export async function sendTelegramReport(
  text: string,
): Promise<TelegramReportOutcome> {
  const timeoutMs = reportSendTimeoutMs();
  const deadline = Date.now() + REPORT_TOTAL_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      await sendTelegramHtml(text, timeoutMs);
      const ms = Date.now() - started;
      console.log(`[telegram] report send attempt ${attempt}: sent in ${ms}ms`);
      return { status: "sent", attempts: attempt, ms };
    } catch (err) {
      const ms = Date.now() - started;
      const detail = err instanceof Error ? err.message : String(err);
      const kind = classify(err);
      const willRetry =
        kind === "retryable" &&
        attempt < REPORT_MAX_ATTEMPTS &&
        Date.now() + RETRY_BACKOFF_MS + timeoutMs <= deadline;
      console.log(
        `[telegram] report send attempt ${attempt}: ${kind}${
          willRetry ? " (retrying)" : ""
        } in ${ms}ms — ${detail}`,
      );
      if (willRetry) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      if (kind === "unknown") {
        return { status: "unknown", attempts: attempt, ms, detail };
      }
      throw err;
    }
  }
}
