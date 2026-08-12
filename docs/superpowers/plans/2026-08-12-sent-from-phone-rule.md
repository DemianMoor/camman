# "Sent from phone number" Segment Rule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a segment rule that selects contacts by which of our sending phone numbers messaged them, chosen as a provider then one or more of that provider's numbers.

**Architecture:** A new rule type `sent_from_provider_phone` with a new `provider_phone_set` value shape (`{provider_id, phone_ids[]}`). Evaluation is a single indexed read of `stage_sends.provider_phone_id` where `status='sent'`. That column is `NULL` for the 34% of history predating migration 0112, so a one-time backfill stamps those 1,008,689 rows from their stage before the feature ships.

**Tech Stack:** Next.js 16 (App Router) · TypeScript · Drizzle ORM · Zod · Postgres (Supabase) · Tailwind · Radix.

**Spec:** [docs/superpowers/specs/2026-08-12-sent-from-phone-rule-design.md](../specs/2026-08-12-sent-from-phone-rule-design.md)

## Global Constraints

- Every query filters by `org_id`. Non-negotiable (CLAUDE.md §3).
- Migrations are **hand-authored**: LF line endings, `--> statement-breakpoint` between statements, snapshot cloned forward, journal entry appended. `npm run db:generate` blocks on a TTY rename prompt in this repo — do not run it.
- Migrations are **not** auto-applied on deploy. `npm run db:migrate` is run manually against the production `DATABASE_URL`, then `npx tsx scripts/verify-migration-integrity.ts`.
- `npm run lint` is unusable repo-wide (it walks `.claude/worktrees/`, ~8.4MB, exits 1 on other branches' problems). Lint only changed files: `npx eslint <paths>`.
- No React test runner exists. Tests are standalone scripts run with `npx tsx scripts/test-*.ts`.
- `lib/segment-rules-eval.ts` imports `server-only`, so any script importing it must run as `npx tsx --conditions=react-server`.
- Scripts importing app code must `import { config } from "dotenv"` and load `.env.local` **before** any `@/db` import (ESM hoisting — otherwise `DATABASE_URL` is unset).
- New value: rule type key `sent_from_provider_phone`, label exactly `"Sent from phone number"`, operators `["is","is_not"]`, value shape `"provider_phone_set"`.
- Branch: `feat/segment-rule-sent-from-phone`, already created off `origin/main`.

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `db/migrations/0129_segment_rules_sent_from_phone.sql` | Widen rule_type CHECK; add partial index | Create |
| `db/migrations/meta/0129_snapshot.json` | Snapshot cloned from 0128 | Create |
| `db/migrations/meta/_journal.json` | Journal entry idx 129 | Modify |
| `scripts/backfill-stage-send-provider-phone.ts` | One-time stamp of 1,008,689 rows | Create |
| `lib/validators/segment-rule-types.ts` | Rule type registry + `isProviderPhoneSet` guard | Modify |
| `lib/validators/segment-rules.ts` | Zod shape validation | Modify |
| `lib/segment-rules-eval.ts` | `isRuleComplete` set shapes + eval SQL case + `intArrayLiteral` | Modify |
| `lib/api/segment-rule-value-ownership.ts` | Org + provider ownership for phone sets | Modify |
| `app/api/segments/[id]/rules/route.ts` | `refs[]` hydration | Modify |
| `app/api/provider-phones/list/route.ts` | `include_archived` param | Modify |
| `components/segments/rules-panel.tsx` | Provider select + numbers multi-select | Modify |
| `scripts/test-segment-rule-sent-from-phone.ts` | Validator + ownership + eval assertions | Create |

---

### Task 1: Migration 0129 (CHECK widen + partial index)

**Files:**
- Create: `db/migrations/0129_segment_rules_sent_from_phone.sql`
- Create: `db/migrations/meta/0129_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the DB accepts `rule_type = 'sent_from_provider_phone'`; index `stage_sends_org_provider_phone_sent_idx` exists.

- [ ] **Step 1: Write the migration SQL**

Create `db/migrations/0129_segment_rules_sent_from_phone.sql`. The CHECK must list all 22 existing values plus the new one — Postgres has no `ADD VALUE` for a CHECK constraint, so it is dropped and recreated (same as migration 0098).

```sql
-- Migration 0129: add the 'sent_from_provider_phone' segment rule type.
--
-- Selects contacts by WHICH OF OUR SENDING NUMBERS messaged them. Value is
-- {provider_id, phone_ids[]} scoped to a single provider; only stage_sends
-- rows with status='sent' count (the codebase-wide "accepted by the provider"
-- definition used by lib/reporting/rollup.ts). Eval in lib/segment-rules-eval.ts.
--
-- Distinct from the contact-side 'phone_type' / 'carrier' rules, which
-- describe the RECIPIENT's number.
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
      'sent_from_provider_phone'
    )
  );
--> statement-breakpoint

-- Supports the eval's only predicate. INCLUDE (contact_id) makes it an
-- index-only scan: the query selects nothing else.
CREATE INDEX IF NOT EXISTS stage_sends_org_provider_phone_sent_idx
  ON public.stage_sends (org_id, provider_phone_id) INCLUDE (contact_id)
  WHERE status = 'sent';
```

- [ ] **Step 2: Verify the file is LF-only**

Run: `git ls-files --eol db/migrations/0129_segment_rules_sent_from_phone.sql` (after `git add`)
Expected: `w/lf` — CRLF here causes false positives in `verify-migration-integrity.ts`.
(`.gitattributes` already pins `db/migrations/** eol=lf`.)

- [ ] **Step 3: Clone the snapshot forward and add the journal entry**

```bash
cp db/migrations/meta/0128_snapshot.json db/migrations/meta/0129_snapshot.json
```

**After cloning, update ONLY the two identity fields in the new `0129_snapshot.json`:** change `"id"` from `0128a000-0128-4128-8128-000000000128` to `0129a000-0129-4129-8129-000000000129`, and `"prevId"` from `0127a000-0127-4127-8127-000000000127` to `0128a000-0128-4128-8128-000000000128`. Omitting this step makes `verify-migration-integrity.ts` fail with `prevId-chain ✗` because the chain identity no longer matches the file sequence.

Append to the `entries` array in `db/migrations/meta/_journal.json`, after the `idx: 128` object:

```json
    {
      "idx": 129,
      "version": "7",
      "when": 1787529600000,
      "tag": "0129_segment_rules_sent_from_phone",
      "breakpoints": true
    }
```

Apart from those two identity fields, the snapshot's *content* is cloned unchanged: this migration adds no Drizzle-modelled columns — only a CHECK constraint and an index, neither of which the snapshot tracks for this table. The repo's convention is "content stays frozen, id/prevId always bump".

- [ ] **Step 4: Commit the migration file BEFORE applying it**

Applying before committing breaks `verify-migration-integrity` on main.

```bash
git add db/migrations/0129_segment_rules_sent_from_phone.sql db/migrations/meta/0129_snapshot.json db/migrations/meta/_journal.json
git commit -m "chore(db): 0129 — sent_from_provider_phone rule type + stage_sends phone index"
```

- [ ] **Step 5: STOP — get explicit approval, then apply**

This writes to the shared production database. Ask the user before running.

Run: `npm run db:migrate`
Then: `npx tsx scripts/verify-migration-integrity.ts`
Expected: integrity check reports a clean chain with no hash mismatches.

- [ ] **Step 6: Verify both objects exist**

```sql
SELECT conname FROM pg_constraint WHERE conname = 'segment_rules_rule_type_check';
SELECT indexname FROM pg_indexes WHERE indexname = 'stage_sends_org_provider_phone_sent_idx';
```
Expected: one row each.

---

### Task 2: Backfill `stage_sends.provider_phone_id`

**Files:**
- Create: `scripts/backfill-stage-send-provider-phone.ts`

**Interfaces:**
- Consumes: migration 0129 applied (Task 1).
- Produces: `SELECT count(*) FROM stage_sends WHERE provider_phone_id IS NULL` = 0.

- [ ] **Step 1: Write the backfill script**

Create `scripts/backfill-stage-send-provider-phone.ts`:

```ts
// One-shot backfill: stamp stage_sends.provider_phone_id from the parent
// stage for rows written before migration 0112 added the column. Idempotent
// — only writes rows where provider_phone_id IS NULL, so a partial run
// resumes cleanly.
//
// Measured on prod 2026-08-12: 1,008,689 NULL rows, 100% resolvable via
// campaign_stages, 3 distinct phones. Everything before 2026-07-18.
//
// Run:  npx tsx scripts/backfill-stage-send-provider-phone.ts           (dry run)
//       npx tsx scripts/backfill-stage-send-provider-phone.ts --apply   (writes)
//
// Writes a reversal file (id,provider_phone_id pairs BEFORE the change is
// applied) to scripts/.backfill-0129-reversal.csv so the change can be undone.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { appendFileSync, writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";

const BATCH = 50_000;
const REVERSAL = resolve(process.cwd(), "scripts/.backfill-0129-reversal.csv");

async function main() {
  const apply = process.argv.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  const [pre] = await db.execute<{
    null_rows: string;
    resolvable: string;
    phones: number[];
  }>(drizzleSql`
    SELECT count(*)::text AS null_rows,
           count(*) FILTER (WHERE cs.provider_phone_id IS NOT NULL)::text AS resolvable,
           array_agg(DISTINCT cs.provider_phone_id)
             FILTER (WHERE cs.provider_phone_id IS NOT NULL) AS phones
    FROM stage_sends ss
    LEFT JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.provider_phone_id IS NULL
  `);

  console.log(`NULL rows:      ${pre.null_rows}`);
  console.log(`resolvable:     ${pre.resolvable}`);
  console.log(`distinct phones: ${JSON.stringify(pre.phones)}`);

  if (pre.null_rows !== pre.resolvable) {
    console.error(
      `REFUSING: ${Number(pre.null_rows) - Number(pre.resolvable)} rows have no stage phone. Investigate before writing.`,
    );
    await pg.end();
    process.exit(1);
  }

  if (!apply) {
    console.log("\nDry run — no rows written. Re-run with --apply to write.");
    await pg.end();
    return;
  }

  writeFileSync(REVERSAL, "id,provider_phone_id\n", "utf8");
  let total = 0;
  for (;;) {
    const rows = await db.execute<{ id: number; provider_phone_id: number }>(drizzleSql`
      WITH batch AS (
        SELECT ss.id, cs.provider_phone_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.provider_phone_id IS NULL
          AND cs.provider_phone_id IS NOT NULL
        LIMIT ${BATCH}
      )
      UPDATE stage_sends ss
         SET provider_phone_id = b.provider_phone_id
        FROM batch b
       WHERE ss.id = b.id
      RETURNING ss.id, ss.provider_phone_id
    `);
    if (rows.length === 0) break;
    appendFileSync(
      REVERSAL,
      rows.map((r) => `${r.id},`).join("\n") + "\n",
      "utf8",
    );
    total += rows.length;
    console.log(`  stamped ${total}`);
  }

  const [post] = await db.execute<{ remaining: string }>(
    drizzleSql`SELECT count(*)::text AS remaining FROM stage_sends WHERE provider_phone_id IS NULL`,
  );
  console.log(`\nDone. Stamped ${total}. Remaining NULL: ${post.remaining}`);
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Note the reversal file records the id with an **empty** prior value, because every affected row's prior value is `NULL` by definition of the `WHERE` clause — undoing is `UPDATE stage_sends SET provider_phone_id = NULL WHERE id IN (…)`.

- [ ] **Step 2: Run the dry run**

Run: `npx tsx scripts/backfill-stage-send-provider-phone.ts`
Expected:
```
NULL rows:      1008689
resolvable:     1008689
distinct phones: [26,27,43]
Dry run — no rows written.
```
If `NULL rows` ≠ `resolvable`, STOP and report — the design's core assumption has changed.

- [ ] **Step 3: Commit the script**

```bash
git add scripts/backfill-stage-send-provider-phone.ts
git commit -m "chore(scripts): idempotent backfill for stage_sends.provider_phone_id (pre-0112 history)"
```

- [ ] **Step 4: STOP — get explicit approval, then apply**

This writes ~1M rows to production. Ask the user before running.

Run: `npx tsx scripts/backfill-stage-send-provider-phone.ts --apply`
Expected: `Remaining NULL: 0`

- [ ] **Step 5: Verify against the reports**

```sql
SELECT provider_phone_id, count(*) FROM stage_sends
WHERE status='sent' GROUP BY 1 ORDER BY 2 DESC;
```
Expected: phone 26 ≈ 1,627,307 · 43 ≈ 1,120,528 · 27 ≈ 86,762 · 45 = 1 — matching the pre-backfill COALESCE'd totals in the spec. Totals shifting means the backfill resolved differently than the reports do.

---

### Task 3: Rule type + value shape in the validators

**Files:**
- Modify: `lib/validators/segment-rule-types.ts`
- Modify: `lib/validators/segment-rules.ts`
- Create: `scripts/test-segment-rule-sent-from-phone.ts`

**Interfaces:**
- Consumes: nothing (pure TypeScript).
- Produces: `isProviderPhoneSet(v): v is ProviderPhoneSet`, type `ProviderPhoneSet = { provider_id: number; phone_ids: number[] }`, `ValueShape` member `"provider_phone_set"`, `RULE_TYPES.sent_from_provider_phone`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-segment-rule-sent-from-phone.ts`:

```ts
// Validator + ownership + eval assertions for the sent_from_provider_phone
// segment rule. Run: npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import {
  isProviderPhoneSet,
  getValueShapeForRuleType,
  isValidOperatorForRuleType,
} from "@/lib/validators/segment-rule-types";
import { validateMergedRuleShape } from "@/lib/validators/segment-rules";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

function testGuard() {
  console.log("isProviderPhoneSet");
  check("accepts a well-formed set", isProviderPhoneSet({ provider_id: 3, phone_ids: [26, 43] }));
  check("rejects empty phone_ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: [] }));
  check("rejects duplicate phone_ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: [26, 26] }));
  check("rejects a non-array phone_ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: 26 }));
  check("rejects a missing provider_id", !isProviderPhoneSet({ phone_ids: [26] }));
  check("rejects zero/negative ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: [0] }));
  check("rejects null", !isProviderPhoneSet(null));
  check("rejects an array", !isProviderPhoneSet([26, 43]));
  check("rejects extra keys", !isProviderPhoneSet({ provider_id: 3, phone_ids: [26], period: "1w" }));
}

function testRegistry() {
  console.log("RULE_TYPES registration");
  check(
    "value shape is provider_phone_set",
    getValueShapeForRuleType("sent_from_provider_phone") === "provider_phone_set",
  );
  check("allows is", isValidOperatorForRuleType("sent_from_provider_phone", "is"));
  check("allows is_not", isValidOperatorForRuleType("sent_from_provider_phone", "is_not"));
}

function testMergedShape() {
  console.log("validateMergedRuleShape");
  check(
    "accepts a valid rule",
    validateMergedRuleShape("sent_from_provider_phone", "is", { provider_id: 3, phone_ids: [26] }) === null,
  );
  check(
    "rejects an empty set",
    validateMergedRuleShape("sent_from_provider_phone", "is", { provider_id: 3, phone_ids: [] }) !== null,
  );
  check(
    "rejects a bogus operator",
    validateMergedRuleShape("sent_from_provider_phone", "contains", { provider_id: 3, phone_ids: [26] }) !== null,
  );
}

async function main() {
  testGuard();
  testRegistry();
  testMergedShape();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts`
Expected: FAIL — `isProviderPhoneSet` is not an exported member of `segment-rule-types`.

- [ ] **Step 3: Add the shape, guard and rule type**

In `lib/validators/segment-rule-types.ts`, extend the `ValueShape` union with `| "provider_phone_set"`, then add the type + guard after `isStringSubsetOf`:

```ts
// Value for `sent_from_provider_phone`: a set of provider_phones ids scoped to
// one provider. provider_id is redundant with the phones (each belongs to
// exactly one provider) but is persisted so the editor can hold a provider
// while the user is mid-pick, and so ownership checks can assert both.
export type ProviderPhoneSet = { provider_id: number; phone_ids: number[] };

export function isProviderPhoneSet(v: unknown): v is ProviderPhoneSet {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2) return false;
  if (!keys.includes("provider_id") || !keys.includes("phone_ids")) return false;
  const pid = o.provider_id;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return false;
  const ids = o.phone_ids;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  if (!ids.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 1)) {
    return false;
  }
  return new Set(ids).size === ids.length;
}
```

Add to `RULE_TYPES`, after the `carrier` entry:

```ts
  // === Send provenance ===
  // Which of OUR sending numbers messaged the contact. Distinct from the
  // contact-side phone_type / carrier rules above, which describe the
  // RECIPIENT's number — hence the "Sent from" label.
  sent_from_provider_phone: {
    label: "Sent from phone number",
    operators: ["is", "is_not"],
    value_shape: "provider_phone_set",
  },
```

- [ ] **Step 4: Wire the shape into Zod validation**

In `lib/validators/segment-rules.ts`, add `isProviderPhoneSet` to the import from `./segment-rule-types`, then add a case to `validateValueByShape` before `default:`:

```ts
    case "provider_phone_set":
      // No "incomplete" null state — an empty set is invalid server-side, so
      // the editor keeps a half-made selection local until a number is picked
      // (same contract as phone_type_set / carrier_set).
      return isProviderPhoneSet(value);
```

- [ ] **Step 5: Add the eval case in the same commit**

Registering the rule type widens the `RuleType` union, which immediately breaks
the `const _exhaustive: never = t;` guard in `ruleInnerQuery`. The case ships
with the type so every commit on this branch compiles.

In `lib/segment-rules-eval.ts`, add next to `textArrayLiteral`:

```ts
// Postgres int[] literal from a validated id list. Values are integers that
// already passed isProviderPhoneSet, so there is nothing to escape; Math.trunc
// is belt-and-braces before the value reaches drizzleSql.raw.
function intArrayLiteral(values: number[]): string {
  if (values.length === 0) return "ARRAY[]::int[]";
  return "ARRAY[" + values.map((n) => String(Math.trunc(n))).join(",") + "]::int[]";
}
```

Add `isProviderPhoneSet` to the existing import from
`@/lib/validators/segment-rule-types`, then add the `case` in `ruleInnerQuery`,
after `case "carrier"` and before `default`:

```ts
    case "sent_from_provider_phone": {
      // Which of OUR numbers messaged the contact. status='sent' is the
      // codebase-wide "accepted by the provider" definition (lib/reporting/
      // rollup.ts et al) — counting pending/rejected/filtered would disagree
      // with /reports for the same number. Written as a literal, not a bind,
      // so the planner can match the partial index
      // stage_sends_org_provider_phone_sent_idx (same technique as
      // contact_added_in_last_n_days). provider_id is not used here: it is
      // implied by the phone ids and enforced at write time by
      // verifyValueOwnership.
      const set = isProviderPhoneSet(v) ? v : { provider_id: 0, phone_ids: [] };
      return drizzleSql`
        SELECT DISTINCT contact_id FROM stage_sends
        WHERE org_id = ${orgId}::uuid
          AND status = 'sent'
          AND provider_phone_id = ANY(${drizzleSql.raw(intArrayLiteral(set.phone_ids))})
      `;
    }
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts`
Expected: `ALL PASS`

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: **clean** — the exhaustiveness guard is satisfied because the case landed alongside the type.

- [ ] **Step 8: Commit**

```bash
git add lib/validators/segment-rule-types.ts lib/validators/segment-rules.ts lib/segment-rules-eval.ts scripts/test-segment-rule-sent-from-phone.ts
git commit -m "feat(segments): sent_from_provider_phone rule type, value shape and eval case"
```

---

### Task 4: Fix set-shape handling in the two shared helpers

Migration 0098 added `phone_type_set` / `carrier_set` without updating `isRuleComplete` or `verifyValueOwnership`. Both fall through to a `typeof value === "number"` test, so **an array value fails both**: `verifyValueOwnership` rejects creation with "Value must be a positive integer", and `isRuleComplete` would drop the rule from evaluation. Confirmed latent — production has zero `phone_type`/`carrier` rules, because they cannot be created. `provider_phone_set` hits the identical path, so this is a prerequisite.

**Files:**
- Modify: `lib/segment-rules-eval.ts:40-60` (`isRuleComplete`)
- Modify: `lib/api/segment-rule-value-ownership.ts`
- Modify: `scripts/test-segment-rule-sent-from-phone.ts`

**Interfaces:**
- Consumes: `isProviderPhoneSet` (Task 3).
- Produces: `verifyValueOwnership` returns `{ok:true}` for valid phone sets and `{ok:false, reason}` when a phone is foreign to the org or to the named provider.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-segment-rule-sent-from-phone.ts` — import at the top:

```ts
import { verifyValueOwnership } from "@/lib/api/segment-rule-value-ownership";
```

and add this function plus a call to it in `main()` (before the summary):

```ts
// Uses real prod rows: org b0ce3435… owns phones 26 (TextHub) and 43.
const ORG = "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b";

async function testOwnership() {
  console.log("verifyValueOwnership");
  const phoneRow = await db.execute<{ id: number; provider_id: number }>(
    drizzleSql`SELECT id, provider_id FROM provider_phones WHERE org_id = ${ORG}::uuid ORDER BY id LIMIT 1`,
  );
  const phone = phoneRow[0];
  const good = await verifyValueOwnership(
    ORG,
    "sent_from_provider_phone",
    { provider_id: phone.provider_id, phone_ids: [phone.id] },
    null,
  );
  check("accepts an owned phone under its own provider", good.ok);

  const wrongProvider = await verifyValueOwnership(
    ORG,
    "sent_from_provider_phone",
    { provider_id: phone.provider_id + 99999, phone_ids: [phone.id] },
    null,
  );
  check("rejects a phone under the wrong provider", !wrongProvider.ok);

  const missing = await verifyValueOwnership(
    ORG,
    "sent_from_provider_phone",
    { provider_id: phone.provider_id, phone_ids: [phone.id, 999999999] },
    null,
  );
  check("rejects an unknown phone id", !missing.ok);

  const carrier = await verifyValueOwnership(ORG, "carrier", ["AT&T"], null);
  check("no longer rejects a carrier string set", carrier.ok);

  const phoneType = await verifyValueOwnership(ORG, "phone_type", ["mobile"], null);
  check("no longer rejects a phone_type string set", phoneType.ok);
}
```

Add the DB imports the helper needs at the top of the test file:

```ts
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
```

and make `main()` await it: `await testOwnership();`

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts`
Expected: the five ownership checks FAIL — every set-shaped value currently returns `{ok:false, reason:"Value must be a positive integer"}`.

- [ ] **Step 3: Handle set shapes in `verifyValueOwnership`**

In `lib/api/segment-rule-value-ownership.ts`, add imports:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { brands, contact_groups, offers, provider_phones, segments } from "@/db/schema";
import {
  getValueShapeForRuleType,
  isProviderPhoneSet,
} from "@/lib/validators/segment-rule-types";
```

Insert this block immediately **after** the early `none / positive_integer / campaign_use_period` return and **before** the `value == null` check — the generic checks below assume a numeric scalar and would reject arrays and objects:

```ts
  // String-set shapes carry no entity reference — the enum members are
  // validated by the Zod refinement, so there is nothing to own.
  if (shape === "phone_type_set" || shape === "carrier_set") {
    return { ok: true };
  }

  // Phone sets reference provider_phones rows: every id must belong to the
  // caller's org AND to the provider named in the value.
  if (shape === "provider_phone_set") {
    if (!isProviderPhoneSet(value)) {
      return { ok: false, reason: "Pick at least one phone number" };
    }
    const rows = await db
      .select({ id: provider_phones.id })
      .from(provider_phones)
      .where(
        and(
          eq(provider_phones.org_id, orgId),
          eq(provider_phones.provider_id, value.provider_id),
          inArray(provider_phones.id, value.phone_ids),
        ),
      );
    if (rows.length !== value.phone_ids.length) {
      return {
        ok: false,
        reason:
          "One or more phone numbers don't belong to your organization or to the selected provider",
      };
    }
    return { ok: true };
  }
```

- [ ] **Step 4: Handle set shapes in `isRuleComplete`**

In `lib/segment-rules-eval.ts`, add `isProviderPhoneSet` to the existing import from `@/lib/validators/segment-rule-types`, then insert before the final `return` of `isRuleComplete` (line ~55):

```ts
  // Set shapes hold arrays/objects, not numbers — without these the fall-through
  // below silently drops every phone_type / carrier / sent_from_provider_phone
  // rule from evaluation.
  if (shape === "phone_type_set") {
    return isStringSubsetOf(rule.value, PHONE_TYPE_VALUES);
  }
  if (shape === "carrier_set") {
    return isStringSubsetOf(rule.value, CARRIER_VALUES);
  }
  if (shape === "provider_phone_set") {
    return isProviderPhoneSet(rule.value);
  }
```

`isStringSubsetOf`, `PHONE_TYPE_VALUES` and `CARRIER_VALUES` are already imported in this file.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts`
Expected: `ALL PASS`

- [ ] **Step 6: Commit**

```bash
git add lib/api/segment-rule-value-ownership.ts lib/segment-rules-eval.ts scripts/test-segment-rule-sent-from-phone.ts
git commit -m "fix(segments): set-shaped rule values were rejected by ownership + dropped by the eval

phone_type and carrier (migration 0098) were never wired into
verifyValueOwnership or isRuleComplete, both of which fall through to a
typeof value === number test. Creating either returned 400; evaluating
either would have silently dropped the rule. Latent until now — prod has
zero such rules because they could not be created."
```

---

### Task 5: Eval verification and index proof

The eval case itself shipped in Task 3 (so no commit leaves the tree
non-compiling). This task proves its **semantics** against real rows and
proves the migration's index is actually chosen by the planner.

**Files:**
- Modify: `scripts/test-segment-rule-sent-from-phone.ts`

**Interfaces:**
- Consumes: eval case + `intArrayLiteral` (Task 3), backfilled column (Task 2), index from migration 0129 (Task 1).
- Produces: none (verification only).

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-segment-rule-sent-from-phone.ts`:

These assertions pin the rule's **semantics** in SQL rather than calling
`buildSegmentAudienceClause`, which would need a real segment carrying the rule
and would mutate production data to set up. The builder itself is covered by
the typecheck's exhaustiveness guard plus the browser check in Task 7.

```ts
async function testEval() {
  console.log("eval");
  // A contact with a known sent row, and the phone that sent it.
  const seed = await db.execute<{ contact_id: string; provider_phone_id: number }>(
    drizzleSql`
      SELECT contact_id, provider_phone_id FROM stage_sends
      WHERE org_id = ${ORG}::uuid AND status = 'sent' AND provider_phone_id IS NOT NULL
      LIMIT 1
    `,
  );
  const { contact_id, provider_phone_id } = seed[0];

  const hit = await db.execute<{ contact_id: string }>(drizzleSql`
    SELECT DISTINCT contact_id FROM stage_sends
    WHERE org_id = ${ORG}::uuid AND status = 'sent'
      AND provider_phone_id = ANY(ARRAY[${provider_phone_id}]::int[])
      AND contact_id = ${contact_id}::uuid
  `);
  check("the contact matches the number that sent to it", hit.length === 1);

  const other = await db.execute<{ id: number }>(drizzleSql`
    SELECT id FROM provider_phones
    WHERE org_id = ${ORG}::uuid AND id <> ${provider_phone_id} LIMIT 1
  `);
  const miss = await db.execute<{ contact_id: string }>(drizzleSql`
    SELECT DISTINCT contact_id FROM stage_sends
    WHERE org_id = ${ORG}::uuid AND status = 'sent'
      AND provider_phone_id = ANY(ARRAY[${other[0].id}]::int[])
      AND contact_id = ${contact_id}::uuid
  `);
  check("a different number does not necessarily match", miss.length <= 1);

  const [remaining] = await db.execute<{ n: string }>(
    drizzleSql`SELECT count(*)::text AS n FROM stage_sends WHERE provider_phone_id IS NULL`,
  );
  check("backfill invariant: no unstamped rows remain", remaining.n === "0");
}
```

Call `await testEval();` from `main()`.

- [ ] **Step 2: Run the test**

Run: `npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts`
Expected: `ALL PASS`. If the backfill invariant assertion fails with a non-zero
count, Task 2's `--apply` has not been run — STOP and report rather than
weakening the assertion.

- [ ] **Step 3: Confirm the index is actually used**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT DISTINCT contact_id FROM stage_sends
WHERE org_id = 'b0ce3435-5ea2-4510-ab11-8cdd0d0c125b'::uuid
  AND status = 'sent'
  AND provider_phone_id = ANY(ARRAY[27]::int[]);
```
Expected: an **Index Only Scan** using `stage_sends_org_provider_phone_sent_idx`, well under the 8,480ms two-seq-scan baseline recorded in the spec. Record the actual number in the PR body. Phone 27 is the selective case (86,762 rows); phone 26 is the worst case and will still be slow — that is the documented limitation, not a regression.

- [ ] **Step 6: Commit**

```bash
git add lib/segment-rules-eval.ts scripts/test-segment-rule-sent-from-phone.ts
git commit -m "feat(segments): eval sent_from_provider_phone against the stage_sends phone index"
```

---

### Task 6: API — `refs[]` hydration and archived phones

**Files:**
- Modify: `app/api/segments/[id]/rules/route.ts`
- Modify: `app/api/provider-phones/list/route.ts`

**Interfaces:**
- Consumes: `ProviderPhoneSet`, `isProviderPhoneSet` (Task 3).
- Produces: rule rows of this type carry `refs: {id,name,color}[]` (one per `phone_id`, same order); `GET /api/provider-phones/list?include_archived=1` returns archived rows too.

- [ ] **Step 1: Add `include_archived` to the phones list**

In `app/api/provider-phones/list/route.ts`, change the signature to accept the request and make the status filter conditional:

```ts
export async function GET(request: Request) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Opt-in: the segment-rules editor needs archived numbers so a rule
  // referencing one still renders its label instead of going blank.
  const includeArchived =
    new URL(request.url).searchParams.get("include_archived") === "1";

  const rows = await db
    .select({
      id: provider_phones.id,
      phone_number: provider_phones.phone_number,
      number_type: provider_phones.number_type,
      status: provider_phones.status,
      provider_id: sms_providers.id,
      provider_name: sms_providers.name,
      provider_key: sms_providers.sms_provider_id,
      provider_color: sms_providers.color,
      supports_api_send: sms_providers.supports_api_send,
    })
    .from(provider_phones)
    .innerJoin(sms_providers, eq(sms_providers.id, provider_phones.provider_id))
    .where(
      includeArchived
        ? eq(provider_phones.org_id, orgId)
        : and(
            eq(provider_phones.org_id, orgId),
            eq(provider_phones.status, "active"),
          ),
    )
    .orderBy(asc(sms_providers.name), asc(provider_phones.phone_number));

  return NextResponse.json({ data: rows });
}
```

`status` is added to the projection so the editor can mark an archived number.

- [ ] **Step 2: Hydrate `refs` in the rules list**

In `app/api/segments/[id]/rules/route.ts`, inside `hydrateRefs`, collect phone ids alongside the existing sets:

```ts
  const phoneIds = new Set<number>();
```

in the collection loop:

```ts
    if (shape === "provider_phone_set" && isProviderPhoneSet(r.value)) {
      for (const id of r.value.phone_ids) phoneIds.add(id);
    }
```

fetch them (no `status` filter — archived numbers must still resolve):

```ts
  const phoneMap = new Map<number, Info>();
  if (phoneIds.size > 0) {
    const rows = await db
      .select({
        id: provider_phones.id,
        name: provider_phones.phone_number,
        color: sms_providers.color,
      })
      .from(provider_phones)
      .innerJoin(sms_providers, eq(sms_providers.id, provider_phones.provider_id))
      .where(
        and(
          eq(provider_phones.org_id, orgId),
          inArray(provider_phones.id, Array.from(phoneIds)),
        ),
      );
    for (const row of rows) phoneMap.set(row.id, row);
  }
```

and in the per-row return, add `refs` while leaving `ref` untouched for every other type:

```ts
    let refs: Info[] | null = null;
    if (shape === "provider_phone_set" && isProviderPhoneSet(r.value)) {
      // One entry per phone_id, in the value's order, so the editor can render
      // labels positionally. Nulls are filtered: a phone deleted outright
      // simply drops out of the label list.
      refs = r.value.phone_ids
        .map((id) => phoneMap.get(id))
        .filter((x): x is Info => x !== undefined);
    }
    return { ...r, ref, refs };
```

Add `provider_phones`, `sms_providers` to the `@/db/schema` import, `inArray` to the drizzle import, and `isProviderPhoneSet` to the validators import.

- [ ] **Step 3: Verify by hand against a real segment**

Start the dev server (`npm run dev`), then with the browser already authenticated:

Run: `curl -s "http://localhost:3000/api/provider-phones/list?include_archived=1" | head -c 400`
Expected: JSON with `status` present on each row.

Expected for the rules endpoint: every existing rule still returns its `ref` unchanged and `refs: null`. Confirm no existing rule type regressed.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx eslint "app/api/segments/[id]/rules/route.ts" app/api/provider-phones/list/route.ts`
Expected: no new problems.

- [ ] **Step 5: Commit**

```bash
git add "app/api/segments/[id]/rules/route.ts" app/api/provider-phones/list/route.ts
git commit -m "feat(api): refs[] hydration for phone-set rules; include_archived on the phones list"
```

---

### Task 7: RulesPanel UI

**Files:**
- Modify: `components/segments/rules-panel.tsx`

**Interfaces:**
- Consumes: `/api/provider-phones/list?include_archived=1`, `refs` from Task 6, `isProviderPhoneSet` from Task 3.
- Produces: none (leaf).

- [ ] **Step 1: Fetch the phone list eagerly**

Alongside the existing brand/offer/segment/contact-group fetches (the file explains why these are eager — lazy gating deadlocked), add:

```tsx
type PhoneOption = {
  id: number;
  phone_number: string;
  number_type: string;
  status: string;
  provider_id: number;
  provider_name: string;
  provider_color: string | null;
};
```

```tsx
  const phonesApi = useApiCall<{ data: PhoneOption[] }>();
  const [phones, setPhones] = useState<PhoneOption[]>([]);
  const [phonesLoaded, setPhonesLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await phonesApi.execute(
        "/api/provider-phones/list?include_archived=1",
      );
      if (cancelled) return;
      if (r.ok) setPhones(r.data.data);
      setPhonesLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [phonesApi.execute]);
```

Thread `phones` / `phonesLoaded` through `RuleRow` into `ValueControl` exactly as `brands` / `brandsLoaded` are threaded today.

- [ ] **Step 2: Coerce the value on rule-type switch**

In `coerceValueForShape`, add before the FK branch:

```tsx
  if (shape === "provider_phone_set") {
    // Keep a prior selection only if it is still a valid set; otherwise start
    // empty. An empty set stays local (invalid server-side) — same contract as
    // phone_type_set / carrier_set.
    return isProviderPhoneSet(prior) ? prior : { provider_id: 0, phone_ids: [] };
  }
```

In `isRuleReadyToSave`, add:

```tsx
  if (shape === "provider_phone_set") return isProviderPhoneSet(value);
```

In `isRuleIncomplete`, add:

```tsx
  if (shape === "provider_phone_set") return !isProviderPhoneSet(value);
```

Import `isProviderPhoneSet` from `@/lib/validators/segment-rule-types`.

- [ ] **Step 3: Render the two controls**

In `ValueControl`, add before the FK branch:

```tsx
  if (shape === "provider_phone_set") {
    const set = isProviderPhoneSet(value)
      ? value
      : ((value as { provider_id?: number; phone_ids?: number[] } | null) ?? null);
    const providerId = set?.provider_id ?? 0;
    const selectedIds = set?.phone_ids ?? [];

    // Providers that actually own at least one number, de-duplicated.
    const providers = Array.from(
      new Map(
        phones.map((p) => [
          p.provider_id,
          { id: p.provider_id, name: p.provider_name, color: p.provider_color },
        ]),
      ).values(),
    ).sort((a, b) => a.name.localeCompare(b.name));

    const forProvider = phones.filter((p) => p.provider_id === providerId);

    return (
      <div className="flex flex-wrap items-center gap-2">
        {/* 6 providers — under the <=10 threshold in docs/07-conventions.md,
            so deliberately a plain Select rather than SearchableSelect. */}
        <Select
          value={providerId > 0 ? String(providerId) : ""}
          onValueChange={(v) => {
            const nextProvider = Number.parseInt(v, 10);
            if (!Number.isFinite(nextProvider)) return;
            // Changing provider clears the numbers — a number must never
            // survive into a provider it doesn't belong to.
            onChange({ provider_id: nextProvider, phone_ids: [] });
          }}
          disabled={disabled}
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue
              placeholder={phonesLoaded ? "Select a provider" : "Loading…"}
            />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {providerId > 0 ? (
          <div className="w-[260px]">
            <MultiSelectPicker
              options={forProvider.map((p) => ({
                id: p.id,
                label: p.phone_number,
                meta:
                  p.status === "archived"
                    ? `${p.number_type} · archived`
                    : p.number_type,
              }))}
              value={selectedIds}
              onChange={(next) =>
                onPhoneSetChange({
                  provider_id: providerId,
                  phone_ids: next.map((n) => Number(n)),
                })
              }
              disabled={disabled}
              placeholder="Select numbers…"
              searchPlaceholder="Search numbers…"
              selectedLabel={(n) => `${n} number${n === 1 ? "" : "s"}`}
              emptyMessage="This provider has no numbers."
            />
          </div>
        ) : null}
      </div>
    );
  }
```

Import `MultiSelectPicker` from `@/components/multi-select-picker`.

- [ ] **Step 4: Add the commit handler**

`ValueControl` gains an `onPhoneSetChange: (next: ProviderPhoneSet) => void` prop. In `RuleRow`, define it to mirror the existing `handleSetChange` contract — an empty set stays local, and the rule type + operator ride along with the first non-empty selection because a switch *to* this type cannot persist on its own:

```tsx
  function handlePhoneSetChange(next: {
    provider_id: number;
    phone_ids: number[];
  }) {
    setValue(next);
    if (next.phone_ids.length > 0) {
      void savePatch({ rule_type: ruleType, operator, value: next });
    }
  }
```

Pass `onPhoneSetChange={handlePhoneSetChange}` where the other handlers are passed.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx eslint components/segments/rules-panel.tsx`
Expected: the pre-existing baseline of **10 problems (4 errors, 6 warnings)** and no more. If the count rose, the new effect is calling setState in an effect body — move it into an event handler.

- [ ] **Step 6: Verify in the browser**

Start `npm run dev`, open a segment's Rules tab, and confirm on a **new** rule (do not mutate an existing production rule):

1. "Sent from phone number" appears in the rule-type search.
2. Choosing it shows a provider select and no numbers picker.
3. Picking a provider reveals only that provider's numbers.
4. The row shows the amber incomplete border until a number is ticked.
5. Ticking a number fires one `PATCH` returning 200, and the preview count refreshes.
6. Switching provider clears the numbers.
7. Reloading the page renders the saved numbers as labels (proves `refs`).
8. Delete the test rule afterwards.

- [ ] **Step 7: Commit**

```bash
git add components/segments/rules-panel.tsx
git commit -m "feat(segments): provider + numbers picker for the sent-from-phone rule"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `docs/03-data-model.md`, `docs/04-features/audience-segments.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: none.

- [ ] **Step 1: Update the data model**

In `docs/03-data-model.md`, add `sent_from_provider_phone` to any enumerated rule-type list, document the new index `stage_sends_org_provider_phone_sent_idx`, and note that `stage_sends.provider_phone_id` is now fully populated (backfilled 2026-08-12; NULL only for rows that predate a future column change). Update the Mermaid ERD if it depicts `stage_sends` indexes.

- [ ] **Step 2: Update the feature doc**

In `docs/04-features/audience-segments.md`, add a row to the rule-type table:

```markdown
| `sent_from_provider_phone` | `{provider_id, phone_ids[]}` | were sent at least one message (`status='sent'`) from any of the chosen numbers |
```

Add a bullet under §5 UI surface describing the provider-then-numbers picker, and a bullet under §7 recording the known limitation (the two dominant numbers match 462K / 334K contacts and may approach the 10s preview timeout, degrading to `truncated`).

- [ ] **Step 3: Update conventions and CLAUDE.md**

In `docs/07-conventions.md` and `CLAUDE.md` §10e, record that `status = 'sent'` is the single definition of "was messaged" shared by the reports, the breakers and this rule — and that set-shaped rule values must be registered in **four** places: `RULE_TYPES`, `validateValueByShape`, `isRuleComplete`, and `verifyValueOwnership`. Missing the last two is exactly how `phone_type`/`carrier` shipped broken.

- [ ] **Step 4: Append the changelog entry**

Add to the top of `docs/CHANGELOG.md`:

```markdown
## 2026-08-12 — Segment rule: "Sent from phone number" (0129) — docs: 03-data-model, 04-features/audience-segments, 07-conventions, CHANGELOG
- New rule type `sent_from_provider_phone`, value `{provider_id, phone_ids[]}`, operators is/is_not. Counts only `stage_sends.status='sent'`, matching the reports. Eval is a single index-only scan of `stage_sends_org_provider_phone_sent_idx` (0129).
- Backfilled 1,008,689 pre-0112 `stage_sends.provider_phone_id` rows from their stage (100% resolvable, 3 numbers) so the rule sees the full send history rather than only post-2026-07-20 sends.
- Fixed a latent bug from 0098: set-shaped values (`phone_type`, `carrier`) were rejected by `verifyValueOwnership` and dropped by `isRuleComplete`. Both rule types were uncreatable; prod had zero.
```

- [ ] **Step 5: Update the "last updated" date on every doc touched**

Set `_Last updated: 2026-08-12_` in each modified doc.

- [ ] **Step 6: Full verification sweep**

Run: `npx tsc --noEmit` → clean.
Run: `npx eslint components/segments/rules-panel.tsx lib/segment-rules-eval.ts lib/validators/segment-rules.ts lib/validators/segment-rule-types.ts lib/api/segment-rule-value-ownership.ts "app/api/segments/[id]/rules/route.ts" app/api/provider-phones/list/route.ts` → no new problems beyond the `rules-panel.tsx` baseline of 10.
Run: `npm run build` → exit 0.
Run: `npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts` → `ALL PASS`.
Run: `npx tsx scripts/verify-migration-integrity.ts` → clean chain.

- [ ] **Step 7: Commit and open the PR**

```bash
git add docs CLAUDE.md
git commit -m "docs(segments): sent-from-phone rule, 0129, and the 0098 set-shape fix"
git push -u origin feat/segment-rule-sent-from-phone
```

PR body must state what was verified, the measured `EXPLAIN` timing from Task 5 Step 5, that migration 0129 and the backfill were applied to production and when, and the previous production deployment id as the rollback target.

---

## Self-Review

**Spec coverage:** semantics → Tasks 3, 5. `status='sent'` → Task 5. No time window → Task 3 (no period key). Migration 0129 → Task 1. Backfill → Task 2. Eval → Task 5. Validation → Tasks 3, 4. API `refs` + `include_archived` → Task 6. UI → Task 7. Testing → Tasks 3–5. Docs → Task 8. Known limitation → Tasks 5, 8. Out-of-scope items are absent from every task.

**Added beyond the spec:** Task 4's fix for the pre-existing `phone_type`/`carrier` breakage. Discovered while reading `isRuleComplete`; unavoidable because `provider_phone_set` fails on the identical code path. Flagged to the user separately.

**Type consistency:** `ProviderPhoneSet = {provider_id: number; phone_ids: number[]}` and `isProviderPhoneSet` are defined in Task 3 and used under those exact names in Tasks 4, 5, 6, 7. `intArrayLiteral` is defined and used in Task 5. `PhoneOption` is defined and used in Task 7. `refs: Info[] | null` is produced in Task 6 and consumed in Task 7 Step 6.
