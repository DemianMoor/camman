# Creatives "Used Campaigns" Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show on `/creatives` how many campaigns each creative has been used in, sortable.

**Architecture:** One correlated subquery on `campaign_stages` (indexed by `creative_id`) added to the `/api/creatives/list` rows query as `used_campaigns`, plus a sortable column on the page. No cache, no migration. Spec: `docs/superpowers/specs/2026-09-15-creatives-used-campaigns-design.md`.

**Tech Stack:** Next.js 16 route handler, Drizzle `sql` template, TanStack Table via `DataTable`, tsx verify script with `postgres` + `@supabase/ssr` cookie auth.

## Global Constraints

- "Used" = `count(DISTINCT campaign_id)` over `campaign_stages` with `org_id = <org>`, `creative_id = <creative>`, `sent_at IS NOT NULL`. All time. Archived campaigns count.
- Every query filters by `org_id` (CLAUDE.md §3).
- `used_campaigns` is returned on every row regardless of `include_metrics`.
- Every ORDER BY branch ends with `asc(creatives.id)` (docs/07-conventions.md).
- Column header text: `Used Campaigns`. Tooltip: `Campaigns with a sent stage using this creative (all time)`. `0` renders as `0`.
- Work only in `C:/AFF/camman/.claude/worktrees/used-campaigns`; every git command is `git -C <that path>`.
- Lint only changed files (`npx eslint <files>`), never repo-wide.

---

### Task 1: API field + sort, proven by a verify script

**Files:**
- Create: `scripts/verify-creatives-used-campaigns.ts`
- Modify: `app/api/creatives/list/route.ts` (after `RATIO_SQL` ~L157; sort branches ~L169-189; `baseColumns` ~L194; row map ~L420)

**Interfaces:**
- Produces: every `/api/creatives/list` row has `used_campaigns: number`; `sortBy=used_campaigns` orders by it with `id` ascending tiebreak.

- [ ] **Step 1: Write the verify script**

`scripts/verify-creatives-used-campaigns.ts` — reads `.env.local`, signs in as `TEST_USER_EMAIL`, and checks against an independent `postgres` connection (no app modules):

1. Collect every creative in the org via `showArchived=true&include_metrics=false&pageSize=500`, paginating to `totalCount`.
2. Every row has a numeric `used_campaigns`; all rows share one `org_id`.
3. Independent SQL count per creative, taken before AND after the API fetch; for creatives whose count didn't move, API value === SQL value (moved ones are reported, not compared — live sends race exact checks).
4. The most-used creative: API value === number of distinct `campaign_id` in `GET /api/creatives/{id}/usage`.
5. `sortBy=used_campaigns` desc is non-increasing and asc non-decreasing, with id ascending inside ties — on both the `include_metrics=false` and the default (metrics join) query paths.
6. Pages 0 and 1 (pageSize 20) sorted by `used_campaigns` share no ids.
7. The default request (metrics on) also carries `used_campaigns`.

- [ ] **Step 2: Run it before implementing — expect FAIL**

Run (dev server from the worktree on :3100): `npx tsx scripts/verify-creatives-used-campaigns.ts`
Expected: `✗ every row has a numeric used_campaigns`, non-zero exit.

- [ ] **Step 3: Implement in the route**

After `RATIO_SQL`:

```ts
  // All-time count of distinct campaigns with a SENT stage using this creative —
  // the same "used" rule as getCreativeUsage (lib/reporting/grading.ts). Live, not
  // cached: an indexed lookup on campaign_stages_creative_id_idx, ~3 ms for the
  // whole org (measured 2026-09-15), so it needs no include_metrics opt-out.
  const usedCampaignsSql = drizzleSql<number>`(
    SELECT count(DISTINCT cs.campaign_id)::int
      FROM campaign_stages cs
     WHERE cs.org_id = ${orgId}
       AND cs.creative_id = ${creatives.id}
       AND cs.sent_at IS NOT NULL
  )`;
```

Sort branch, before the `spam_score` branch:

```ts
  } else if (sortBy === "used_campaigns") {
    orderByClause = [orderFn(usedCampaignsSql), asc(creatives.id)];
```

`baseColumns`: `used_campaigns: usedCampaignsSql.as("used_campaigns"),`
Row map, after `offers:`: `used_campaigns: Number(r.used_campaigns),`

- [ ] **Step 4: Re-run the script — expect PASS**, all checks `✓`, exit 0. Note the `rows` segment of `x-camman-timing`.

- [ ] **Step 5: `npx tsc --noEmit` clean; `npx eslint app/api/creatives/list/route.ts scripts/verify-creatives-used-campaigns.ts` no new problems. Commit.**

### Task 2: Column on /creatives + docs

**Files:**
- Modify: `app/(protected)/creatives/page.tsx` (`Creative` type ~L106; columns after `clean_clicks_lifetime` ~L943)
- Modify: `docs/04-features/campaigns-stages-creatives.md` (L3 date, L82), `docs/operator-api.md` (§6 creatives list entry), `docs/CHANGELOG.md` (top)

**Interfaces:**
- Consumes: `used_campaigns: number` from Task 1.

- [ ] **Step 1: Type** — after `offers: Info[];`:

```ts
  // Distinct campaigns with a sent stage using this creative, all time.
  used_campaigns: number;
```

- [ ] **Step 2: Column** — after the `clean_clicks_lifetime` column:

```tsx
      {
        id: "used_campaigns",
        header: "Used Campaigns",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className="tabular-nums text-muted-foreground"
            title="Campaigns with a sent stage using this creative (all time)"
          >
            {numberFmt.format(row.original.used_campaigns)}
          </span>
        ),
      },
```

- [ ] **Step 3: Docs** — feature doc: replace the "former `Campaigns` and `Quality` table columns were removed" note and add a "Used Campaigns column" bullet (definition, caveat, not gated by `include_metrics`, sortable, `0` not "—"); bump `_Last updated:_` to 2026-09-15. operator-api.md §6: add `used_campaigns`. CHANGELOG: newest-first entry at the top.

- [ ] **Step 4: Verify on screen** — Playwright against `http://localhost:3100/creatives` (creds via scratchpad JSON, deleted after): header present, values render, clicking the header sorts desc/asc (compare first rows with the API). Screenshot to `.playwright-mcp/`, then delete.

- [ ] **Step 5: `npx tsc --noEmit`; `npx eslint "app/(protected)/creatives/page.tsx"` vs a baseline copy of the origin/main version (no new problems); `npm run check:docs`. Commit.**

### Task 3: Ship

- [ ] Push; open PR (what was verified + previous prod deployment id from `gh api "repos/:owner/:repo/deployments?environment=Production%20%E2%80%93%20camman&per_page=1"`).
- [ ] Wait for checks green; `gh pr merge --squash`; confirm `gh pr view --json state` = MERGED.
- [ ] Poll the merge sha's `Production – camman` deployment to `success`.
- [ ] Smoke: re-run `BASE_URL=https://camman.vercel.app npx tsx scripts/verify-creatives-used-campaigns.ts` (one run, no loop — bot checkpoint).
- [ ] Tear down the worktree (absolute paths: `.next`, junction via `rmdir`, `.env.local`, `git worktree remove`); verify main checkout's `node_modules` count (544) and `.env.local` intact.
