# Alert-Notify Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop losing an alert when the Telegram send fails on the tick a condition starts firing — latch only after delivery is confirmed, and retry on the next tick until it is.

**Architecture:** `notifyTelegram` starts reporting delivery as a `boolean`. `notifyOnTransition` splits into claim → send → stamp: the guarded upsert claims a send when the alert is either newly firing or firing-but-never-delivered, and `last_notified_at` is written only after the send is confirmed. `state='firing' AND last_notified_at IS NULL` is the pending-retry state. No schema change; the column already exists and has no readers.

**Tech Stack:** TypeScript · Drizzle (raw `sql` template) · Postgres (Supabase) · `tsx` scripts for tests

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-24-alert-notify-retry-design.md`. Read it before Task 1.
- Worktree `C:\AFF\camman\.claude\worktrees\alertfix`, branch `fix/alert-notify-retry`, based on `origin/main` @ `a9e06e3`. **Never** work in `C:\AFF\camman` directly — it is shared and another session can move HEAD between two commands. `cd` to the worktree at the start of every bash command and verify `git branch --show-current` before committing.
- **NO MIGRATION. NO SCHEMA CHANGE.** `alert_state.last_notified_at` already exists as nullable `timestamptz`.
- **The happy path must stay bit-identical**: one message per breach, same latch. `clearAlert` is not modified. None of the 8 call sites are modified.
- `notifyTelegram` must keep its never-throws contract. It returns `false` on unset config, non-2xx, network error, and timeout; `true` only on a 2xx response.
- **No top-level `await` in scripts.** The repo has no `"type": "module"`, so `tsx` compiles as CJS and top-level `await` fails with `esbuild: Top-level await is currently not supported with the "cjs" output format`. 256 scripts use `async function main() { … } main().catch((err) => { console.error(err); process.exit(1); });`.
- Scripts that touch the database must `import "./_env-preload";` as their **first** import, or the connection fails with `password authentication failed for user "dimat"`.
- **Rollback sentinel: use a `Symbol`, not a string.** Measured in this repo: 30 scripts use `const ROLLBACK = Symbol("rollback"); … throw ROLLBACK; … if (e !== ROLLBACK) throw e;` and only 2 use a string sentinel (both introduced on the previous branch — do not copy them). A `Symbol` cannot collide with a genuine error message.
- Lint changed files only: `npx eslint <file>`. A repo-wide run walks other worktrees and exits 1 on unrelated problems.
- Tests are `tsx` scripts under `scripts/`, run with `npx tsx scripts/<name>.ts`. There is no test runner; do not add one.

---

### Task 1: `notifyTelegram` reports delivery

**Files:**
- Modify: `lib/alerts/telegram.ts`
- Create: `scripts/test-telegram-delivery-contract.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `notifyTelegram(text: string): Promise<boolean>` — `true` only on a 2xx response from Telegram; `false` on unset config, non-2xx, network error, or timeout. Never throws.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-telegram-delivery-contract.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix && npx tsx scripts/test-telegram-delivery-contract.ts
```

Expected: FAIL. `notifyTelegram` currently returns `Promise<void>`, so every `=== false` / `=== true` comparison is against `undefined`. You should see the ⭐ lines fail.

- [ ] **Step 3: Make `notifyTelegram` report delivery**

In `lib/alerts/telegram.ts`, replace the `notifyTelegram` function. Keep the surrounding file (including `sendTelegramHtml`) untouched.

```ts
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
```

- [ ] **Step 4: Run the test and make sure it passes**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix && npx tsx scripts/test-telegram-delivery-contract.ts
```

Expected: `PASS — 7 passed, 0 failed`

- [ ] **Step 5: Confirm no existing caller broke**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix && npx tsc --noEmit
```

Expected: clean. ~20 call sites discard the return value; TypeScript permits discarding a returned value, so none of them need to change. If `tsc` reports an error at a `notifyTelegram` call site, STOP and report it — that would mean a caller is doing something the spec did not anticipate.

- [ ] **Step 6: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
npx eslint lib/alerts/telegram.ts scripts/test-telegram-delivery-contract.ts
git add lib/alerts/telegram.ts scripts/test-telegram-delivery-contract.ts
git commit -m "feat(alerts): notifyTelegram reports whether the message was delivered

It swallows every failure and never throws, so the boolean is the only
signal a caller has. Additive — the ~20 existing callers discard it and
are right to; the rule is for new callers that gate state on delivery.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Claim → send → stamp, and the durability guard

The fix and its guard are one deliverable: the guard is the only thing that demonstrates the fix, and the fix is meaningless without it. TDD order — guard first, watch it fail on the real bug, then fix.

**Files:**
- Modify: `lib/alerts/alert-state.ts`
- Create: `scripts/verify-alert-notify-retry.ts`

**Interfaces:**
- Consumes: `notifyTelegram(text: string): Promise<boolean>` (Task 1).
- Produces:
  - `transitionAlert(dbc, { alertKey, orgId, state }): Promise<boolean>` — unchanged signature; for `state: "firing"` it now returns `true` when a send is owed (fresh transition **or** undelivered retry).
  - `notifyOnTransition(dbc, { alertKey, orgId, text, send? }): Promise<void>` — `send` defaults to `notifyTelegram`.
  - `markAlertNotified(dbc, alertKey): Promise<void>` — stamps `last_notified_at` only while still firing and still unstamped.

- [ ] **Step 1: Write the failing guard**

Create `scripts/verify-alert-notify-retry.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail on the real bug**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix && npx tsx scripts/verify-alert-notify-retry.ts
```

Expected: FAIL. `notifyOnTransition` does not accept a `send` option yet, so this will not compile-run cleanly. Once that is resolved by Step 3, the meaningful failure to look for is **CASE 4** — the current code latches on detection, so the retry never happens.

If you want to see the bug itself before fixing it, temporarily give `notifyOnTransition` only the `send` parameter (no claim/stamp change) and re-run: CASE 3's "stays NULL" and CASE 4 both fail. This is optional but it is the clearest possible demonstration of what you are fixing.

- [ ] **Step 3: Rewrite `notifyOnTransition` as claim → send → stamp**

In `lib/alerts/alert-state.ts`, replace `transitionAlert` and `notifyOnTransition`, and add `markAlertNotified`. **Leave `clearAlert` exactly as it is.** Add `import { notifyTelegram } from "@/lib/alerts/telegram";` — it is already imported.

```ts
export type AlertState = "ok" | "firing";

/**
 * Move an alert to `state`, returning true only when this call OWES A SEND.
 *
 * For `state: "ok"` that means the state actually changed (unchanged behaviour).
 *
 * For `state: "firing"` it means EITHER a fresh transition into firing OR the
 * alert is already firing and has never been delivered — see the pending state
 * below. A true return is the caller's licence to notify.
 *
 * ⚠️ THE PENDING STATE: `state = 'firing' AND last_notified_at IS NULL` means
 * "breach recorded, notification NOT yet delivered". It is what makes a failed
 * send retry instead of vanishing. Before this, the latch flipped on DETECTION,
 * so a send that failed on the transition tick was lost permanently — the next
 * tick saw no transition and stayed silent, and a condition that never resolves
 * never re-arms.
 *
 * No migration was needed: `last_notified_at` already existed, nothing reads it,
 * and the old code always stamped it when transitioning to firing — so no
 * pre-existing row can be firing-with-NULL and be misread as pending.
 *
 * `since` is PRESERVED on a retry. It records when the breach began, not when
 * the latest delivery attempt ran.
 */
export async function transitionAlert(
  dbc: DbOrTx,
  { alertKey, orgId, state }: { alertKey: string; orgId?: string | null; state: AlertState },
): Promise<boolean> {
  if (state === "ok") {
    const rows = (await dbc.execute(sql`
      INSERT INTO alert_state (alert_key, org_id, state, since, last_notified_at)
      VALUES (${alertKey}, ${orgId ?? null}, 'ok', now(), NULL)
      ON CONFLICT (alert_key) DO UPDATE
        SET state = 'ok',
            since = now(),
            org_id = COALESCE(EXCLUDED.org_id, alert_state.org_id)
        WHERE alert_state.state <> 'ok'
      RETURNING alert_key
    `)) as unknown as { alert_key: string }[];
    return rows.length > 0;
  }

  const rows = (await dbc.execute(sql`
    INSERT INTO alert_state (alert_key, org_id, state, since, last_notified_at)
    VALUES (${alertKey}, ${orgId ?? null}, 'firing', now(), NULL)
    ON CONFLICT (alert_key) DO UPDATE
      SET state = 'firing',
          since = CASE WHEN alert_state.state <> 'firing' THEN now()
                       ELSE alert_state.since END,
          last_notified_at = CASE WHEN alert_state.state <> 'firing' THEN NULL
                                  ELSE alert_state.last_notified_at END,
          org_id = COALESCE(EXCLUDED.org_id, alert_state.org_id)
      WHERE alert_state.state <> 'firing'
         OR alert_state.last_notified_at IS NULL
    RETURNING alert_key
  `)) as unknown as { alert_key: string }[];
  return rows.length > 0;
}

/**
 * Stamp an alert as delivered. Called ONLY after a send is confirmed.
 *
 * The `state = 'firing'` guard matters: if the condition cleared between the
 * send and this stamp, the row is now 'ok' and must not be recorded as
 * delivered-while-firing. The `last_notified_at IS NULL` guard makes it
 * idempotent.
 */
export async function markAlertNotified(dbc: DbOrTx, alertKey: string): Promise<void> {
  await dbc.execute(sql`
    UPDATE alert_state SET last_notified_at = now()
    WHERE alert_key = ${alertKey}
      AND state = 'firing'
      AND last_notified_at IS NULL
  `);
}

/**
 * Notify on a transition into firing, and RETRY until the send is confirmed.
 *
 * Best-effort throughout: a failure to record state or to reach Telegram must
 * never propagate into the request that noticed the condition.
 *
 * ⚠️ A DUPLICATE IS POSSIBLE ON THE FAILURE PATH, deliberately. Two overlapping
 * ticks can both claim an undelivered retry before either stamps success. The
 * window exists only between claim and stamp and only for an alert whose first
 * send already failed; cron cadences are 15-60 minutes and mostly single-runner.
 * At-most-one duplicate is strictly better than the silent loss it replaces. Not
 * closed with a lease (a second time-based concept in this state machine) nor
 * with SELECT FOR UPDATE (a row lock held across a 4s network call on a pooled
 * connection).
 *
 * `send` is injectable ONLY so the guard can force a failure without touching
 * the network. Production callers use the default.
 */
export async function notifyOnTransition(
  dbc: DbOrTx,
  {
    alertKey,
    orgId,
    text,
    send = notifyTelegram,
  }: {
    alertKey: string;
    orgId?: string | null;
    text: string;
    send?: (text: string) => Promise<boolean>;
  },
): Promise<void> {
  try {
    const owesSend = await transitionAlert(dbc, { alertKey, orgId, state: "firing" });
    if (!owesSend) return;
    const delivered = await send(text);
    if (delivered) await markAlertNotified(dbc, alertKey);
  } catch (err) {
    console.error(`[alert-state] transition failed for ${alertKey} (swallowed):`, err);
  }
}
```

Note the `state: "ok"` branch is split out but behaviourally identical to before: it changes the row only when the state actually differs, and it no longer writes `last_notified_at` on the insert path (it was always `NULL` there anyway). The `org_id` COALESCE is added so a clear no longer leaves the column stale — the previous branch had to work around exactly that.

- [ ] **Step 4: Run the guard and make sure it passes**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix && npx tsx scripts/verify-alert-notify-retry.ts
```

Expected: `PASS — 0 failed check(s)`, with CASE 4 and CASE 6 both ✓.

- [ ] **Step 5: Prove the guard can go red**

Temporarily move the stamp back before the send — replace the body of `notifyOnTransition`'s try block with the old ordering:

```ts
    const owesSend = await transitionAlert(dbc, { alertKey, orgId, state: "firing" });
    if (owesSend) {
      await markAlertNotified(dbc, alertKey); // WRONG ON PURPOSE: stamp before send
      await send(text);
    }
```

Re-run. Expected: **FAIL**, with CASE 3's "stays NULL" and CASE 4's retry both ✗ — the exact bug reproduced. Then **revert** and confirm PASS again.

A guard never shown to go red is not a guard. Paste both outputs in your report.

- [ ] **Step 6: Confirm the 8 call sites still compile untouched**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
npx tsc --noEmit
git diff --name-only
```

Expected: `tsc` clean, and `git diff --name-only` lists ONLY `lib/alerts/alert-state.ts` and `scripts/verify-alert-notify-retry.ts`. If any call site appears, the change was not additive — STOP and report.

- [ ] **Step 7: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
npx eslint lib/alerts/alert-state.ts scripts/verify-alert-notify-retry.ts
git add lib/alerts/alert-state.ts scripts/verify-alert-notify-retry.ts
git commit -m "fix(alerts): latch only after delivery is confirmed, retry until then

notifyOnTransition flipped the latch on DETECTION, and notifyTelegram
never throws — so a send that failed on the transition tick was lost
permanently and a condition that never resolves never re-armed.

firing + last_notified_at IS NULL is now the pending state: the guarded
upsert claims a send for a fresh transition OR an undelivered retry, and
the stamp happens only after the send is confirmed. No migration.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Documentation

**Files:**
- Modify: `docs/03-data-model.md` (the `alert_state` row, around line 363)
- Modify: `docs/07-conventions.md` (the state-transition-gated alerts paragraph, around lines 919-923)
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Record the pending state in the data model**

In `docs/03-data-model.md`, immediately after the `alert_state` table row (line ~363), add:

```markdown
> **⚠️ `alert_state.last_notified_at` is the DELIVERY marker, not a detection timestamp.**
> `state='firing' AND last_notified_at IS NULL` means *breach recorded, notification not yet
> delivered* — the next tick retries the send. It is stamped only after Telegram confirms
> receipt. No schema change was needed to introduce this: the column already existed, nothing
> reads it, and the previous code always stamped it on transition, so no historical row can sit
> in the pending state and be misread. See [lib/alerts/alert-state.ts](../lib/alerts/alert-state.ts).
```

- [ ] **Step 2: Extend the conventions paragraph**

In `docs/07-conventions.md`, after the existing paragraph ending "partner-key rotation does this explicitly." (around line 923), add:

```markdown
**The latch is claimed on DELIVERY, not on detection.** `notifyTelegram` never throws and
returns `false` on unset config, a non-2xx, a network error, or its timeout. If the latch
flipped when the condition was *noticed*, a send that failed on that one tick would be lost
forever — the next tick sees no transition and stays silent, and a condition that never
resolves never re-arms. So `notifyOnTransition` claims a send when the alert is newly firing
**or** firing-but-never-delivered, and writes `last_notified_at` only after the send is
confirmed.

**If you gate state on "we told someone", you MUST check `notifyTelegram`'s boolean.** About
twenty call sites discard it and are right to — they are best-effort notifications with nothing
riding on them. The rule is for new callers that latch, suppress, or otherwise make a decision
based on delivery. Ignoring it there re-creates the bug above.

A duplicate is possible on the failure path: two overlapping ticks can both claim an
undelivered retry before either stamps success. Accepted deliberately — at-most-one duplicate
beats a silent loss, and the window only exists for an alert whose first send already failed.

**Not fully covered:** callers that are event-driven rather than periodic retry only when the
event recurs. `app/api/intake/leads/[token]/route.ts` is the one such caller today — if no
further auth failure arrives, its alert is still lost. A sweeper over
`state='firing' AND last_notified_at IS NULL` would close that; it is not built.
```

- [ ] **Step 3: Append the changelog line**

Add to `docs/CHANGELOG.md`:

```markdown
2026-08-24 — Alerts latch only after Telegram confirms delivery; a failed send now retries on the next tick instead of being lost permanently (no migration) — docs/03-data-model.md, docs/07-conventions.md
```

- [ ] **Step 4: Update the "last updated" dates**

Set the `last updated` line to `2026-08-24` on `docs/03-data-model.md` and `docs/07-conventions.md`. Do not invent the line on `CHANGELOG.md` — it does not carry one.

- [ ] **Step 5: Verify and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
git diff --name-only | grep -v '^docs/' && echo "NON-DOC FILE TOUCHED — STOP" || echo "docs only (correct)"
test -f lib/alerts/alert-state.ts && echo "referenced path exists"
git add docs/
git commit -m "docs: record the delivery-confirmed latch and the pending-retry state

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Pre-merge checks and PR

- [ ] **Step 1: Run every gate**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
npx tsc --noEmit
npx tsx scripts/test-telegram-delivery-contract.ts
npx tsx scripts/verify-alert-notify-retry.ts
npx eslint $(git diff --name-only origin/main...HEAD | grep -E '\.tsx?$' | tr '\n' ' ')
```

Expected: `tsc` clean, both scripts PASS, eslint clean on changed files (report the count and confirm none are new — compare flagged line numbers against your diff's changed lines; a flagged line outside your hunks is pre-existing).

- [ ] **Step 2: Confirm no migration and no call-site changes**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
echo "migrations: $(git diff --name-only origin/main...HEAD | grep -c '^db/migrations/')"
echo "schema.ts touched: $(git diff --name-only origin/main...HEAD | grep -c '^db/schema.ts')"
git diff --name-only origin/main...HEAD
```

Expected: migrations `0`, schema.ts `0`, and the file list contains only `lib/alerts/telegram.ts`, `lib/alerts/alert-state.ts`, the two scripts, and `docs/`. **No file under `app/` or `lib/drip/` may appear** — those are the 8 call sites and they must be untouched.

- [ ] **Step 3: Diff touched files against the drip-campaign branch**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
git fetch origin --quiet
BASE=$(git merge-base origin/main HEAD)
for f in $(git diff --name-only origin/main...HEAD); do
  for b in $(git branch -r --list 'origin/*drip*' | tr -d ' '); do
    git diff --quiet "$BASE" "$b" -- "$f" 2>/dev/null || echo "OVERLAP: $f also changed on $b"
  done
done
echo "(no OVERLAP lines = clean)"
```

If a file overlaps, merge that branch's changes and re-run Step 1. Never overwrite parallel work.

- [ ] **Step 4: Merge current main and re-run the gates**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
git fetch origin --quiet && git merge origin/main --no-edit
npx tsc --noEmit && npx tsx scripts/test-telegram-delivery-contract.ts && npx tsx scripts/verify-alert-notify-retry.ts
```

Both scripts must still PASS on the merged tree. `origin/main` moves several times a day on this project — do not skip this.

- [ ] **Step 5: Push and open the PR**

```bash
cd /c/AFF/camman/.claude/worktrees/alertfix
git push -u origin fix/alert-notify-retry
```

The PR body must state: the bug and why it was invisible, that there is **no migration** and why none was needed (the column exists, has no readers, and no legacy row can sit in the pending state), that the happy path and all 8 call sites are unchanged, the verification output including the proven-red run, the accepted duplicate window, the intake-webhook limitation, and the previous prod deployment id as the rollback target.

---

## Notes for the implementer

**The one thing most likely to go wrong.** The claim statement's `WHERE` clause is the whole fix. `WHERE alert_state.state <> 'firing' OR alert_state.last_notified_at IS NULL` — if you drop the second disjunct you have rebuilt the bug, and only CASE 4 will catch you. If you drop the first, a fresh transition on a row previously stamped will not claim, and CASE 1 will catch you.

**Do not reset `since` on a retry.** CASE 7 exists for this. `since` records when the breach began; resetting it on every failed attempt would make a long-running breach permanently look brand new, which is exactly the wrong signal on an alert that has been undelivered for hours.

**`clearAlert` is not in scope.** It already does the right thing. The only change near it is the `org_id` COALESCE inside `transitionAlert`'s `ok` branch, which stops a clear leaving `org_id` stale.
