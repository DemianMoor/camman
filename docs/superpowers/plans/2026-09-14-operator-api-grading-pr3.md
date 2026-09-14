# Operator API Grading — PR 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New token-reachable `GET /api/reports/opt-outs?dimension=number|campaign|stage|group&from&to&granularity=day` — the send-day cohort opt-out rate per ET day per dimension value (spec item 3).

**Architecture:** One lib function `getOptOutCohorts()` in `lib/reporting/grading.ts` behind a thin route. Sends and distinct STOPs are aggregated in SEPARATE grouped subqueries and joined on (day, key), so no `count(DISTINCT send)` sort is needed. Daily `totals` come straight from the sends, never from summing rows (group rows overlap). The 72h window moves to a zero-import leaf module that `poll-opt-outs.ts` re-exports. No migration.

**Tech Stack:** Next.js 16 route handlers · Drizzle `sql` · date-fns-tz · tsx verification scripts.

Spec: [../specs/2026-09-14-operator-api-grading-design.md](../specs/2026-09-14-operator-api-grading-design.md) §3 opt-outs.

## Global Constraints

- Read-only, aggregate-only; every query filters `org_id`; `label` for `number` is a SENDING number (allowed), never a recipient.
- Basis is the send-day cohort: a row's sends are `stage_sends` with `status='sent'` and `sent_at` on that ET day; its opt-outs are `count(DISTINCT opt_out_id)` of attributions whose `stage_send_id` is one of those sends.
- `complete` = `now() >= end of that ET day + OPT_OUT_ATTRIBUTION_WINDOW_HOURS`.
- Range at most **14** days (measured: 11.8s for 7 days on the number dimension); `from`/`to` must be real calendar days; `granularity` only `day`.
- The window constant keeps exactly one definition; `poll-opt-outs.ts` keeps exporting the same name with the same value (a pure extraction — no STOP-handling behaviour changes).
- Arrays in raw SQL go through `sql.join(...)`, never `${array}`.

## File map

| File | Change |
|---|---|
| `lib/sends/opt-out-window.ts` | **Create.** `OPT_OUT_ATTRIBUTION_WINDOW_HOURS = 72` (no imports) |
| `lib/sends/poll-opt-outs.ts` | import the constant from the leaf + `export { OPT_OUT_ATTRIBUTION_WINDOW_HOURS }` in place of the `const` |
| `lib/reporting/grading.ts` | `OPT_OUT_DIMENSIONS`, `getOptOutCohorts()` |
| `app/api/reports/opt-outs/route.ts` | **Create.** param validation + call |
| `lib/authz/route-map.ts` | `"reports/opt-outs": { methods: ["GET"], token: ["GET"] }` |
| `scripts/verify-operator-grading.ts` | section E |
| `scripts/verify-operator-grading-http.ts` | section 8 |
| docs | operator-api.md, 04-features/operator-api-tokens.md (34 → 35, 270 routes), 04-features/reports-rollup.md, 07-conventions.md, CHANGELOG.md |

### Task 1: Failing checks

- [ ] Lib section E — range = the 5 closed ET days ending yesterday (so both `complete` values occur). Independent SQL per day: `count(*)` sent and `count(DISTINCT oa.opt_out_id)` via `stage_sends ⋈ opt_out_attributions`. Assert:
  - `totals[d].sent` / `totals[d].opt_outs` equal the SQL per day;
  - for `number`, `campaign`, `stage`: each day's rows sum to that day's totals (one STOP credits one send, so these dimensions partition);
  - for `group`: the largest group's `sent` equals an independent membership count; every group row's `sent` ≤ the day's total;
  - `opt_rate === pct(opt_outs, sent)` on every row;
  - `complete` is `true` for the oldest day and `false` for yesterday (control: both values seen);
  - `window_hours === 72` and the leaf constant equals the poller's re-export.
- [ ] HTTP section 8: `dimension=number` 200 with `basis: "send_date"`, `granularity: "day"`, `window_hours: 72`; 400 for a missing/unknown dimension, `granularity=hour`, a 15-day range, and `from=2026-02-31`.

### Task 2: Extract the window constant

- [ ] Create `lib/sends/opt-out-window.ts` (content above).
- [ ] `poll-opt-outs.ts`: add `import { OPT_OUT_ATTRIBUTION_WINDOW_HOURS } from "@/lib/sends/opt-out-window";` with the other imports; replace `export const OPT_OUT_ATTRIBUTION_WINDOW_HOURS = 72;` with `export { OPT_OUT_ATTRIBUTION_WINDOW_HOURS };` and keep its comment.
- [ ] `tsc` exit 0; `grep` confirms `import-optout-attribution.ts` still imports it from `poll-opt-outs`.

### Task 3: `getOptOutCohorts` + route + route map

`lib/reporting/grading.ts` additions:

```ts
export const OPT_OUT_DIMENSIONS = ["number", "campaign", "stage", "group"] as const;
export type OptOutDimension = (typeof OPT_OUT_DIMENSIONS)[number];

export interface OptOutRow {
  date: string;
  key: string;
  label: string;
  sent: number;
  opt_outs: number;
  opt_rate: number | null;
  complete: boolean;
}

export interface OptOutCohorts {
  dimension: OptOutDimension;
  granularity: "day";
  basis: "send_date";
  window_hours: number;
  range: { from: string; to: string; timezone: string };
  data: OptOutRow[];
  totals: { date: string; sent: number; opt_outs: number; opt_rate: number | null; complete: boolean }[];
}
```

Query shape (one statement for rows, one for totals, one for labels):

```sql
WITH sends AS (
  SELECT ss.id, ss.contact_id, ss.campaign_id, ss.stage_id, ss.provider_phone_id,
         to_char((ss.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
  FROM stage_sends ss
  WHERE ss.org_id = $org AND ss.status = 'sent'
    AND ss.sent_at >= $fromUtc AND ss.sent_at < $toExclusiveUtc
),
keyed AS (<per dimension: SELECT s.id, s.day, <key> AS key FROM sends s [JOIN …]>),
sent_agg AS (SELECT day, key, count(*)::int AS sent FROM keyed GROUP BY 1, 2),
opt_agg AS (
  SELECT k.day, k.key, count(DISTINCT oa.opt_out_id)::int AS opt_outs
  FROM keyed k JOIN opt_out_attributions oa ON oa.stage_send_id = k.id AND oa.org_id = $org
  GROUP BY 1, 2
)
SELECT sa.day, sa.key, sa.sent, coalesce(oa.opt_outs, 0)::int AS opt_outs
FROM sent_agg sa LEFT JOIN opt_agg oa ON oa.day = sa.day AND oa.key = sa.key
```

Keys: `number` → `coalesce(s.provider_phone_id, -1)`; `campaign` → `s.campaign_id`; `stage` → `s.stage_id`; `group` → `ccg.contact_group_id` from `JOIN campaigns c ON c.id = s.campaign_id JOIN contact_contact_groups ccg ON ccg.contact_id = s.contact_id AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)`. Totals use `keyed` = `sends` with key `0`. Labels: `provider_phones.phone_number` (+ `sms_providers.name`), `campaigns.name`, `campaign name · stage N`, `contact_groups.name`; key `-1` → "No number". `complete` computed in JS from `fromZonedTime(<next day> 00:00, ET) + window`. Sort rows by date desc, then sent desc.

Route: `requireApiMembership({ route: "reports/opt-outs", method: "GET" })`, `can(role, "campaigns.view")`, `maxDuration = 60`; validate `dimension` (required), `granularity` (absent or `day`), `from`/`to` (real calendar days, default today ET, `from <= to`, span ≤ 14 days).

Route map: `"reports/opt-outs": { methods: ["GET"], token: ["GET"] }` beside `reports/tails`.

### Task 4: Docs; Task 5: verify, ship, smoke — same shape as PR 2.
