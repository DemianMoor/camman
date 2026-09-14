# Operator API Grading — PR 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/campaigns/{campaignId}/stages/{stageId}/send-groups?groups=2` (first half vs second half of a cell, spec item 8) and document `GET /api/dashboard/daily-activity` as the tracker's daily sums (item 7).

**Architecture:** One lib function `getStageSendGroups()` in `lib/reporting/grading.ts` — one aggregate statement plus a JS reshape — behind a thin route added to `OPERATOR_ROUTE_MAP` with `token: ["GET"]`. Item 7 is documentation only: the route is already token-reachable. No migration.

**Tech Stack:** Next.js 16 route handlers · Drizzle `sql` · tsx verification scripts.

Spec: [../specs/2026-09-14-operator-api-grading-design.md](../specs/2026-09-14-operator-api-grading-design.md) §2 "Item 7" and §3 send-groups (revised from `/hourly`).

## Global Constraints

- Read-only, aggregate-only; every query filters `org_id`; no contact ids or recipient numbers in any payload.
- Groups: `stage_sends.status = 'sent'` rows of the stage ordered by `(sent_at, id)`, `ntile(groups)`; `groups` integer 2–10, default 2.
- Per group: `sent`, `reached` (`offer_reached_at IS NOT NULL`), `opt_outs` (`count(DISTINCT opt_out_id)` over `opt_out_attributions.stage_send_id`), `clicks_human` (the stage's `counted_clickers` whose contact's send is in the group), `click_to_reach_pct` and `opt_rate` via `pct()`, `first_sent_at` / `last_sent_at` as UTC ISO strings.
- Top level: `stage_id`, `campaign_id`, `link_mode`, `groups`, `sent`, `pending_sends` (rows with status `pending` or `sending`), `opt_outs_complete` (last send + `OPT_OUT_ATTRIBUTION_WINDOW_HOURS` has passed).
- `null` (→ 404) when the stage is not in that campaign and org; ids validated as positive int4 (→ 400); `groups` outside 2–10 → 400 naming `groups`.
- Permission `stages.view` (same as the stages list).

## File map

| File | Change |
|---|---|
| `lib/reporting/grading.ts` | `SEND_GROUPS_MIN/MAX/DEFAULT`, `getStageSendGroups()` |
| `app/api/campaigns/[campaignId]/stages/[stageId]/send-groups/route.ts` | **Create.** `stages.view` |
| `lib/authz/route-map.ts` | `"campaigns/[campaignId]/stages/[stageId]/send-groups": { methods: ["GET"], token: ["GET"] }` |
| `scripts/verify-operator-grading.ts` | section H (send groups) |
| `scripts/verify-operator-grading-http.ts` | section 10 (send-groups + daily-activity) |
| docs | operator-api.md (send groups + daily sums), 04-features/operator-api-tokens.md (37 → 38, 273 routes), 04-features/reports-rollup.md, 07-conventions.md, CHANGELOG.md, spec §6 table |

### Task 1: Failing checks

- [ ] **Lib H** — pick a settled tracked stage (≥ 4,000 sent, no pending rows, last send > 5 days ago; prod candidates 4095 / 4109 / 4094). Independent reference: fetch its sent rows ordered by `(sent_at, id)` (id, contact_id, reached flag), the stage's counted-clicker contact set, and the attributed send ids with their opt_out ids. Re-derive `ntile` in JS (size = ⌊N/g⌋, the first N mod g groups +1) and compare every group's `sent`, `reached`, `opt_outs`, `clicks_human` exactly for `groups=2` and `groups=10`. Assert group sums = stage-level direct counts; `first_sent_at` non-decreasing; `pending_sends = 0`; `opt_outs_complete = true`. Controls: some group has `clicks_human > 0` and `opt_outs > 0`. `null` for the stage under a different campaign id (control: the right pair is non-null). A manual stage returns `link_mode: "manual"`, `data: []`.
- [ ] **HTTP 10** — send-groups 200 with the keys above and 2 groups by default; `groups=3` → 3 groups; `groups=1`, `11`, `abc` → 400 naming `groups`; wrong campaign → 404; stage 999999999 → 404 (9 digits so the privacy sweep cannot mistake it for a phone). daily-activity `preset=custom` for 7 closed days → every day's `sales` equals the independent `keitaro_stage_results` sum for that `stat_date` when the org has no manual sales entries in range (control: some day has sales > 0).
- [ ] Run both; expect FAIL (missing export; 404).

### Task 2: `getStageSendGroups`

```sql
WITH stage AS (
  SELECT cs.id, cs.campaign_id, c.link_mode
  FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
  WHERE cs.org_id = $org AND cs.id = $stage AND cs.campaign_id = $campaign
),
s AS MATERIALIZED (
  SELECT ss.id, ss.contact_id, ss.offer_reached_at, ss.sent_at,
         ntile($groups) OVER (ORDER BY ss.sent_at, ss.id) AS grp
  FROM stage_sends ss
  WHERE ss.org_id = $org AND ss.stage_id = $stage AND ss.status = 'sent'
),
g AS (SELECT grp, count(*)::int AS sent,
             count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached,
             min(sent_at) AS first_sent_at, max(sent_at) AS last_sent_at
      FROM s GROUP BY grp),
opt AS (SELECT s.grp, count(DISTINCT oa.opt_out_id)::int AS opt_outs
        FROM s JOIN opt_out_attributions oa ON oa.stage_send_id = s.id AND oa.org_id = $org
        GROUP BY 1),
first_grp AS (SELECT contact_id, min(grp) AS grp FROM s GROUP BY 1),
cc AS (SELECT fg.grp, count(*)::int AS clicks_human
       FROM counted_clickers c JOIN first_grp fg ON fg.contact_id = c.contact_id
       WHERE c.org_id = $org AND c.stage_id = $stage GROUP BY 1)
SELECT … g ⋈ opt ⋈ cc ordered by grp, plus the stage row and the pending count
```

(measured on stage 4232: 100ms). Return `null` when `stage` is empty.

### Task 3: route + route map

Thin handler mirroring `app/api/creatives/[id]/usage/route.ts`: `requireApiMembership({ route: "campaigns/[campaignId]/stages/[stageId]/send-groups", method: "GET" })`, `stages.view`, int4 id validation, `groups` parse, 404 on `null`.

### Task 4: verify, docs, ship

- [ ] `npx tsc --noEmit`; `npx eslint <changed files>`; `npm run check:authz`; `npm run check:docs`; lib + HTTP scripts green against `next dev -p 3107`.
- [ ] Docs + CHANGELOG; PR body with verification + rollback deployment id; merge on green; prod smoke on `https://camman.vercel.app`.
