# Creatives list — "Used Campaigns" column (design)

_Date: 2026-09-15 · Status: approved by the user in-session_

## Goal

Show, per creative on `/creatives`, how many campaigns it has been used in, so an operator can judge a creative's results against how widely it has run.

## Definition (user decision)

`used_campaigns` = number of **distinct campaigns that have a sent stage using this creative, all time**:

```sql
SELECT count(DISTINCT cs.campaign_id)
FROM campaign_stages cs
WHERE cs.org_id = <org> AND cs.creative_id = creatives.id AND cs.sent_at IS NOT NULL
```

- Same "used" rule as `getCreativeUsage` in `lib/reporting/grading.ts` (`/api/creatives/[id]/usage`).
- Archived campaigns count — they did run.
- Draft / never-sent campaigns do not count. On prod (2026-09-15) counting them would add 89 campaign references across 65 of 401 creatives.
- Known caveat: a stage that fired and then had every message cancelled still counts (19 campaign references across 17 creatives). The exact "messages actually went out" check costs ~2.3 s per load and was rejected.

## Approach

A correlated subquery inside the `/api/creatives/list` rows query, not the 15-min metrics cache or the hourly snapshot. Measured on prod: ~3 ms for the whole org (1,988 stages, `campaign_stages_creative_id_idx`). Live and sortable server-side across the filtered set.

## Changes

- **API** `app/api/creatives/list/route.ts`: every row gains `used_campaigns: number`, returned regardless of `include_metrics` (it does not come from the cache). `sortBy=used_campaigns` gets an explicit branch with the `id` tiebreaker (unknown `sortBy` silently falls back to `created_at`, so the UI alone is not enough).
- **UI** `app/(protected)/creatives/page.tsx`: sortable "Used Campaigns" column after "Clicks (all time)", `tabular-nums`, `0` renders as `0` (a real count), tooltip "Campaigns with a sent stage using this creative (all time)".
- **Docs**: `docs/04-features/campaigns-stages-creatives.md` (replace the "former Campaigns column removed" note), `docs/CHANGELOG.md`.
- No migration, no schema change.

## Out of scope

Stage creative picker; click-through to the list of campaigns; a 30-day variant.

## Verification

1. `tsc` + `eslint` on changed files (no new problems vs baseline).
2. Script: authenticated `/api/creatives/list` fetch of every creative; `used_campaigns` equals an independent direct SQL count for **every** creative; the most-used creative equals the distinct `campaign_id`s from `getCreativeUsage`; `sortBy=used_campaigns` asc/desc is monotonic.
3. Playwright screenshot of `/creatives` showing the column and sort.
4. After merge: Vercel prod READY + smoke on `/api/creatives/list`.
