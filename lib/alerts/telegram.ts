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

// Non-swallowing counterpart used by the scheduled performance report
// (app/api/cron/telegram-report). Unlike notifyTelegram, this THROWS on any
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
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body}`);
  }
}

// Minimal HTML escaping for Telegram parse_mode "HTML" — only the three chars
// Telegram treats as markup need escaping (&, <, >).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
