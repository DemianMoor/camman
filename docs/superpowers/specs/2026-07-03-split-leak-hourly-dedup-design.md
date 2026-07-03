# Split-leak fix + global 1-hour send-dedup

**Date:** 2026-07-03
**Branch:** `fix/split-leak-hourly-dedup` (based on `origin/main` @ `f9ee7ec` — the live windowed-materialization code)
**Status:** approved design, pending implementation

## Background / incident

Campaign `8_62_070326_1` (id 238) was split into 2 stages over a 10,000-contact
audience. Each stage was expected to send ~5,000 (disjoint halves). Instead each
sent 7,500, with **5,000 contacts materialized into BOTH stages** and **4,926
people actually receiving two live SMS**.

### Proven root cause

The stage split partition is `rn % splitTotal = splitIndex - 1`, where
`rn = row_number() over (order by contact_id) - 1` in
[lib/sends/recipients.ts](../../../lib/sends/recipients.ts) (`stageRecipientsSql`).
The resumable-materialization filter `notYetMaterialized` ("exclude contacts that
already have a `stage_sends` row for this stage") is applied in the `base` CTE —
**before** `row_number()` and the split modulo.

Consequently, on a **resume** invocation the row numbers are re-assigned over the
shrunken not-yet-materialized set, so `rn % splitTotal` selects a *different*
subset than the original partition — including contacts belonging to the sibling
stage's half.

Timeline confirmed from `stage_sends.created_at`:
- Initial materialization inserted a **clean 5,000** per stage but never stamped
  `campaign_stages.materialized_at` (interrupted before the post-loop stamp).
- A later scheduled kickoff saw `materialized_at IS NULL`, resumed, re-numbered
  over the leftover 5,000 (the sibling's half), and pulled 2,500 of them into
  each stage → 7,500 each, 5,000 overlap.

Cross-tab proof (pool ordered by contact_id, rn assigned globally):
- Stage 1 = 5,000 on even rn (its rightful half) + 2,500 on odd rn (leaked).
- Stage 2 = 5,000 on odd rn (its rightful half) + 2,500 on even rn (leaked).

**Blast radius:** campaign 238 only — the sole split campaign with non-zero
sibling overlap. All other split campaigns are clean (0 overlap).

## Part A — resume-stable split (hash bucketing)

**Problem:** the split bucket must not depend on the not-yet-materialized set.

**Fix:** replace position-based (`row_number()`) bucketing with a **stable
per-contact hash bucket** in `stageRecipientsSql`:

```
((hashtextextended(contact_id::text, 0) % splitTotal) + splitTotal) % splitTotal = splitIndex - 1
```

- A contact's bucket depends only on its own `contact_id` — never on the
  remaining set — so excluding already-materialized rows can never move a contact
  into a different bucket. **Resume-stable by construction.**
- Drops the full-set window sort — cheaper at the millions-of-contacts target
  scale (the "efficient long-term" choice).
- The export path and the send path both call `stageRecipientsSql`, so they stay
  byte-consistent automatically.

**Accepted tradeoff:** buckets are *approximately* even (hash uniformity), not
exactly 50/50 — typically within ~1% at 10k, tighter at scale. Acceptable for A/B
splits. Exactly-balanced splits are explicitly out of scope.

**Note on existing campaigns:** frozen/sent stages are never recomputed; this only
changes bucket assignment for *future* materializations. Campaign 238 already sent
and is not touched.

## Part B — global 1-hour send-dedup (hard safety net)

**Rule:** a phone number must not receive more than one message within any 1-hour
window, **org-wide across all campaigns/stages**. A send that would violate this
is excluded and surfaced as a warning — the safety net against this bug,
cross-campaign overlap, and any future bug.

**Enforcement point: send-time (the drain)** — the single chokepoint every send
passes through, and the only place the prior message's actual `sent_at` is known.
(Materialization-time enforcement was rejected: time-imprecise and racy.)

**Mechanism** in [lib/sends/drain.ts](../../../lib/sends/drain.ts), after a batch
is claimed (`status='sending'`), before the TextHub sends:
1. Query org-wide: which of the claimed **phone numbers** already have a
   `status='sent'` row with `sent_at >= now() - SEND_DEDUP_WINDOW`.
2. Also track phones already sent earlier *in this same drain run* (in-memory set)
   to catch same-run collisions.
3. Partition the batch: violators → `UPDATE ... SET status = 'skipped_duplicate'`
   (a new **terminal** status: not sent, not opted-out, not auto-retried); the
   rest send normally.
4. Return a `skippedDuplicate` count alongside `sent`/`failed`/`filtered`.

**Dedup key:** phone number (literal "1 number"), org-scoped.

**Window constant:** `SEND_DEDUP_WINDOW_MS = 3_600_000` in a single small config
file (`lib/sends/dedup-window.ts`) — one place to change later.

**New status `skipped_duplicate`:**
- Migration `0090` adds it to the `stage_sends.status` CHECK constraint.
- Every reader of `stage_sends.status` must treat it correctly (NOT sent, NOT
  cost-bearing, NOT failed): `lib/sends/reconcile.ts`, stage-results, dashboard
  counters, `lib/stages/total-cost.ts`. Audited as part of "done".

**Notification:**
- Telegram alert per stage via the existing alert helper: `N numbers skipped —
  already messaged within 1h`.
- Skipped count shown on the stage's results in the UI with a warning treatment.

**Behavior implication of "global":** an intentional rapid drip (stage 1 at 11:00,
stage 2 at 11:30 to the same people) will skip the overlap in stage 2. This is the
strict rule as requested.

## Out of scope
- Automatic re-send/retry of skipped numbers (terminal skip; operator can re-send).
- Un-sending / remediating campaign 238's already-sent double-texts.
- Exactly-balanced split assignment.
- Materialization-time or preview-time dedup (send-time gate is authoritative).

## Verification
- **Part A:** failing test reproducing the resume-leak (materialize half → resume
  → assert zero sibling overlap); assert a contact's hash bucket is identical
  before and after resume.
- **Part B:** test that a second send to a phone within the window is marked
  `skipped_duplicate` and never sent; outside the window it sends; skip count is
  returned and surfaced.
- `tsc` clean; existing send/drain tests green.

## Docs to update (mandatory checklist)
- `docs/03-data-model.md` — `stage_sends.status` new value (+ ERD if applicable).
- `docs/04-features/sms-send-pipeline.md` — split bucketing change + 1-hour dedup gate.
- `docs/07-conventions.md` — hash-split rule + 1-hour dedup rule + window constant.
- `docs/CHANGELOG.md` — one-line entry.
