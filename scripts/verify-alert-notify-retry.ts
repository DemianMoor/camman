// Durability guard for the alert-delivery retry (spec §8).
// Run: npx tsx scripts/verify-alert-notify-retry.ts
//
// ⚠️ WHY THIS SHAPE. The bug is invisible in the happy path and only appears when
// a send FAILS on the tick a condition starts firing. There is no live breach to
// observe that on, and there never will be on demand — so every case here is
// SYNTHESIZED inside a transaction that is rolled back. Nothing depends on a real
// alert existing, so the guard cannot go green-by-absence when live alerts clear.
//
// The sender is injected, so no case touches the network or the real Telegram
// channel.
//
// The two load-bearing cases:
//   CASE 2 — fails if the fix breaks today's latch (a message every tick).
//   CASE 6 — fails if a retry duplicates (two messages for one breach).
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { notifyTelegram } from "@/lib/alerts/telegram";

const ROLLBACK = Symbol("rollback");

let fail = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}

/**
 * A fake sender that records every attempt and fails the first `failures` of
 * them, then succeeds. Counts BOTH attempts and deliveries, because the
 * difference between the two is exactly what CASE 6 asserts.
 */
function fakeSender(failures: number) {
  let remaining = failures;
  const state = {
    attempts: 0,
    delivered: 0,
    async send(text: string): Promise<boolean> {
      void text;
      state.attempts++;
      if (remaining > 0) {
        remaining--;
        return false;
      }
      state.delivered++;
      return true;
    },
  };
  return state;
}

type Row = { state: string; last_notified_at: string | null; since: string };

async function readRow(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], key: string) {
  const rows = (await tx.execute(sql`
    SELECT state, last_notified_at::text AS last_notified_at, since::text AS since
    FROM alert_state WHERE alert_key = ${key}
  `)) as unknown as Row[];
  return rows[0] ?? null;
}

async function main() {
  console.log("\nSynthesized cases (rolled back)\n");

  try {
    await db.transaction(async (tx) => {
      // ── CASES 1-2: happy path is unchanged ─────────────────────────────
      {
        const key = "verify:alert_retry:happy";
        const s = fakeSender(0);
        const send = s.send;

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        const afterFirst = await readRow(tx, key);
        ok(s.delivered === 1, "CASE 1: fresh transition sends exactly once");
        ok(afterFirst?.state === "firing", "CASE 1: row is firing");
        ok(
          afterFirst?.last_notified_at !== null,
          "CASE 1: last_notified_at stamped after a confirmed send",
        );

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        ok(s.delivered === 1, "⭐ CASE 2: still breaching on the next tick -> NO second send (latched)");
        ok(s.attempts === 1, "CASE 2: and no second ATTEMPT either — the claim was refused");
      }

      // ── CASES 3-7: the bug ─────────────────────────────────────────────
      {
        const key = "verify:alert_retry:failing";
        const s = fakeSender(1); // first send fails, the rest succeed
        const send = s.send;

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        const afterFail = await readRow(tx, key);
        ok(s.attempts === 1, "CASE 3: a send was attempted");
        ok(s.delivered === 0, "CASE 3: the send FAILED, so nothing was delivered");
        ok(afterFail?.state === "firing", "CASE 3: the breach is still recorded as firing");
        ok(
          afterFail?.last_notified_at === null,
          "⭐ CASE 3: last_notified_at stays NULL — the row is PENDING, not latched",
        );
        const sinceAfterFail = afterFail?.since;

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        const afterRetry = await readRow(tx, key);
        ok(
          s.delivered === 1,
          "⭐⭐ CASE 4: the next tick RETRIES and delivers — this is the whole fix",
        );
        ok(
          afterRetry?.last_notified_at !== null,
          "CASE 4: last_notified_at stamped once the retry succeeded",
        );
        ok(
          afterRetry?.since === sinceAfterFail,
          "⭐ CASE 7: `since` is PRESERVED across the retry (the breach began when it began)",
        );

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        ok(s.delivered === 1, "CASE 5: the tick after delivery does NOT send again");
        ok(
          s.attempts === 2 && s.delivered === 1,
          "⭐ CASE 6: exactly 2 attempts and exactly 1 delivery across the whole sequence",
        );
      }

      // ── CASE 8: a cleared alert re-arms even after a failed send ───────
      {
        const key = "verify:alert_retry:rearm";
        const s = fakeSender(1);
        const send = s.send;

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        ok(s.delivered === 0, "CASE 8: first send failed");
        await clearAlert(tx, { alertKey: key });
        const cleared = await readRow(tx, key);
        ok(cleared?.state === "ok", "CASE 8: clearAlert moved it to ok");

        await notifyOnTransition(tx, { alertKey: key, text: "breach again", send });
        ok(s.delivered === 1, "⭐ CASE 8: breaching again after a clear sends — not stuck");
      }

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    console.log("\n  (transaction rolled back — nothing written)");
  }

  // ── CASE 9: the real sender treats unset config as not sent ───────────
  {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const delivered = await notifyTelegram("verify: must not send");
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = token;
    if (chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = chat;
    ok(delivered === false, "⭐ CASE 9: unset TELEGRAM_* counts as NOT sent");
  }

  // ── CASE 10: residue ──────────────────────────────────────────────────
  const residue = (await db.execute(sql`
    SELECT count(*)::int AS n FROM alert_state WHERE alert_key LIKE 'verify:alert_retry:%'
  `)) as unknown as { n: number }[];
  ok(Number(residue[0].n) === 0, "⭐ CASE 10: residue check — no synthesized rows survived");

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
