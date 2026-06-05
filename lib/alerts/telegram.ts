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

export async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // not configured — silent no-op

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
    }
  } catch (err) {
    // Swallow EVERYTHING — never let an alert failure propagate.
    console.error("[telegram] alert error (swallowed):", err);
  }
}
