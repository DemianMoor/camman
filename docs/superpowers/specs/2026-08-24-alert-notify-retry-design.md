# Alert-loss window in shared alerting — design

**Date:** 2026-08-24
**Branch:** `fix/alert-notify-retry` (worktree `.claude/worktrees/alertfix`, based on `origin/main` @ `a9e06e3`)
**Status:** approved design, ready for implementation plan

---

## 1. The bug

`lib/alerts/alert-state.ts`:

```ts
const changed = await transitionAlert(dbc, { alertKey, orgId, state: "firing" });
if (changed) await notifyTelegram(text);
```

The latch flips to `firing` **before** the send. `notifyTelegram` never throws — it swallows
network errors, non-200 responses and timeouts, and returns early as a silent no-op when
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are unset.

So if the send fails on the single tick where the condition transitions, the alert is lost
**permanently**: the latch now reads "already told", and the next tick sees no transition and
stays silent. A condition that does not resolve — a dead landing page, a stalled sweeper —
never re-arms, because re-arming requires passing through `ok` first.

The monitors are described in their own headers as "the only thing that notices". This defeats
that on the one tick it matters.

**Blast radius: 8 call sites**, not the 6 estimated:

| Call site | Retry driver |
|---|---|
| `app/api/cron/tracking-monitors/route.ts` | hourly cron, re-calls while breaching |
| `lib/drip/monitors.ts` (backlog) | 15-min cron, re-calls while breaching |
| `lib/drip/monitors.ts` (awaiting lookup) | 15-min cron, re-calls while breaching |
| `lib/drip/lookup-guard.ts` (Telnyx balance) | called from the drip monitors cron |
| `lib/drip/numbers.ts` (numbers exhausted) | scheduler run, re-calls while exhausted |
| `lib/drip/optout-monitor.ts` | re-calls while breaching (key includes ET day) |
| `lib/drip/scheduler.ts` (daily cap near) | re-calls while over threshold (key includes ET day) |
| `app/api/intake/leads/[token]/route.ts` | **event-driven only** — the next failed auth request |

Seven are periodic and sit inside `if (firing) { notifyOnTransition } else { clearAlert }`, so
a retry driver already exists. The eighth is a `void`-ed fire-and-forget on a webhook; see §6.

---

## 2. Why no migration

`alert_state` already carries `last_notified_at timestamptz NULL`.

**Nothing reads it.** Verified across the repo: the only occurrences outside `db/schema.ts`
are the three lines inside `alert-state.ts` that write it. There is no consumer whose meaning
could break.

**The cutover is clean by construction.** Under the current code, a transition into `firing`
*always* sets `last_notified_at = now()` in the same statement. So no existing row can be
`state='firing' AND last_notified_at IS NULL`. That combination is a state only the new code
can create — there is no legacy row to misread, and no backfill.

Confirmed against production at design time: the single `firing` row
(`tracking_gap:stage:3041`) carries a non-null `last_notified_at`. Every `last_notified_at IS
NULL` row is in state `ok`, where the new semantics do not apply.

---

## 3. The state

| `state` | `last_notified_at` | meaning |
|---|---|---|
| `ok` | anything | not breaching. `clearAlert` sets this. Unchanged. |
| `firing` | `NULL` | breach recorded, **notification not yet delivered** — retry on the next tick |
| `firing` | timestamp | breach recorded and delivered — stay silent (today's latch) |

The column finally means what its name says. No new column, no new state value, no change to
the `alert_state_state_check` CHECK constraint.

---

## 4. The flow

**Step 1 — claim.** One guarded upsert, widened by a single clause:

```sql
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
```

A row comes back in exactly two cases, and both mean *send now*:
- a fresh transition `ok → firing`, or
- already `firing` but never delivered (the retry).

`since` is **preserved on a retry** — the breach began when it began, not when the retry ran.
Resetting it would misreport the breach's age on every failed attempt.

**Step 2 — send.** `const sent = await send(text)`.

**Step 3 — stamp, only on confirmed success:**

```sql
UPDATE alert_state SET last_notified_at = now()
WHERE alert_key = ${alertKey} AND state = 'firing' AND last_notified_at IS NULL
```

The `state = 'firing'` guard matters: if the condition cleared between the send and the stamp,
the row is now `ok` and must not be stamped as delivered-while-firing.

**Happy path is bit-identical to today**: transition → claim → send succeeds → stamp. One
message per breach, latched exactly as before. `clearAlert` is not touched at all.

---

## 5. `notifyTelegram` must report delivery

It currently returns `Promise<void>` and swallows everything. Change it to
`Promise<boolean>` — `true` only when Telegram accepted the message (HTTP 2xx).

Returns `false` for: unset `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, a non-2xx response, a
network error, and the 4s timeout.

This is **additive**. All ~20 existing call sites ignore the return value; TypeScript permits
discarding a returned value, so none of them change. The swallow-never-throw contract is
preserved — the function still never throws, it just now says whether it worked.

### ⚠️ Ignoring the return must not become the convention

Twenty call sites discarding a `boolean` is exactly how a meaningful return value decays into
decoration: the next author copies a neighbouring line, ignores the result, and silently
re-creates the fire-and-forget bug this change exists to remove.

TypeScript has no `#[must_use]`, and no ESLint rule in this project's config flags an ignored
non-`Promise` return, so this cannot be enforced mechanically without building machinery that
would itself rot. It is handled by making the contract loud where an author will actually read
it:

1. `notifyTelegram`'s JSDoc states plainly that the boolean is the **only** signal of delivery,
   that it never throws, and that a caller who needs to know whether a human was told **must**
   check it — with a pointer to `notifyOnTransition` as the worked example.
2. `docs/07-conventions.md` carries the same rule next to the transition-gate paragraph, so it
   surfaces in a docs search rather than only at the call site.
3. The existing ~20 callers are *correct* to ignore it — they are best-effort notifications
   with no latch to protect. The rule is about **new** callers that gate state on delivery, and
   both notes say so, so this does not read as twenty pre-existing violations.

**Unset config counts as not sent**, deliberately. In preview and local environments alerts
will stay `firing` + pending and re-attempt each tick. The retry is close to free (the
function returns before any `fetch`), nothing was ever delivered so there is no duplicate
risk, and the row honestly records that no human was told. Treating unset as delivered would
re-create this exact bug, narrowed to a missing-config cause — which is itself a real
production failure mode.

---

## 6. Accepted limitations

**A duplicate is possible on ANY concurrent claim, not only a post-failure retry.** [Corrected
2026-08-24 — see `lib/alerts/alert-state.ts` and `docs/07-conventions.md`, which fixed exactly
this paragraph without it being carried back here.] The claim's `WHERE` has two disjuncts
(`state <> 'firing'` OR `last_notified_at IS NULL`), and the window is open on EVERY claim that
matches either one — including a fresh `ok → firing` transition, not only an alert whose first
send already failed. Two overlapping callers racing a fresh transition can both win: the first
sets `firing`/`NULL` and returns a row; the second blocks on the row lock, then re-reads
`firing` + `NULL` once the first commits, matches the second disjunct, and also returns a row —
both send. Under the OLD statement (gated on state change alone) the guarded upsert was
atomically exclusive: exactly one winner, always. **That single-winner property is deliberately
traded away here, for every caller, not just ones recovering from a failed send.** This is not a
cron-only concern: `app/api/intake/leads/[token]/route.ts` calls this at per-request cadence, on
a 401 auth-failure path, and two concurrent requests crossing the alert threshold together is a
real case there, not a theoretical one. No numeric bound is stated on how many duplicates this
produces — it depends on how many callers race the same claim, which this design does not
constrain.

Not fixed with a claim lease (a second time-based concept in a state machine this change is
meant to leave alone) nor with `SELECT FOR UPDATE` (which would hold a row lock across a 4s
network call on a pooled transaction connection). A duplicate delivery beats the silent loss it
replaces — that tradeoff is the accepted call.

**The intake route: what actually shipped.** [Corrected 2026-08-24 — the paragraph this replaces
described a `void`-ed fire-and-forget; the shipped code `await`s and, after a follow-up fix, is
also sparsely gated. Both facts change the limitation analysis below.]

`app/api/intake/leads/[token]/route.ts` `await`s `notifyOnTransition` on its 401 auth-failure
path — it is not fire-and-forget, so a serverless freeze immediately after the response is not a
loss vector the way a `void`-ed call would be. Its retry driver is still event-driven rather than
periodic: the next qualifying bad-secret request on the same partner key, not a cron tick. Absent
any further request, a pending row from this route stays pending — same shape as before, just not
for the reason originally written here.

That event-driven retry, on its own, is also the amplification risk this design did not
anticipate: `recordAuthFailure` is uncapped, so a naive `failures >= 5` gate would call
`notifyOnTransition` on every bad-secret request for the rest of the day, and every one of those
SENDS while the row is pending — worst case a burst of Telegram 429s (429 = not delivered =
still pending = the next wave all reclaims) that drowns the shared channel, triggered by exactly
the condition the alert exists to detect (a hammered leaked/rotated secret). A follow-up fix
changed the gate from `failures >= 5` to `failures === 5 || failures % 100 === 0`, so attempts
now scale with failure COUNT rather than request RATE. See
[docs/04-features/partner-lead-intake.md](../../04-features/partner-lead-intake.md).

With that gate in place: another qualifying auth failure arrives ⇒ the alert retries and can
deliver; no further qualifying failure arrives ⇒ the alert is still lost, same as the seven
periodic callers are NOT subject to (they always get another tick). Do not read this change as
"alert loss is fixed everywhere" — it is fixed for every caller that re-evaluates on a schedule,
and improved-but-not-fully-fixed for this one event-driven caller.

Building a dedicated retry driver for event-driven callers — a sweeper that finds
`state='firing' AND last_notified_at IS NULL` rows and re-sends them, independent of whoever
raised them — is the real fix, and is deliberately out of scope for this branch. If pending
rows start accumulating in `alert_state`, that is the signal to build it. **See §10 for a trap
in that sweeper's naive predicate.**

A permanently-pending row is also invisible until someone queries `alert_state` directly; no
surface reports it. Also a known blind spot, also not closed here.

---

## 7. Testability seam

`notifyOnTransition` gains an optional injectable sender:

```ts
export async function notifyOnTransition(
  dbc: DbOrTx,
  { alertKey, orgId, text, send = notifyTelegram }: {
    alertKey: string; orgId?: string | null; text: string;
    send?: (text: string) => Promise<boolean>;
  },
): Promise<void>
```

Defaulted, so every existing call site is unchanged. The guard injects a fake that fails on
the first call and succeeds on the second — proving the retry without touching the network
and without posting to the real Telegram channel.

Without this seam the only way to force a send failure is to mutate `process.env`, which then
either hits the real channel on the retry or cannot distinguish "unset" from "failed".

---

## 8. Verification

`scripts/verify-alert-notify-retry.ts`, following the durability pattern proven in
`scripts/verify-tracking-gap.ts`: fixtures synthesized inside a `db.transaction`, a sentinel
throw to roll back, and a residue check proving nothing persisted.

| # | Case | Expected |
|---|---|---|
| 1 | Fresh transition, send succeeds | 1 send; row `firing`, `last_notified_at` set |
| 2 | Same key, still breaching, next tick | **0 sends** (latched, today's behavior) |
| 3 | Fresh transition, send FAILS | 1 attempt; row `firing`, `last_notified_at` **NULL** |
| 4 | Same key, next tick, send succeeds | **1 send** (the retry — this is the bug being fixed) |
| 5 | Same key, tick after that | **0 sends** (latched once delivered) |
| 6 | Across 3–5, total successful sends | **exactly 1** |
| 7 | `since` after the retry | unchanged from the original transition |
| 8 | Send fails, then `clearAlert`, then breach again | sends again (re-armed, not stuck) |
| 9 | Unset `TELEGRAM_*` via the real sender | counts as not sent; row stays pending |
| 10 | Residue | no synthesized rows survive the rollback |

Case 6 is the one that fails if a retry duplicates. Case 2 is the one that fails if the fix
breaks today's latch. Both must be present.

**Durability:** every case is synthesized, so the suite does not depend on any live alert
existing and cannot expire when real breaches resolve. It must also be proven to go red —
revert the stamp-after-send ordering and confirm case 4 fails.

---

## 9. Files

```
lib/alerts/telegram.ts                        (notifyTelegram returns boolean)
lib/alerts/alert-state.ts                     (claim / send / stamp; injectable sender)
scripts/verify-alert-notify-retry.ts          (new)
docs/03-data-model.md:363                     (alert_state row — last_notified_at now means DELIVERED,
                                               and firing + NULL is the pending-retry state)
docs/07-conventions.md:919-923                (extend the state-transition-gated alerts paragraph:
                                               the latch is claimed on send confirmation, not on detection)
docs/CHANGELOG.md                             (one line)
```

There is no dedicated alerting feature doc; `03-data-model.md` documents the table and
`07-conventions.md` documents the transition-gate construction, so those are the two homes.
The table's *schema* does not change — only the meaning of an existing nullable column — which
is exactly the kind of thing `07-conventions.md` exists to record.

No migration. No schema change. No changes to any of the 8 call sites — the fix is entirely
inside the two `lib/alerts` files.

Pre-merge: diff every touched file against the drip-campaign branch and rebase if anything
overlaps.

---

## 10. Deliberately not built

- No claim lease, no `SELECT FOR UPDATE` (§6).
- No retry backoff or attempt counter — the caller's own cadence is the retry schedule.
- No surfacing of stuck-pending rows (§6). Worth a follow-up if pending rows accumulate.
- No change to `clearAlert`, to the state values, or to the CHECK constraint.

**A trap for the proposed sweeper (§6).** The suggested predicate,
`state='firing' AND last_notified_at IS NULL`, is not safe to page on as-is. Two alert families
key their `alert_key` by ET day and are **never cleared**:
`` `drip:optout:${level}:${campaign_id}:${day}` `` ([lib/drip/optout-monitor.ts](../../../lib/drip/optout-monitor.ts))
and `` `drip:daily_cap_near:${campaignId}:${etDay()}` `` ([lib/drip/scheduler.ts](../../../lib/drip/scheduler.ts)).
If either alert's first send fails and no further breach recurs before the day rolls over, the row
is orphaned: the next day's breach mints a *different* key (new day segment), so nothing ever
retries it, and nothing ever calls `clearAlert` on the old key either — it sits `firing` +
`last_notified_at IS NULL` forever, permanently matching the sweeper's predicate. So "pending rows
accumulating" is polluted by a benign, expected cause (yesterday's opt-out or cap-near breach that
simply aged out), not only by a genuinely stuck alert. A naive sweeper built straight off the
predicate above would re-page about a rate that is no longer even being evaluated. Whoever builds
it needs a `since`-age cutoff (skip rows older than the caller's own re-evaluation window) and
probably an exclusion for day-keyed alert families, not the bare predicate.
