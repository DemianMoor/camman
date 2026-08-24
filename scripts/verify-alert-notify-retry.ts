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
// The load-bearing cases:
//   CASE 2  — fails if the fix breaks today's latch (a message every tick).
//   CASE 6  — fails if a retry duplicates (two messages for one breach).
//   CASE 11 — fails if the claim's FIRST disjunct (`state <> 'firing'`) is
//             removed. No other case ever produces a row in state 'ok' with a
//             non-NULL last_notified_at — the one state that discriminates the
//             two disjuncts — so without CASE 11, deleting that disjunct is
//             undetectable and a delivered breach that recurs stays silent
//             forever.
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

  // The residue check (CASE 10) must run even if something above throws a
  // real (non-ROLLBACK) error — otherwise a broken case rethrows, main()
  // rejects, and the run produces no proof of cleanliness even though the
  // transaction itself still aborted (so nothing actually leaked). Captured
  // here instead of rethrown, so CASE 10 always runs; reported after.
  let caseError: unknown = null;
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
          typeof afterFirst?.last_notified_at === "string",
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
          typeof afterRetry?.last_notified_at === "string",
          "CASE 4: last_notified_at stamped once the retry succeeded",
        );
        // ⚠️ THIS ASSERTION IS DELIBERATELY WEAK, AND ITS LABEL SAYS SO.
        //
        // Postgres `now()` is transaction_timestamp(), frozen for the whole
        // surrounding db.transaction that every case in this file runs inside.
        // The claim's `since = CASE WHEN state <> 'firing' THEN now() ELSE
        // alert_state.since END` picks between "now()" and "the existing
        // since" — but both evaluate to the SAME frozen instant here, so a
        // byte-identical value comes back whether the CASE preserved the old
        // `since` or reset it. Deleting the CASE entirely and writing
        // `since = now()` unconditionally would still make `afterRetry.since
        // === sinceAfterFail` true, and this check would still print ✓.
        //
        // Same root cause as CASE 11's stamp assertion below, and not
        // strengthened here for the same reason: proving PRESERVED-vs-RESET
        // needs either `statement_timestamp()` in the production SQL (out of
        // scope — this guard does not touch alert-state.ts) or running the
        // retry in a second, separately committed transaction (which would
        // give up this file's one-rolled-back-transaction durability
        // guarantee, and the residue check with it, for a single case). The
        // label states only what this checks — that `since` is still
        // populated after the retry, not that it was preserved rather than
        // reset.
        ok(
          afterRetry?.since === sinceAfterFail,
          "CASE 7: `since` is still populated after the retry (cannot prove PRESERVED-vs-RESET — frozen tx now(), see comment)",
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

      // ── CASE 11: pins the FIRST disjunct (`state <> 'firing'`) ─────────
      // CASE 8's clear happens after a FAILED first send, so last_notified_at
      // is still NULL when it reaches 'ok' — its re-fire matches EITHER
      // disjunct and proves nothing about the first one on its own. This
      // block clears after a SUCCESSFUL delivery instead, so the cleared row
      // is 'ok' WITH a non-NULL last_notified_at — the state no other case in
      // this file produces, and the only one where the second disjunct
      // (`last_notified_at IS NULL`) is false. If `state <> 'firing'` were
      // deleted from the claim's WHERE, the recurrence below could not claim
      // and would silently never send again.
      {
        const key = "verify:alert_retry:redeliver";
        const s = fakeSender(0); // first send succeeds
        const send = s.send;

        await notifyOnTransition(tx, { alertKey: key, text: "breach", send });
        const afterFirst = await readRow(tx, key);
        ok(s.delivered === 1, "CASE 11: fresh transition delivers");
        ok(afterFirst?.state === "firing", "CASE 11: row is firing");
        ok(
          typeof afterFirst?.last_notified_at === "string",
          "CASE 11: last_notified_at stamped after the confirmed send",
        );

        await clearAlert(tx, { alertKey: key });
        const cleared = await readRow(tx, key);
        ok(cleared?.state === "ok", "CASE 11: clearAlert moved it to ok");
        ok(
          typeof cleared?.last_notified_at === "string",
          "⭐ CASE 11: last_notified_at is STILL stamped on the cleared row — the " +
            "one state no other case creates, and the one that discriminates " +
            "`state <> 'firing'` from `last_notified_at IS NULL`",
        );

        await notifyOnTransition(tx, { alertKey: key, text: "breach again", send });
        const afterRecur = await readRow(tx, key);
        ok(
          s.delivered === 2,
          "⭐⭐ CASE 11: breaching again after a DELIVERED clear sends again — " +
            "this is exactly what removing `state <> 'firing'` from the claim breaks",
        );
        ok(afterRecur?.state === "firing", "CASE 11: row is firing again");
        // ⚠️ THIS ASSERTION IS DELIBERATELY WEAK, AND ITS LABEL SAYS SO.
        //
        // It cannot distinguish a fresh stamp from the first delivery's
        // leftover. Under the exact mutation CASE 11 exists to catch (the
        // `state <> 'firing'` disjunct removed), the claim is refused, the row
        // stays 'ok', markAlertNotified never runs — and the first delivery's
        // stamp is still sitting there, so this check prints ✓ while nothing
        // was re-stamped. It is the two assertions above that catch that.
        //
        // It cannot be strengthened here: Postgres `now()` is transaction
        // timestamp, frozen for the whole surrounding transaction, so the two
        // stamps are byte-identical and comparing them for inequality proves
        // nothing. Rather than leave a ✓ next to a label claiming more than it
        // checks, the label states exactly what it verifies — that the column
        // is populated at all.
        ok(
          typeof afterRecur?.last_notified_at === "string",
          "CASE 11: last_notified_at is populated (cannot prove it is FRESH — see comment)",
        );
      }

      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) {
      console.log("\n  (transaction rolled back — nothing written)");
    } else {
      caseError = e;
    }
  }

  // ── CASE 9: the real sender treats unset config as not sent ───────────
  // Skipped if the transaction above threw a real error — nothing after it ran
  // to leave state worth checking with a live network call, and CASE 10 below
  // (which DOES still run) is what actually proves no residue was left.
  if (!caseError) {
    try {
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
    } catch (e) {
      caseError = e;
    }
  }

  // ── CASE 10: residue ──────────────────────────────────────────────────
  // Runs unconditionally: neither block above rethrows on a real error
  // anymore — each captures it into `caseError` instead — so a broken case
  // earlier can never skip this check. The transaction is rolled back (or
  // never committed) either way; this proves cleanliness rather than causing
  // it.
  const residue = (await db.execute(sql`
    SELECT count(*)::int AS n FROM alert_state WHERE alert_key LIKE 'verify:alert_retry:%'
  `)) as unknown as { n: number }[];
  ok(Number(residue[0].n) === 0, "⭐ CASE 10: residue check — no synthesized rows survived");

  if (caseError) {
    console.error(caseError);
    process.exit(1);
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
