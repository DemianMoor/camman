# Design: "In use in a specific offer" segment rule

**Date:** 2026-07-07
**Status:** Approved
**Author:** Demian Moor + Claude

## Goal

Add a new segment audience rule that selects contacts that **were used** (or,
via `is_not`, **were not used**) in a chosen offer — i.e. contacts already
snapshotted into a campaign for that offer.

## Semantics

New rule type: **`in_use_in_offer`**

- **Value shape:** `offer_id` (single-offer picker, already wired everywhere).
- **Operators:** `is` / `is_not`.
- **Label (dropdown):** "In use in a specific offer".

A contact is **in use in offer X** when it sits in `campaign_audience_pool`
for a campaign where:

- `campaigns.offer_id = X`, and
- `campaigns.status IN ('active','paused','completed')` — draft has no pool
  rows; archived campaigns count as **not used**, and
- the campaign still has ≥1 **live** stage, `campaign_stages.status IN
  ('draft','pending','sent','success')`. A campaign whose stages are all
  `archived` / `cancelled` / `failed` (or has none) has released its audience
  and counts as **not used**.

This is the existing `in_use_in_campaign_last_period` logic with the time
window removed and an `offer_id` filter added — the "live stage" definition
is identical, matching the existing rule exactly (confirmed decision).

`is_not` ("not used in the offer") flows through the existing per-rule
negation machinery (`universe EXCEPT inner`) in `buildSegmentAudienceClause`
— no special handling.

## SQL (added as a `case` in `ruleInnerQuery`, lib/segment-rules-eval.ts)

```sql
SELECT DISTINCT p.contact_id
FROM campaign_audience_pool p
JOIN campaigns ca ON ca.id = p.campaign_id
WHERE p.org_id = $org AND ca.org_id = $org
  AND ca.status IN ('active','paused','completed')
  AND ca.offer_id = $offer
  AND EXISTS (
    SELECT 1 FROM campaign_stages s
    WHERE s.campaign_id = ca.id AND s.org_id = $org
      AND s.status IN ('draft','pending','sent','success')
  )
```

## Files touched

1. **Migration `0092_segment_rules_in_use_in_offer.sql`** (hand-authored):
   drop + recreate `segment_rules_rule_type_check` with `'in_use_in_offer'`
   added to the allowed set. Clone the latest snapshot forward, add the
   journal entry, `npm run db:migrate` against prod `DATABASE_URL`, then
   `npx tsx scripts/verify-migration-integrity.ts`.
2. **db/schema.ts** — add `'in_use_in_offer'` to the `segment_rules_rule_type_check`
   CHECK list (keeps Drizzle schema in sync with the DB).
3. **lib/validators/segment-rule-types.ts** — one `RULE_TYPES` entry
   (label, operators `is`/`is_not`, value_shape `offer_id`), placed in the
   "Campaign usage" section next to `in_use_in_campaign_last_period`.
4. **lib/segment-rules-eval.ts** — one `case "in_use_in_offer"` in
   `ruleInnerQuery` emitting the SQL above.
5. **Docs** — docs/03-data-model.md (rule_type constraint list),
   docs/04-features segment-rules doc, docs/07-conventions.md if applicable,
   docs/CHANGELOG.md entry.
6. **Client** — no changes. `RulesPanel` renders the offer picker purely
   from `value_shape === "offer_id"`; validation + FK ownership check
   (`verifyValueOwnership`) already handle the `offer_id` shape.

## Out of scope

- No new index. `campaign_audience_pool` and `campaigns.offer_id` already
  have working indexes used by the existing pool-based rules; the offer
  filter is a cheap additional predicate.
- No change to `exclude_in_use_contacts` flags or campaign snapshotting —
  this is purely a new read-side rule.

## Verification

- `npx tsc --noEmit` clean.
- `verify-migration-integrity` green (chain intact).
- Script test (following `scripts/test-segment-rules-api.ts`):
  - `is` matches pooled contacts of a live offer-X campaign;
  - excludes contacts whose only offer-X campaign is archived (campaign or
    all-stages);
  - `is_not` returns the complement.
