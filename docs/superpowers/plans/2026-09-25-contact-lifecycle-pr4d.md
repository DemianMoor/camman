# Contact Lifecycle PR 4d — offer cooldown and offer limit (869f53efz)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "this contact ever got this offer, so never again" with two numbers an operator controls: **not within Y days** (cooldown, default 7) and **not more than N times** (limit, default 5).

**Architecture:** Two more labelled layers in `EXCLUSION_PRIORITY`, reading `contact_offer_campaigns` — the per-(contact, offer, campaign) rollup the engagement job already maintains. The same predicate replaces the permanent DELETE at activation, so the snapshot stops removing people the Y/N rule would re-admit.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle raw `sql`, postgres-js, Supabase.

---

## Global Constraints

- **⛔ NOTHING IN THIS PR MERGES until campaign 1460's post-run comparison is accepted** (owner, 2026-09-25). It changes audience selection AND eligibility — both sides of the freeze. Build, test on preview, open the PR, stop.
- **`lifecycleRules` and every new selection parameter is REQUIRED on its input type** — CLAUDE.md §11b. The two new toggles are selection parameters and follow the same rule; no optional-with-a-default.
- **The 4a byte-identical SQL gate must stay green**, with the baseline re-captured from `origin/main` first. Legacy campaigns must not move.
- Migration: hand-authored, next number **0191**. Show the SQL and wait for explicit approval before applying to production. Apply outside the send window.
- Docs are part of done. Reporting per CLAUDE.md §11a.

---

## The state this builds on (verified on production, 2026-09-25)

- **`contact_offer_campaigns` is live and populated**: 2,485,496 rows, 791,505 contacts, 34 offers, `max(messages) = 5`, newest write 15:21 UTC today. The job maintains it; this PR only reads it.
- The thing being replaced is at [lib/audience-snapshot.ts:1810-1821](../../../lib/audience-snapshot.ts) — a `DELETE FROM audience_qualified WHERE EXISTS (offer_exposures …)`, run as its own statement after `ANALYZE` for planner reasons documented in CLAUDE.md §10b.

⚠️ **That DELETE's split-out shape is load-bearing and must survive.** Folding the new predicate back into the qualifier reproduces a measured 84s activation that blew the 60s route limit (nested-loop anti-join, 115.7M heap fetches). Whatever replaces it stays a separate statement after `ANALYZE`.

---

### Task 1: Migration 0191 — the two toggles

**Files:** Create `db/migrations/0191_campaign_offer_limit_cooldown.sql`, clone the meta snapshot, add the `_journal.json` entry, update `db/schema.ts`.

- [ ] **Step 1: Write the SQL and STOP for approval.** Proposed:

```sql
-- Offer cooldown + limit (869f53efz). Both NOT NULL with constant defaults, so
-- the ADD COLUMN is metadata-only on PG 11+ (attmissingval) — no table rewrite
-- on a 673-row table, but the habit is what matters.
ALTER TABLE campaigns
  ADD COLUMN offer_cooldown_days integer NOT NULL DEFAULT 7,
  ADD COLUMN offer_limit_times   integer NOT NULL DEFAULT 5,
  ADD COLUMN offer_rules_enabled boolean NOT NULL DEFAULT false;

-- Bounds, NOT VALID then VALIDATE so the check never scans under ACCESS
-- EXCLUSIVE (the 0188/0190 pattern).
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_offer_cooldown_days_check
  CHECK (offer_cooldown_days BETWEEN 0 AND 365) NOT VALID;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_offer_limit_times_check
  CHECK (offer_limit_times BETWEEN 1 AND 100) NOT VALID;
ALTER TABLE campaigns VALIDATE CONSTRAINT campaigns_offer_cooldown_days_check;
ALTER TABLE campaigns VALIDATE CONSTRAINT campaigns_offer_limit_times_check;
```

⚠️ **`offer_rules_enabled` defaults to FALSE, not true**, and this is the one place the card's wording and safety disagree. "Toggle on by default for new campaigns" is implemented in the **create route** (like `lifecycle_rules`), not in the column default. A `true` column default silently converts all 673 existing campaigns the moment the migration lands — including active ones whose pools are already frozen — and their `exclude_prior_offer_contacts` semantics would change under them. New campaigns get `true` from the route; existing ones keep what they had.

- [ ] **Step 2:** After approval, apply outside the send window, then `npx tsx scripts/verify-migration-integrity.ts` (expect 192/192).
- [ ] **Step 3: Commit.**

---

### Task 2: The two layers

**Files:** `lib/sends/eligibility.ts`, test `scripts/test-offer-limit-cooldown.ts`

**Interfaces:**
- Consumes: `EXCLUSION_PRIORITY`, `LIFECYCLE_EXCLUSION_KEYS` (which gains the two keys by derivation, not by hand-listing — see 4b's drift bar).
- Produces: `offerRulesLayers({ orgId, offerId, currentCampaignId, cooldownDays, limitTimes })`.

- [ ] **Step 1: Add `offer_limit` and `offer_cooldown` to `EXCLUSION_PRIORITY`**, positioned per spec §8.3: after `freeze_not_due`, before `creative`. `LIFECYCLE_EXCLUSION_KEYS` derives them automatically because it is `EXCLUSION_PRIORITY` minus the content-dedup keys — **verify that is still the set difference you want**, and if these two should report separately from the lifecycle three, split the derivation explicitly rather than letting them fall in by accident.

- [ ] **Step 2: Write the failing test first** — `scripts/test-offer-limit-cooldown.ts`, PART M. The cases that carry the design:

```ts
// M1  got this offer 6 days ago, cooldown 7  ⇒ EXCLUDED (cooldown)
// M2  got it 8 days ago, cooldown 7          ⇒ eligible
// M3  ⭐ boundary: exactly 7 days            ⇒ eligible (strictly "within Y")
// M4  got it 5 times, limit 5                ⇒ EXCLUDED (limit)
// M5  got it 4 times, limit 5                ⇒ eligible
// M6  ⭐ counts span CAMPAIGNS: 3 sends in one campaign + 2 in another = 5
// M7  ⭐ THE CURRENT CAMPAIGN IS EXCLUDED FROM BOTH COUNTS — stage 2 must not
//     be blocked by stage 1 (spec §11). Build a contact with rows ONLY under
//     the current campaign and assert it is eligible on both layers.
// M8  ⭐ a BUYER is excluded regardless of cooldown/limit — bought_offer sorts
//     first, so a buyer inside the cooldown reports 'bought_offer', not
//     'offer_cooldown'.
// M9  ⭐ A CLICK DOES NOT RESET THE COUNT. Same fixture as M4 plus a human
//     click yesterday ⇒ still excluded. This is the card's explicit rule and
//     the one a future "engagement resets everything" change would break.
// M10 a contact with NO contact_offer_campaigns row is eligible on both.
// M11 with offer_rules_enabled = false, NEITHER layer is built (legacy).
```

- [ ] **Step 3: Run it, confirm it fails.** `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-offer-limit-cooldown.ts`
- [ ] **Step 4: Implement**, reading `contact_offer_campaigns` with `campaign_id <> currentCampaignId` on both layers. Index `contact_offer_campaigns_org_offer_contact_idx (org_id, offer_id, contact_id)` serves both.
- [ ] **Step 5: Re-run — expect 11/11.** **Step 6: Commit.**

---

### Task 3: Replace the permanent DELETE at activation

**Files:** `lib/audience-snapshot.ts` (`snapshotAudience` ~`:1810`, `previewAudience`'s `oe_set`)

⚠️ **This is the task that changes who ends up in a frozen pool.** It is the reason this PR cannot merge before 1460's comparison is accepted.

- [ ] **Step 1:** For a campaign with `offer_rules_enabled = true`, the DELETE's `WHERE EXISTS (offer_exposures …)` becomes the Y/N predicate over `contact_offer_campaigns`, **still a separate statement after `ANALYZE audience_qualified`** (Global Constraints).
- [ ] **Step 2:** A campaign with the toggle OFF keeps the existing `offer_exposures` DELETE **byte-identically** — legacy campaigns with `exclude_prior_offer_contacts` on keep today's "ever got" behaviour, exactly as the card requires.
- [ ] **Step 3:** The same swap in `previewAudience`'s `oe_set`, so preview and pool agree. Both read the same builder.
- [ ] **Step 4: Measure.** Report activation wall time for a realistic recipe, old predicate vs new, on preview. The old one is 4.2s after the split-out fix; a regression here is a 60s-route problem, not a tuning note.
- [ ] **Step 5:** Bar that a contact excluded by "ever got" but ALLOWED by Y/N is in the new pool and absent from the old — the whole point of the change, and it fails if the DELETE was left in place alongside the new predicate.
- [ ] **Step 6: Commit.**

---

### Task 4: The toggles in the UI, and the create-route default

**Files:** `components/campaigns/campaign-editor-page.tsx`, `lib/validators/campaigns.ts`, `app/api/campaigns/route.ts`

- [ ] **Step 1:** Two numeric fields beside the existing "Exclude leads who already got this offer" toggle, shown when offer rules are on. Copy: "Not within **Y** days" / "Not more than **N** times".
- [ ] **Step 2: New campaigns get `offer_rules_enabled = true` from the CREATE ROUTE**, named explicitly in the `values({…})` literal — the same shape and the same reason as `lifecycle_rules` (an unnamed field silently takes the column default; see CLAUDE.md §11b and the 4c blocker).
- [ ] **Step 3:** Relationship to `exclude_prior_offer_contacts`: decide and **write down** whether the old toggle is hidden, disabled, or removed when offer rules are on. Two controls that both claim to govern "already got this offer" is how an operator ends up unable to explain their own audience. My recommendation: keep the old toggle as the **enable** switch and treat Y/N as its parameters, so there is one control, not two.
- [ ] **Step 4:** Test that both create-route paths (draft and create+activate) carry the toggles, and the editor round-trips them.
- [ ] **Step 5: Commit.**

---

### Task 5: Reporting the two new reasons

- [ ] **Step 1:** They flow into all five reporting shapes automatically **if** they are in `LIFECYCLE_EXCLUSION_KEYS` — confirm against `scripts/test-exclusion-bucket-drift.ts` rather than assuming, and confirm G4's source scan still passes (it now catches string-valued copies too, so the labels map needs both keys).
- [ ] **Step 2:** Labels in `lib/sends/exclusion-labels.ts` — `Record<LifecycleExclusionKey, string>` makes a missing one a compile error.
- [ ] **Step 3: Commit.**

---

### Task 6: Docs, checks, PR

- [ ] **Step 1:** `contact-lifecycle.md` (a section on the two layers and what replaced the permanent delete), `03-data-model.md` + the ERD for 0191, `05-flows.md`, `07-conventions.md`, `CHANGELOG.md`, last-updated dates.
- [ ] **Step 2:** `tsc`, `next build`, `check:guards`, `check:authz`, `check:docs`, every lifecycle suite, the 4a gate re-captured. Lint compared by **message set**, not count. Rebase, report conflicts rather than resolving silently.
- [ ] **Step 3: Open the PR and STOP.** Do not merge — see Global Constraints.

---

## Open questions for you, before I build

1. **Cooldown boundary.** "Within 7 days" — is exactly 7.0 days ago eligible or excluded? The plan assumes **eligible** (strictly less than Y). M3 pins whichever you choose.
2. **Does the limit count MESSAGES or CAMPAIGNS?** `contact_offer_campaigns` has both: one row per (contact, offer, campaign) with a `messages` counter. "Got this offer 5 times" reads more naturally as five **campaigns** than five messages, and a three-stage drip would otherwise consume the allowance in one campaign. The plan assumes **campaigns** (`count(*)` over rows, current campaign excluded). This is the single biggest semantic choice in the PR.
3. **One control or two** (Task 4 Step 3) — recommendation above is one.

## Merge gate

**Ask before merge**, and not before campaign 1460's post-run comparison is accepted. Bring: the Task 3 measurement (old vs new activation time), the count of contacts the Y/N rule re-admits that "ever got" excluded, and the 4a gate result.
