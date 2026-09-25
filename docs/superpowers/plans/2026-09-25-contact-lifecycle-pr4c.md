# Contact Lifecycle PR 4c — send-time re-check, send-panel reasons, and the switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch the contacts who stopped being eligible between Prepare and dispatch, show why they were dropped, and then — and only then — let a campaign actually be a lifecycle campaign.

**Architecture:** One extra query per claimed drain batch, sitting beside the opt-out and 1-hour-dedup gates that already exist there and following their exact shape. Drops get `skipped_ineligible` with a machine-readable reason in `last_error`. The send panel reads those reasons back. The `lifecycle_rules = true` switch is the last task, behind its own gate.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle raw `sql`, postgres-js, Supabase.

---

## Global Constraints

- **No migration.** `skipped_ineligible` shipped in 0190 (PR 4a) and is already in the CHECK constraint, the activity filter and the send-panel counts. If this plan appears to need a schema change, stop and raise it.
- **Every new code path stays behind `campaigns.lifecycle_rules`,** which is `false` on all ~670 production campaigns until Task 6. Tasks 1–5 are inert in production by construction.
- **The 4a byte-identical SQL gate must stay green.** Re-capture the baseline from `origin/main` first (it was captured before #224 merged, so it is now stale). Bar: 0 differences on the intersection.
- **The drain is the live send path.** `SEND_ENABLED` is ON in production and real messages go out. No change may add a failure mode that blocks a send; every new check fails **open** (see Task 1 Step 5).
- **Test safety:** `_env-preload` first, then `_require-preview-db`. Preview DB only. Fictional phones. Teardown by captured PK, with a post-teardown count.
- Docs are part of done: `docs/04-features/contact-lifecycle.md`, `docs/05-flows.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md`, and every `_Last updated:_` touched.
- Reporting follows CLAUDE.md §11a: only what the task asked for; anything else in one line under "Blocking / affects this task".

---

## What is NOT in this PR

- **869f53efz's two layers** (`offer_limit`, `offer_cooldown`) — PR 4d.
- **The lifecycle report tab + 60-day reconstruction** — PR 5.
- **Excluding `bought_offer` at activation when an `audience_cap` is set** — owner follow-up raised 2026-09-25, deliberately deferred. The capped case is a different argument from the uncapped one (a cap makes a slot scarce, so a buyer occupying one is a wasted send rather than a skipped one), and it changes what activation freezes. It gets its own card after 4d.

---

### Task 1: The send-time re-check in the drain

**Files:**
- Create: `lib/sends/lifecycle-recheck.ts`
- Modify: `lib/sends/drain.ts` (after the 1-hour dedup gate, ~`:640`)
- Test: `scripts/test-lifecycle-send-recheck.ts`

**Interfaces:**
- Produces: `recheckLifecycleEligibility(dbc, { orgId, campaignId, offerId, rows })` → `Map<stageSendId, LifecycleSkipReason>`, empty when the campaign is legacy.
- Produces: `LIFECYCLE_SKIP_REASONS` — the `last_error` strings, derived from `LIFECYCLE_EXCLUSION_KEYS` (PR 4b) so the drain and the panel cannot disagree.
- Consumes: `LIFECYCLE_EXCLUSION_KEYS`, `EXCLUSION_PRIORITY` from `lib/sends/eligibility.ts`.

**Why a separate module and not more inline drain code:** `drain.ts` is 909 lines and is the single most dangerous file in the repo to get wrong. The decision is pure given its inputs, so it is testable on its own; the drain keeps only the call and the UPDATE.

- [ ] **Step 1: Write the failing test** — `scripts/test-lifecycle-send-recheck.ts`, PART J.

Fixtures (preview DB, one org): a `pending` `stage_sends` row per case, on a lifecycle campaign with an offer.

```ts
// J1  a contact who became 'suppressed' AFTER materialization is skipped
// J2  a freeze contact messaged INSIDE their own cadence since Prepare is skipped
// J3  a freeze contact messaged OUTSIDE it is NOT skipped
// J4  ⭐ the cadence is per contact: same last_sent_at, freeze_cadence_days 14 vs 45
// J5  a contact who bought the offer AFTER materialization is skipped
// J6  an eligible contact is untouched (the control — without it every bar
//     passes on a function that skips everyone)
// J7  ⭐ a LEGACY campaign runs NO query at all and returns an empty map
// J8  reasons are attributed in EXCLUSION_PRIORITY order: a contact who is
//     BOTH suppressed and freeze-not-due reports 'suppressed'
// J9  the returned reason strings are exactly LIFECYCLE_SKIP_REASONS
//     (derived, not retyped — cf. PR 4b's drift bar)
```

- [ ] **Step 2: Run it, confirm it fails** with "recheckLifecycleEligibility is not a function".

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
  npx tsx --conditions=react-server scripts/test-lifecycle-send-recheck.ts
```

- [ ] **Step 3: Implement `lib/sends/lifecycle-recheck.ts`.**

One query over the claimed contact ids, one `LEFT JOIN` per layer, attributing each row to the first layer that catches it — the same exclusive-FILTER shape `computeStageReconciliation` uses (PR 4b).

⚠️ **Do not reuse `buildStageEligibilityExclusions`' layer SQL verbatim here.** Two of the three layers mean something different at send time than at Prepare, and copying the Prepare SQL would silently answer the wrong question:

| layer | at Prepare | at send time |
|---|---|---|
| `suppressed` | `contacts.lifecycle_status` (the 0188 projection) | same — the job maintains it in the same transaction as the transition row |
| `bought_offer` | `purchasedOfferContacts()` | same |
| `freeze_not_due` | `contact_engagement.last_sent_at > now() - cadence` | **`stage_sends`**: a live `sent` row to that PHONE within the cadence |

The `freeze_not_due` difference is the whole point of the re-check (spec §8.4): `contact_engagement.last_sent_at` is up to 15 minutes stale and is only written by the cron, so it cannot see a message another campaign sent to the same freeze contact **ten minutes ago**. The send-time form reads `stage_sends` directly and uses the same `(org_id, phone, sent_at)` index the 1-hour dedup already uses.

- [ ] **Step 4: Wire it into `drain.ts`,** immediately after the `skipped_duplicate` block and before the request shape is built. Structurally mirror the two gates above it: partition `toSend`, bulk-UPDATE the losers to `status = 'skipped_ineligible'` with `last_error = <reason>`, `continue` if the whole batch is gone, and count them into the run summary.

- [ ] **Step 5: Make it fail OPEN, and prove it.**

```ts
// The drain sends real messages. A re-check that throws must not strand a
// stage: the cost of skipping the check is that a handful of contacts get a
// message they would have been spared, and the cost of throwing is that a
// whole stage stops dispatching mid-drain with rows stuck in 'sending'.
// The first is recoverable; the second pages someone at night.
try { skips = await recheckLifecycleEligibility(...) }
catch (e) { logSendEvent("lifecycle_recheck_failed", ...); skips = new Map() }
```

Bar **J10**: with a deliberately broken query injected, the batch still dispatches and the failure is recorded. Assert on the logged event, not on the absence of a throw.

- [ ] **Step 6: Re-run PART J** — expect 10/10, teardown 0 rows left.
- [ ] **Step 7: Commit.**

---

### Task 2: Send-panel and activity reasons

**Files:**
- Modify: `app/api/campaigns/[campaignId]/stages/[stageId]/send/route.ts` (`:72-153`)
- Modify: `components/campaigns/stage-send-panel.tsx` (`counts`, `:41-45`)
- Test: extend `scripts/test-exclusion-bucket-drift.ts`

The route already counts `skipped_ineligible` as one number and the panel already carries it. This splits it **by reason**.

- [ ] **Step 1: Break the count out by `last_error`** in the route, keyed by `LIFECYCLE_EXCLUSION_KEYS`, returning `skipped_ineligible_by_reason: LifecycleExclusionCounts` beside the existing total.
- [ ] **Step 2: Render it** — "Skipped at send: 340 freeze cadence · 95 bought this offer · 12 suppressed", zero-count reasons omitted, reasons in `EXCLUSION_PRIORITY` order. Reuse the `EXCLUSION_LABELS` map added to the Prepare dialog in 4b rather than writing a second one.
- [ ] **Step 3: Extend the anti-drift bar** so this becomes the **fifth** shape it checks, and confirm its source-scan half still passes (it is the check that caught a hand-written copy in 4b).
- [ ] **Step 4:** Assert `skipped_ineligible_by_reason` sums to `skipped_ineligible`. A reason bucket that does not foot means a `last_error` string the panel cannot name — which would render as a silent zero, the exact failure 4b's convention exists to prevent.
- [ ] **Step 5: Commit.**

---

### Task 3: The dry run — ≥3 real claimed batches per reason

**Files:** Create `scripts/dryrun-lifecycle-recheck.ts`

**This runs against production and writes NOTHING.** It is the evidence that Task 1 is safe to switch on, and it is the task the owner's gate hangs off.

- [ ] **Step 1: Reproduce the drain's claim predicate exactly** — `status = 'pending'`, ordered `created_at, id`, batched at the live `limit`. Read-only: `SELECT`, never the `UPDATE … SET status='sending'`.

⚠️ **A dry run that invents its own batching proves nothing about the real one.** Read the claim predicate out of `drain.ts` and mirror it, in the same order and the same batch size, or the counts describe a population the drain never sees.

- [ ] **Step 2: For each batch, run the re-check and record what it WOULD have skipped, per reason** — never writing `skipped_ineligible`.

- [ ] **Step 3: Require ≥3 real claimed batches per reason before reporting.**

A reason seen in one batch is an anecdote. The bar is **≥3 batches that each contained at least one claimed row, per reason**, and the script states, per reason, how many batches contributed. If a reason never fires across the whole corpus, **say so explicitly and do not report a rate for it** — `suppressed` is expected to be 0 today (nobody in the org has reached it), and a 0 that is reported as a measured rate is worse than one reported as "never observed".

- [ ] **Step 4: THE STOP RULE — ~10% per reason.**

> If any single reason would skip **more than ~10% of claimed rows**, stop and report before switching anything on.

What the threshold is protecting against: the three layers are supposed to remove a trickle at the margin, because Prepare already removed the bulk. A double-digit share at send time means one of two things, and they are not the same problem:

- **the Prepare-time layer and the send-time layer disagree** — the send-time `freeze_not_due` reads `stage_sends` while Prepare reads `contact_engagement`, so a systematic gap between them shows up here first; or
- **the cadence is genuinely being violated across campaigns**, which is a real finding about how campaigns overlap, not a bug in this code.

Either way the answer is to report, not to tune the number. **Do not raise the threshold to make the run pass.**

Given the 4b measurements, the number to watch is `freeze_not_due`: 125,021 contacts org-wide match that layer, against 2,196 inside a single campaign's audience. A broad lifecycle audience could plausibly push this one over 10%.

- [ ] **Step 5: Run it off the busy cron minutes** (avoid :29/:59 pools, :11/:41 fresh counts, :14 creative lifetime, the */5 marks, :10/:25/:40/:55 engagement) and name the window in the report, per the heavy-prod-read convention.

- [ ] **Step 6: Report** — per reason: rows that would skip, % of claimed, batches contributing, and the largest single batch's share. Plus total rows examined and the wall time. Then **stop for the owner's read.**

- [ ] **Step 7: Add to the preview-db guard's `EXCLUSIONS`** with its reason (`viaLibrary: true`).
- [ ] **Step 8: Commit.**

---

### Task 4: Draft conversion

**Files:** Modify `app/api/campaigns/route.ts`, or a one-shot script if any drafts exist.

- [ ] **Step 1: Count the drafts FIRST.** The spec says there were 0 at spec time (2026-09-22). Re-count on production before writing any conversion code — a conversion for 0 rows is code that will never run and cannot be tested.
- [ ] **Step 2:** If the count is still 0, write no conversion; record in the PR body that it was re-verified on the day and the number. If it is not 0, convert them (chips derived by `mapLegacyFiltersToChips`, which 4b already ships) and report per-draft before/after.
- [ ] **Step 3: Commit.**

---

### Task 5: Docs

- [ ] **Step 1:** `contact-lifecycle.md` gains §3i (the send-time re-check: what it reads, why `freeze_not_due` reads a different table than at Prepare, and that it fails open). `05-flows.md`'s drain diagram gains the gate beside the opt-out and dedup ones. `07-conventions.md` gains one entry: **a send-path check must fail open, and the bar must assert on the logged event rather than the absence of a throw.** `CHANGELOG.md` + every `_Last updated:_`.
- [ ] **Step 2: Full check + rebase + PR.** `tsc`, `next build`, `check:guards`, `check:authz`, `check:docs`, the 4a gate (re-captured), and every lifecycle suite. Compare the lint **message set** against `origin/main`, not the count. Rebase and report conflicts rather than resolving them silently.
- [ ] **Step 3: Open the PR and STOP.** Do not merge.

---

### Task 6: The switch — `lifecycle_rules = true` — GATED

**Files:** `app/api/campaigns/route.ts` (the `.values({…})` literal, `:271`), `lib/validators/campaigns.ts`.

⚠️ **This is the task that changes who receives a message.** Everything before it is inert.

- [ ] **Step 1: Do not start this task until the owner has read the Task 3 dry run and said go.** It is listed here so the plan is complete, not so it runs in sequence.
- [ ] **Step 2:** New campaigns are created with `lifecycle_rules = true`. ⚠️ The create route's `.values({…})` carries an explicit warning that an unnamed field silently takes its default — name this one.
- [ ] **Step 3: Existing campaigns are NOT converted.** Their audiences are frozen and their chips were never chosen; flipping them would re-interpret a stored `audience_filters` that was written under different semantics.
- [ ] **Step 4: Decide with the owner whether the switch is also gated on `lifecycle_settings.engine_mode = 'write'`.** The status facts come from the job; if the engine is off they are stale, and a campaign selecting on a frozen status would quietly target a snapshot of the world from whenever the engine stopped. My recommendation: gate it, and fall back to legacy chips when the engine is off.
- [ ] **Step 5: Commit, and stop before merge.**

---

## Watching the first live send

After 4c merges and the first campaign is created with `lifecycle_rules = true`, the first stage that drains is the only moment the whole chain is exercised together on real traffic. I will watch it live rather than reading it back the next morning.

**Before it fires**
- Confirm the stage is a lifecycle campaign and record the Prepare-time numbers: `materialized_audience`, `predicted_sends`, and the per-reason exclusion counts from the preflight breakdown. These are the predictions the live run is checked against.
- Record the audience's status distribution and `freeze_not_due` from the preview.
- Confirm `SEND_ENABLED`, the provider's `sends_enabled`, and that no circuit breaker is latched — so a stall during the watch is attributable.

**While it drains** — I will report, per polling interval:
1. `sent` / `pending` / `sending` and the throughput, against `estimated_drain_seconds`.
2. **`skipped_ineligible`, split by reason** — the number this whole PR exists to produce.
3. Whether any reason's share crosses the ~10% stop rule, and if so I stop the drain and report before it continues.
4. `skipped_opted_out` and `skipped_duplicate`, so a change in those is not mistaken for the new gate's doing.
5. Any `lifecycle_recheck_failed` event — the fail-open path firing means the numbers for that batch are missing, not zero, and I will say which batches are affected rather than reporting a total that quietly under-counts.
6. Rows stuck in `sending` for more than one poll — the at-most-once claim means those never retry, so it is the failure worth catching early.

**After it completes**
- **Prepare-time prediction vs live outcome**, side by side: `predicted_sends` vs `sent`, and each per-reason count vs what actually fired. A gap between them is the honest measure of whether the Prepare-time layers and the send-time re-check agree, and it is the number I would most want to see.
- `computeStageReconciliation`'s gap. **Non-zero is a bug** and gets reported as one.
- The per-reason `last_error` totals from `stage_sends` directly, as a cross-check that the panel is reading what the drain wrote.

**Stop conditions** (I stop and report rather than pressing on): any reason over ~10%, a non-zero reconciliation gap, a `lifecycle_recheck_failed`, rows stranded in `sending`, or a latched circuit breaker.

---

## Merge gate

**Ask before merge** — this PR changes who receives a message. Bring to that conversation: the Task 3 dry-run table (per reason, with batch counts and the "never observed" reasons named), the 4a gate's re-captured result, and the draft count from Task 4.
