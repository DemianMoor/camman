# Feature — Segments & Segment Rules

_Last updated: 2026-06-05_

## 1. Purpose
A **segment** is a named audience. Its effective membership is the **UNION** of manually-added contacts and contacts matching a chain of declarative **rules**. Segments feed campaign audiences. The rules engine compiles to SQL **set arithmetic** (not boolean predicates) so each branch can pick its own index plan against a >100K-row contacts table.

## 2. Key concepts / entities
- `segments` (`exclude_in_use_contacts` flag, `original_name`).
- `segment_contacts` — manual membership.
- `segment_rules` — `rule_type`, `operator` (`is`/`is_not`), `value` (jsonb), `position`, `is_active`, `combinator` (`and`/`or`).
- `segment_stats` — `total_count` (trigger-maintained manual count) + `rule_filtered_count` (on-demand full audience count, nullable).

## 3. How it works — the eval ([`lib/segment-rules-eval.ts`](../../lib/segment-rules-eval.ts))

**Model C — UNION + per-rule combinator:**
```
final audience = (manual membership) ∪ (contacts matching the rule chain)
rule chain = rule[0] comb[1] rule[1] comb[2] rule[2] …   (left-associative; comb[0] ignored)
```

- `buildSegmentAudienceClause(segmentId, orgId)` returns a `SELECT contact_id FROM …` SQL fragment.
- **Zero active rules → short-circuits to manual membership only** (bare `SELECT contact_id FROM segment_contacts`). **This property must be preserved in any refactor.**
- Incomplete rules (FK not yet picked, `value = null`) are filtered out via `isRuleComplete()` before eval — they don't accidentally match-everything via `NOT IN (empty set)`.
- With rules active, each rule becomes a subquery, combined via set operators:

  | operator | combinator | set op |
  |----------|-----------|--------|
  | `is` | `and` | `INTERSECT` |
  | `is` | `or` | `UNION` |
  | `is_not` | `and` | `EXCEPT` |
  | `is_not` | `or` | `UNION (all_org_contacts EXCEPT inner)` — slow, rare |

- **Left-associative**: `A OR B AND C` = `(A OR B) AND C`. Each step is parenthesized so the planner doesn't apply standard SQL precedence (INTERSECT > UNION). **Reordering rules can change the audience.**
- The first rule's combinator is read but ignored; if its operator is `is_not`, the seed is `(all_contacts ∖ inner)`.
- Result = `manual ∪ (rule chain)` via `UNION` (dedupes — needed when a manual member also matches a rule, else the count inflates).
- `exclude_in_use_contacts` (segment flag): if on, the whole clause is wrapped in `EXCEPT (SELECT contact_id FROM campaign_audience_pool JOIN campaigns WHERE status='active')`. Only `active` campaigns block; paused/completed/archived don't.

### Rule types (`segment_rules.rule_type`)
| rule_type | value shape | matches contacts who… |
|-----------|-------------|------------------------|
| `is_clicker_any_brand` | none | clicked any brand |
| `is_clicker_for_brand` | brand id | clicked a brand |
| `is_clicker_for_offer` | offer id | clicked an offer |
| `is_optin_any_brand` | none | opted in to any brand |
| `is_optin_for_brand` | brand id | opted in to a brand |
| `is_optout_for_brand` | brand id | opted out of a brand |
| `contact_added_in_last_n_days` | positive int | contact created ≤ N days ago |
| `contact_added_more_than_n_days_ago` | positive int | contact created > N days ago |
| `joined_segment_in_last_n_days` | positive int | joined *this* segment ≤ N days ago |
| `joined_segment_more_than_n_days_ago` | positive int | joined *this* segment > N days ago |
| `member_of_segment` | segment id | are members of another segment |
| `is_in_contact_group` | contact_group id | carry a contact-group tag |

- Time-based types accept `is` only (direction encoded in the name; the UI hides the operator select).
- **Validation source of truth:** [`lib/validators/segment-rule-types.ts`](../../lib/validators/segment-rule-types.ts) maps each type → allowed operators + value shape. Both server (Zod in `lib/validators/segment-rules.ts`) and client (`RulesPanel`) read from it — **don't fork.**
- **FK ownership:** brand/offer/segment/contact_group ids in rule values are re-verified against the user's org before insert/update (`verifyValueOwnership` in `app/api/segments/[id]/rules/route.ts`).

## 4. Data it reads/writes
- Reads `segment_rules`, `segment_contacts`, `segments`, and target tables (`clickers`, `opt_ins`, `opt_outs`+junction, `contacts`, `contact_contact_groups`, `campaign_audience_pool`).
- Writes `segment_rules`, `segment_stats.rule_filtered_count` (via refresh-stats).

## 5. UI surface
- Rules tab on `app/(protected)/segments/[id]` (next to Contacts/Upload/Remove).
- **Auto-save per rule:** `rule_type`/`operator` commit immediately; numeric/FK values commit on blur (no per-row save button).
- Reorder via up/down arrows (no drag-and-drop dep). `position` has no UNIQUE constraint — reorder briefly duplicates then renumbers in a two-phase update.
- 600ms debounced preview fires when the in-memory rule list changes (only after a PATCH returns — not on every keystroke).
- Segments with `active_rules_count > 0` show a `Has rules` badge in the campaign audience picker.

## 6. Counts & preview
- `segment_stats.total_count` (trigger) = manual count, unaffected by rules.
- `segment_stats.rule_filtered_count` (on-demand via `/api/segments/[id]/refresh-stats`) = the FULL UNION'd audience count; NULL when no active rules or the eval timed out. Name is historical — under UNION it's really `audience_count`.
- **Preview:** `POST /api/segments/[id]/rules/preview` → `{ count, manual_count, rule_filtered_count, duration_ms, truncated }`. Hard **10s** `SET LOCAL statement_timeout` inside a transaction; on timeout (PG `57014`) returns `truncated:true, count:null` rather than 500 (`previewSegmentAudienceCount()`).

## 7. Rules & edge cases / limitations
- The `is_not + or` path expands to a full `contacts` table scan — slow, but correct and rare (UI defaults to `is` + `and`).
- Campaign audience snapshots respect UNION semantics ([audience-snapshot.md](audience-snapshot.md)) but **frozen pools are NOT recomputed** when rules change later — by design.
- See the `is_in_contact_group` CHECK-vs-eval note in [03-data-model.md](../03-data-model.md).
