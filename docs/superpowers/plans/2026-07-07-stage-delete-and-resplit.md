# Stage hard-delete + re-split unblock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators hard-delete stages that hold no send/result data, and make both split kinds (A/B and behavioral) re-splittable after their extra variants are archived or deleted.

**Architecture:** Two small guard fixes (behavioral + A/B) so archived siblings/lanes stop blocking re-splits; a new `deleteStage` core (factored like `performBehavioralSplit`) behind a thin `DELETE` route, gated to "no send data"; a UI Delete action. No schema change — relies on existing `ON DELETE CASCADE` / `SET NULL` FKs and the existing `split_index`/`split_total` columns.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle ORM (raw `sql` executor) · Postgres (Supabase) · hand-written `tsx` test scripts (no jest/vitest).

**Spec:** [docs/superpowers/specs/2026-07-07-stage-delete-and-resplit-design.md](../specs/2026-07-07-stage-delete-and-resplit-design.md)

## Global Constraints

- **Multi-tenancy:** every stage query filters by `org_id` (and `campaign_id` for stage-scoped routes). Non-negotiable.
- **No migration:** do not add columns, constraints, or migration files. If you think you need one, stop and re-read the spec.
- **Permission tier:** `stages.delete` lives at **manager+** (same as every other `.delete`).
- **Executor type** (reuse verbatim where a fn takes db-or-tx):
  `type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];`
- **Test-data safety:** every test seeds under a throwaway org whose `name` starts with a unique marker; teardown is scoped to that `org_id` only after asserting the marker; capture real-table counts before and assert no drift after. Copy the pattern from [scripts/test-behavioral-split.ts](../../../scripts/test-behavioral-split.ts).
- **Run a test:** `npx tsx scripts/<name>.ts` (exits non-zero on failure).
- **Typecheck:** `npx tsc --noEmit -p tsconfig.json`. **Lint:** `npx eslint <files>`.
- **Commit message trailer:** end every commit with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Behavioral-split guard ignores archived lanes

Directly unblocks the reported case (`8_62_070126_1` "Day 4"). Self-contained.

**Files:**
- Modify: `lib/stages/behavioral-split.ts` (imports line 1; `existingLanes` guard ~line 118-126)
- Test: `scripts/test-behavioral-split.ts` (add a case before the `finally`)

**Interfaces:**
- Consumes: `performBehavioralSplit({ orgId, campaignId, stageId }, database?)` — existing signature, unchanged.
- Produces: nothing new; behavior change only.

- [ ] **Step 1: Add the failing test case** to `scripts/test-behavioral-split.ts`, inserted right after Case 2 (after the `check("no lanes created under the rejected lane"...)` line, before Case 3):

```ts
    // ====================================================================
    // CASE 2b — ARCHIVED lanes no longer block a re-split of their parent.
    // (The 8_62_070126_1 "Day 4" bug: archived lanes kept the parent stuck.)
    // ====================================================================
    console.log("\nCase 2b — re-split after archiving lanes:");
    // Archive the 3 lanes created in Case 1.
    await db.execute(sql`
      UPDATE campaign_stages SET status = 'archived'
      WHERE parent_stage_id = ${parent.id}::int AND org_id = ${orgId}::uuid
    `);
    const r2b = await performBehavioralSplit({ orgId, campaignId, stageId: parent.id });
    check("re-split ALLOWED once lanes are archived", r2b.ok, JSON.stringify(r2b));
    const liveLanes = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaign_stages
      WHERE parent_stage_id = ${parent.id}::int AND org_id = ${orgId}::uuid
        AND status <> 'archived'
    `)) as unknown as { n: number }[];
    check("exactly 3 LIVE lanes after re-split", Number(liveLanes[0].n) === 3, `got ${liveLanes[0].n}`);

    // And with LIVE lanes present, a further re-split is still rejected.
    const r2bBlocked = await performBehavioralSplit({ orgId, campaignId, stageId: parent.id });
    check(
      "re-split still BLOCKED while live lanes exist",
      !r2bBlocked.ok && r2bBlocked.status === 409 &&
        (r2bBlocked.details as { reason?: string })?.reason === "already_behaviorally_split",
      JSON.stringify(r2bBlocked),
    );
```

- [ ] **Step 2: Run the test, verify the new case FAILS**

Run: `npx tsx scripts/test-behavioral-split.ts`
Expected: FAIL — "re-split ALLOWED once lanes are archived" fails (current guard counts archived lanes, so it rejects). Exit code 1.

- [ ] **Step 3: Fix the guard.** In `lib/stages/behavioral-split.ts`, add `ne` to the drizzle import on line 1:

```ts
import { and, eq, ne, sql } from "drizzle-orm";
```

Then add the archived filter to the `existingLanes` query (the `.where(and(...))` around line 121-126):

```ts
  const existingLanes = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.parent_stage_id, stageId),
        eq(campaign_stages.org_id, orgId),
        ne(campaign_stages.status, "archived"),
      ),
    );
```

Update the guard's comment (line ~116-117) to note archived lanes are excluded:

```ts
  // Guard (behavioral analog of A/B's "already split"): refuse if this stage
  // still has LIVE (non-archived) behavioral lanes, so we never stack a second
  // trio. Archived lanes are excluded — archiving the accidental lanes frees the
  // parent to be re-split (matches the A/B re-split rule).
```

- [ ] **Step 4: Run the test, verify PASS**

Run: `npx tsx scripts/test-behavioral-split.ts`
Expected: PASS — all cases green including 2b; "N passed, 0 failed"; exit 0.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add lib/stages/behavioral-split.ts scripts/test-behavioral-split.ts
git commit -m "fix(stages): behavioral re-split ignores archived lanes"
```

---

### Task 2: Split-membership helpers (A/B)

Shared helpers used by the A/B re-split guard (Task 3) and the delete split-reset (Task 5).

**Files:**
- Create: `lib/stages/split-membership.ts`
- Test: `scripts/test-split-membership.ts`

**Interfaces:**
- Produces:
  - `liveSplitPartnerCount(exec: Executor, opts: { orgId: string; campaignId: number; stageId: number }): Promise<number>` — count of OTHER non-archived stages in the campaign with `split_total IS NOT NULL`.
  - `resetLoneSplitSurvivor(exec: Executor, opts: { orgId: string; campaignId: number }): Promise<number | null>` — if exactly one non-archived split member remains, null its `split_index`/`split_total`; return that id else null.
  - `type Executor` (exported for reuse).

- [ ] **Step 1: Write the failing test** `scripts/test-split-membership.ts`:

```ts
// Tests the A/B split-membership helpers against a throwaway org.
// TEST-DATA SAFETY: see scripts/test-behavioral-split.ts — same marker/teardown/drift pattern.
// Run: npx tsx scripts/test-split-membership.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  liveSplitPartnerCount,
  resetLoneSplitSurvivor,
} from "@/lib/stages/split-membership";

const ORG_MARKER = "__SPLITMEM_TEST__";
const COUNTED_TABLES = ["organizations", "campaigns", "campaign_stages"] as const;

async function main() {
  let passed = 0, failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name + (cond || !detail ? "" : ` — ${detail}`));
    cond ? passed++ : failed++;
  }
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`)) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }
  const unique = Date.now();
  let orgId = "";
  // Insert a stage with explicit split fields + status. Returns its id.
  async function stage(campaignId: number, n: number, splitIndex: number | null, splitTotal: number | null, status = "draft"): Promise<number> {
    const r = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, split_index, split_total, status)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${n}, ${splitIndex}, ${splitTotal}, ${status})
      RETURNING id
    `)) as unknown as { id: number }[];
    return r[0].id;
  }

  const before = await tableCounts();
  try {
    const orgRows = (await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`}) RETURNING id::text AS id`)) as unknown as { id: string }[];
    orgId = orgRows[0].id;
    const campRows = (await db.execute(sql`INSERT INTO campaigns (org_id, slug, name) VALUES (${orgId}::uuid, ${`sm-${unique}`}, ${"SM"}) RETURNING id`)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;

    // 3-way split: A(1/3) live, B(2/3) live, C(3/3) live.
    const a = await stage(campaignId, 1, 1, 3, "draft");
    const b = await stage(campaignId, 2, 2, 3, "draft");
    const c = await stage(campaignId, 3, 3, 3, "draft");

    check("A has 2 live partners (B,C)", (await liveSplitPartnerCount(db, { orgId, campaignId, stageId: a })) === 2);

    // Archive B and C → A stands alone.
    await db.execute(sql`UPDATE campaign_stages SET status = 'archived' WHERE id IN (${b}, ${c})`);
    check("A has 0 live partners once B,C archived", (await liveSplitPartnerCount(db, { orgId, campaignId, stageId: a })) === 0);

    // resetLoneSplitSurvivor: one live split member (A) remains → it gets reset.
    const resetId = await resetLoneSplitSurvivor(db, { orgId, campaignId });
    check("reset returns A's id", resetId === a, `got ${resetId}`);
    const aAfter = (await db.execute(sql`SELECT split_index, split_total FROM campaign_stages WHERE id = ${a}`)) as unknown as { split_index: number | null; split_total: number | null }[];
    check("A's split fields cleared", aAfter[0].split_index === null && aAfter[0].split_total === null);

    // With NO live split members left (A now reset), reset is a no-op.
    check("reset no-ops when no live split members", (await resetLoneSplitSurvivor(db, { orgId, campaignId })) === null);
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const nameRows = (await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[];
        if (!(nameRows[0]?.name ?? "").startsWith(ORG_MARKER)) throw new Error(`Refusing teardown: org ${orgId} is not the test marker.`);
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED_TABLES) if (before[t] !== after[t]) { drift = true; console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: ${before[t]}→${after[t]}`); }
      check("real-data table counts unchanged after teardown", !drift);
      await pgConn.end({ timeout: 5 });
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `npx tsx scripts/test-split-membership.ts`
Expected: FAIL to compile/run — `Cannot find module '@/lib/stages/split-membership'`.

- [ ] **Step 3: Create `lib/stages/split-membership.ts`:**

```ts
import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Any drizzle executor — the top-level client or a transaction handle.
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Count OTHER non-archived stages in the campaign that are part of an A/B split
// (split_total set). These are `stageId`'s "live partners" — re-splitting it
// while any exist would orphan them, so the /split guard blocks on count > 0.
export async function liveSplitPartnerCount(
  exec: Executor,
  opts: { orgId: string; campaignId: number; stageId: number },
): Promise<number> {
  const rows = (await exec.execute(sql`
    SELECT count(*)::int AS n
    FROM campaign_stages
    WHERE org_id = ${opts.orgId}::uuid
      AND campaign_id = ${opts.campaignId}
      AND id <> ${opts.stageId}
      AND split_total IS NOT NULL
      AND status <> 'archived'
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// After a delete, if EXACTLY ONE non-archived A/B-split member remains in the
// campaign, dissolve the split on it (revert to a normal stage). Returns the id
// reset, or null (zero or >1 remaining, or none). Call inside the delete tx.
export async function resetLoneSplitSurvivor(
  exec: Executor,
  opts: { orgId: string; campaignId: number },
): Promise<number | null> {
  const survivors = (await exec.execute(sql`
    SELECT id
    FROM campaign_stages
    WHERE org_id = ${opts.orgId}::uuid
      AND campaign_id = ${opts.campaignId}
      AND split_total IS NOT NULL
      AND status <> 'archived'
  `)) as unknown as { id: number }[];
  if (survivors.length !== 1) return null;
  await exec.execute(sql`
    UPDATE campaign_stages
    SET split_index = NULL, split_total = NULL
    WHERE id = ${survivors[0].id}
  `);
  return survivors[0].id;
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `npx tsx scripts/test-split-membership.ts`
Expected: PASS — "N passed, 0 failed"; exit 0.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add lib/stages/split-membership.ts scripts/test-split-membership.ts
git commit -m "feat(stages): split-membership helpers (live partner count + lone-survivor reset)"
```

---

### Task 3: A/B re-split guard ignores archived variants

**Files:**
- Modify: `app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts` (imports; guard ~line 123-130)

**Interfaces:**
- Consumes: `liveSplitPartnerCount` from Task 2.

- [ ] **Step 1: Add the import** near the other `@/lib` imports in `split/route.ts`:

```ts
import { liveSplitPartnerCount } from "@/lib/stages/split-membership";
```

- [ ] **Step 2: Replace the blanket guard.** Swap the existing block (currently ~line 123-130):

```ts
  if (source.split_total !== null) {
    return apiError(
      409,
      "This stage is already part of a split. Delete its sibling splits before re-splitting.",
      API_ERROR_CODES.CONFLICT,
      { reason: "already_split", split_total: source.split_total },
    );
  }
```

with a live-partner check:

```ts
  if (source.split_total !== null) {
    // Only block if LIVE (non-archived) variants still exist. Once the extra
    // variants are archived or deleted, the source stands alone and re-splitting
    // it is safe — the transaction below overwrites its split_index/split_total.
    const partners = await liveSplitPartnerCount(db, {
      orgId,
      campaignId: cid,
      stageId: sid,
    });
    if (partners > 0) {
      return apiError(
        409,
        "This stage is already split into active variants. Archive or delete the other variants first.",
        API_ERROR_CODES.CONFLICT,
        { reason: "already_split", split_total: source.split_total },
      );
    }
  }
```

Leave the immediately-following `source.status === "archived"` check unchanged.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Manual guard-logic check** (reuses the Task 2 test harness idea inline — no auth needed). Run this one-off to confirm the route module imports cleanly and the helper is wired:

Run: `npx tsx -e "import('@/lib/stages/split-membership').then(m => console.log(typeof m.liveSplitPartnerCount === 'function' ? 'OK' : 'MISSING'))"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add "app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts"
git commit -m "fix(stages): A/B re-split ignores archived variants"
```

---

### Task 4: `stages.delete` permission + `stage_deleted` event type

Enabling changes for the delete route.

**Files:**
- Modify: `lib/permissions.ts` (Permission union ~line 103-107; `operatorPerms`/`managerPerms`)
- Modify: `lib/campaign-events.ts` (`CampaignEventType` union ~line 11-22)

**Interfaces:**
- Produces: `can(role, "stages.delete")` true for manager/admin/owner, false below; `CampaignEventType` now includes `"stage_deleted"`.

- [ ] **Step 1: Write the failing test** `scripts/test-stages-delete-perm.ts`:

```ts
// Verifies stages.delete is manager+ only. Pure function test, no DB.
// Run: npx tsx scripts/test-stages-delete-perm.ts
import "./_env-preload";
import { can } from "@/lib/permissions";

let ok = true;
function check(name: string, cond: boolean) { console.log((cond ? "  ✓ " : "  ✗ ") + name); if (!cond) ok = false; }

check("viewer cannot", !can("viewer", "stages.delete"));
check("operator cannot", !can("operator", "stages.delete"));
check("manager can", can("manager", "stages.delete"));
check("admin can", can("admin", "stages.delete"));
check("owner can", can("owner", "stages.delete"));

console.log(ok ? "\nAll passed." : "\nFAILED.");
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `npx tsx scripts/test-stages-delete-perm.ts`
Expected: FAIL — `stages.delete` isn't a valid `Permission` yet (type error) or `can` returns false for manager. Exit 1.

- [ ] **Step 3: Add the permission.** In `lib/permissions.ts`, add to the `Permission` union next to the other `stages.*` entries (~line 107):

```ts
  | "stages.restore"
  | "stages.delete"
```

Then add `"stages.delete"` to the `managerPerms` set, next to the other `.delete` entries (right after `"segments.delete",` ~line 248, or alongside `"stages.restore"` ~line 256):

```ts
  "stages.restore",
  "stages.delete",
```

(Do NOT add it to `operatorPerms`.)

- [ ] **Step 4: Add the event type.** In `lib/campaign-events.ts`, extend `CampaignEventType` (~line 11-22):

```ts
  | "results_imported"
  | "results_reverted"
  | "stage_deleted";
```

- [ ] **Step 5: Run test, verify PASS**

Run: `npx tsx scripts/test-stages-delete-perm.ts`
Expected: PASS — all 5 checks green; exit 0.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add lib/permissions.ts lib/campaign-events.ts scripts/test-stages-delete-perm.ts
git commit -m "feat(stages): add stages.delete permission (manager+) and stage_deleted event"
```

---

### Task 5: `deleteStage` core (gate + delete + A/B split-reset)

**Files:**
- Create: `lib/stages/delete-stage.ts`
- Test: `scripts/test-stage-delete.ts`

**Interfaces:**
- Consumes: `resetLoneSplitSurvivor`, `type Executor` from Task 2.
- Produces:
  - `type DeleteStageResult = { ok: true; deleted_id: number; stage_number: number; split_reset_stage_id: number | null } | { ok: false; status: number; code: string; message: string; details?: unknown }`
  - `deleteStage(opts: { orgId: string; campaignId: number; stageId: number }, database?: typeof db): Promise<DeleteStageResult>`

- [ ] **Step 1: Write the failing test** `scripts/test-stage-delete.ts`:

```ts
// deleteStage core test against a throwaway org.
// TEST-DATA SAFETY: same marker/teardown/drift pattern as test-behavioral-split.ts.
// Run: npx tsx scripts/test-stage-delete.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { deleteStage } from "@/lib/stages/delete-stage";

const ORG_MARKER = "__STAGEDEL_TEST__";
const COUNTED_TABLES = ["organizations", "campaigns", "campaign_stages", "stage_manual_sales"] as const;

async function main() {
  let passed = 0, failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name + (cond || !detail ? "" : ` — ${detail}`));
    cond ? passed++ : failed++;
  }
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`)) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }
  const unique = Date.now();
  let orgId = "";
  async function stage(campaignId: number, n: number, opts: { splitIndex?: number | null; splitTotal?: number | null; status?: string; sentAt?: string | null } = {}): Promise<number> {
    const r = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, split_index, split_total, status, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${n},
              ${opts.splitIndex ?? null}, ${opts.splitTotal ?? null},
              ${opts.status ?? "draft"}, ${opts.sentAt ?? null})
      RETURNING id
    `)) as unknown as { id: number }[];
    return r[0].id;
  }
  async function exists(id: number): Promise<boolean> {
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM campaign_stages WHERE id = ${id}`)) as unknown as { n: number }[];
    return Number(r[0].n) === 1;
  }

  const before = await tableCounts();
  try {
    const orgRows = (await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`}) RETURNING id::text AS id`)) as unknown as { id: string }[];
    orgId = orgRows[0].id;
    const campRows = (await db.execute(sql`INSERT INTO campaigns (org_id, slug, name) VALUES (${orgId}::uuid, ${`sd-${unique}`}, ${"SD"}) RETURNING id`)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;

    // --- Case 1: plain draft stage deletes. ---
    const s1 = await stage(campaignId, 1);
    const r1 = await deleteStage({ orgId, campaignId, stageId: s1 });
    check("draft stage deletes ok", r1.ok, JSON.stringify(r1));
    check("row is gone", !(await exists(s1)));

    // --- Case 2: sent stage is BLOCKED (archive-only). ---
    const s2 = await stage(campaignId, 2, { status: "success", sentAt: "2026-07-06 14:00:00+00" });
    const r2 = await deleteStage({ orgId, campaignId, stageId: s2 });
    check("sent stage blocked with 409 has_send_data", !r2.ok && r2.status === 409 && (r2 as { code: string }).code === "stage_has_send_data", JSON.stringify(r2));
    check("sent stage still exists", await exists(s2));

    // --- Case 3: stage with a manual-sales row is BLOCKED (has result data). ---
    const s3 = await stage(campaignId, 3);
    await db.execute(sql`INSERT INTO stage_manual_sales (org_id, campaign_id, stage_id, delta) VALUES (${orgId}::uuid, ${campaignId}::int, ${s3}::int, 1)`);
    const r3 = await deleteStage({ orgId, campaignId, stageId: s3 });
    check("stage with manual sales blocked", !r3.ok && r3.status === 409, JSON.stringify(r3));
    check("that stage still exists", await exists(s3));

    // --- Case 4: A/B split-reset. A(1/3),B(2/3),C(3/3) all draft; delete B then C; A reverts. ---
    const a = await stage(campaignId, 4, { splitIndex: 1, splitTotal: 3 });
    const b = await stage(campaignId, 5, { splitIndex: 2, splitTotal: 3 });
    const c = await stage(campaignId, 6, { splitIndex: 3, splitTotal: 3 });
    const rb = await deleteStage({ orgId, campaignId, stageId: b });
    check("delete B ok, no reset yet (A & C remain)", rb.ok && (rb as { split_reset_stage_id: number | null }).split_reset_stage_id === null, JSON.stringify(rb));
    const rc = await deleteStage({ orgId, campaignId, stageId: c });
    check("delete C ok, resets lone survivor A", rc.ok && (rc as { split_reset_stage_id: number | null }).split_reset_stage_id === a, JSON.stringify(rc));
    const aFields = (await db.execute(sql`SELECT split_index, split_total FROM campaign_stages WHERE id = ${a}`)) as unknown as { split_index: number | null; split_total: number | null }[];
    check("A reverted to normal (split fields null)", aFields[0].split_index === null && aFields[0].split_total === null);

    // --- Case 5: 404 for a foreign / missing stage. ---
    const r5 = await deleteStage({ orgId, campaignId, stageId: 999999999 });
    check("missing stage → 404", !r5.ok && r5.status === 404, JSON.stringify(r5));
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const nameRows = (await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[];
        if (!(nameRows[0]?.name ?? "").startsWith(ORG_MARKER)) throw new Error(`Refusing teardown: org ${orgId} is not the test marker.`);
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED_TABLES) if (before[t] !== after[t]) { drift = true; console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: ${before[t]}→${after[t]}`); }
      check("real-data table counts unchanged after teardown", !drift);
      await pgConn.end({ timeout: 5 });
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `npx tsx scripts/test-stage-delete.ts`
Expected: FAIL — `Cannot find module '@/lib/stages/delete-stage'`.

- [ ] **Step 3: Create `lib/stages/delete-stage.ts`:**

```ts
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { resetLoneSplitSurvivor } from "@/lib/stages/split-membership";

export type DeleteStageResult =
  | {
      ok: true;
      deleted_id: number;
      stage_number: number;
      split_reset_stage_id: number | null;
    }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

// Hard-delete a stage that holds NO send/result data. The DB FKs do the cleanup
// (ON DELETE CASCADE for stage_sends/links/result rows/imports/keitaro/manual
// sales/opt-out attributions/behavioral lanes; SET NULL for campaign_events),
// so there are no orphans. Factored out of the route so it can be tested without
// an auth session (mirrors performBehavioralSplit).
export async function deleteStage(
  opts: { orgId: string; campaignId: number; stageId: number },
  database: typeof db = db,
): Promise<DeleteStageResult> {
  const { orgId, campaignId, stageId } = opts;

  // Load the stage AND whether it carries any real send/result data, one trip.
  // These four tables cover everything: links/stage_result_rows/opt_out_
  // attributions only ever exist alongside one of them.
  const rows = (await database.execute(sql`
    SELECT s.id, s.stage_number, s.split_total,
      (s.sent_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM stage_sends ss WHERE ss.stage_id = s.id)
        OR EXISTS (SELECT 1 FROM stage_results_imports ri WHERE ri.stage_id = s.id)
        OR EXISTS (SELECT 1 FROM stage_manual_sales ms WHERE ms.stage_id = s.id)
        OR EXISTS (SELECT 1 FROM keitaro_stage_results kr WHERE kr.stage_id = s.id)
      ) AS has_send_data
    FROM campaign_stages s
    WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND s.org_id = ${orgId}::uuid
    LIMIT 1
  `)) as unknown as {
    id: number;
    stage_number: number;
    split_total: number | null;
    has_send_data: boolean;
  }[];

  const stage = rows[0];
  if (!stage) {
    return { ok: false, status: 404, code: "not_found", message: "Stage not found", details: { entity: "stage" } };
  }
  if (stage.has_send_data) {
    return {
      ok: false,
      status: 409,
      code: "stage_has_send_data",
      message: "This stage has send or result data and can't be deleted — archive it instead.",
      details: { reason: "has_send_data" },
    };
  }

  return database.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM campaign_stages
      WHERE id = ${stageId} AND campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
    `);
    // If this stage was part of an A/B split and exactly one live split member
    // now remains, revert that survivor to a normal stage.
    let splitResetStageId: number | null = null;
    if (stage.split_total !== null) {
      splitResetStageId = await resetLoneSplitSurvivor(tx, { orgId, campaignId });
    }
    return {
      ok: true as const,
      deleted_id: stageId,
      stage_number: stage.stage_number,
      split_reset_stage_id: splitResetStageId,
    };
  });
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `npx tsx scripts/test-stage-delete.ts`
Expected: PASS — all cases green; "N passed, 0 failed"; exit 0.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add lib/stages/delete-stage.ts scripts/test-stage-delete.ts
git commit -m "feat(stages): deleteStage core — no-send-data gate + A/B split-reset"
```

---

### Task 6: `DELETE` route handler

**Files:**
- Modify: `app/api/campaigns/[campaignId]/stages/[stageId]/route.ts` (add a `DELETE` export; add imports)

**Interfaces:**
- Consumes: `deleteStage` (Task 5), `can`/`"stages.delete"` (Task 4), `logCampaignEvent`/`"stage_deleted"` (Task 4), existing `parseId`, `apiError`, `requireApiMembership`, `API_ERROR_CODES`, `db`.
- Produces: `DELETE /api/campaigns/[campaignId]/stages/[stageId]` → `200 { deleted: true, id, split_reset_stage_id }` or error.

- [ ] **Step 1: Add imports** to `route.ts` (it already imports `logCampaignEvent`, `can`, `apiError`, `requireApiMembership`, `API_ERROR_CODES`, `db`). Add:

```ts
import { deleteStage } from "@/lib/stages/delete-stage";
```

- [ ] **Step 2: Append the `DELETE` handler** at the end of `route.ts` (after the `PATCH` function):

```ts
export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "stages.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const result = await deleteStage({ orgId, campaignId: cid, stageId: sid });
  if (!result.ok) {
    const code =
      result.code === "not_found"
        ? API_ERROR_CODES.NOT_FOUND
        : API_ERROR_CODES.CONFLICT;
    return apiError(result.status, result.message, code, result.details);
  }

  // Row is gone; log with stageId null (campaign_events.stage_id SET NULL keeps
  // the history entry). stage_number lives in the summary + metadata.
  await logCampaignEvent(db, {
    orgId,
    campaignId: cid,
    stageId: null,
    actorUserId: user.id,
    eventType: "stage_deleted",
    summary: `Stage ${result.stage_number} deleted`,
    metadata: {
      stage_number: result.stage_number,
      split_reset_stage_id: result.split_reset_stage_id,
    },
  });

  return NextResponse.json({
    deleted: true,
    id: sid,
    split_reset_stage_id: result.split_reset_stage_id,
  });
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint "app/api/campaigns/[campaignId]/stages/[stageId]/route.ts"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "app/api/campaigns/[campaignId]/stages/[stageId]/route.ts"
git commit -m "feat(stages): DELETE route for hard-deleting a never-sent stage"
```

---

### Task 7: UI — Delete action + confirm dialog

**Files:**
- Modify: `app/(protected)/campaigns/[id]/page.tsx`

**Interfaces:**
- Consumes: `DELETE /api/campaigns/{cid}/stages/{sid}` (Task 6), `can("stages.delete")`.

- [ ] **Step 1: Import the Trash2 icon.** Add `Trash2` to the `lucide-react` import block (the one that already imports `Archive as ArchiveIcon`, `ArchiveRestore`, `Split`, etc. near line 5-23):

```ts
  Trash2,
```

- [ ] **Step 2: Add permission + api-call + confirm state.** Near `const canArchiveStage = can("stages.archive");` (~line 566) add:

```ts
  const canDeleteStage = can("stages.delete");
```

Near the existing `stageArchiveApi` / `stageRestoreApi` `useApiCall` declarations, add:

```ts
  const stageDeleteApi = useApiCall<{ deleted: boolean; id: number; split_reset_stage_id: number | null }>();
```

Near the `stageArchiveConfirm` state (~line 542) add:

```ts
  const [stageDeleteConfirm, setStageDeleteConfirm] = useState<Stage | null>(null);
```

- [ ] **Step 3: Add the delete handler.** Right after `handleStageArchiveRestore` (~line 661) add:

```ts
  async function handleStageDelete() {
    if (!stageDeleteConfirm) return;
    const result = await stageDeleteApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageDeleteConfirm.id}`,
      { method: "DELETE" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success("Stage deleted");
    setStageDeleteConfirm(null);
    refetchStages();
    refetchCampaign();
  }
```

- [ ] **Step 4: Add the Delete menu item.** In the stage-row actions dropdown, right after the `showRestore` `DropdownMenuItem` block (~line 1234-1242), add. `looksDeletable` inlines the "no send data" heuristic (server is authoritative):

```tsx
                  {canDeleteStage &&
                  !s.sent_at &&
                  s.sms_count === 0 &&
                  s.delivered_count === 0 &&
                  s.opt_out_count === 0 &&
                  s.inbound_stop_count === 0 &&
                  s.click_count === 0 &&
                  s.sales_count === 0 &&
                  s.keitaro_sales_count === 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setStageDeleteConfirm(s)}
                      >
                        <Trash2 className="size-4" aria-hidden /> Delete
                      </DropdownMenuItem>
                    </>
                  ) : null}
```

> If the `DropdownMenuItem` component in this codebase doesn't accept a `variant="destructive"` prop, drop that prop and instead add `className="text-destructive focus:text-destructive"`. Check `components/ui/dropdown-menu.tsx`.

- [ ] **Step 5: Add `canDeleteStage` to the columns `useMemo` dependency array** (the array starting ~line 1250 that lists `canArchiveStage`, `canRestoreStage`, …):

```ts
      canDeleteStage,
```

- [ ] **Step 6: Add the confirm dialog.** Next to the stage archive/restore `AlertDialog` (~line 2082), add a destructive confirm dialog:

```tsx
      <AlertDialog
        open={stageDeleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setStageDeleteConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete stage {stageDeleteConfirm?.stage_number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the stage and all of its records. This
              can&apos;t be undone. Stages that were sent or have imported
              results can&apos;t be deleted — archive those instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stageDeleteApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={stageDeleteApi.isLoading}
              onClick={(e) => {
                e.preventDefault();
                void handleStageDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
```

- [ ] **Step 7: Typecheck + lint + build the page**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint "app/(protected)/campaigns/[id]/page.tsx"`
Expected: no errors. (`AlertDialog*` primitives and `useApiCall`/`toastApiError`/`toast` are already imported in this file — confirm; if `AlertDialogAction` isn't imported yet, add it to the existing `@/components/ui/alert-dialog` import.)

- [ ] **Step 8: Commit**

```bash
git add "app/(protected)/campaigns/[id]/page.tsx"
git commit -m "feat(stages): Delete action + confirm dialog in the stage menu"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `docs/04-features/` (the campaigns/stages feature doc), `docs/07-conventions.md`, `docs/CHANGELOG.md`, and "last updated" dates on each.

- [ ] **Step 1: Find the stages feature doc**

Run: `ls docs/04-features/ && grep -rl "behavioral" docs/04-features/`
Expected: identifies the file documenting stages/splits (e.g. `campaigns.md` or similar). Edit that one.

- [ ] **Step 2: Document the delete + re-split behavior** in that feature doc — add a short "Deleting stages" subsection and update the split sections:

```markdown
### Deleting stages

Stages that were never sent, never marked-as-sent, and carry no imported/manual
results can be hard-deleted (`DELETE /api/campaigns/[campaignId]/stages/[stageId]`,
`stages.delete`, manager+). The delete removes the row and all its child records
via DB cascade (`stage_sends`, `links`, result rows/imports, keitaro results,
manual sales, opt-out attributions, behavioral lanes); `campaign_events` keep the
history with `stage_id` set NULL. Sent/result-bearing stages stay archive-only.

Deleting the extra variants of an A/B split reverts the lone remaining member to
a normal stage. Archiving OR deleting the extra variants of either split kind
(A/B or behavioral) unblocks re-splitting the original — only *live* (non-archived)
variants/lanes block a re-split.
```

- [ ] **Step 3: Update `docs/07-conventions.md`** — add the delete gate + split-reset rule (one short paragraph mirroring Step 2), and bump its "last updated" date to 2026-07-07.

- [ ] **Step 4: Append to `docs/CHANGELOG.md`** at the top of the entries:

```markdown
## 2026-07-07 — Stage hard-delete + re-split unblock — docs: 04-features, 07-conventions, CHANGELOG
- New `DELETE /api/campaigns/[campaignId]/stages/[stageId]` (`stages.delete`, manager+): removes a stage that has no send/result data (`sent_at` null AND no `stage_sends`/`stage_results_imports`/`stage_manual_sales`/`keitaro_stage_results`), cleaned up by existing FK cascades. Sent/result-bearing stages stay archive-only. Deleting the extra A/B variants reverts the lone survivor to a normal stage.
- Re-split guards now ignore ARCHIVED siblings/lanes: A/B `/split` blocks only on live partners (`lib/stages/split-membership.ts`); behavioral `performBehavioralSplit` excludes archived lanes. Fixes stages stuck as "already split" after their variants were archived (e.g. `8_62_070126_1` "Day 4"). No schema change.
```

- [ ] **Step 5: Bump "last updated" dates** to `2026-07-07` on every doc touched in Steps 2-4.

- [ ] **Step 6: Full verification sweep**

Run each and confirm all green / exit 0:

```bash
npx tsc --noEmit -p tsconfig.json
npx tsx scripts/test-behavioral-split.ts
npx tsx scripts/test-split-membership.ts
npx tsx scripts/test-stages-delete-perm.ts
npx tsx scripts/test-stage-delete.ts
npx eslint "app/api/campaigns/[campaignId]/stages/[stageId]/route.ts" "app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts" "lib/stages/behavioral-split.ts" "lib/stages/split-membership.ts" "lib/stages/delete-stage.ts" "app/(protected)/campaigns/[id]/page.tsx"
```

Expected: typecheck clean; every test prints "N passed, 0 failed"; eslint clean.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(stages): hard-delete + re-split unblock (04-features, 07-conventions, CHANGELOG)"
```

---

## Post-deploy manual verification (real data)

After merge to `main` + Vercel deploy READY:
1. Open campaign `8_62_070126_1` → stage "Day 4" (id 719) → trigger a behavioral split. It should now succeed (archived lanes 730/731/732 no longer block).
2. The three archived lanes (730/731/732) and the stray archived stage 733 should now show a **Delete** action (never-sent, no data) — deleting them removes them cleanly.
3. Confirm a sent stage (e.g. "Day 1" / id 659) shows **no** Delete action and the API returns 409 if forced.

## Self-review notes

- **Spec coverage:** permission (Task 4) · DELETE handler + gate (Tasks 5-6) · A/B split-reset (Task 5) · A/B guard (Tasks 2-3) · behavioral guard (Task 1) · UI (Task 7) · docs (Task 8). All spec sections mapped.
- **No migration** anywhere — matches the spec's non-goal.
- **Type consistency:** `Executor` defined in Task 2 and reused in Task 5; `DeleteStageResult` shape produced in Task 5 consumed in Task 6; `stage_deleted` added in Task 4 before use in Task 6.
