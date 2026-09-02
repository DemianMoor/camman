# Feature — Operator guardrails

_Last updated: 2026-09-02_

ClickUp 869et3vm1 Phase 3. Volume caps, link policy, creative versioning, a
deletion approval queue, and three warnings. No migration — `deletion_requests`
and `audit_log` shipped in 0175.

## 1. Nothing runs on the fire path

Every check is evaluated when a **human asks for something** — Prepare/kickoff,
approve-send, retry-failed — or inside the **send-preflight cron**, which already
runs every five minutes and is off the fire path. Neither `materialize` nor the
drain gained a single condition.

That placement is the design, not a convenience. A cap enforced at fire time has
to decide mid-batch whether to abandon a send in progress; a cap enforced at
request time refuses an **assignment that has not happened yet**, which is
reversible, explainable, and costs the send path nothing.

## 2. BLOCKs

| Guardrail | Where | Refusal |
|---|---|---|
| **Per-stage 10,000 recipients/hour** | Prepare/kickoff, before materialization | 409 `per_stage_hourly_cap` |
| **Aggregate 60,000 sent/hour, org-wide** | approve-send, retry-failed, before the drain call | 409 `aggregate_hourly_cap` |
| **URL allowlist** | creative create, bulk create, update | 400 `raw_url_in_body` |
| **Creative versioning** | creative update | 200 with a **new** creative id |
| **Deletion requests** | creative archive, segment archive/delete | 202 with a queued request |

### The aggregate cap counts what is scheduled, not only what is sent

`pendingScheduledRecipients` is what makes *ten stages of 9,999* fail. Each stage
is scheduled while the others have sent **nothing**, so measured against sent
volume alone every one of them sees a near-zero count and passes. Counting
approved-but-unsent rows is the difference between a cap and a decoration.
`scripts/test-guardrail-caps.ts` runs exactly that scenario and asserts it stops
at stage 7.

The org-wide count is the 418ms `count(*)` measured in recon §7 — cheap enough to
run synchronously on a request someone is waiting on, which is why the cap can
live at request time at all.

### 60,000, not 10,000

The card originally said 10,000/hour. Measurement put live throughput at **41,347
sends in a single hour** and 58K–104K/day, so 10,000 would have stopped the
operation on day one. Dmytro set 60,000 as final on 2026-09-01.

### Creative versioning is what makes the proven gate mean anything

Editing the body of a creative that has sends **forks a new creative** and freezes
the original. Without it the gate is decorative: "proven" is derived from send
history keyed on `creative_id`, so editing in place lets an unsent body inherit
the old body's history and be instantly proven. It also stops history being
silently re-labelled — every stage, link and `stage_send` points at that id, so
rewriting the text makes last Tuesday's report describe words that did not exist
last Tuesday.

### The deletion queue returns 202, not 403

The operator **may** delete these things; it just needs an owner's decision
first. A 403 would say the opposite, and the status code is what lets the UI say
*requested* rather than *forbidden*.

⚠️ **The intercept must run BEFORE the `can()` check.** The operator deliberately
lacks `creatives.archive` / `segments.archive` / `segments.delete`, so a
permission check placed first returns 403 and the request is never created —
which is exactly what the first verification run caught. Correct order is
**auth → parse id → intercept → `can()`**. The intercept only diverts a role
holding `deletion.request`, so nothing is widened for anyone else.

Approval records the decision under the **decider's** id and does **not** execute
the delete. Each entity type has its own cascade rules and its own route; firing
a generic delete from the queue would re-implement all of them somewhere none of
their tests reach.

Only two surfaces need interception, and that follows from the matrix: campaigns
archive and stage delete are granted outright, and the registry is view-only so
an operator cannot archive it at all.

## 3. WARNs — the action proceeds

| Warning | Where | Dedupe |
|---|---|---|
| Unproven creative over 10,000/day | Prepare | once per creative per ET day |
| Day's volume >20% over the trailing 7 **sending**-day average | Prepare | once per org per ET day |
| Contact reached by a second campaign within 3 days | send-preflight cron | once per org per ET day |

Each writes `audit_log` **first**, then posts to Telegram. Telegram is
best-effort and never throws, so writing the durable record first means the worst
case is "it happened and nobody was pinged", not "it happened and nothing knows".

⚠️ **The once-per-day dedupe reads `audit_log`, not memory.** A per-process flag
resets on every serverless cold start, which for a daily alert means once per
instance per day — i.e. many times.

### Proven = sends on ≥2 consecutive days, and the query runs ONCE per Prepare

`loadCreativeSendHistory` is called **once** and returns every creative's send
days; `isProven` is then a pure map read. The joined query costs ~1.0–1.2s, so
calling it per stage would make a twelve-lane campaign spend fifteen seconds
inside a request a human is waiting on.
[`scripts/test-proven-creative-query-count.ts`](../../scripts/test-proven-creative-query-count.ts)
asserts exactly one execution via `pg_stat_statements`.

Consecutive **calendar** days: a Friday/Monday pair is not "two days running",
and a weekend gap resetting the streak delays the cap lifting rather than lifting
it early.

### Sending days, not calendar days

30 Aug 2026 was a Sunday with zero sends. Averaging over calendar days would drag
the mean down ~14% and make Monday trip a spurious breach every week. Today is
excluded too — it is partial, and comparing it against a mean of complete days
would report a breach every morning and none by evening.

⚠️ **Use the joined query.** Grouping `stage_sends` by day *without* the
`campaign_stages` join is **8× slower** (9.5–10.5s vs 1.0–1.2s): the planner
switches to an index-only scan on `stage_sends_org_phone_sent_idx` and pays
~254,000 heap fetches.

## 4. approve-send and retry-failed are open to the operator

Phase 2 denied both because they fire real SMS and no volume limits existed. The
caps are the precondition that was missing. Leaving them denied would mean the
hire cannot send, which is the job.

## 5. Verification

| Script | Proves |
|---|---|
| `test-guardrail-caps.ts` | the 55K + crossing-stage case; exactly-60,000 allowed; one over refused; ten-of-9,999 stopped |
| `test-proven-creative-query-count.ts` | exactly ONE history query per Prepare |
| `test-creative-versioning.ts` | a fork yields a new id, the original is frozen, cleanup verified by re-query |
| `verify-operator-guardrails.ts` | end-to-end as a real operator on preview |

⚠️ **`approve-send` cannot return 200 on preview**, by design: the handler walks
provider capability → credentials → the two send switches, and preview fails the
first three deliberately — they are the documented reasons a preview cannot send.
Reaching 200 would mean seeding credentials into preview, i.e. removing a safety
property to make a test green. The assertion is therefore **not 403**, with the
refusal reason printed. `retry-failed` does return a real 200.
