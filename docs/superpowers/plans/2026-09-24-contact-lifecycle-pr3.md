# Contact lifecycle — PR 3 (the 8 lifecycle segment rule types) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator build an audience out of lifecycle facts — "at least 5 messages", "no message in the last 21 days", "clicked in the last 3 days", "is Hot or Warm" — by adding eight rule types to the existing segment-rules system. Nothing about how segments are evaluated, combined or frozen changes.

**Architecture:** Each new rule becomes one more `SELECT contact_id FROM …` branch in the existing set-arithmetic evaluator, so `UNION` / `INTERSECT` / `EXCEPT` composition, manual membership and the `Excl` behaviour all keep working untouched. Seven of the eight read `contact_engagement`; `lifecycle_status` reads the `contacts.lifecycle_status` projection that migration 0188 added.

**Tech Stack:** Drizzle `sql` templates over postgres-js · Zod validators sharing one rule-type map with the client · react-hook-form-free rules editor (auto-save per rule) · tsx tests against the preview DB.

**Spec:** [2026-09-22-contact-lifecycle-status-design.md](../specs/2026-09-22-contact-lifecycle-status-design.md) §9, plus §16 choice 1 (never-messaged contacts match neither direction). Prior PRs: [PR 1](2026-09-22-contact-lifecycle-pr1.md), [PR 2a](2026-09-23-contact-lifecycle-pr2a.md), [PR 2b](2026-09-23-contact-lifecycle-pr2b.md).

## Global Constraints

- **Worktree:** `C:\AFF\camman\.claude\worktrees\lifecycle-recon`, branch `feat/segment-lifecycle-rules`, cut from merged main `db1450de`. Absolute paths in shell commands.
- **This PR needs migration 0189** (the `rule_type` CHECK plus two indexes — Task 1). Same gate as 0187 and 0188: **the SQL is shown and approved before it touches production, and it is applied outside the send window** (before 08:00 or after 22:00 ET). Do not apply it as part of ordinary development.
- **A rule type must be registered in EIGHT places** (spec §9). Missing any of the middle four is how `phone_type`/`carrier` shipped uncreatable in migration 0098:
  1. `RULE_TYPES` · 2. `validateValueByShape` · 3. `isRuleComplete` · 4. `verifyValueOwnership` · 5. the SQL builder · 6. the DB CHECK · 7. `db/schema.ts` · 8. the editor's `ValueControl`.
  `scripts/test-segment-rule-type-registration.ts` guards 1, 6 and 7 **in both directions**, so the CHECK cannot run ahead of the code or behind it — the migration and the code land in the same PR by construction.
- **Never messaged / never clicked matches NEITHER direction** (spec §16 choice 1). `last_sent_at IS NULL` fails both `< now − N` and `>= now − N`, which SQL gives us for free — but it is a contract, so it gets its own test rather than resting on NULL semantics being remembered.
- **`messages_sent_at_most` must count a missing row as 0.** A contact the job has not reached has no `contact_engagement` row and has been sent nothing, so "at most 3 messages" MUST match it. A bare `EXISTS`/inner join silently drops every such contact. This is the same trap PR 2b's filter hit.
- **`lifecycle_status` reads `contacts.lifecycle_status`,** not `coalesce(contact_engagement.status,'new')` as spec §9 writes it. The spec predates migration 0188. The column is NOT NULL with default `'new'`, carries the same value (the job writes both in one transaction), and is indexed — so this is the same semantics with none of the `coalesce`. Flagged because it is a deliberate divergence from the spec text.
- **"Any N" where the spec says any N.** `last_message_*` and `last_click_*` take a free positive integer, like the existing `contact_added_in_last_n_days`. Only `messages_sent_in_period_at_least` is restricted to the fixed 7/14/30/90 windows, because those are literally the stored `msgs_7d/14d/30d/90d` columns and a free window would need a recount (owner confirmation, 2026-09-24).
- **Existing rule types and existing segments are untouched.** No behaviour change to any of the 32 types already in the CHECK.
- **Perf is a first-class requirement here, not a footnote** — see the measurements below. Every rule added to a segment is another pass over `contact_engagement`, and the preview endpoint has a hard 10 s `statement_timeout`.
- **Tests** run on the preview DB only (`_env-preload` then `_require-preview-db`), with `npx tsx --conditions=react-server`. Preview DB env prefix: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)"`.
- **Lint only changed files**, compared against the `origin/main` baseline for the same files. Docs are part of done. Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Measured facts this plan rests on (production, 2026-09-24)

| Fact | Value |
|---|---|
| `segment_rules` | **72 rows** across 38 segments (71 active) |
| Existing `rule_type` CHECK | **32 values**; this PR makes it 40 |
| `contact_engagement` | **973,731 rows / 467 MB** |
| Indexes on `contact_engagement` | `(org_id, status)`, `(org_id, time_due_at) WHERE NOT NULL`, PK only |
| Segment preview budget | hard **10 s** `statement_timeout` |

`segment_rules` being tiny is why the CHECK can be swapped outright rather than added `NOT VALID` and validated.

**Every new predicate is a sequential scan today** — measured with `EXPLAIN (ANALYZE)` against the production org:

| predicate | time | plan |
|---|---|---|
| `msgs_total >= 5` | 1,229 ms | Seq Scan |
| `msgs_total <= 3` | 1,273 ms | Seq Scan |
| `msgs_30d >= 2` | 1,263 ms | Seq Scan |
| `last_sent_at < now() − 30d` | 1,418 ms | Seq Scan |
| `last_sent_at >= now() − 30d` | 1,465 ms | Seq Scan |
| `last_click_at < now() − 90d` | 1,059 ms | Parallel Seq Scan |
| `last_click_at >= now() − 7d` | 1,022 ms | Parallel Seq Scan |

**Spec §4 specified `(org_id, last_sent_at)` and `(org_id, last_click_at)` indexes and migration 0187 did not create them.** That omission is invisible today because nothing queries those columns; it stops being invisible the moment these rule types exist. At ~1.2 s per rule, a segment with three of them spends 4 s of its 10 s preview budget before any set arithmetic. Task 1 adds both indexes.

## Decisions taken in this plan — override any of them

1. **Migration 0189 carries the two missing indexes**, not just the CHECK. They are part of spec §4 that 0187 missed, and the rule types are what make them load-bearing. Built `CONCURRENTLY` by a script, 0101/0109/0143/0188 pattern, because `contact_engagement` is written every 15 minutes.
2. **No index on `msgs_total` or the `msgs_Nd` columns.** "At least N messages" is a low-selectivity predicate that the planner would decline to use an index for anyway, and four more indexes on a 973K-row table the job rewrites is real write amplification for no measured gain. Revisit if a measurement says otherwise.
3. **`lifecycle_status` gets its own value shape** (`lifecycle_status_set`), validated against `ENGAGEMENT_STATUSES`, rather than reusing the open `text_set`. This follows the existing convention that "the ALLOWED VALUES are part of the type so a typo cannot validate".
4. **`messages_sent_in_period_at_least` gets a new `count_in_period` shape** `{count: N, days: 7|14|30|90}` — a set-shaped value, so it needs the four-place registration CLAUDE.md §10e warns about, not just two.
5. **The activate-dialog Excl warning is NOT in this PR.** Spec §9 describes it next to these rules, but the rollout table puts it in PR 4 with the rest of the audience-block work, and it depends on the lifecycle-campaign flag PR 4 introduces.

---

### Task 1: Migration 0189 — the CHECK and the two missing indexes

**GATED.** The SQL below goes to the owner for approval and is applied to production outside the send window, exactly as 0187 and 0188 were. During development it is applied to the PREVIEW database only, so the rest of the tasks can be tested.

**Files:**
- Create: `db/migrations/0189_segment_rules_lifecycle_types.sql`
- Create: `db/migrations/meta/0189_snapshot.json` (clone 0188, bump `id`/`prevId`, add the 8 values + 2 indexes)
- Create: `scripts/apply-engagement-rule-indexes-concurrent.ts`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts`, `scripts/test-preview-db-guard.ts`

- [ ] **Step 1: Write the migration**

The CHECK is only ever WIDENED, so no existing row can be invalidated and there is nothing to backfill. `segment_rules` holds 72 rows, so the drop-and-add is instant and needs no `NOT VALID` split — unlike the indexes.

```sql
-- Migration 0189: the lifecycle segment rule types (spec §9), plus the two
-- contact_engagement indexes spec §4 specified and 0187 did not create.
--
-- THE CHECK IS THE SIXTH OF EIGHT PLACES A RULE TYPE MUST BE REGISTERED, and
-- the only one in the database. Miss it and the rule validates in Zod, passes
-- ownership, renders in the editor -- and the INSERT is rejected by Postgres.
-- scripts/test-segment-rule-type-registration.ts asserts RULE_TYPES, this
-- constraint and the db/schema.ts mirror agree IN BOTH DIRECTIONS, so this file
-- and the code must land together.
--
-- Additive: the constraint is only ever WIDENED (72 rows today, all still valid).
--
-- THE INDEXES. Seven of the eight new rule types filter contact_engagement
-- (973,731 rows / 467 MB) on columns that have none, so each is a sequential
-- scan -- measured 2026-09-24: msgs_total >= 5 1,229 ms; last_sent_at <
-- now()-30d 1,418 ms; last_click_at >= now()-7d 1,022 ms. The segment preview
-- has a hard 10 s statement_timeout, so three such rules spend 4 s of it before
-- any set arithmetic. (org_id, last_sent_at) and (org_id, last_click_at) are
-- what spec §4 asked for; they serve the selective direction of the four time
-- rules. No index on msgs_total or the msgs_Nd columns: "at least N messages"
-- is low-selectivity, the planner would decline it, and four more indexes on a
-- table the job rewrites every 15 minutes is write amplification for no
-- measured gain.
--
-- BUILD THE INDEXES CONCURRENTLY IN PRODUCTION FIRST:
--     npx tsx scripts/apply-engagement-rule-indexes-concurrent.ts --apply
-- then run db:migrate -- the IF NOT EXISTS forms below no-op and the migration
-- is still recorded in the chain. contact_engagement is written every 15
-- minutes; a plain CREATE INDEX takes ACCESS EXCLUSIVE for the whole build, and
-- CONCURRENTLY cannot run inside drizzle-kit's migration transaction. Same
-- pattern as 0101, 0109, 0143 and 0188.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.segment_rules
  DROP CONSTRAINT IF EXISTS segment_rules_rule_type_check;
--> statement-breakpoint
ALTER TABLE public.segment_rules
  ADD CONSTRAINT segment_rules_rule_type_check CHECK (
    rule_type IN (
      'is_clicker_any_brand',
      'is_clicker_for_brand',
      'is_clicker_for_offer',
      'made_purchase',
      'made_purchase_for_brand',
      'made_purchase_for_offer',
      'reached_offer',
      'reached_offer_for_brand',
      'reached_offer_for_offer',
      'is_optin_any_brand',
      'is_optin_for_brand',
      'is_optout_for_brand',
      'contact_added_in_last_n_days',
      'contact_added_more_than_n_days_ago',
      'joined_segment_in_last_n_days',
      'joined_segment_more_than_n_days_ago',
      'in_use_in_campaign_last_period',
      'in_use_in_offer',
      'member_of_segment',
      'is_in_contact_group',
      'phone_type',
      'carrier',
      'sent_from_provider_phone',
      'gender',
      'age_band',
      'income_band',
      'has_kids',
      'is_married',
      'contact_state',
      'contact_country',
      'interest_tag',
      'partner_slug',
      -- Contact lifecycle (spec §9)
      'messages_sent_at_least',
      'messages_sent_at_most',
      'messages_sent_in_period_at_least',
      'last_message_more_than_n_days_ago',
      'last_message_in_last_n_days',
      'last_click_more_than_n_days_ago',
      'last_click_in_last_n_days',
      'lifecycle_status'
    )
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_last_sent_idx
  ON public.contact_engagement (org_id, last_sent_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_last_click_idx
  ON public.contact_engagement (org_id, last_click_at);
```

- [ ] **Step 2: Mirror it in `db/schema.ts`**

Add the eight values to the `segment_rules_rule_type_check` template and the two indexes to the `contact_engagement` table. The guard parses this file **textually**, matching `'[a-z0-9_]+'` between the backticks of the `sql` template, so keep each value single-quoted on its own line.

- [ ] **Step 3: The concurrent-index script**

`scripts/apply-engagement-rule-indexes-concurrent.ts`, modelled on `scripts/apply-carrier-day-index-concurrent.ts`: a `postgres(url, { prepare: false, max: 1 })` autocommit connection, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for each of the two, then the INVALID-index check `apply-lifecycle-status-column.ts` uses — a failed concurrent build leaves an invalid index the planner ignores while it still costs write amplification. Dry run by default, `--apply` to build. Add it to `EXCLUSIONS` in `scripts/test-preview-db-guard.ts` with its reason, or `npm run check:guards` fails.

- [ ] **Step 4: Journal + snapshot, then verify the chain**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
cp db/migrations/meta/0188_snapshot.json db/migrations/meta/0189_snapshot.json
# then: id=0189a000-0189-4189-8189-000000000189,
#       prevId=0188a000-0188-4188-8188-000000000188,
#       add the 8 CHECK values and the 2 indexes; append journal entry idx=189.
npx tsx scripts/verify-migration-integrity.ts
```

Expected: every migration `SQL ✓ snapshot ✓ prevId-chain ✓`, with 0189 showing `hash ✗ recorded: undefined` plus a record-count mismatch until it is applied. Those two clear on apply and on nothing else.

- [ ] **Step 5: Apply to PREVIEW only, then commit**

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npm run db:migrate
```

Production waits for the owner. Commit the migration, snapshot, journal, schema mirror and script together.

---

### Task 2: Register the eight types

**Files:**
- Modify: `lib/validators/segment-rule-types.ts` (`ValueShape`, the new value helpers, `RULE_TYPES`)
- Modify: `lib/validators/segment-rules.ts` (`validateValueByShape`, line 29)
- Modify: `lib/segment-rules-eval.ts` (`isRuleComplete`, line 53)
- Modify: `lib/api/segment-rule-value-ownership.ts` (`verifyValueOwnership`, line 27)

**Interfaces:**
- Produces:
```ts
export type ValueShape = … | "count_in_period" | "lifecycle_status_set";
export const COUNT_IN_PERIOD_DAYS: readonly [7, 14, 30, 90];
export type CountInPeriod = { count: number; days: 7 | 14 | 30 | 90 };
export function isCountInPeriod(v: unknown): v is CountInPeriod;
```

- [ ] **Step 1: The two new value shapes**

Extend the `ValueShape` union in `lib/validators/segment-rule-types.ts` and add:

```ts
// The windows ARE the stored columns msgs_7d / msgs_14d / msgs_30d / msgs_90d
// on contact_engagement, not an arbitrary interval — a free window would have
// to recount stage_sends, which is the 121 s job, not a preview. Owner
// confirmed 2026-09-24 that the fixed set is what this rule wants, while the
// last-message and last-click rules take any N.
export const COUNT_IN_PERIOD_DAYS = [7, 14, 30, 90] as const;
export type CountInPeriodDays = (typeof COUNT_IN_PERIOD_DAYS)[number];
export type CountInPeriod = { count: number; days: CountInPeriodDays };

export function isCountInPeriod(v: unknown): v is CountInPeriod {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.count === "number" &&
    Number.isInteger(o.count) &&
    o.count >= 1 &&
    o.count <= 100000 &&
    typeof o.days === "number" &&
    (COUNT_IN_PERIOD_DAYS as readonly number[]).includes(o.days)
  );
}
```

`lifecycle_status_set` reuses the existing `isStringSubsetOf` against `ENGAGEMENT_STATUSES` (`lib/engagement/constants.ts`). It is its own shape rather than the open `text_set` for the reason the file already gives about the attribute sets: the allowed values become part of the type, so a typo cannot validate.

- [ ] **Step 2: The eight `RULE_TYPES` entries**

Append a `// === Contact lifecycle (0187/0188) ===` block. The four time rules mirror `contact_added_in_last_n_days` exactly — `operators: ["is"]`, `value_shape: "positive_integer"` — which is what gives them the free N (that shape already validates 1…36500).

```ts
  messages_sent_at_least: {
    label: "Messages sent, at least N",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  messages_sent_at_most: {
    label: "Messages sent, at most N",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  messages_sent_in_period_at_least: {
    label: "At least N messages in the last X days",
    operators: ["is"],
    value_shape: "count_in_period",
  },
  last_message_more_than_n_days_ago: {
    label: "Last message more than N days ago",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  last_message_in_last_n_days: {
    label: "Last message within the last N days",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  last_click_more_than_n_days_ago: {
    label: "Last human click more than N days ago",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  last_click_in_last_n_days: {
    label: "Last human click within the last N days",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  lifecycle_status: {
    label: "Lifecycle status",
    operators: ["is", "is_not"],
    value_shape: "lifecycle_status_set",
  },
```

The map is closed with `} as const satisfies Record<string, RuleTypeSpec>`, and the emitter ends in `const _exhaustive: never = t`. So **adding these keys makes `tsc` fail until Task 3 adds the matching cases** — a free compile-time guard for registration point 5. Expect that error between Task 2 and Task 3; it is the plan working, not a mistake.

- [ ] **Step 3: `validateValueByShape`**

```ts
    case "count_in_period":
      return isCountInPeriod(value);
    case "lifecycle_status_set":
      return isStringSubsetOf(value, ENGAGEMENT_STATUSES);
```

- [ ] **Step 4: `isRuleComplete` — the branch that inverts audiences if missed**

```ts
  if (shape === "count_in_period") return isCountInPeriod(rule.value);
  if (shape === "lifecycle_status_set") {
    return isStringSubsetOf(rule.value, ENGAGEMENT_STATUSES);
  }
```

Read the comment already sitting above these branches before writing them. A set-shaped value falls through to a `typeof value === "number"` test, which rejects it, which marks the rule INCOMPLETE, which drops it from evaluation — and **a dropped `is_not` rule under `EXCEPT` turns "nobody" into EVERYBODY**. `lifecycle_status` is the first new type carrying `is_not`, so this PR is exactly where that bites.

- [ ] **Step 5: `verifyValueOwnership`**

Add both shapes to the early return that already covers `none` / `positive_integer` / `campaign_use_period`:

```ts
    shape === "campaign_use_period" ||
    // Neither carries an entity id: count_in_period is two numbers, and
    // lifecycle_status_set's members are validated against ENGAGEMENT_STATUSES
    // by the Zod refinement. There is nothing to own.
    shape === "count_in_period" ||
    shape === "lifecycle_status_set"
```

- [ ] **Step 6: Lint and commit** (`tsc` will still be red until Task 3 — commit anyway, or fold Tasks 2 and 3 into one commit.)

---

### Task 3: The SQL emitter

**Files:**
- Modify: `lib/segment-rules-eval.ts` — `ruleInnerQuery`, the `switch (t)` at line 140

- [ ] **Step 1: Add the eight cases**

Each returns a parameterised `SELECT contact_id FROM …`; the caller combines them with set arithmetic, never `IN (…)`. Follow the file's style: `${orgId}::uuid`, `make_interval(days => …)`, and a literal rather than a bind where a partial index depends on it.

```ts
    // ── Contact lifecycle (0187/0188) ──────────────────────────────────────
    case "messages_sent_at_least":
      return drizzleSql`
        SELECT contact_id FROM contact_engagement
        WHERE org_id = ${orgId}::uuid AND msgs_total >= ${Number(v)}::int
      `;
    case "messages_sent_at_most":
      // A contact the job has not reached has NO row and has been sent
      // nothing, so it must match "at most N". An EXISTS/inner-join form
      // silently drops every one of them — the same trap PR 2b's list filter
      // hit. Driven from contacts so the row-less case is representable.
      return drizzleSql`
        SELECT c.id AS contact_id FROM contacts c
        LEFT JOIN contact_engagement ce
          ON ce.contact_id = c.id AND ce.org_id = c.org_id
        WHERE c.org_id = ${orgId}::uuid
          AND c.messaging_status = 'eligible'
          AND coalesce(ce.msgs_total, 0) <= ${Number(v)}::int
      `;
    case "messages_sent_in_period_at_least": {
      const p = v as { count: number; days: number };
      // The window selects a STORED column. `days` is validated to 7|14|30|90
      // by isCountInPeriod, so this raw interpolation cannot be arbitrary text.
      const col = { 7: "msgs_7d", 14: "msgs_14d", 30: "msgs_30d", 90: "msgs_90d" }[
        p.days
      ];
      if (!col) return drizzleSql`SELECT NULL::uuid AS contact_id WHERE false`;
      return drizzleSql`
        SELECT contact_id FROM contact_engagement
        WHERE org_id = ${orgId}::uuid
          AND ${drizzleSql.raw(col)} >= ${Number(p.count)}::int
      `;
    }
    case "last_message_more_than_n_days_ago":
      // last_sent_at IS NULL fails this AND its opposite, which IS the spec's
      // "never messaged matches neither direction" (§16 choice 1).
      return drizzleSql`
        SELECT contact_id FROM contact_engagement
        WHERE org_id = ${orgId}::uuid
          AND last_sent_at < now() - make_interval(days => ${Number(v)})
      `;
    case "last_message_in_last_n_days":
      return drizzleSql`
        SELECT contact_id FROM contact_engagement
        WHERE org_id = ${orgId}::uuid
          AND last_sent_at >= now() - make_interval(days => ${Number(v)})
      `;
    case "last_click_more_than_n_days_ago":
      return drizzleSql`
        SELECT contact_id FROM contact_engagement
        WHERE org_id = ${orgId}::uuid
          AND last_click_at < now() - make_interval(days => ${Number(v)})
      `;
    case "last_click_in_last_n_days":
      return drizzleSql`
        SELECT contact_id FROM contact_engagement
        WHERE org_id = ${orgId}::uuid
          AND last_click_at >= now() - make_interval(days => ${Number(v)})
      `;
    case "lifecycle_status": {
      // Reads the 0188 PROJECTION on contacts, not contact_engagement: the
      // same value (the job writes both in one transaction), NOT NULL so the
      // "missing row is new" case needs no coalesce, and indexed. Spec §9
      // predates 0188. messaging_status literal so the eligible-partial
      // indexes stay usable, as the neighbouring contacts cases do.
      const set = Array.isArray(v) ? (v as string[]) : [];
      return drizzleSql`
        SELECT id AS contact_id FROM contacts
        WHERE org_id = ${orgId}::uuid AND messaging_status = 'eligible'
          AND lifecycle_status = ANY(${drizzleSql.raw(textArrayLiteral(set))})
      `;
    }
```

- [ ] **Step 2: Confirm the `is_not` path**

`is_not` is handled by the CALLER, not inside these cases. Read `ruleSet` / `combinedOp` / `operandFor` further down the file and confirm `AND + is_not` maps to `EXCEPT` and `OR + is_not` to `UNION (org_contacts EXCEPT inner)`. `lifecycle_status` is the only new type with `is_not`, so it is the one path the other seven never exercise.

- [ ] **Step 3: `tsc` should now be green**

```bash
npx tsc --noEmit
```

Expected: clean. If `_exhaustive` still errors, a case is missing.

- [ ] **Step 4: Commit**

---

### Task 4: The rules editor

**Files:**
- Modify: `components/segments/rules-panel.tsx` — `coerceValueForShape` (~line 118), `ValueControl`, and the local validity helpers (~lines 170–210)

- [ ] **Step 1: `coerceValueForShape`**

```ts
  if (shape === "count_in_period") {
    return isCountInPeriod(prior) ? prior : { count: 1, days: 30 };
  }
  if (shape === "lifecycle_status_set") {
    return isStringSubsetOf(prior, ENGAGEMENT_STATUSES) ? prior : [];
  }
```

A 30-day default rather than 7: it is the window an operator reaches for first, and `msgs_30d` is the column most likely to be non-zero.

- [ ] **Step 2: `ValueControl`**

- **`count_in_period`** — a number input bound to `.count` beside a `<Select>` of the four windows, committing on blur/change like the sibling controls. Label the number "messages" and the select "in the last …".
- **`lifecycle_status_set`** — the six statuses via `MultiSelectPicker`, options labelled from `ENGAGEMENT_STATUS_LABELS`. Six is above the ≤5 that `CLAUDE.md` §9 reserves for pill toggles and below the >10 that mandates the picker; the picker wins for consistency with the contacts-list lifecycle filter shipped in PR 2b.

Mirror both shapes into the file's local validity/incompleteness helpers around lines 170–210. They are a third copy of the same contract, and a missed branch there marks a valid rule invalid **in the editor only** — which looks like a UI bug and is really a registration miss.

- [ ] **Step 3: Look at the screen**

Start the dev server, open a segment's Rules tab, and for each of the eight types: add the rule, confirm the value control renders and commits, confirm the operator select is **hidden** for the seven `is`-only types and **shown** for `lifecycle_status`, and confirm the debounced preview returns a count. A source guard names a file, not a screen.

- [ ] **Step 4: Lint against the `origin/main` baseline for this file, then commit**

---

### Task 5: Tests

**Files:**
- Create: `scripts/test-segment-rule-lifecycle.ts`
- Run (no change expected): `scripts/test-segment-rule-type-registration.ts`

- [ ] **Step 1: The registration guard, against preview**

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-segment-rule-type-registration.ts
```

It reads the CHECK from the **live** database, so it is red until Task 1's migration is applied there and green after. Expect it to name all 40 values in both directions.

- [ ] **Step 2: Semantics, on the preview DB**

A new `scripts/test-segment-rule-lifecycle.ts` in the house style (`_env-preload` then `_require-preview-db`, a throwaway org, `_fictional-phones`, teardown by captured org id with a marker check, `bar()` assertions). Build a world with known `contact_engagement` rows **plus one contact with no row at all**, then assert by calling `buildSegmentAudienceClause` — not by rebuilding the SQL, which would only compare the statement against a copy of itself:

| bar | assertion |
|---|---|
| L1 | `messages_sent_at_least 5` matches exactly the contacts with `msgs_total >= 5` |
| L2 | **`messages_sent_at_most 3` includes the contact with NO engagement row** |
| L3 | `messages_sent_in_period_at_least {count:2, days:30}` reads `msgs_30d`, not `msgs_total` |
| L4 | `last_message_in_last_n_days 10` and `last_message_more_than_n_days_ago 10` are disjoint, and **neither contains a never-messaged contact** |
| L5 | the same for the two click rules, with a never-clicked contact |
| L6 | `lifecycle_status is [hot, warm]` matches exactly those; `is_not [hot, warm]` is its complement within the org **and is not empty** |
| L7 | a free N of 3 and of 365 both work on the four time rules (the owner's "any N") |
| L8 | all eight types round-trip through `isRuleComplete` as COMPLETE with a valid value |

L2 and L6 are the bars that fail loudly if the traps in Task 2 Steps 4–5 are reintroduced.

- [ ] **Step 3: End-to-end through the real API**

Follow `scripts/test-segment-rule-contact-attributes.ts` for the eight new types (a sibling script, or parameterise that one). It drives the REAL HTTP endpoint, which is the only thing that exercises all eight registration points at once — Zod, ownership, the DB CHECK and the editor's contract — and that is precisely the failure mode that shipped `phone_type`/`carrier` uncreatable in 0098. It runs against a preview deployment with `APP_URL` + preview credentials, never production.

- [ ] **Step 4: Measure against production**

Read-only, after Task 1's indexes exist in production. Re-run the predicate timings from the table at the top of this plan and confirm the two new indexes are used for the selective direction of the time rules. Report anything still over ~1 s **with its plan**, and add no further indexes without the owner's approval.

- [ ] **Step 5: Commit**

---

### Task 6: Docs

- [ ] **Step 1: Write them**

- `docs/04-features/contact-lifecycle.md` — the eight rule types, their value shapes, the "never messaged matches neither direction" contract, and that `lifecycle_status` reads the projection.
- `docs/07-conventions.md` — update the rule-registration note from SEVEN places to EIGHT (the editor's `ValueControl` plus its local validity helpers), and record that `messages_sent_at_most` must be driven from `contacts` so a row-less contact is representable.
- `docs/03-data-model.md` — the two new `contact_engagement` indexes.
- `docs/CHANGELOG.md` — one line. Update every `_Last updated:_` header touched.

- [ ] **Step 2: Full check, rebase, PR**

```bash
npm run check:docs && npm run check:authz && npm run check:guards
npx tsc --noEmit
git fetch origin && git rebase origin/main
git grep -n "^<<<<<<<\|^>>>>>>>\|^=======" -- docs/ || echo "clean"
```

The changelog has produced a rebase conflict on three consecutive PRs in this series; resolve by keeping both entries in date order and confirm no markers survive.

---

## Merge gate

**Ship on green** per the spec's rollout table, with one exception the owner must clear first: **migration 0189's SQL is approved and applied before the code merges**, on the same terms as 0187 and 0188.

Adding a rule type changes no existing audience: the 32 current types are untouched, the 71 active rules keep their behaviour, and no campaign's frozen pool is recomputed. A new rule only affects a segment once an operator adds it.

## Self-review

**Spec coverage.** §9's table lists eight rule types; Tasks 2 and 3 implement all eight with the value shapes the table names — `count_in_period` for the period rule, a status set for `lifecycle_status`, plain integers elsewhere. §9's eight registration points map to Task 2 (1–4), Task 3 (5), Task 1 (6–7) and Task 4 (8). §16 choice 1, never messaged/clicked matching neither direction, is Task 5 bars L4/L5. §9's "existing rule types and existing segments are untouched" holds: no task modifies an existing entry, case or CHECK value. §9's activate-dialog Excl warning is deliberately deferred to PR 4 (decision 5), matching the rollout table.

**Placeholders.** None. Every code step carries its code, and Task 1's SQL is complete as written — which is what the migration gate needs in order to be a real review rather than a promise.

**Type consistency.** `CountInPeriod` is `{count, days}` in the type, the validator, the emitter and the editor default. `COUNT_IN_PERIOD_DAYS` is the single source of the 7/14/30/90 set, read by the validator and by the emitter's column map. `lifecycle_status_set` is checked with `isStringSubsetOf(v, ENGAGEMENT_STATUSES)` in all three places that check it. `ValueShape` gains exactly two members, and every `switch`/chain over it gains exactly two branches — `validateValueByShape`, `isRuleComplete`, `verifyValueOwnership`, `coerceValueForShape`, `ValueControl` and the editor's local validity helpers. That is six chains; missing one is the defect class this whole plan is shaped around.

**Two risks worth naming rather than burying.**

The `isRuleComplete` fall-through does not fail loudly. A set-shaped value it does not recognise makes the rule *silently incomplete*, and an incomplete `is_not` rule under `EXCEPT` inverts the audience from nobody to everybody. `lifecycle_status` is the first new type with `is_not`, so this PR is where that bites. Bar L6 exists to catch it, and it is the first bar to run if an audience ever looks wrong.

The migration is gated but the code is not, and the registration guard reads the CHECK from whichever database it is pointed at. So between merging this PR and applying 0189 to production, the guard is red against production and any attempt to create one of the new rules is rejected by Postgres. **Apply 0189 to production before merging**, not after — that ordering is the merge gate above, and it is the reverse of the usual "code first, migration follows".
