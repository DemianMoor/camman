# Design: "Sent from phone number" segment rule

**Date:** 2026-08-12
**Status:** Approved
**Author:** Demian Moor + Claude

## Goal

Add a segment audience rule that selects contacts by **which of our sending
phone numbers was used to message them** — chosen as a provider first, then one
or more of that provider's numbers.

Drives number-rotation and complaint-isolation work: "number 63109 got flagged,
find everyone it ever touched", or "these contacts already saw 621637, send the
next round from a different number".

## Semantics

New rule type: **`sent_from_provider_phone`**

- **Label (dropdown):** "Sent from phone number"
- **Operators:** `is` / `is_not`
- **Value shape:** `provider_phone_set` (new)
- **Value:** `{ provider_id: number, phone_ids: number[] }`

A contact **was sent from** the chosen numbers when it has **≥1 `stage_sends`
row** where:

- `stage_sends.org_id` = the caller's org, and
- `stage_sends.status = 'sent'`, and
- `stage_sends.provider_phone_id` ∈ `phone_ids`.

`status = 'sent'` is the only counted status. It is the codebase-wide
definition of "the message was accepted by the provider" — used by
`lib/reporting/rollup.ts`, `performance-report.ts`, `report-snapshot.ts`
(which documents it as *"delivered → stage_sends accepted by the provider"*),
and the opt-out circuit breakers. Counting anything else would make this rule
disagree with `/reports` for the same number.

Explicitly **not** counted, with today's row counts:

| status | rows | contacts | why not |
|--------|------|----------|---------|
| `rejected` | 48,355 | 42,791 | provider refused; nothing was delivered |
| `pending` | 42,825 | 42,818 | still queued — rule would go true before the send |
| `filtered` | 37,196 | 28,976 | suppressed before dispatch |
| `failed` | 2,043 | 2,036 | never left |
| `skipped_opted_out` | 1,109 | 1,109 | never left |
| `sending` | 187 | 187 | in flight; excluded for a stable definition |
| `skipped_duplicate` | 4 | 4 | never left |

**No time window.** The rule means "ever". A lookback can be added later
without schema churn (the value is a JSONB object — add an optional `period`
key and the existing `CAMPAIGN_USE_PERIODS` codes).

**`provider_id` is not used in the SQL.** It is implied by `phone_ids` (every
number belongs to exactly one provider). It is persisted so the editor can
remember the provider while the user is mid-pick, and so validation can enforce
that every chosen number belongs to that one provider.

`is_not` flows through the existing per-rule negation (`universe EXCEPT inner`)
in `buildSegmentAudienceClause` — no special handling.

## The pre-0112 history problem (and why we backfill)

`stage_sends.provider_phone_id` was added by migration 0112 and is stamped at
materialization (`lib/sends/kickoff.ts`). Rows written before that are `NULL`.

Measured on production 2026-08-12:

| | rows |
|---|---|
| `stage_sends` total | 2,966,317 |
| `provider_phone_id` stamped | 1,957,628 (66%) |
| `provider_phone_id` NULL | **1,008,689 (34%)** |
| of those NULL, resolvable via `campaign_stages.provider_phone_id` | **1,008,689 (100%)** |
| distinct phones in the NULL set | 3 — ids `26` (945,198 rows), `43` (63,490), `45` (1) |

The cutover is clean: last unstamped send `2026-07-18`, first stamped
`2026-07-20`.

Reading only stamped rows would make the rule silently answer "no" for a third
of all send history — including every June blast — while `/reports` continues
to count that history (the rollup COALESCEs to the stage's phone at read time).

**Decision: backfill, then read one column.** Every NULL row resolves, the
value is deterministic, and only 3 numbers are involved. This is preferred over
a permanent two-branch read-time UNION because:

- it halves the rows scanned on every evaluation, forever;
- a single-column predicate can use one partial index (a `COALESCE` across two
  tables cannot);
- it removes a code branch that would exist purely for pre-2026-07-20 history.

### Measured cost of the rejected read-time alternative

The two-branch UNION, run on production without any new index:

```
Execution Time: 8,480 ms
  Seq Scan on stage_sends  (1,780,555 rows)  3,407 ms
  Seq Scan on stage_sends  (967,281 rows)    2,724 ms   [the NULL branch]
  HashAggregate: Batches 33, Disk Usage 95,584 kB
```

Against a **10s** preview timeout. That is the baseline this design is
avoiding.

## Migration 0129

Two statements, hand-authored (LF line endings, `--> statement-breakpoint`,
snapshot cloned forward, journal entry — `db:generate` blocks on a TTY rename
prompt in this repo).

1. Widen the rule-type CHECK — drop + recreate, adding
   `'sent_from_provider_phone'` to the existing 22 values. Postgres has no
   `ADD VALUE` for a CHECK constraint; this mirrors migration 0098 exactly.

2. Add the supporting index:

```sql
CREATE INDEX stage_sends_org_provider_phone_sent_idx
  ON stage_sends (org_id, provider_phone_id) INCLUDE (contact_id)
  WHERE status = 'sent';
```

`INCLUDE (contact_id)` makes the eval an index-only scan — the query selects
nothing else.

## Backfill

`scripts/backfill-stage-send-provider-phone.ts`, modelled on
`scripts/backfill-tracking-ids.ts`:

```sql
UPDATE stage_sends ss
   SET provider_phone_id = cs.provider_phone_id
  FROM campaign_stages cs
 WHERE cs.id = ss.stage_id
   AND ss.provider_phone_id IS NULL
   AND cs.provider_phone_id IS NOT NULL;
```

- **Dry-run by default**; `--apply` to write.
- **Idempotent** — the `IS NULL` gate means a re-run is a no-op.
- **Batched** (50K rows per transaction) so it never holds one long
  transaction against the transaction pooler.
- Before writing, dumps the affected `(id, provider_phone_id)` pairs to a local
  file so the change is reversible, and prints the row count plus the distinct
  phone IDs for eyeball confirmation.
- Reports rows still NULL afterwards; expected to be 0.

**Execution order is load-bearing:**

1. Commit + apply migration 0129.
2. Run the backfill dry-run, confirm 1,008,689 / 3 phones, then `--apply`.
3. Verify 0 rows remain NULL.
4. Only then merge the feature code.

The feature must not go live against a half-stamped table — that is the
constraint the ordering exists to satisfy. Steps 1–3 are additive and safe to
run ahead of the code (per the standing rule: additive migrations lead the
code).

Both index statements ship in migration 0129, so the index is built *before*
the backfill and its ~967K new entries are maintained during the UPDATE rather
than built in one pass. Building the index afterwards would be marginally
cheaper, but splitting it into a second migration applied between two manual
steps is more process risk than the minutes it saves on a one-time job.

Both the migration and the backfill are prod-affecting and are gated on
explicit approval at execution time, per the standing policy.

## Eval (`lib/segment-rules-eval.ts`)

A new `case` in `ruleInnerQuery`:

```sql
SELECT DISTINCT contact_id
FROM stage_sends
WHERE org_id = ${orgId}::uuid
  AND status = 'sent'
  AND provider_phone_id = ANY(${phoneIds}::int[])
```

`DISTINCT` because a contact typically has many send rows. `status` is a
literal, not a bind, so the planner matches the partial index — the same
technique `contact_added_in_last_n_days` uses for
`contacts_org_created_eligible_idx`.

`isRuleComplete()` gains: a `provider_phone_set` rule with an empty `phone_ids`
is **incomplete** and is filtered out before eval, so it can never degrade to
`= ANY('{}')` (which matches nothing) or, under `is_not`, to "everyone".

## Validation

- `lib/validators/segment-rule-types.ts`: new `ValueShape`
  `"provider_phone_set"`; register `sent_from_provider_phone` in `RULE_TYPES`
  with operators `["is", "is_not"]`.
- `lib/validators/segment-rules.ts`: Zod object —
  `provider_id` positive int; `phone_ids` non-empty array of positive ints,
  unique. Rejects extra keys.
- `verifyValueOwnership` (`app/api/segments/[id]/rules/route.ts`): every
  `phone_id` must resolve to a `provider_phones` row in **the caller's org**
  AND with `provider_id` equal to the value's `provider_id`. A single query
  asserting `count(*) = phone_ids.length` under both conditions. RLS remains
  defence-in-depth, per §3.

## API

- **Rules list hydration.** `ref` is scalar today (`{id,name,color}` derived
  from a numeric `r.value`). This shape needs several labels, so rows of this
  rule type also return `refs: {id, name, color}[]` — **exactly one entry per
  `phone_id`**, in the same order, with `name` = `provider_phones.phone_number`
  and `color` = the owning provider's colour. The provider's own name is **not**
  in `refs`; the editor resolves it from `provider_id` against the phone list it
  already fetches. `ref` stays `null` for this rule type, and every other rule
  type is untouched.
  Phone labels resolve **regardless of `provider_phones.status`**, so a rule
  pointing at a since-archived number still renders it instead of going blank.
- **`/api/provider-phones/list`** gains an optional `include_archived=1`.
  It is active-only today (34 rows), which would drop archived numbers from
  the editor's label lookup.

## UI (`components/segments/rules-panel.tsx`)

A new branch in `ValueControl` for `provider_phone_set`, rendering two
controls:

1. **Provider** — a plain `<Select>`. There are 6 providers, under the ≤10
   threshold recorded in `07-conventions`, so it is deliberately *not*
   searchable.
2. **Numbers** — `<MultiSelectPicker>` (the established many-option
   multi-select), filtered to the chosen provider, each option labelled
   `phone_number` with `number_type` as `meta`.

Behaviour:

- Changing provider **clears `phone_ids`** — a number never survives into a
  provider it does not belong to.
- The phone list is fetched once, eagerly, alongside the existing brand/offer/
  segment/contact-group fetches, following the comment in that file explaining
  why those are eager (lazy gating deadlocked).
- A rule with a provider but no numbers persists and renders with the existing
  amber "incomplete" border, consistent with an unpicked FK.
- Commit-on-change, matching how the existing set editors (`phone_type`,
  `carrier`) commit: the rule type and operator ride along with the first
  non-empty selection, since an empty set is invalid server-side.

## Testing

`scripts/test-segment-rule-sent-from-phone.ts`, in the existing `test-*.ts`
style (this repo has no React component test runner — its tests are standalone
`tsx` scripts):

1. Zod accepts a well-formed value; rejects empty `phone_ids`, a non-array,
   duplicates, and an unknown operator.
2. `verifyValueOwnership` rejects a phone from another org, and a phone whose
   real provider differs from the value's `provider_id`.
3. Eval: a contact known to have a `status='sent'` row for phone N matches
   `is` on N, and does not match `is` on a different number.
4. `is_not` returns the complement within the org.
5. An empty-`phone_ids` rule is treated as incomplete and does not alter the
   audience count.
6. Post-backfill invariant: `SELECT count(*) FROM stage_sends WHERE
   provider_phone_id IS NULL` = 0.

## Docs to update

`docs/03-data-model.md` (+ the Mermaid ERD, for the new index),
`docs/04-features/audience-segments.md` (rule-type table + UI surface),
`docs/07-conventions.md`, `docs/CHANGELOG.md`, and `CLAUDE.md` §10e if the
rule-type list is enumerated there.

## Known limitation

For the two dominant numbers this rule matches a large fraction of the whole
contact base:

| number | provider | sent rows | contacts |
|--------|----------|-----------|----------|
| `63109` | TextHub | 1,627,307 | 462,569 |
| `621637` | Texthub - 621637+TFN | 1,120,528 | 334,150 |
| `+18446210404` | Texthub - 621637+TFN | 86,762 | 39,099 |
| `+13158359592` | Ahoi | 1 | 1 |

Returning 300–460K contact IDs is inherently expensive regardless of indexing,
and a preview over one of those numbers may still approach the 10s timeout — in
which case it degrades to `truncated: true, count: null` rather than erroring,
via the existing handler. The other ~30 numbers are highly selective and fast.
This is a property of the data, not a defect to fix in this change.

## Out of scope

- Time windows / lookback periods.
- One rule spanning numbers from **multiple** providers.
- Counting non-`sent` statuses.
- Simplifying `lib/reporting/rollup.ts` to drop its read-time `COALESCE` now
  that the column is fully populated — a safe follow-up, deliberately not
  bundled with a user-facing feature.
