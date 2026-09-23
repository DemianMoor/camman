# Contact lifecycle — PR 2a (Settings → Lifecycle, group overrides, preview counts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lifecycle thresholds editable — an org-level Settings page (six thresholds + the engine switch) and four per-group overrides on the contact-group form — each gated on `lifecycle.configure`, audited, and each able to preview what the change would do before it is saved.

**Architecture:** The rules stay in one place. The preview evaluates the SAME `evaluationSelectSql` over the **stored** `contact_engagement` facts with the proposed thresholds injected — no recount of `stage_sends`, so it costs a single pass instead of the backfill's 121 s. The threshold-resolution SQL that PR 1 inlined in `refresh.ts` is extracted first, so the job and the preview cannot drift.

**Tech Stack:** Next.js 16 route handlers + server pages · Drizzle `sql` templates · react-hook-form + Zod on the group form · shadcn/ui (`Switch`, `AlertDialog`, `Card`) · tsx tests against the preview DB.

**Spec:** [2026-09-22-contact-lifecycle-status-design.md](../specs/2026-09-22-contact-lifecycle-status-design.md) §3.3, §6. PR 1 shipped the data layer ([2026-09-22-contact-lifecycle-pr1.md](2026-09-22-contact-lifecycle-pr1.md)).

## Global Constraints

- **Worktree:** `C:\AFF\camman\.claude\worktrees\lifecycle-recon`, branch `feat/contact-lifecycle-p2` (already cut from merged main `2c388aa5`). Absolute paths in shell commands.
- **No migration.** Every table and column this PR needs shipped in 0187. If something seems to need DDL, stop and ask.
- **Not in this PR** (they are PR 2b): the contacts list column and filter, the contact detail panel, the Prepare stamp, and the "Global suppression" relabel.
- **The owner's decisions (2026-09-23):**
  - the engine switch **is** on the Settings page, gated on `lifecycle.configure`, behind a confirm dialog that says what turning it off does: statuses stop updating, and PR 4's eligibility will read stale statuses as-is. The script path stays.
  - the preview evaluates stored facts with proposed thresholds injected. **Measure before building the UI.** If it lands over **10 s**, it becomes a cached/background result with a spinner — never a raised timeout.
- **One definition.** Status is only ever evaluated through `evaluationSelectSql`; threshold resolution only ever through the builder extracted in Task 1. No second copy.
- **Ranges mirror the database.** `lifecycle_settings_ranges_check` (incl. `warm_days > hot_days`) and `contact_groups_lifecycle_overrides_check`. The Zod schemas restate them; the DB is the backstop.
- **Permissions:** `lifecycle.configure` (manager+) already exists and is already declared in the permission matrix's additions. Server routes check it with `can(role, …)`; the client hides/disables with `useAuth().can(…)`.
- **Every new API route needs a key in `OPERATOR_ROUTE_MAP`** (`null` = operator denied), or `npm run check:authz` fails.
- **Tests** run on the preview DB only (`_env-preload` then `_require-preview-db`), with `npx tsx --conditions=react-server`. Preview DB env prefix: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)"`.
- **Lint only changed files.** Docs are part of done. Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Responsibility |
|---|---|
| `lib/engagement/thresholds-sql.ts` | **New.** Builds `eng_org_thr` / `eng_grp_thr`, with optional proposed org values and one proposed group override |
| `lib/engagement/refresh.ts` | Modify: use the extracted builder (behaviour identical) |
| `lib/engagement/preview.ts` | **New.** `previewLifecycleThresholds()` over stored facts |
| `lib/engagement/settings-io.ts` | **New.** `loadLifecycleSettings` / `saveLifecycleSettings` (+ audit rows) |
| `app/api/settings/lifecycle/route.ts` | **New.** GET + PUT (thresholds, engine_mode), audited |
| `app/api/settings/lifecycle/preview/route.ts` | **New.** POST proposed values → counts |
| `app/(protected)/settings/lifecycle/{page,layout}.tsx` | **New.** Server page + permission guard |
| `components/settings/lifecycle-settings.tsx` | **New.** The form, the preview, the engine toggle |
| `components/protected/nav-config.ts` | Modify: Settings → Lifecycle entry |
| `lib/authz/route-map.ts` | Modify: two `null` keys |
| `lib/validators/contact-groups.ts` | Modify: four nullable override fields |
| `components/contact-groups/contact-group-form.tsx` | Modify: four fields + effective hints |
| `app/api/contact-groups/[id]/route.ts` | Modify: numeric null coercion, `lifecycle.configure` gate, effective thresholds in GET |
| `app/(protected)/contact-groups/{page,[id]/page}.tsx` | Modify: pass the four values through `initialValues` |
| `scripts/test-engagement-db.ts` | Modify: Part D — preview correctness |
| `scripts/measure-lifecycle-preview.ts` | **New.** Read-only prod measurement |
| `docs/…` | Feature doc, conventions, changelog |

---

### Task 1: Extract the threshold-resolution SQL

**Files:**
- Create: `lib/engagement/thresholds-sql.ts`
- Modify: `lib/engagement/refresh.ts` (replace the inline `thresholds` phase)

**Interfaces:**
- Produces:
```ts
export type GroupOverrideKey =
  | "freeze_after_messages" | "freeze_cadence_days"
  | "suppress_after_days" | "suppress_min_freeze_messages";
export const GROUP_OVERRIDE_KEYS: readonly GroupOverrideKey[];
export interface ThresholdSourceOptions {
  /** Proposed org values. Omitted ⇒ read the org's lifecycle_settings row (or the code defaults). */
  proposedOrg?: LifecycleThresholds;
  /** Proposed override for ONE group; a null value means "cleared, inherit the org value". */
  proposedGroup?: { groupId: number; overrides: Partial<Record<GroupOverrideKey, number | null>> };
}
/** Creates the ON COMMIT DROP temp tables `eng_org_thr` (1 row) and `eng_grp_thr` (per contact). */
export async function createThresholdTempTables(
  dbc: DbOrTx, orgId: string, opts?: ThresholdSourceOptions,
): Promise<void>;
```

- [ ] **Step 1: Write the failing test.** Add to `scripts/test-engagement-db.ts`, inside Part B's `try` block right after the `B2` bars (the world already has groups A/B/C/D and org cadence 21):

```ts
    // B2t — the extracted threshold builder resolves what the job stores.
    const thr = await import("@/lib/engagement/thresholds-sql");
    const resolved = await db.transaction(async (tx) => {
      await thr.createThresholdTempTables(tx, orgId);
      return (await tx.execute(sql`
        SELECT contact_id, freeze_after_messages, freeze_cadence_days,
               suppress_after_days, suppress_min_freeze_messages
        FROM eng_grp_thr ORDER BY contact_id`)) as unknown as Record<string, unknown>[];
    });
    const forContact = (c: C) => resolved.find((r) => r.contact_id === c.id);
    bar("B2t cCold: strictest across A (cadence 7) and B (inherits 21) ⇒ 21",
      n(forContact(cCold)?.freeze_cadence_days) === 21, JSON.stringify(forContact(cCold)));
    bar("B2t cD: group D's 8 / 30 / 1 win over the org's 10 / 60 / 2",
      n(forContact(cD)?.freeze_after_messages) === 8 && n(forContact(cD)?.suppress_after_days) === 30 &&
      n(forContact(cD)?.suppress_min_freeze_messages) === 1, JSON.stringify(forContact(cD)));
    bar("B2t cBot: only group is archived ⇒ not in the per-contact table at all",
      forContact(cBot) === undefined);
    const proposed = await db.transaction(async (tx) => {
      await thr.createThresholdTempTables(tx, orgId, {
        proposedOrg: { hot_days: 30, warm_days: 120, freeze_after_messages: 5,
                       freeze_cadence_days: 21, suppress_after_days: 60, suppress_min_freeze_messages: 2 },
        proposedGroup: { groupId: GD, overrides: { freeze_after_messages: null } },
      });
      return (await tx.execute(sql`
        SELECT (SELECT freeze_after_messages FROM eng_org_thr) AS org_fam,
               (SELECT freeze_after_messages FROM eng_grp_thr WHERE contact_id = ${cD.id}::uuid) AS cd_fam
      `)) as unknown as { org_fam: number; cd_fam: number }[];
    });
    bar("B2t proposed org value is used instead of the saved row", n(proposed[0].org_fam) === 5, JSON.stringify(proposed[0]));
    bar("B2t clearing group D's override falls back to the proposed org value", n(proposed[0].cd_fam) === 5, JSON.stringify(proposed[0]));
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd /c/AFF/camman/.claude/worktrees/lifecycle-recon && DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts`
Expected: `Cannot find module '@/lib/engagement/thresholds-sql'`.

- [ ] **Step 3: Write `lib/engagement/thresholds-sql.ts`.**

```ts
import { sql, type SQL } from "drizzle-orm";

import {
  DEFAULT_LIFECYCLE_THRESHOLDS as D,
  type LifecycleThresholds,
} from "@/lib/engagement/constants";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// EFFECTIVE THRESHOLDS (spec §3.3) — the one resolution, shared by the job
// (lib/engagement/refresh.ts) and the settings preview (lib/engagement/preview.ts).
//
//   org value   = the org's lifecycle_settings row, else the code defaults
//   contact     = the STRICTEST value across the contact's ACTIVE groups:
//                 lowest freeze_after_messages, LONGEST freeze_cadence_days,
//                 shortest suppress_after_days, lowest suppress_min_freeze_messages.
//                 A group with a blank override contributes the org value, so a
//                 contact in one overriding group and one plain group gets the
//                 org value wherever the plain group is stricter.
//   hot_days / warm_days are org-wide; no per-group column exists.
//
// Only contacts that belong to at least one active group CARRYING an override
// land in eng_grp_thr; everyone else reads the org row, so this costs nothing
// until somebody sets an override.
// =============================================================================

export type GroupOverrideKey =
  | "freeze_after_messages"
  | "freeze_cadence_days"
  | "suppress_after_days"
  | "suppress_min_freeze_messages";

export const GROUP_OVERRIDE_KEYS: readonly GroupOverrideKey[] = [
  "freeze_after_messages",
  "freeze_cadence_days",
  "suppress_after_days",
  "suppress_min_freeze_messages",
] as const;

export interface ThresholdSourceOptions {
  /** Proposed org values (the settings preview). Omitted ⇒ the saved row. */
  proposedOrg?: LifecycleThresholds;
  /** Proposed override for ONE group (the group form's preview). null ⇒ cleared. */
  proposedGroup?: {
    groupId: number;
    overrides: Partial<Record<GroupOverrideKey, number | null>>;
  };
}

/** `g.<key>`, or the proposed value when this row is the group being previewed. */
function groupValue(key: GroupOverrideKey, opts?: ThresholdSourceOptions): SQL {
  const col = sql.raw(`g.${key}`);
  const p = opts?.proposedGroup;
  if (!p || !(key in p.overrides)) return col;
  const v = p.overrides[key];
  return sql`CASE WHEN g.id = ${p.groupId} THEN ${v ?? null}::smallint ELSE ${col} END`;
}

/**
 * Creates `eng_org_thr` (one row) and `eng_grp_thr` (one row per contact that has
 * an override in force). ON COMMIT DROP, so the CALLER owns the transaction.
 */
export async function createThresholdTempTables(
  dbc: DbOrTx,
  orgId: string,
  opts?: ThresholdSourceOptions,
): Promise<void> {
  const org = sql`${orgId}::uuid`;
  const p = opts?.proposedOrg;
  await dbc.execute(
    p
      ? sql`
        CREATE TEMP TABLE eng_org_thr ON COMMIT DROP AS
        SELECT ${p.hot_days}::int AS hot_days,
               ${p.warm_days}::int AS warm_days,
               ${p.freeze_after_messages}::int AS freeze_after_messages,
               ${p.freeze_cadence_days}::int AS freeze_cadence_days,
               ${p.suppress_after_days}::int AS suppress_after_days,
               ${p.suppress_min_freeze_messages}::int AS suppress_min_freeze_messages`
      : sql`
        CREATE TEMP TABLE eng_org_thr ON COMMIT DROP AS
        SELECT coalesce(ls.hot_days, ${D.hot_days})::int AS hot_days,
               coalesce(ls.warm_days, ${D.warm_days})::int AS warm_days,
               coalesce(ls.freeze_after_messages, ${D.freeze_after_messages})::int AS freeze_after_messages,
               coalesce(ls.freeze_cadence_days, ${D.freeze_cadence_days})::int AS freeze_cadence_days,
               coalesce(ls.suppress_after_days, ${D.suppress_after_days})::int AS suppress_after_days,
               coalesce(ls.suppress_min_freeze_messages, ${D.suppress_min_freeze_messages})::int AS suppress_min_freeze_messages
        FROM (SELECT 1) one
        LEFT JOIN lifecycle_settings ls ON ls.org_id = ${org}`,
  );

  const fam = groupValue("freeze_after_messages", opts);
  const fcd = groupValue("freeze_cadence_days", opts);
  const sad = groupValue("suppress_after_days", opts);
  const smm = groupValue("suppress_min_freeze_messages", opts);
  // Membership of the aggregate is judged on the SAVED overrides, not the
  // proposed ones: a preview that adds this org's FIRST override still has to
  // reach the contacts of the group being edited.
  const hasSavedOverride = sql`(g2.freeze_after_messages IS NOT NULL OR g2.freeze_cadence_days IS NOT NULL
                                OR g2.suppress_after_days IS NOT NULL OR g2.suppress_min_freeze_messages IS NOT NULL)`;
  const previewedGroup = opts?.proposedGroup
    ? sql` OR g2.id = ${opts.proposedGroup.groupId}`
    : sql``;
  await dbc.execute(sql`
    CREATE TEMP TABLE eng_grp_thr ON COMMIT DROP AS
    SELECT ccg.contact_id,
           min(coalesce(${fam}, o.freeze_after_messages))::int AS freeze_after_messages,
           max(coalesce(${fcd}, o.freeze_cadence_days))::int AS freeze_cadence_days,
           min(coalesce(${sad}, o.suppress_after_days))::int AS suppress_after_days,
           min(coalesce(${smm}, o.suppress_min_freeze_messages))::int AS suppress_min_freeze_messages,
           coalesce(array_agg(g.id ORDER BY g.id) FILTER (
             WHERE g.freeze_after_messages IS NOT NULL OR g.freeze_cadence_days IS NOT NULL
                OR g.suppress_after_days IS NOT NULL OR g.suppress_min_freeze_messages IS NOT NULL
           ), '{}')::int[] AS override_group_ids
    FROM contact_contact_groups ccg
    JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
    CROSS JOIN eng_org_thr o
    WHERE ccg.org_id = ${org}
      AND ccg.contact_id IN (
        SELECT ccg2.contact_id FROM contact_contact_groups ccg2
        JOIN contact_groups g2 ON g2.id = ccg2.contact_group_id AND g2.status = 'active' AND g2.org_id = ${org}
        WHERE ccg2.org_id = ${org} AND (${hasSavedOverride}${previewedGroup}))
    GROUP BY ccg.contact_id`);
  await dbc.execute(sql`ANALYZE eng_grp_thr`);
}
```

- [ ] **Step 4: Use it from the job.** In `lib/engagement/refresh.ts`, replace the whole body of the `await phase("thresholds", …)` block (the two `CREATE TEMP TABLE eng_org_thr` / `eng_grp_thr` statements and the `ANALYZE`) with:

```ts
  await phase("thresholds", () => createThresholdTempTables(dbc, orgId));
```

and add the import:

```ts
import { createThresholdTempTables } from "@/lib/engagement/thresholds-sql";
```

Delete the now-unused `D` import **only if** nothing else in the file uses it (it will not be used after this change — check with `grep -n "D\." lib/engagement/refresh.ts`).

- [ ] **Step 5: Prove the refactor changed nothing.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -3
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts | tail -6
```
Expected: tsc silent; every Part A/B/C bar still green **plus** the five new B2t bars; `All checks passed.` The job's own bars (B2–B7) passing is the regression gate — they assert the exact stored thresholds.

- [ ] **Step 6: Commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git add lib/engagement/thresholds-sql.ts lib/engagement/refresh.ts scripts/test-engagement-db.ts
git commit -m "refactor(engagement): extract effective-threshold SQL so the job and the preview share one resolution

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The preview, and its measurement

**Files:**
- Create: `lib/engagement/preview.ts`, `scripts/measure-lifecycle-preview.ts`
- Modify: `scripts/test-engagement-db.ts` (Part D), `scripts/test-preview-db-guard.ts` (EXCLUSIONS entry for the measurement script)

**Interfaces:**
- Consumes: `createThresholdTempTables` (Task 1), `evaluationSelectSql` + `ENGAGEMENT_STATUSES`.
- Produces:
```ts
export interface LifecyclePreviewResult {
  evaluated: number;
  currentCounts: Record<EngagementStatus, number>;
  projectedCounts: Record<EngagementStatus, number>;
  transitions: Record<string, number>; // "cold→freeze": 12345
  durationMs: number;
}
export async function previewLifecycleThresholds(
  dbc: DbOrTx, orgId: string,
  opts: ThresholdSourceOptions & { asOf?: Date },
): Promise<LifecyclePreviewResult>;
```

- [ ] **Step 1: Write the failing test.** Append Part D to `scripts/test-engagement-db.ts`, immediately after Part C's block and before the final `console.log(fail === 0 …)`. It builds nothing new: it re-uses Part B's world, so move Part D **inside** Part B's `try`, right after the `B7` bars.

```ts
    // ── PART D — the settings preview over STORED facts ──────────────────────
    // The world's state after B7: cNew cold, cCold warm, cFreeze suppressed,
    // cHot warm, cWarm warm, cBot cold (3 msgs), cD freeze (8 msgs), cOpt cold (1 msg).
    console.log("\nPART D — previewLifecycleThresholds");
    const { previewLifecycleThresholds } = await import("@/lib/engagement/preview");
    const preview = (opts: Parameters<typeof previewLifecycleThresholds>[2]) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
        return previewLifecycleThresholds(tx, orgId, opts);
      });
    const SAVED = { hot_days: 30, warm_days: 120, freeze_after_messages: 10,
                    freeze_cadence_days: 21, suppress_after_days: 60, suppress_min_freeze_messages: 2 };
    const d0 = await preview({ proposedOrg: SAVED, asOf: A4 });
    bar("D1 proposing the saved values changes nobody",
      Object.keys(d0.transitions).length === 0 && d0.evaluated === 8, JSON.stringify(d0));
    bar("D1 current counts are the stored ones",
      d0.currentCounts.cold === 3 && d0.currentCounts.warm === 3 && d0.currentCounts.freeze === 1 &&
      d0.currentCounts.suppressed === 1, JSON.stringify(d0.currentCounts));
    // Only cBot has ≥3 messages since its last click (3); cNew and cOpt have 1 each,
    // and the three warm contacts are decided by their click before any message
    // count is consulted. So exactly one contact moves, and freeze goes 1 → 2.
    const d1 = await preview({ proposedOrg: { ...SAVED, freeze_after_messages: 3 }, asOf: A4 });
    bar("D2 lowering freeze_after_messages to 3 freezes only the 3-message contact",
      d1.transitions["cold→freeze"] === 1 && d1.projectedCounts.freeze === 2, JSON.stringify(d1.transitions));
    const d2 = await preview({ proposedOrg: { ...SAVED, warm_days: 30 }, asOf: A4 });
    bar("D3 shrinking warm_days to 30 ages the warm contacts out",
      (d2.transitions["warm→cold"] ?? 0) + (d2.transitions["warm→freeze"] ?? 0) === 3, JSON.stringify(d2.transitions));
    const d3 = await preview({ proposedGroup: { groupId: GA, overrides: { freeze_after_messages: 1 } }, asOf: A4 });
    bar("D4 a group override reaches only that group's contacts (A = cNew, cCold)",
      (d3.transitions["cold→freeze"] ?? 0) === 1 && (d3.transitions["warm→freeze"] ?? 0) === 0,
      JSON.stringify(d3.transitions));
    bar("D5 the preview writes nothing",
      (await count("contact_engagement_transitions")) === 13 &&
      (await one<{ n: string }>(sql`SELECT count(*) AS n FROM contact_engagement WHERE org_id = ${org} AND status = 'freeze'`)).n === "1");
```

- [ ] **Step 2: Run it and watch it fail** with `Cannot find module '@/lib/engagement/preview'`.

- [ ] **Step 3: Write `lib/engagement/preview.ts`.**

```ts
import { sql, type SQL } from "drizzle-orm";

import { ENGAGEMENT_STATUSES, type EngagementStatus } from "@/lib/engagement/constants";
import { evaluationSelectSql } from "@/lib/engagement/status-sql";
import {
  createThresholdTempTables,
  type ThresholdSourceOptions,
} from "@/lib/engagement/thresholds-sql";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// "WHAT WOULD THIS THRESHOLD CHANGE DO?" (spec §6)
//
// The same evaluator the job uses, run over the STORED facts in
// contact_engagement with the proposed thresholds injected. It does NOT recount
// stage_sends — that is the backfill's 121-second pass, and the answer does not
// need it: thresholds move contacts between statuses given the facts as they
// are, and the facts are already stored.
//
// Contacts with NO contact_engagement row are deliberately not evaluated: they
// are `new` with zero messages, and no threshold can change that.
//
// Writes nothing. The caller owns the transaction (temp tables).
// =============================================================================

export interface LifecyclePreviewResult {
  evaluated: number;
  currentCounts: Record<EngagementStatus, number>;
  projectedCounts: Record<EngagementStatus, number>;
  /** Only rows that would MOVE, keyed "cold→freeze". */
  transitions: Record<string, number>;
  durationMs: number;
}

const zero = (): Record<EngagementStatus, number> =>
  Object.fromEntries(ENGAGEMENT_STATUSES.map((s) => [s, 0])) as Record<EngagementStatus, number>;

export async function previewLifecycleThresholds(
  dbc: DbOrTx,
  orgId: string,
  opts: ThresholdSourceOptions & { asOf?: Date },
): Promise<LifecyclePreviewResult> {
  const started = Date.now();
  const org = sql`${orgId}::uuid`;
  const asOf: SQL = opts.asOf ? sql`${opts.asOf.toISOString()}::timestamptz` : sql`now()`;
  await createThresholdTempTables(dbc, orgId, opts);

  // The evaluator's input columns, sourced from the stored row. The freeze clock
  // the evaluator calls "calc_*" is simply what is stored: no recount happened,
  // so nothing new was sent while this preview ran.
  const input = sql`(
    SELECT ce.contact_id,
           ce.status AS prev_status,
           ce.status_changed_at AS prev_status_changed_at,
           ce.freeze_entered_at AS prev_freeze_entered_at,
           ce.msgs_total, ce.msgs_since_click, ce.msgs_7d, ce.msgs_14d, ce.msgs_30d, ce.msgs_90d,
           ce.first_sent_at, ce.last_sent_at, ce.first_click_at, ce.last_click_at,
           ce.freeze_started_at AS calc_freeze_started_at,
           ce.freeze_msgs AS calc_freeze_msgs,
           o.hot_days, o.warm_days,
           coalesce(g.freeze_after_messages, o.freeze_after_messages) AS freeze_after_messages,
           coalesce(g.freeze_cadence_days, o.freeze_cadence_days) AS freeze_cadence_days,
           coalesce(g.suppress_after_days, o.suppress_after_days) AS suppress_after_days,
           coalesce(g.suppress_min_freeze_messages, o.suppress_min_freeze_messages) AS suppress_min_freeze_messages,
           coalesce(g.override_group_ids, '{}'::int[]) AS override_group_ids
    FROM contact_engagement ce
    LEFT JOIN eng_grp_thr g ON g.contact_id = ce.contact_id
    CROSS JOIN eng_org_thr o
    WHERE ce.org_id = ${org}
  )`;

  const rows = (await dbc.execute(sql`
    SELECT prev_status, status, count(*)::int AS n
    FROM (${evaluationSelectSql(input, asOf, "first_seen")}) p
    GROUP BY 1, 2
  `)) as unknown as { prev_status: EngagementStatus; status: EngagementStatus; n: number }[];

  const currentCounts = zero();
  const projectedCounts = zero();
  const transitions: Record<string, number> = {};
  let evaluated = 0;
  for (const r of rows) {
    const n = Number(r.n);
    evaluated += n;
    currentCounts[r.prev_status] += n;
    projectedCounts[r.status] += n;
    if (r.prev_status !== r.status) transitions[`${r.prev_status}→${r.status}`] = n;
  }
  return { evaluated, currentCounts, projectedCounts, transitions, durationMs: Date.now() - started };
}
```

- [ ] **Step 4: Run the test; every Part D bar green.** Command as in Task 1 Step 5.

- [ ] **Step 5: Write the measurement script** `scripts/measure-lifecycle-preview.ts`:

```ts
import "./_env-preload";

// READ-ONLY measurement of the lifecycle settings preview against production.
// Runs previewLifecycleThresholds inside a transaction that is always rolled
// back, three times (cold, warm, group-scoped), and prints the timings the
// settings screen will have to live with. Listed in EXCLUSIONS of
// scripts/test-preview-db-guard.ts: it reads prod deliberately and writes nothing.
//
// Run: npx tsx --conditions=react-server scripts/measure-lifecycle-preview.ts

import { sql } from "drizzle-orm";

class RolledBack extends Error {
  constructor(public readonly payload: unknown) {
    super("rolled back");
  }
}

async function main() {
  const { db } = await import("@/db/client");
  const { previewLifecycleThresholds } = await import("@/lib/engagement/preview");
  const { DEFAULT_LIFECYCLE_THRESHOLDS } = await import("@/lib/engagement/constants");
  type R = Awaited<ReturnType<typeof previewLifecycleThresholds>>;

  const orgs = (await db.execute(sql`SELECT id FROM organizations ORDER BY created_at`)) as unknown as { id: string }[];
  if (orgs.length !== 1) throw new Error(`${orgs.length} organizations — this script assumes one`);
  const orgId = orgs[0].id;

  const run = async (label: string, opts: Parameters<typeof previewLifecycleThresholds>[2]) => {
    let out: R | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
        throw new RolledBack(await previewLifecycleThresholds(tx, orgId, opts));
      });
    } catch (e) {
      if (!(e instanceof RolledBack)) throw e;
      out = e.payload as R;
    }
    console.log(`${label}: ${out!.durationMs} ms, evaluated ${out!.evaluated}, moves ${JSON.stringify(out!.transitions)}`);
    return out!;
  };

  await run("1 saved values (cold cache)", { proposedOrg: DEFAULT_LIFECYCLE_THRESHOLDS });
  await run("2 saved values (warm cache)", { proposedOrg: DEFAULT_LIFECYCLE_THRESHOLDS });
  await run("3 freeze_after_messages 10 → 8", {
    proposedOrg: { ...DEFAULT_LIFECYCLE_THRESHOLDS, freeze_after_messages: 8 },
  });
  console.log("\nNothing was written (every run rolled back).");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Register it in `scripts/test-preview-db-guard.ts` EXCLUSIONS, alphabetically:

```ts
  { file: "measure-lifecycle-preview.ts", viaLibrary: true, why: "read-only production measurement of the lifecycle settings preview; every run is inside a transaction that always rolls back (computes via lib/engagement/preview, so it carries no write token of its own)" },
```

- [ ] **Step 6: MEASURE, and let the number decide the UI.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npm run check:guards 2>&1 | tail -2
npx tsx --conditions=react-server scripts/measure-lifecycle-preview.ts
```
Run it off `:29/:59` (pools), `:11/:41` (fresh counts), `:14` (creative lifetime) and the `*/5` marks.

**Record the warm-cache number and apply the owner's rule:**
- **≤ 10 s** → the preview route computes synchronously (Task 3 as written).
- **> 10 s** → keep the route synchronous but add the cache and the spinner: the POST hashes the proposed values (`sha256` of the canonical JSON), looks for a fresh (< 15 min) `operator_rollups` row with `rollup_key = 'lifecycle_preview:<hash>'`, returns it if present, otherwise computes, stores and returns. The client shows a spinner while it waits and re-uses the cached answer on re-open. **Do not raise any statement timeout**; if a single pass ever approaches the route's `maxDuration`, stop and ask rather than extending it.

Report the measured numbers to the owner before building the UI.

- [ ] **Step 7: Commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint lib/engagement/preview.ts scripts/measure-lifecycle-preview.ts scripts/test-engagement-db.ts scripts/test-preview-db-guard.ts
git add lib/engagement/preview.ts scripts/measure-lifecycle-preview.ts scripts/test-engagement-db.ts scripts/test-preview-db-guard.ts
git commit -m "feat(engagement): threshold-change preview over stored facts + prod measurement

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The settings API

**Files:**
- Create: `lib/engagement/settings-io.ts`, `app/api/settings/lifecycle/route.ts`, `app/api/settings/lifecycle/preview/route.ts`
- Modify: `lib/authz/route-map.ts`

**Interfaces:**
- Produces:
```ts
export interface LifecycleSettingsRow extends LifecycleThresholds {
  engine_mode: "off" | "write";
  updated_at: string | null;
  has_row: boolean;
}
export async function loadLifecycleSettings(dbc: DbOrTx, orgId: string): Promise<LifecycleSettingsRow>;
export async function saveLifecycleSettings(
  dbc: DbOrTx, orgId: string, patch: Partial<LifecycleThresholds & { engine_mode: "off" | "write" }>,
  actorUserId: string,
): Promise<{ row: LifecycleSettingsRow; changed: string[] }>;
```
- `GET /api/settings/lifecycle` → `LifecycleSettingsRow` + `{ defaults: LifecycleThresholds }`.
- `PUT /api/settings/lifecycle` → the saved row. Body: any subset of the six thresholds plus `engine_mode`.
- `POST /api/settings/lifecycle/preview` → `LifecyclePreviewResult`. Body: `{ thresholds?: LifecycleThresholds, group?: { group_id: number, overrides: {...} } }`.

- [ ] **Step 1: Write `lib/engagement/settings-io.ts`.**

```ts
import { sql } from "drizzle-orm";

import {
  DEFAULT_LIFECYCLE_THRESHOLDS,
  type LifecycleThresholds,
} from "@/lib/engagement/constants";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// Load / save for lifecycle_settings, the notification-settings pattern: a
// missing row reads as the code defaults, and a save is a read-merge-upsert.
// EVERY field change writes an org_setting_events row — the audit trail the
// owner asked for, and the same key space the backfill script writes
// ('lifecycle.engine_mode').

export type EngineMode = "off" | "write";

export interface LifecycleSettingsRow extends LifecycleThresholds {
  engine_mode: EngineMode;
  updated_at: string | null;
  /** false ⇒ the org has no row and is running on the defaults. */
  has_row: boolean;
}

const THRESHOLD_KEYS = Object.keys(DEFAULT_LIFECYCLE_THRESHOLDS) as (keyof LifecycleThresholds)[];

export async function loadLifecycleSettings(
  dbc: DbOrTx,
  orgId: string,
): Promise<LifecycleSettingsRow> {
  const rows = (await dbc.execute(sql`
    SELECT hot_days, warm_days, freeze_after_messages, freeze_cadence_days,
           suppress_after_days, suppress_min_freeze_messages, engine_mode,
           updated_at::text AS updated_at
    FROM lifecycle_settings WHERE org_id = ${orgId}::uuid
  `)) as unknown as (Record<string, unknown> | undefined)[];
  const r = rows[0];
  if (!r) {
    return { ...DEFAULT_LIFECYCLE_THRESHOLDS, engine_mode: "off", updated_at: null, has_row: false };
  }
  return {
    hot_days: Number(r.hot_days),
    warm_days: Number(r.warm_days),
    freeze_after_messages: Number(r.freeze_after_messages),
    freeze_cadence_days: Number(r.freeze_cadence_days),
    suppress_after_days: Number(r.suppress_after_days),
    suppress_min_freeze_messages: Number(r.suppress_min_freeze_messages),
    engine_mode: r.engine_mode === "write" ? "write" : "off",
    updated_at: (r.updated_at as string | null) ?? null,
    has_row: true,
  };
}

export async function saveLifecycleSettings(
  dbc: DbOrTx,
  orgId: string,
  patch: Partial<LifecycleThresholds & { engine_mode: EngineMode }>,
  actorUserId: string,
): Promise<{ row: LifecycleSettingsRow; changed: string[] }> {
  const before = await loadLifecycleSettings(dbc, orgId);
  const next = { ...before, ...patch };
  const changed = [...THRESHOLD_KEYS, "engine_mode" as const].filter(
    (k) => String(before[k]) !== String(next[k]),
  );
  if (changed.length === 0) return { row: before, changed };

  await dbc.execute(sql`
    INSERT INTO lifecycle_settings (org_id, hot_days, warm_days, freeze_after_messages,
      freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages,
      engine_mode, updated_at, updated_by)
    VALUES (${orgId}::uuid, ${next.hot_days}, ${next.warm_days}, ${next.freeze_after_messages},
      ${next.freeze_cadence_days}, ${next.suppress_after_days}, ${next.suppress_min_freeze_messages},
      ${next.engine_mode}, now(), ${actorUserId}::uuid)
    ON CONFLICT (org_id) DO UPDATE SET
      hot_days = EXCLUDED.hot_days, warm_days = EXCLUDED.warm_days,
      freeze_after_messages = EXCLUDED.freeze_after_messages,
      freeze_cadence_days = EXCLUDED.freeze_cadence_days,
      suppress_after_days = EXCLUDED.suppress_after_days,
      suppress_min_freeze_messages = EXCLUDED.suppress_min_freeze_messages,
      engine_mode = EXCLUDED.engine_mode, updated_at = now(), updated_by = EXCLUDED.updated_by
  `);
  for (const key of changed) {
    await dbc.execute(sql`
      INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
      VALUES (${orgId}::uuid, ${`lifecycle.${key}`}, ${String(before[key])}, ${String(next[key])}, ${actorUserId}::uuid)
    `);
  }
  // Ask the next job run to re-evaluate everyone from the stored facts.
  await dbc.execute(sql`
    UPDATE lifecycle_settings SET reevaluate_requested_at = now() WHERE org_id = ${orgId}::uuid
  `);
  return { row: await loadLifecycleSettings(dbc, orgId), changed };
}
```

> **Note for PR 2b/3:** `reevaluate_requested_at` is now written but nothing reads it yet — the 15-minute job re-evaluates time-due rows only. Wiring it into `refresh.ts` (re-evaluate ALL rows from stored facts when it is newer than the last run) is a one-branch change; it is out of scope here and is listed in the PR body as a known follow-up.

- [ ] **Step 2: Write `app/api/settings/lifecycle/route.ts`.**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES, apiError, requireApiMembership } from "@/lib/api/helpers";
import { DEFAULT_LIFECYCLE_THRESHOLDS } from "@/lib/engagement/constants";
import { loadLifecycleSettings, saveLifecycleSettings } from "@/lib/engagement/settings-io";
import { can } from "@/lib/permissions";

// Org-level lifecycle thresholds + the engine switch (migration 0187).
// Read: any member who can see campaigns. Write: lifecycle.configure (manager+),
// audited one org_setting_events row per changed field.
export const dynamic = "force-dynamic";

// Ranges mirror lifecycle_settings_ranges_check; the cross-field rule
// (warm_days > hot_days) is a refine because the DB expresses it in one CHECK.
const putSchema = z
  .object({
    hot_days: z.number().int().min(1).max(365).optional(),
    warm_days: z.number().int().min(2).max(730).optional(),
    freeze_after_messages: z.number().int().min(1).max(1000).optional(),
    freeze_cadence_days: z.number().int().min(1).max(365).optional(),
    suppress_after_days: z.number().int().min(1).max(730).optional(),
    suppress_min_freeze_messages: z.number().int().min(1).max(100).optional(),
    engine_mode: z.enum(["off", "write"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  return NextResponse.json({
    ...(await loadLifecycleSettings(db, orgId)),
    defaults: DEFAULT_LIFECYCLE_THRESHOLDS,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  if (!can(role, "lifecycle.configure")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = putSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid body", API_ERROR_CODES.VALIDATION);
  }
  // warm_days > hot_days is checked against the MERGED row, since either side
  // can be the one being changed. The DB CHECK is the backstop.
  const current = await loadLifecycleSettings(db, orgId);
  const merged = { ...current, ...parsed.data };
  if (merged.warm_days <= merged.hot_days) {
    return apiError(400, "Warm window must be longer than the hot window.", API_ERROR_CODES.VALIDATION);
  }
  const { row, changed } = await db.transaction((tx) =>
    saveLifecycleSettings(tx, orgId, parsed.data, user.id),
  );
  return NextResponse.json({ ...row, changed });
}
```

- [ ] **Step 3: Write `app/api/settings/lifecycle/preview/route.ts`.**

```ts
import { type NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES, apiError, requireApiMembership } from "@/lib/api/helpers";
import { previewLifecycleThresholds } from "@/lib/engagement/preview";
import { can } from "@/lib/permissions";

// "What would this threshold change do?" — the same evaluator the job uses, over
// the STORED facts, with the proposed values injected. Writes nothing.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const numOrNull = z.number().int().min(1).max(1000).nullable();
const bodySchema = z.object({
  thresholds: z
    .object({
      hot_days: z.number().int().min(1).max(365),
      warm_days: z.number().int().min(2).max(730),
      freeze_after_messages: z.number().int().min(1).max(1000),
      freeze_cadence_days: z.number().int().min(1).max(365),
      suppress_after_days: z.number().int().min(1).max(730),
      suppress_min_freeze_messages: z.number().int().min(1).max(100),
    })
    .optional(),
  group: z
    .object({
      group_id: z.number().int().positive(),
      overrides: z.object({
        freeze_after_messages: numOrNull.optional(),
        freeze_cadence_days: numOrNull.optional(),
        suppress_after_days: numOrNull.optional(),
        suppress_min_freeze_messages: numOrNull.optional(),
      }),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "lifecycle.configure")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid body", API_ERROR_CODES.VALIDATION);
  }
  if (parsed.data.thresholds && parsed.data.thresholds.warm_days <= parsed.data.thresholds.hot_days) {
    return apiError(400, "Warm window must be longer than the hot window.", API_ERROR_CODES.VALIDATION);
  }
  // The group being previewed must belong to this org — a preview must not be a
  // cross-tenant probe.
  if (parsed.data.group) {
    const owned = (await db.execute(sql`
      SELECT 1 FROM contact_groups WHERE id = ${parsed.data.group.group_id} AND org_id = ${orgId}::uuid
    `)) as unknown as unknown[];
    if (owned.length === 0) {
      return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND);
    }
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '55s'`);
    return previewLifecycleThresholds(tx, orgId, {
      proposedOrg: parsed.data.thresholds,
      proposedGroup: parsed.data.group
        ? { groupId: parsed.data.group.group_id, overrides: parsed.data.group.overrides }
        : undefined,
    });
  });
  return NextResponse.json(result);
}
```

If Task 2's measurement came in over 10 s, add the cache here exactly as described in Task 2 Step 6 before moving on.

- [ ] **Step 4: Route map.** In `lib/authz/route-map.ts`, in the alphabetical `settings/*` block:

```ts
  "settings/lifecycle": null, // settings -- lifecycle.configure (manager+); no operator path
  "settings/lifecycle/preview": null, // settings -- lifecycle.configure (manager+); no operator path
```

- [ ] **Step 5: Verify.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -3
npm run check:authz 2>&1 | tail -3
npx eslint lib/engagement/settings-io.ts app/api/settings/lifecycle/route.ts app/api/settings/lifecycle/preview/route.ts lib/authz/route-map.ts
```
Expected: tsc silent, `ALL PASS` from both authz scripts, eslint clean. Check `API_ERROR_CODES.NOT_FOUND` and `.VALIDATION` exist with those names in `lib/api/helpers.ts`; use the file's actual spellings if they differ.

- [ ] **Step 6: Commit.**

```bash
git add lib/engagement/settings-io.ts app/api/settings/lifecycle lib/authz/route-map.ts
git commit -m "feat(engagement): lifecycle settings API (thresholds + engine switch, audited) and preview endpoint

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The Settings page

**Files:**
- Create: `app/(protected)/settings/lifecycle/page.tsx`, `app/(protected)/settings/lifecycle/layout.tsx`, `components/settings/lifecycle-settings.tsx`
- Modify: `components/protected/nav-config.ts`

- [ ] **Step 1: The page and its guard.**

`app/(protected)/settings/lifecycle/layout.tsx`:

```tsx
import type { ReactNode } from "react";

import { requirePagePermission } from "@/lib/authz/page-guard";

// The settings subtree is already gated on providers.view; this narrows THIS
// page to the permission that actually governs it, so a viewer gets a 404
// rather than a form every control of which is disabled.
export default async function LifecycleSettingsLayout({ children }: { children: ReactNode }) {
  await requirePagePermission("lifecycle.configure");
  return <>{children}</>;
}
```

`app/(protected)/settings/lifecycle/page.tsx`:

```tsx
import type { Metadata } from "next";

import { LifecycleSettings } from "@/components/settings/lifecycle-settings";

export const metadata: Metadata = { title: "Lifecycle Settings" };

export default function LifecycleSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Lifecycle</h1>
        <p className="text-sm text-muted-foreground">
          The thresholds that decide each contact&apos;s status. Changes take effect on the
          next status run, never instantly — preview them first.
        </p>
      </header>
      <LifecycleSettings />
    </div>
  );
}
```

- [ ] **Step 2: The component** `components/settings/lifecycle-settings.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { ENGAGEMENT_STATUSES, type LifecycleThresholds } from "@/lib/engagement/constants";
import { useApiCall } from "@/lib/hooks/use-api-call";

type Settings = LifecycleThresholds & {
  engine_mode: "off" | "write";
  updated_at: string | null;
  has_row: boolean;
  defaults: LifecycleThresholds;
};
type Preview = {
  evaluated: number;
  currentCounts: Record<string, number>;
  projectedCounts: Record<string, number>;
  transitions: Record<string, number>;
  durationMs: number;
};

const FIELDS: { key: keyof LifecycleThresholds; label: string; help: string; min: number; max: number }[] = [
  { key: "hot_days", label: "Hot window (days)", min: 1, max: 365,
    help: "A human click this recent makes a contact hot. Applies to all groups." },
  { key: "warm_days", label: "Warm window (days)", min: 2, max: 730,
    help: "Past the hot window and within this one, a contact is warm. Applies to all groups." },
  { key: "freeze_after_messages", label: "Freeze after messages", min: 1, max: 1000,
    help: "Messages since the last click before a contact freezes. A contact group can override this." },
  { key: "freeze_cadence_days", label: "Freeze cadence (days)", min: 1, max: 365,
    help: "A frozen contact is eligible again only this long after its last message." },
  { key: "suppress_after_days", label: "Suppress after (days in freeze)", min: 1, max: 730,
    help: "Days since the first message sent while frozen before a contact is suppressed." },
  { key: "suppress_min_freeze_messages", label: "Suppress after (messages in freeze)", min: 1, max: 100,
    help: "Messages that must have been sent while frozen before suppression can happen." },
];

export function LifecycleSettings() {
  const { can } = useAuth();
  const canEdit = can("lifecycle.configure");
  const getApi = useApiCall<Settings>();
  const putApi = useApiCall<Settings>();
  const previewApi = useApiCall<Preview>();

  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<LifecycleThresholds | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmEngineOff, setConfirmEngineOff] = useState(false);

  const load = useCallback(async () => {
    const r = await getApi.execute("/api/settings/lifecycle");
    if (r.ok) {
      setSaved(r.data);
      setDraft({
        hot_days: r.data.hot_days, warm_days: r.data.warm_days,
        freeze_after_messages: r.data.freeze_after_messages,
        freeze_cadence_days: r.data.freeze_cadence_days,
        suppress_after_days: r.data.suppress_after_days,
        suppress_min_freeze_messages: r.data.suppress_min_freeze_messages,
      });
    } else toastApiError(r, "Could not load lifecycle settings");
  }, [getApi.execute]);
  useEffect(() => { void load(); }, [load]);

  const dirty = saved != null && draft != null &&
    FIELDS.some((f) => saved[f.key] !== draft[f.key]);

  async function runPreview() {
    if (!draft) return;
    setPreview(null);
    const r = await previewApi.execute("/api/settings/lifecycle/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholds: draft }),
    });
    if (r.ok) setPreview(r.data);
    else toastApiError(r, "Could not preview the change");
  }

  async function save(patch: Partial<LifecycleThresholds & { engine_mode: "off" | "write" }>) {
    const r = await putApi.execute("/api/settings/lifecycle", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      toast.success("Saved. The next status run will apply it.");
      setPreview(null);
      await load();
    } else toastApiError(r, "Could not save");
  }

  if (!saved || !draft) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>;
  }

  const busy = putApi.isLoading || previewApi.isLoading;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Thresholds</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {!saved.has_row && (
            <p className="text-sm text-muted-foreground">
              This organization has no saved row yet, so the values below are the defaults in force.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input id={f.key} type="number" min={f.min} max={f.max} disabled={!canEdit || busy}
                  value={draft[f.key]}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} />
                <p className="text-xs text-muted-foreground">
                  {f.help} Default {saved.defaults[f.key]}.
                </p>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => void runPreview()} disabled={!canEdit || busy || !dirty}>
              {previewApi.isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Preview changes
            </Button>
            <Button onClick={() => void save(draft)} disabled={!canEdit || busy || !dirty}>Save</Button>
            {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          </div>
          {preview && (
            <div className="rounded-md border p-3 text-sm">
              {Object.keys(preview.transitions).length === 0 ? (
                <p>No contact changes status under these values.</p>
              ) : (
                <ul className="space-y-1">
                  {Object.entries(preview.transitions)
                    .sort((a, b) => b[1] - a[1])
                    .map(([move, n]) => (
                      <li key={move}><span className="font-medium">{move.replace("→", " → ")}</span>{" "}{n.toLocaleString()}</li>
                    ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {preview.evaluated.toLocaleString()} contacts evaluated ·{" "}
                {ENGAGEMENT_STATUSES.map((s) => `${s} ${(preview.projectedCounts[s] ?? 0).toLocaleString()}`).join(" · ")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Status engine</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch id="engine" checked={saved.engine_mode === "write"} disabled={!canEdit || busy}
              onCheckedChange={(on) => (on ? void save({ engine_mode: "write" }) : setConfirmEngineOff(true))} />
            <Label htmlFor="engine">
              {saved.engine_mode === "write" ? "Running — statuses update every 15 minutes" : "Off — statuses are frozen"}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Turning this off stops the job. Existing statuses stay exactly as they are and go
            stale; nothing recomputes until it is turned back on.
          </p>
        </CardContent>
      </Card>

      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          You can view these settings but only a manager or owner can change them.
        </p>
      )}

      <AlertDialog open={confirmEngineOff} onOpenChange={(o) => !o && setConfirmEngineOff(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn the status engine off?</AlertDialogTitle>
            <AlertDialogDescription>
              Statuses stop updating: no contact moves to hot on a click, none freezes on its
              tenth message, and none is ever suppressed while this is off. Existing statuses
              are kept and go stale, and the campaign rules that read them will treat stale
              statuses as if they were current. The change is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmEngineOff(false); void save({ engine_mode: "off" }); }}>
              Turn it off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 3: Nav entry.** In `components/protected/nav-config.ts`, in the Settings group between Notifications and User Management, and add the icon to the `lucide-react` import block (alphabetically):

```tsx
      {
        label: "Lifecycle",
        href: "/settings/lifecycle",
        permission: "lifecycle.configure",
        icon: <Activity className="h-4 w-4" />,
      },
```
(Match the exact icon-rendering shape used by its neighbours — copy the Notifications entry and change the three fields.)

- [ ] **Step 4: Verify.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -3
npx eslint "app/(protected)/settings/lifecycle/page.tsx" "app/(protected)/settings/lifecycle/layout.tsx" components/settings/lifecycle-settings.tsx components/protected/nav-config.ts
npx next build 2>&1 | grep -E "settings/lifecycle|Compiled successfully|Failed" | head -5
```
Expected: tsc silent; eslint clean; the build lists `/settings/lifecycle` and `/api/settings/lifecycle`.

- [ ] **Step 5: Look at it.** Start the app and open `/settings/lifecycle` (use the `run` skill, or `npm run dev` on a free port). Check by eye: values load, Preview reports moves for a lowered `freeze_after_messages`, Save persists and the page reloads, the engine toggle's confirm dialog says what it should, and a fresh `org_setting_events` row exists per changed field:

```sql
SELECT setting_key, old_value, new_value FROM org_setting_events
WHERE setting_key LIKE 'lifecycle.%' ORDER BY id DESC LIMIT 5;
```
Use the **preview** database for this (point `DATABASE_URL` at `.env.demo` when starting the dev server) so no production row moves.

- [ ] **Step 6: Commit.**

```bash
git add "app/(protected)/settings/lifecycle" components/settings/lifecycle-settings.tsx components/protected/nav-config.ts
git commit -m "feat(engagement): Settings → Lifecycle (thresholds, preview, engine switch)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Per-group overrides

**Files:**
- Modify: `lib/validators/contact-groups.ts`, `components/contact-groups/contact-group-form.tsx`, `app/api/contact-groups/[id]/route.ts`, `app/(protected)/contact-groups/page.tsx`, `app/(protected)/contact-groups/[id]/page.tsx`

- [ ] **Step 1: Validator.** In `lib/validators/contact-groups.ts`, add to `contactGroupCreateSchema` (ranges mirror `contact_groups_lifecycle_overrides_check`; `.partial()` propagates them to the update schema):

```ts
  // Lifecycle overrides (migration 0187). null = inherit the org default.
  freeze_after_messages: z.number().int().min(1).max(1000).nullable().optional(),
  freeze_cadence_days: z.number().int().min(1).max(365).nullable().optional(),
  suppress_after_days: z.number().int().min(1).max(730).nullable().optional(),
  suppress_min_freeze_messages: z.number().int().min(1).max(100).nullable().optional(),
```

- [ ] **Step 2: PATCH route.** In `app/api/contact-groups/[id]/route.ts`:

(a) after the existing `contact_groups.update` check, add the narrower gate:

```ts
  const LIFECYCLE_KEYS = [
    "freeze_after_messages", "freeze_cadence_days",
    "suppress_after_days", "suppress_min_freeze_messages",
  ] as const;
  const touchesLifecycle = LIFECYCLE_KEYS.some((k) => k in parsed.data);
  if (touchesLifecycle && !can(role, "lifecycle.configure")) {
    return apiError(403, "Changing lifecycle overrides needs the lifecycle permission.",
      API_ERROR_CODES.FORBIDDEN);
  }
```
(place it directly after `parsed` exists, so a plain rename by someone without the permission still works).

(b) in the block that maps parsed fields into `updates`, add the four keys verbatim — they are numbers or `null`, so they need no string coercion:

```ts
  for (const k of LIFECYCLE_KEYS) {
    if (k in parsed.data) updates[k] = parsed.data[k] ?? null;
  }
```

(c) in `GET`, return the org's values alongside the row so the form can show "Effective: N":

```ts
  const orgThresholds = await loadLifecycleSettings(db, orgId);
  return NextResponse.json({ ...row, org_thresholds: orgThresholds });
```
(import `loadLifecycleSettings` from `@/lib/engagement/settings-io`.)

- [ ] **Step 3: The form.** In `components/contact-groups/contact-group-form.tsx`:

- extend `ContactGroupFormProps` with `orgThresholds?: { freeze_after_messages: number; freeze_cadence_days: number; suppress_after_days: number; suppress_min_freeze_messages: number }` and `canConfigureLifecycle?: boolean`;
- add the four keys to `defaultValues` (`initialValues?.freeze_after_messages ?? null`, etc.);
- after the `color` field, add one `<FormField>` per override, each an optional number input where empty means inherit:

```tsx
        {LIFECYCLE_FIELDS.map((f) => (
          <FormField
            key={f.name}
            control={form.control}
            name={f.name}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{f.label}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={f.min}
                    max={f.max}
                    placeholder={`Inherit (${orgThresholds?.[f.name] ?? "org default"})`}
                    disabled={!canConfigureLifecycle}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? null : Number(e.target.value))
                    }
                  />
                </FormControl>
                <FormDescription>
                  {field.value == null
                    ? `Effective: ${orgThresholds?.[f.name] ?? "—"} (org default)`
                    : `Effective: ${field.value} (this group)`}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          A contact in several groups takes the strictest value across all of them, not
          necessarily this one: the lowest freeze threshold, the longest cadence, and the
          shortest suppression window.
        </p>
```
with, above the component:

```tsx
const LIFECYCLE_FIELDS = [
  { name: "freeze_after_messages", label: "Freeze after messages", min: 1, max: 1000 },
  { name: "freeze_cadence_days", label: "Freeze cadence (days)", min: 1, max: 365 },
  { name: "suppress_after_days", label: "Suppress after (days in freeze)", min: 1, max: 730 },
  { name: "suppress_min_freeze_messages", label: "Suppress after (messages in freeze)", min: 1, max: 100 },
] as const;
```

- [ ] **Step 4: Both call sites.** In `app/(protected)/contact-groups/page.tsx` and `app/(protected)/contact-groups/[id]/page.tsx`, add the four keys to each `initialValues` literal (`?? null`), pass `canConfigureLifecycle={can("lifecycle.configure")}` (the list page already has `can` from `useAuth`; add it on the detail page if missing), and pass `orgThresholds` from the group GET response on the detail page. On the list page, which has no per-group GET, fetch the org thresholds once from `/api/settings/lifecycle` alongside the existing loads and pass the same object.

- [ ] **Step 5: Verify.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -3
npx eslint lib/validators/contact-groups.ts components/contact-groups/contact-group-form.tsx "app/api/contact-groups/[id]/route.ts" "app/(protected)/contact-groups/page.tsx" "app/(protected)/contact-groups/[id]/page.tsx"
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-contact-groups-api.ts 2>&1 | tail -4
```
Expected: tsc silent, eslint clean, the existing contact-groups API test still green (it proves the rename path did not regress).

Then, on the preview DB dev server: set an override on one group, save, and confirm with
`SELECT name, freeze_after_messages FROM contact_groups WHERE org_id = …;` — and that clearing the field writes NULL back.

- [ ] **Step 6: Commit.**

```bash
git add lib/validators/contact-groups.ts components/contact-groups/contact-group-form.tsx "app/api/contact-groups/[id]/route.ts" "app/(protected)/contact-groups/page.tsx" "app/(protected)/contact-groups/[id]/page.tsx"
git commit -m "feat(engagement): per-contact-group lifecycle overrides with effective-value hints

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

- [ ] **Step 1: `docs/04-features/contact-lifecycle.md`.** Under §5 "Switching it on", add a "Configuring it" section: the Settings page and what each threshold does, the group overrides and the strictest-wins rule, how the preview works (stored facts + injected values, no recount) and what it costs (**the measured number from Task 2**), the engine switch and what turning it off does, and that every change writes `org_setting_events` rows keyed `lifecycle.<field>`. Note that `reevaluate_requested_at` is written but not yet read. Bump the date.
- [ ] **Step 2: `docs/07-conventions.md`.** Extend the existing "Contact lifecycle status has exactly one definition" block with one bullet: threshold resolution has one implementation too (`lib/engagement/thresholds-sql.ts`), used by both the job and the preview; a preview that needs unsaved values injects them there rather than writing and rolling back. Bump the date.
- [ ] **Step 3: `docs/CHANGELOG.md`.** One dated line naming the new page, the API routes, the group overrides, the shared threshold builder and the docs touched.
- [ ] **Step 4: `npm run check:docs`** passes, and `git diff --stat origin/main -- docs/CHANGELOG.md` is a pure insertion. Commit.

---

### Task 7: Verify, rebase, PR

- [ ] **Step 1: Everything.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -3
npm run check:authz 2>&1 | tail -2
npm run check:docs 2>&1 | tail -2
npm run check:guards 2>&1 | tail -2
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts | tail -4
npx eslint $(git diff --name-only origin/main -- '*.ts' '*.tsx' | tr '\n' ' ')
npx next build 2>&1 | tail -5
```
Every one green. Keep the output for the PR body.

- [ ] **Step 2: Confirm the live job is unaffected.** The Task 1 refactor touched `refresh.ts`, which runs in production every 15 minutes. After the PR deploys, check that the next tick still reports `rowsWritten: 0` on a quiet minute and that `cron_locks.watermark` for `contact-engagement` keeps advancing. Before merge, the preview deploy plus the green fixture tests are the evidence.

- [ ] **Step 3: Rebase and open the PR.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git fetch origin --quiet && git rebase origin/main
git push -u origin feat/contact-lifecycle-p2
cat > /tmp/pr2a-body.md <<'EOF'
PR 2a of the contact lifecycle spec: the thresholds become editable. **No migration** — every table and column shipped in 0187.

- **Settings → Lifecycle** (`lifecycle.configure`, manager+): the six thresholds, a preview of what a change would do, and the engine switch behind a confirm dialog that says what turning it off means. Every changed field writes an `org_setting_events` row.
- **Per-contact-group overrides**: the four freeze/suppression fields on the group form, blank = inherit, each showing its effective value, with the strictest-wins rule stated.
- **Preview**: the same `evaluationSelectSql` the job uses, run over the STORED facts with the proposed values injected — no `stage_sends` recount. Measured on prod: <PASTE the Task 2 numbers>.
- **Shared threshold resolution**: PR 1 inlined it in `refresh.ts`; it now lives in `lib/engagement/thresholds-sql.ts` and both the job and the preview call it. The SQL is unchanged — the PR 1 fixture tests assert the exact stored thresholds and stay green.

Known follow-up, deliberately not here: `reevaluate_requested_at` is now written on every save but nothing reads it yet, so a threshold change lands on the next run that touches a contact rather than re-evaluating everyone. Wiring it into `refresh.ts` is a one-branch change and belongs with PR 3.

Not in this PR (they are PR 2b): the contacts list column and filter, the contact detail panel, the Prepare stamp, and the "Global suppression" relabel.

Verified: <PASTE the Task 7 Step 1 results>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr create --base main --head feat/contact-lifecycle-p2 --title "feat(engagement): contact lifecycle PR 2a — Settings, group overrides, threshold preview" --body-file /tmp/pr2a-body.md
```
Report any rebase conflict instead of resolving it silently. Fill both `<PASTE …>` placeholders with real output before creating the PR.
