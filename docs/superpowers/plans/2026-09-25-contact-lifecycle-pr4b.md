# Contact lifecycle — PR 4b (lifecycle chips, Prepare-time layers, exclusion reasons) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator choose an audience by lifecycle status, and start excluding contacts who are suppressed, inside their freeze cadence, or have already bought the offer — at Prepare, with the reason shown wherever a lead is dropped.

**Architecture:** Everything hangs off the two seams PR 4a built. The chips fill in `lifecycleChipPredicate()`'s `lifecycleRules` branch — one edit, not five. The three new exclusions become three entries in the `EXCLUSION_PRIORITY` layer list, which every consumer already iterates. Nothing new is invented; 4a's whole purpose was to make 4b additive.

**Tech Stack:** Zod `audienceFiltersSchema` · the campaign form's Audience block · Drizzle `sql` templates · the existing preflight/preview surfaces · tsx tests against the preview DB.

**Spec:** [2026-09-22-contact-lifecycle-status-design.md](../specs/2026-09-22-contact-lifecycle-status-design.md) §7 (audience block), §8.1–8.3 (layers and reasons). Plan: [PR 4](2026-09-24-contact-lifecycle-pr4.md) — this is its 4b. Prior: [4a](2026-09-24-contact-lifecycle-pr4.md#pr-4a--the-refactor-that-changes-nothing), merged as #223.

---

## ⚠️ This PR changes who gets messaged — but only for campaigns that do not exist yet

The switch is still off. `campaigns.lifecycle_rules` is `false` on all **670** campaigns and nothing in this PR sets it; the create route keeps writing `false` until **4c**. So every chip, every layer and every new bucket here is **dead code on every existing campaign**, and becomes live only for campaigns created after 4c merges.

That is the safety property this plan is built around, and it is why 4b can be reviewed on its own merits rather than as a change to live sending.

**31 campaigns are `active` and their audiences are frozen** (CLAUDE.md §10b). Nothing here recomputes `campaign_audience_pool` for a campaign past `draft`.

## Measured facts (production, 2026-09-25)

| Fact | Value |
|---|---|
| Campaigns | **670** — 603 completed, 31 active, 29 archived, 7 paused, **0 draft** |
| `lifecycle_rules = true` | **0** |
| Campaigns with stored `audience_filters` | 670 |
| — `include_clickers` | 497 |
| — `include_not_clicked` | 576 |
| — `include_no_status` | 574 |
| — `include_opt_in` | **3** |
| Campaigns with Excl segments (`audience_exclude_segment_ids`) | **8** |
| `stage_sends` | 5,621,175 rows; `status` CHECK now carries `skipped_ineligible` (0190, applied 2026-09-25) |

**Two of these change the plan.** `include_opt_in` is on exactly **3** campaigns, which matches the spec's "3 completed campaigns" — so dropping it from the chip mapping costs nothing real. And **0 drafts** means §7.3's draft conversion is a no-op; it becomes a release-time assertion, not a migration.

**8 campaigns use Excl segments**, which is the population the activate-dialog warning exists for. Small, but not zero — and all 8 are legacy, so the warning will not fire for them (it is gated on `lifecycle_rules`).

## Global Constraints

- **Worktree:** `C:\AFF\camman\.claude\worktrees\lifecycle-recon`, branch `feat/lifecycle-4b-chips`, cut from merged `main` `a78063fe` (4a + migration 0190).
- **No migration.** 0190 shipped the only DDL PR 4 needs. `audience_filters` is `jsonb`, so a new key needs no schema change. If something appears to need DDL, stop and ask.
- **`lifecycle_rules` stays `false` everywhere.** Wiring the flag through the form and the read paths is in scope; **setting it is not** — that is 4c's final task.
- **Frozen audiences must not change.** No recompute for any campaign past `draft`.
- **Legacy behaviour is preserved exactly.** `lifecycleChipPredicate()`'s `false` branch must keep emitting byte-identical SQL. The 4a gate (`scripts/test-eligibility-layers-identical.ts`) stays green — run it, do not delete it.
- **Every lead counted once**, in `EXCLUSION_PRIORITY` order: suppressed → bought_offer → freeze_not_due → creative → in_flight → offer. That constant already exists; do not introduce a second ordering.
- **None of the new layers filters `messaging_status`** — `gateEligible()` gates the whole audience, the same decision PR 3 made for the segment rules, for the same reason.
- **Tests** on the preview DB only (`_env-preload` then `_require-preview-db`), `npx tsx --conditions=react-server`.
- **Lint only changed files** against the `origin/main` baseline. Docs are part of done. Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## Three things recon found that change this plan

**1. ⚠️ `campaign-form-fields.tsx` and `campaign-form.tsx` are DEAD RENDER CODE.** Nothing mounts `<CampaignForm>`. Both `/campaigns/new` and `/campaigns/[id]/edit` render `CampaignEditorPage`, and the only live imports of `campaign-form.tsx` are the type-only `AudienceFilters`. **The live chip row is `components/campaigns/campaign-editor-page.tsx:111-136` (`FILTER_DEFS`) and `:1253-1281` (the rendering).** Chips added to `campaign-form-fields.tsx` would look correct in review, pass every source-level check, and render on no screen at all. There is already an in-repo note about this trap at `drip-stage-window-fields.tsx:20`. Verified independently before writing this plan.

**2. `audienceFiltersSchema` is not `.strict()`.** Unknown keys are *silently stripped* by Zod's default object behaviour — so if `lifecycle_statuses` is added to the chip UI but not to the schema, the value vanishes on save with **no error anywhere**. That is a failure mode that looks like "the chips don't persist" and is really a one-line schema omission. Task 1 adds the key first, and Task 2's test asserts a round-trip through the real API.

**3. Five call sites must learn `lifecycle_rules`, and none of them knows it today.** `buildStageEligibilityExclusions` is called from `recipients.ts:223`, `reconcile.ts:70`, `audience-snapshot.ts:1630` and the verify script — and `StageEligibilityParams` carries only creative/offer/excludePriorOffer. `reconcile.ts:55-67` selects exactly three columns and will need a fourth. Meanwhile `opts.eligibility` reaches `stageRecipientsSql` from **five** places: `kickoff.ts:649`, `preflight.ts:182`, `export-phones/route.ts:171`, `audience-preview/route.ts:152` and `:179`, plus `preflight-breakdown.ts:132-136`. Every one must pass the flag or the layers silently never apply. That is Task 3's real work — the SQL is the easy part.

---

### Task 1: `lifecycle_statuses` in the schema and on the chip row

**Files:** `lib/validators/campaigns.ts:24-35`, `components/campaigns/campaign-editor-page.tsx`.

- [ ] **Step 1: The schema key, first.**

```ts
export const LIFECYCLE_CHIP_STATUSES = ["new", "hot", "warm", "cold", "freeze"] as const;

const audienceFiltersSchema = z
  .object({
    // The four legacy chips. KEPT: 670 campaigns have them stored, and a
    // campaign with lifecycle_rules = false is still governed by them.
    include_no_status: z.boolean().optional(),
    include_opt_in: z.boolean().optional(),
    include_clickers: z.boolean().optional(),
    include_not_clicked: z.boolean().optional(),
    // Lifecycle chips (PR 4b). The Hot/Warm chip writes BOTH 'hot' and 'warm',
    // so splitting that chip later needs no migration.
    lifecycle_statuses: z.array(z.enum(LIFECYCLE_CHIP_STATUSES)).max(5).optional(),
    carrier_filter: z.array(z.enum(CAMPAIGN_CARRIER_FILTER_VALUES)).max(6).optional(),
  })
  .default({});
```

⚠️ This schema is **not** `.strict()`. Add the key here BEFORE touching the UI, or the chips will appear to work and silently persist nothing.

- [ ] **Step 2: The chip row — in `campaign-editor-page.tsx`, not `campaign-form-fields.tsx`.**

Add a `LIFECYCLE_CHIP_DEFS` beside `FILTER_DEFS` (`:111-136`) and render it above the legacy row (`:1253-1281`), reusing the existing pill markup and the `audienceLocked || anySubmitting` disabled treatment verbatim.

| chip | writes |
|---|---|
| New | `["new"]` |
| Hot/Warm | `["hot","warm"]` — one chip, two values |
| Cold | `["cold"]` |
| Freeze | `["freeze"]` |

- [ ] **Step 3: The old row's fate** (owner decision, 2026-09-24):

| campaign | legacy chip row | lifecycle chips |
|---|---|---|
| `lifecycle_rules = true` | **not rendered** | rendered, editable |
| `lifecycle_rules = false` | **rendered, read-only** | **rendered read-only beside it**, as the mapping |

Neither is editable on a legacy campaign: an edit would silently rewrite a legacy audience, and for the 31 active campaigns it is frozen anyway. Mapping: `include_clickers` → Hot/Warm; `include_not_clicked` or `include_no_status` → New + Cold + Freeze; `include_opt_in` ignored (**3 campaigns**). Label it as a *reading* of the old filters, not an equivalent — the old chips meant "ever clicked", the new ones mean recency.

- [ ] **Step 4: At least one chip required** to save or activate, for lifecycle campaigns only. Block with "Select at least one lifecycle status." New campaigns default to **Cold only**. This is a deliberate exception to CLAUDE.md §10b's "drafts save with zero required fields"; say so in a comment.

- [ ] **Step 5: The Freeze helper note** — the effective cadence of the selected contact groups: each group's override else the org default, a range when they differ ("14–21 days, depending on the contact's groups"), the org default when none is selected. It is informational, and the note must say why: a contact's real cadence is the strictest across **all** its active groups, so a contact also in an unselected group can have a longer one.

- [ ] **Step 6: Commit.**

### Task 2: Fill in `lifecycleChipPredicate`'s `lifecycleRules` branch

**Files:** `lib/audience-snapshot.ts:385-411`.

4a left this function with a `throw` on the `true` branch. This is the one edit — the five former copies are already collapsed.

- [ ] **Step 1: Replace the throw.** The lifecycle branch reads `contacts.lifecycle_status` (the 0188 projection: NOT NULL, indexed, same value as `contact_engagement.status`), so it needs no `coalesce` and no join:

```ts
  if (opts.lifecycleRules) {
    const wanted = Array.isArray(filters.lifecycle_statuses)
      ? (filters.lifecycle_statuses as string[])
      : [];
    // The one-chip minimum is enforced in the form and the create/PATCH
    // routes. Reaching here with an empty set means neither held, and
    // "match everybody" would be the dangerous reading — match nobody.
    if (wanted.length === 0) return drizzleSql`false`;
    return drizzleSql`(${aliasedColumn("lifecycle_status")} = ANY(${drizzleSql.raw(textArrayLiteral(wanted))}))`;
  }
```

⚠️ **Suppressed and opted-out are never chips and are always excluded** (spec §7.1). Suppressed is handled as an eligibility layer in Task 3, not here — do not add it to the chip set.

- [ ] **Step 2: The legacy branch must stay byte-identical.** Run `scripts/test-eligibility-layers-identical.ts`; all 670 campaigns are `lifecycle_rules = false`, so **every** captured shape must still match. A difference here means legacy audiences moved.

- [ ] **Step 3: Test the round trip through the real API** — create a campaign with `lifecycle_statuses`, read it back, confirm the value persisted. This is what catches the not-`.strict()` trap from finding 2.

- [ ] **Step 4: Commit.**

### Task 3: Thread `lifecycle_rules`, then add the three layers

The threading is the work; the SQL is short. Do them in this order so an un-threaded call site fails loudly rather than silently skipping a layer.

**Files:** `lib/sends/eligibility.ts`, `lib/sends/recipients.ts:222-230`, `lib/sends/reconcile.ts:55-83`, `lib/audience-snapshot.ts:1533-1536` + `:1630`, `lib/sends/kickoff.ts:649`, `lib/sends/preflight.ts:182`, `app/api/campaigns/[campaignId]/stages/[stageId]/export-phones/route.ts:171`, `app/api/campaigns/[campaignId]/stages/audience-preview/route.ts:152,179`, `lib/sends/preflight-breakdown.ts:132-136`, `scripts/verify-content-dedup-phase2.ts`.

- [ ] **Step 1: Grow `StageEligibilityParams`** with `lifecycleRules: boolean` — **required, not optional**. A required field turns every un-updated call site into a compile error, which is the only reliable way to find all five. An optional one defaulting to `false` would let a caller quietly skip the layers forever.
- [ ] **Step 2: `reconcile.ts:55-67` selects a fourth column**, `c.lifecycle_rules`.
- [ ] **Step 3: Each of the five `stageRecipientsSql` callers** passes the campaign's flag. Where the caller does not already read the campaign row, add the column to its existing select rather than issuing a second query.
- [ ] **Step 4: The three layers**, built only when `lifecycleRules` is true, pushed into the list and sorted by `orderLayers` (`EXCLUSION_PRIORITY` already places them ahead of the content-dedup layers):

```ts
// suppressed — the end of the lifecycle. Reads the projection, like the chips.
sql`SELECT id AS contact_id FROM contacts
    WHERE org_id = ${orgId}::uuid AND lifecycle_status = 'suppressed'`

// freeze_not_due — in freeze AND messaged inside the effective cadence.
sql`SELECT contact_id FROM contact_engagement
    WHERE org_id = ${orgId}::uuid AND status = 'freeze'
      AND last_sent_at > now() - make_interval(days => freeze_cadence_days)`

// bought_offer — see Step 5.
```

- [ ] **Step 5: ONE shared builder for `bought_offer`.** Spec §8.1 requires it use the same SQL as the `made_purchase_for_offer` segment rule (`lib/segment-rules-eval.ts:188-200`) so the two cannot drift. Extract that rule's body into a builder both call.

  Two details that matter and are easy to get wrong:
  - The rule scopes the offer via the **campaign's** offer (`JOIN campaigns ca ON ca.id = ce.campaign_id`), **not** `conversion_events.offer_id` — the ledger column is the offer at ingest time, while the rule has always meant the campaign's offer. Keep the join.
  - `purchasedClause()` (`lib/sale-attribution.ts:60-63`) is **already parenthesised on purpose**: it is an `A AND B` conjunction, and dropping it into an `OR` without the parens binds as `(x OR A) AND B`. Do not unwrap it.

- [ ] **Step 6: Tests** — each layer excludes exactly whom it should; the layers compose in priority order; and a `lifecycle_rules = false` campaign is **untouched by all three**. That last one is the regression bar.
- [ ] **Step 7: Commit.**

### Task 4: The preview breakdown by status

**Files:** `lib/audience-snapshot.ts` (`previewAudience`, `AudiencePreviewResult` at `:262-305`, the final SELECT at `:1322-1356`), plus its render site in the editor.

- [ ] **Step 1:** For lifecycle campaigns, break the qualified audience down by status — New / Hot / Warm / Cold / Freeze — and report how many Freeze contacts are **not due right now**.
- [ ] **Step 2: Excluded counts as exclusive buckets** in `EXCLUSION_PRIORITY` order: opted out → suppressed → bought this offer → status not selected → in use elsewhere. Each lead counted once.
- [ ] **Step 3:** Legacy campaigns keep today's breakdown shape unchanged.
- [ ] **Step 4: Commit.**

### Task 5: Exclusion reasons in the surfaces, and the anti-drift test

Recon confirms **four** independent shapes, not three: `PreflightBreakdown` (`preflight-breakdown.ts:32-60`), the Prepare dialog's `PreflightResult` (`stage-prepare-dialog.tsx:40-51`), `computeStageEligibilityPreview`'s counters (`audience-snapshot.ts:1516-1523`), and the autopilot page's duplicated client type (`autopilot/page.tsx:24-34`).

- [ ] **Step 1: Add the three new buckets to all four**, each ordered by the existing `EXCLUSION_PRIORITY` — do not introduce a second ordering.
- [ ] **Step 2: The Prepare dialog line** — "Excluded: 1,200 suppressed · 340 freeze not due · 95 bought this offer · …". It shows none today.
- [ ] **Step 3: Fix the stale doc-comment** at `db/schema.ts:2183`, which describes a `will_send` key that does not exist (the real one is `predicted_sends`) and omits `stage_filter` and `carrier`.
- [ ] **Step 4: THE ANTI-DRIFT TEST** (the condition the §8.3 deviation was accepted on). Assert all four shapes carry an identical bucket key set, derived from `EXCLUSION_PRIORITY` rather than a hand-written list — a list would be a fifth copy and would drift with the rest. Each shape exports a zero literal for this, which also retires the hand-maintained zero objects that exist today. It must go red when one key is removed from any one shape.
- [ ] **Step 5: Commit.**

### Task 6: The activate-dialog Excl warning

**Files:** `components/campaigns/status-change-dialog.tsx` (the `activate` COPY entry), its two mount sites, and the in-form activate path.

- [ ] **Step 1:** Show it when a lifecycle campaign has ≥1 Excl segment **and** its earliest scheduled stage is more than 24 h after activation. Text: _"Excl segments are applied now, not at send."_ A warning, not a block. No scheduled stage ⇒ nothing to compare ⇒ no warning.

- [ ] **Step 2: PREFETCH on the list page — do not widen the list route** (owner decision, 2026-09-25).

  On the **detail page** both inputs are already in client state: the stages list carries `scheduled_at` (`campaigns/[id]/page.tsx:245`, fetched at `:598`) and the campaign object needs one added field on `CampaignDetail` (`:182-221`) to carry `audience_exclude_segment_ids`, which `GET /api/campaigns/[campaignId]:94` already returns.

  On the **list page** neither is available. Fetch `GET /api/campaigns/[campaignId]` when the dialog opens, rather than adding `audience_exclude_segment_ids` and a stages join to `campaigns/list/route.ts` — that route serves every row of a 670-campaign list on every page load, and widening it to carry data only 8 campaigns use, only at the moment a dialog opens, is the wrong trade.

  While the prefetch is in flight the dialog renders without the warning and then shows it — so the confirm button stays disabled until the prefetch settles. A dialog that could confirm before its warning appears is worse than one that waits.

- [ ] **Step 2a: One computation, two call sites, and a test that says so.** Extract the decision into a pure function — `shouldWarnExclTiming({ lifecycleRules, excludeSegmentIds, earliestScheduledAt, now })` — so neither mount site decides anything itself. Then test that **both mount sites receive the same inputs** for the same campaign: given one campaign fixture, the detail page's props and the list page's post-prefetch props produce an identical argument object, and therefore an identical verdict.

  That test is the point of the decision: the failure mode being guarded against is not "the warning is wrong" but "the warning is right on one page and absent on the other", which no single-page test can catch.

- [ ] **Step 3: Commit.**

### Task 7: Docs

- [ ] **Step 1:** `docs/04-features/contact-lifecycle.md` (chips, the layers, the preview breakdown), `docs/05-flows.md` (the Prepare path gains three layers), `docs/07-conventions.md` (the one-chip minimum; the dead-render-code trap in the campaign form), `docs/CHANGELOG.md`, and every `_Last updated:_` touched.
- [ ] **Step 2: Full check + rebase + PR.** The changelog has conflicted on four consecutive PRs in this series; rebase before opening and confirm no markers survive.

---

## Merge gate

**Ask before merge**, per the spec's rollout table.

Bring to that conversation:
- the chip counts for a representative campaign — what each chip selects, against what the old filters selected;
- the three layers' exclusion counts on a real stage, per layer;
- confirmation that the 4a byte-identical gate is still green, which is what proves legacy campaigns are untouched.

### How those numbers are produced (owner decision, 2026-09-25)

**Read-only, by calling the functions — never by creating or flipping a campaign on production.**

A `scripts/measure-lifecycle-audience.ts`, modelled on `scripts/measure-lifecycle-list.ts`, takes a real campaign's stored inputs (its segments, contact groups, filters, offer, flags) and calls `previewAudience` / the eligibility builders **with `lifecycleRules: true` passed as an argument**. The flag is a parameter on every one of these paths — that is exactly why Task 3 makes it a required field — so the hypothetical can be evaluated without a single write.

Hard rules for that script:
- **No INSERT, UPDATE or DELETE.** Not on `campaigns.lifecycle_rules`, not a throwaway campaign, not a transaction that rolls back. A rolled-back write still burns an id sequence and still races the drain.
- It reads a real campaign's inputs and substitutes the flag **in memory only**.
- It is listed in `EXCLUSIONS` in `scripts/test-preview-db-guard.ts` with that reason, like the other production measurement scripts.
- Run off-peak, and report per layer rather than as one total — "340 excluded" is unactionable; "12 suppressed · 320 freeze not due · 8 bought offer" says whether a rule is behaving sensibly.

**Spec coverage.** §7.1's chips, the OR semantics, the one-chip minimum, the Cold-only default, the Freeze cadence note and the stored shape → Task 1. §7.1's "suppressed and opted-out are never chips" → Task 2 Step 1 (suppressed is a layer, not a chip). §7.2's single shared predicate → Task 2, one edit, because 4a already collapsed the five copies. §7.3's legacy mapping → Task 1 Step 3; the draft conversion is a no-op with 0 drafts. §7.4's preview breakdown → Task 4. §8.1's three new layers → Task 3. §8.2's where-each-rule-runs → Task 3 (Prepare) with send-time deferred to 4c. §8.3's reasons → Task 5. The activate warning → Task 6.

Not here: the send-time re-check, the send panel counts and the `lifecycle_rules = true` switch (all 4c), and 869f53efz's two layers (4d).

**Placeholders.** None.

**Type consistency.** `LIFECYCLE_CHIP_STATUSES` is the single source for the chip values, used by the Zod enum, the chip defs and the predicate. `EXCLUSION_PRIORITY` (from 4a) orders the layers, the four result shapes and the preview buckets — Task 5's test derives its expectation from it rather than restating it. `lifecycleRules` is a required field on `StageEligibilityParams` precisely so the compiler enumerates the call sites.

**Three risks worth naming.**

*The dead render code is the likeliest way to waste a day.* `campaign-form-fields.tsx` looks exactly like where chips belong, is named as if it were, and renders nowhere. Everything in Task 1 goes in `campaign-editor-page.tsx`. I verified this independently rather than taking recon's word for it, and the repo already carries a note about the same trap.

*The schema is not `.strict()`.* Adding chips to the UI without adding the key to `audienceFiltersSchema` loses the value on save with no error — it presents as "the chips don't persist". Task 1 does the schema first and Task 2 Step 3 asserts the round trip through the real API.

*Five call sites, none of which knows the flag.* Making `lifecycleRules` required on `StageEligibilityParams` converts that from a search problem into a compile error. An optional field defaulting to `false` would let one caller skip all three layers silently, forever — and the symptom would be "some sends exclude suppressed contacts and some don't", which is close to unfindable from the outside.
