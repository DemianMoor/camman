# Contact Lifecycle PR 5 — the Lifecycle report tab + 60-day reconstruction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Reports → Lifecycle tab showing per-cohort performance by send date, plus a one-off backfill that reconstructs the cohort for the ~3.78M sends that predate live stamping.

**Architecture:** One report route + page, following the existing Reports tabs. One resumable backfill script, batched by ET day, replaying as-of facts through the existing evaluator.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle raw `sql`, postgres-js, Supabase.

---

## Measured before planning (production, 2026-09-27 08:40 UTC, read-only)

The whole plan hangs off these, so they are at the top rather than buried in a task.

**One median ET day — 2026-09-17, 71,241 sends — took 102.9 s:**

| step | time | share |
|---|---:|---:|
| target rows | 17.1 s | 17% |
| **clicks as-of** | **37.7 s** | **37%** |
| facts as-of | 20.8 s | 20% |
| thresholds | 8.8 s | 9% |
| eval input | 0.3 s | — |
| **evaluate** (the evaluator itself) | **1.0 s** | 1% |

⭐ **The evaluator is 1% of the cost. The replay is everything else**, and the single heaviest step is the human-click lookup over `clicks`+`links`, not the send counting. Any optimisation effort belongs there, and nowhere near `evaluationSelectSql`.

**Extrapolation: ~93 min of pure compute for all 53 ET days.** One off-peak window is enough, with room. Peak days (106,174 sends vs the median's 71,241) will run ~1.5×, so ~155 s each.

**Result quality on that day:** freeze 31,422 · cold 26,755 · hot 9,459 · warm 3,605 = 71,241. **0 unclassified**, **0 evaluated as suppressed**.

## Decisions already made — carry them, do not re-open

1. **DAY-BOUNDARY reconstruction**: one status per contact per ET day, evaluated as of the day's end. Stated in the plan AND on the page. Per-send evaluation would be ~71K evaluations per day instead of one.
2. **Sales/CR/Revenue: LEDGER PRIMARY.** `stage_sends.sale_*` is a fallback **only** for rows with no ledger event (4 rows in 60 days). Revenue where both exist = the **ledger's approved-only sum**. Label the column **"attributed only"** on the page.
3. **Rows**: New, Cold, Hot, Warm, Freeze, Suppressed, then **Clickers** (hot+warm), **Non-clickers** (the rest), Total, plus **Unclassified** for sends older than the backfill.
4. **Cohort from the STAMP**, never from today's `contact_engagement.status`.
4b. **CTR uses RAW `HUMAN_CLICK` over `clicks`+`links`** (owner, 2026-09-27) — the same source the engagement job evaluates against, not `counted_clickers`.

   ⚠️ **The two disagree, and the plan must not hide it.** Measured on stage 4791 at 19 h: raw `HUMAN_CLICK` gives **125** clickers, `counted_clickers` gives **112**. The scored table lags, so a fresh period reads low through it.

   Using the job's source means **a cohort's CTR and the status that defines the cohort are computed from the same clicks** — otherwise a contact can be "hot" by one definition while their click is missing from the other, in the same row of the same table.

   **A footer note states that Overview uses `counted_clickers`,** so the two tabs showing different CTRs for the same period is documented rather than discovered. This joins the existing footnote about per-recipient numbers not reconciling with Overview's Keitaro aggregates — the Lifecycle tab now differs from Overview on two axes, and both are named.
5. The backfill is a large data write: **dry-run default, `--apply` asks first**, off-peak, **resumable by ET day**.

---

## Global Constraints

- ⛔ **Nothing merges without the owner's word**, and the backfill's `--apply` is a separate ask on top of that.
- No migration: `stage_send_lifecycle` (with its `reconstructed` flag) already exists and is live — **120,660 rows stamped** since 2026-09-24.
- Read-only work runs off the busy cron minutes; heavy reads get their window named.
- Docs are part of done.

---

### Task 1: The backfill script

**Files:** Create `scripts/backfill-lifecycle-reconstruction.ts`

- [ ] **Step 1: Start from `scripts/measure-lifecycle-reconstruction.ts`** — it already does the replay correctly and is the measured artifact above. Read its header first.
- [ ] **Step 2: Dry-run default.** `--apply` writes; without it the script reports per day and writes nothing.
- [ ] **Step 3: Resumable by ET day.** A day is DONE when every `sent` row in it has a `stage_send_lifecycle` row. Skip those. ⚠️ Resume must be derived from the data, not from a cursor file — a cursor lies after a partial failure.
- [ ] **Step 4: Write `reconstructed = true`.** This is what lets the page mark a period.
- [ ] **Step 5: ⚠️ NEVER write `suppressed`** (spec §10). Suppression could not have happened before launch, so a reconstruction that emits it is inventing history. The measured day produced 0, which proves nothing about the other 52 — enforce it in code and count how many were coerced.
- [ ] **Step 6: One transaction per ET day**, so a failure loses one day rather than the run.
- [ ] **Step 7: Bar** — `scripts/test-lifecycle-reconstruction.ts` on preview: a fixture contact whose facts as of day N differ from today's status is reconstructed to the day-N value, not the current one. That is the whole feature in one assertion.
- [ ] **Step 8: Commit.**

### Task 2: The report query

**Files:** Create `lib/reporting/lifecycle-report.ts`

- [ ] **Step 1:** Per cohort, by send date in ET: sends, CTR, CR, sales, revenue, opt-out rate, cost.
- [ ] **Step 2: Sources** — sends from `stage_sends`; cohort from `stage_send_lifecycle.status`; **clicks from raw `clicks`+`links` under `HUMAN_CLICK`** (decision 4b), joined to the send's contact; opt-outs from `opt_out_attributions.stage_send_id`; sales/revenue ledger-primary per decision 2.

  ⚠️ `HUMAN_CLICK` is imported from `lib/reporting/counted-clickers.ts`, never retyped — it is the one definition of a human click, and re-spelling it would let the report and the job disagree about the same click.
- [ ] **Step 3: ⚠️ `Unclassified` must be a real row**, counting sends with no `stage_send_lifecycle` row. Omitting it makes the cohorts silently fail to sum to Total, and a reader will assume the tool is broken rather than that history is missing.
- [ ] **Step 4:** Reuse `getStageMetricsInRange`'s conventions where they apply, so this tab does not invent a second definition of cost or CTR.
- [ ] **Step 5: Bar** on preview: cohorts sum to Total; a send with no stamp lands in Unclassified.
- [ ] **Step 6: Commit.**

### Task 3: The route and page

**Files:** `app/api/reports/lifecycle/route.ts`, `app/(protected)/reports/lifecycle/page.tsx`, route-map entry

- [ ] **Step 1:** Period controls identical to Overview — From/To in ET, default last 7 ET days, max 92.
- [ ] **Step 2:** Route-map entry like the other report routes.
- [ ] **Step 3: The two labels that stop numbers being misread:**
  - the Sales/CR/Revenue columns marked **"attributed only"** — ~1,038 attributed sales across 3.88M sends will otherwise read as catastrophic performance rather than as an attribution gap;
  - a note on any period containing `reconstructed` rows, and a line stating **one status per contact per ET day**;
  - **a footer note that CTR here uses raw human clicks, while Overview uses `counted_clickers`** — the numbers differ for the same period (125 vs 112 on stage 4791 at 19 h) and an unexplained discrepancy between two tabs is worse than either number.
- [ ] **Step 4:** The existing footnote that per-recipient numbers do not reconcile with Overview's Keitaro aggregates.
- [ ] **Step 5: Commit.**

### Task 4: Docs, checks, PR

- [ ] **Step 1:** `docs/04-features/contact-lifecycle.md` (the report + what reconstruction can and cannot know), `docs/05-flows.md`, `docs/07-conventions.md`, `CHANGELOG.md`, last-updated dates.
- [ ] **Step 2:** Full check, 4a gate re-captured from `origin/main`, lint by message set, rebase.
- [ ] **Step 3: Open the PR and STOP.**

### Task 5: The backfill run — SEPARATE ASK

- [ ] **Step 1: Dry run over all 53 days**, report per day and in total.
- [ ] **Step 2: ⛔ Ask before `--apply`.** ~93 min of compute plus 3.78M inserts. Off-peak, and the owner picks the window.
- [ ] **Step 3:** After applying, re-check: rows stamped, `reconstructed` count, days skipped, suppressed coerced.

---

## Open questions — all three ANSWERED (owner, 2026-09-27)

1. **Cost per send: the Overview formula VERBATIM at cohort grain** — `coalesce(cost_per_sms, stage rate) × (1 + opted out)`. A cohort with more opt-outs costing more per send **is the point**, not a confusion. Add one footer line: **cost includes opt-out cost**.
2. **`Suppressed` shows, with a dash**, and the note **"excluded by construction"**. Not omitted (a missing row reads as an oversight) and not a zero (a zero reads as a measurement).
3. **Threshold drift: accept and document.** The backfill runs ONCE and is **not re-run after a threshold change**. The page's reconstruction note states the thresholds in force on the day it ran. **No new column** — reconstructed rows do not record their own thresholds.

   ⚠️ This makes the reconstruction a **one-shot artifact**, so the note is not decoration: without it, a reader comparing reconstructed history against post-change live stamps has no way to know the two were produced under different rules.
