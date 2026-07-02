# Feature — Content Deduplication & Offer Exposure

_Last updated: 2026-07-02_

> **Status: LIVE (Phase 1 + Phase 2 shipped).** Phase 1 (migration `0086`):
> ledgers, triggers, RLS, backfill. Phase 2 (migration `0087`): the send-time
> eligibility anti-join wired into the shared recipient query (send **and** CSV
> export), the per-campaign `exclude_prior_offer_contacts` toggle, the offer-page
> counter, and the async campaign-build preview. The ledgers now both *record*
> and *suppress*.

## 1. Purpose
Prevent a lead from receiving content they've already seen, without breaking
intended sequencing or deliberate re-approaches. Three layers, kept strictly
separate:

1. **Hard rule (always on, cross-campaign):** the same `creatives.id` can never
   reach the same `contacts.id` in a **different** campaign. In-campaign reuse
   across stages is allowed.
2. **Offer exposure counter (informational, never blocks):** the offer page
   shows "N distinct leads already used for this offer."
3. **Include/exclude filter (manual, per-campaign, at creation):** the operator
   chooses whether to exclude or include leads already touched by this offer in
   **previous** campaigns. Even when "include" is chosen, layer 1 still applies.

Send-time eligibility (Phase 2):
```
stage recipients (frozen pool, narrowed by stage filters)
  − saw_this_creative_in_a_DIFFERENT_campaign        (layer 1, always)
  − in-flight send of this creative in another campaign (layer 1, concurrency guard)
  − got_this_offer_in_a_previous_campaign             (layer 3, only if "exclude" chosen)
  − opted_out                                          (existing org-wide suppression)
```

## 2. "Used" is defined as a sent message
A lead counts as **used** for a creative/offer when a `stage_sends` row reached
`status='sent'` — the only per-recipient success marker. Tracked-mode and
manual-mode pipeline sends both qualify. **Blind spot (accepted):** pure
external-CSV campaigns create no `stage_sends` rows, so they leave no exposure
trace and are silently absent from the ledgers and the counter. Nothing more is
reconstructable.

## 3. Schema (migration `0086`)
Three tables in [`db/schema.ts`](../../db/schema.ts), detailed in
[`docs/03-data-model.md`](../03-data-model.md):

- **`creative_exposures`** — the hard-rule ledger. `UNIQUE (org_id, contact_id,
  creative_id)`; `campaign_id` = the first campaign that sent it. Index
  `(org_id, creative_id, contact_id)` drives the suppression anti-join.
  **`campaign_id` is nullable + `ON DELETE SET NULL`** (not cascade): it is
  load-bearing for the in-campaign-reuse exception, not metadata, so the exposure
  row must survive a hard-deleted campaign (cascade would re-expose those
  contacts). **Phase 2 layer-1 clause MUST be `(campaign_id IS NULL OR campaign_id
  <> currentCampaignId)`** so an orphaned row suppresses unconditionally — a
  deleted campaign can never be the "current" one reusing the creative. Same
  nullable/SET NULL treatment on `offer_exposures.campaign_id`.
- **`offer_exposures`** — one row per `(org_id, contact_id, offer_id)`; first
  campaign. Index `(org_id, offer_id, contact_id)` drives the "exclude" branch.
- **`offer_exposure_counts`** — `PK (org_id, offer_id)`, `distinct_contacts`.
  O(1) read for the offer page; maintained by trigger.

**Dedup is org-scoped and intentionally spans brands.** Contacts are unique on
`(org_id, phone_number)` (one row per person per org, no `brand_id`) and
creatives are brand-agnostic, so `(contact_id, creative_id)` can never span two
brands accidentally — and a lead who saw a creative under one brand is correctly
suppressed under another. **No `brand_id` on any of these tables, by design.**

**Hard rule keys on `creatives.id`, never text/slug/hash.** Creative edits are
in-place (same id); a deliberately-new creative comes from the `/duplicate`
endpoint (new id) — that is the intended path for re-sending changed content.

## 4. Write-time maintenance (triggers, robust across paths)
Both ledgers are populated by triggers on `stage_sends`, not by application code,
because `status='sent'` is set from multiple paths (send drain + result poller) —
a trigger guarantees no path bypasses the ledger.

- **`record_exposure_on_sent()`** — fired by `AFTER INSERT WHEN status='sent'`
  and `AFTER UPDATE OF status WHEN status='sent' AND OLD.status IS DISTINCT FROM
  'sent'`. Resolves `creative_id` (via the stage) and `offer_id` (via the
  campaign), then inserts into both ledgers `ON CONFLICT DO NOTHING` (first sender
  keeps the `campaign_id`). A row whose creative was deleted (`creative_id` SET
  NULL) is skipped for `creative_exposures` but still recorded against the offer.
- **`bump_offer_exposure_count()`** — `AFTER INSERT` on `offer_exposures`,
  upserts `offer_exposure_counts.distinct_contacts += 1`. Because the
  `offer_exposures` insert is `ON CONFLICT DO NOTHING`, each fire is a genuinely
  new `(contact, offer)` ⇒ distinct by construction. Mirrors the
  `segment_stats.total_count` junction-trigger precedent.

## 5. Backfill
[`scripts/backfill-content-dedup-exposures.ts`](../../scripts/backfill-content-dedup-exposures.ts)
— idempotent, re-runnable. For every `status='sent'` row it inserts into both
ledgers `ON CONFLICT DO NOTHING`, using `DISTINCT ON (… ORDER BY first_sent_at
ASC)` so the **earliest** send owns the `campaign_id`. The counter trigger fills
`offer_exposure_counts` as rows insert. Run once after migration `0086` applies,
against the same `DATABASE_URL` the app uses.

## 6. Phase 2 — send-time eligibility, toggle, counter, preview (migration 0087)

### 6a. The single shared eligibility builder
[`lib/sends/eligibility.ts`](../../lib/sends/eligibility.ts) is the ONE definition
of "who to suppress for this stage", consumed by the send/export recipient query,
the reconciliation accounting, and the preview — they can never diverge.
`buildStageEligibilityExclusions({ orgId, currentCampaignId, currentCreativeId,
currentOfferId, excludePriorOffer })` returns three labeled `SELECT contact_id`
fragments (`creative`, `inFlight`, `offer`; null when not applicable).
`applyEligibilityExcept(base, ex)` composes them onto a base audience via `EXCEPT`
set-arithmetic (the `lib/segment-rules-eval.ts` form, never `IN (…) OR`).
`eligibilityUnion(ex)` gives the DISTINCT union for membership tests (reconcile).

The three layers:
- **LAYER 1** (always, when `currentCreativeId` set): saw this creative in a
  **different** campaign — `creative_exposures WHERE creative_id = :c AND
  (campaign_id IS NULL OR campaign_id <> :currentCampaignId)`. The
  `campaign_id <> current` clause is the **in-campaign-reuse exception** (a
  campaign may reuse its own creative across stages); a NULL `campaign_id`
  (campaign hard-deleted) suppresses unconditionally. **Never flatten it.**
- **LAYER 2** (always, when creative set): in-flight send of this creative in
  another campaign (`stage_sends … status IN ('pending','sending')`) — covers the
  window between materialization and `status='sent'` (the ledger fills only at
  `'sent'`).
- **LAYER 3** (only when `campaigns.exclude_prior_offer_contacts`): got this offer
  in a **different** campaign — `offer_exposures WHERE offer_id = :o AND
  (campaign_id IS NULL OR campaign_id <> :currentCampaignId)`. The
  `campaign_id <> current` clause is the **same in-campaign-reuse exception** as
  LAYER 1: a multi-stage campaign may re-send its own offer across stages (a drip),
  so a stage must not suppress contacts an EARLIER stage of the SAME campaign
  already reached. Without it a single-offer drip self-cannibalizes — stage 1
  reaches everyone, then stage 2+ see the whole audience as "already got this
  offer" and reach ~nobody. (Fixed 2026-07-02; the clause was previously missing.)
- **Edge A — null creative:** layers 1+2 are omitted entirely (the fragments are
  null); layer 3 may still apply (offer comes from the campaign).
- Opt-out suppression is **not** re-added — it already lives in the base audience.

### 6b. Where it plugs in
- **Send + export:** [`lib/sends/recipients.ts`](../../lib/sends/recipients.ts)
  `stageRecipientsSql` takes an optional `eligibility` overlay; `base` (frozen pool
  ∩ opt-outs ∩ stage filters ∩ lane) → `eligible` (`EXCEPT` the layers) → split.
  Threaded from `kickoff.ts` (send materialization), the `export-phones` route
  (CSV — a manual send is deduped too), and `preflight.ts` (so the previewed
  recipient count equals what materializes). Omitting `eligibility` = today's
  behavior (legacy callers / tests).
- **Reconciliation:** [`lib/sends/reconcile.ts`](../../lib/sends/reconcile.ts)
  gained an `excluded_dedup` bucket — `pool = attempted + excluded(opt_out |
  filter | split | dedup) + gap`. Without it, every deduped campaign would show a
  false materialization-gap alarm.
- **Stages-list `audience_count`** is intentionally LEFT as the pre-dedup
  *addressable* pool size (the perf-tuned batched query is untouched). The
  post-dedup *will-send* number lives in the Prepare popup (preflight) and the §5
  preview.

### 6c. Per-campaign toggle
`campaigns.exclude_prior_offer_contacts` (boolean, default **false** = opt-in).
Wired through the validators, POST/PATCH (added to the audience-lock set — set in
draft, locked after activation like the sibling audience knobs; the value is read
live at send time), and both campaign forms as the toggle *"Exclude leads who
already got this offer"*. The always-on hard creative rule applies regardless.

### 6d. Offer-page counter
The offers list + `GET /api/offers/[id]` LEFT JOIN `offer_exposure_counts` and
return `distinct_contacts_used`; the offers table shows a **"Leads used"** column.
Single-row read, never `COUNT(DISTINCT …)`.

### 6e. Build-time preview
`computeStageEligibilityPreview` ([`lib/audience-snapshot.ts`](../../lib/audience-snapshot.ts))
returns `{ segment_total, saw_creative, got_offer, will_send, truncated }` in ONE
query: the qualifying set resolves once, the indexed ledgers are cheap LEFT JOINs,
and `will_send` subtracts the **same** layers then splits (so it equals the real
materialized count — split applied post-dedup, matching `stageRecipientsSql`).
Wrapped in the segment-preview timeout mechanism (`SET LOCAL statement_timeout`
inside a txn; `57014` ⇒ `truncated`, pooler-safe). Surfaced in the stage form's
audience preview (debounced, recomputed only when segment/creative/offer/toggle
change), showing *"N already saw this creative · M already got this offer · K will
send"*.

### 6f. Out of scope (flagged future)
Recording manual CSV exports back into the ledger ("log these as sent") — the
known manual-CSV blind spot remains.

## 7. Related
- [`docs/04-features/audience-snapshot.md`](audience-snapshot.md) — frozen pool the stages send from.
- [`docs/04-features/sms-send-pipeline.md`](sms-send-pipeline.md) — where `stage_sends` rows are materialized + marked sent.
- [`docs/04-features/audience-segments.md`](audience-segments.md) — segment resolution.
