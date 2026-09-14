# Operator API Grading — PR 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two token-reachable read endpoints — `GET /api/creatives/{id}/usage` (where a text has already run) and `GET /api/campaigns/audit?status=active` (every campaign with its stages in one request) — spec items 5a and 6.

**Architecture:** Two lib functions in `lib/reporting/grading.ts` (`getCreativeUsage`, `getCampaignAudit`), each one aggregate statement plus a JS reshape, behind thin routes added to `OPERATOR_ROUTE_MAP` with `token: ["GET"]`. No migration.

**Tech Stack:** Next.js 16 route handlers · Drizzle `sql` · tsx verification scripts.

Spec: [../specs/2026-09-14-operator-api-grading-design.md](../specs/2026-09-14-operator-api-grading-design.md) §3 usage + audit.

## Global Constraints

- Read-only, aggregate-only; every query filters `org_id`; `sending_number` is a SENDING number (allowed), group names are the campaign's targeted groups (already exposed to tokens).
- Creative identity = `campaign_stages.creative_id` (matches the minted-link creative on 99.4% of stages).
- Send day = `campaign_stages.sent_at` in ET (99% exact at stage grain).
- `sends`: tracked stages count `stage_sends` with `status='sent'`; manual stages use `sms_count`.
- `reached`: tracked stages count `offer_reached_at IS NOT NULL`; a row/stage is `null` only when ALL its stages are manual (same rule as PR 1 — SQL `sum(CASE WHEN tracked THEN … END)` yields NULL only when every input is NULL).
- `clicks_human`: distinct `counted_clickers.contact_id` across the row's tracked stages, plus Keitaro clean visits of its manual stages (the `denominatorFor` rule).
- `conversions` / `revenue`: tracker (`keitaro_stage_results`), lifetime per stage.
- Arrays in raw SQL via `sql.join`, never `${array}`; the usage route 404s a creative outside the org.

## File map

| File | Change |
|---|---|
| `lib/reporting/grading.ts` | `getCreativeUsage()`, `AUDIT_STATUSES`, `isAuditStatus()`, `getCampaignAudit()` |
| `app/api/creatives/[id]/usage/route.ts` | **Create.** `creatives.view` |
| `app/api/campaigns/audit/route.ts` | **Create.** `campaigns.view` + `stages.view` |
| `lib/authz/route-map.ts` | `"creatives/[id]/usage"` and `"campaigns/audit"`: `{ methods: ["GET"], token: ["GET"] }` |
| `scripts/verify-operator-grading.ts` | sections F (usage) and G (audit) |
| `scripts/verify-operator-grading-http.ts` | section 9 |
| docs | operator-api.md, 04-features/operator-api-tokens.md (35 → 37, 272 routes), 04-features/reports-rollup.md, 07-conventions.md, CHANGELOG.md |

### Task 1: Failing checks

- [ ] **Lib F (usage)** — the creative with the most sent stages. Independent SQL over its sent stages: total tracked sends + manual `sms_count`; total tracked reaches; total Keitaro sales. Assert the rows' `sends`, `reached` and `conversions` sum to those; every row's `date` / `sending_number` pair exists among its stages; the largest row's `clicks_human` equals an independent `count(DISTINCT contact_id)` over that row's stages; rows are newest first; `getCreativeUsage` returns `null` for a creative id that is not in the org (control: the real id is non-null).
- [ ] **Lib G (audit)** — `status=active`. Independent SQL: active campaign count; per campaign the non-archived stage count; per stage tracked `sent` and `reached`; per campaign Keitaro sales and revenue. Assert equality for every campaign and stage; `total_conversions` equals the sum of its stages' `conversions`; control: at least one campaign has `total_conversions > 0`.
- [ ] **HTTP 9** — usage 200 with `creative_slug` and rows carrying `sending_number`, `group_names`, `clicks_human`, `reached`, `conversions`; usage for a nonexistent id → 404; audit 200 with every campaign's `stages[]` carrying `stage_seq`, `split_index`, `behavioral_tier`, `status`, `creative_slug`; `status=archived` → 400.
- [ ] Run both; expect FAIL (missing exports; 404s).

### Task 2: `getCreativeUsage`

One statement over the creative's sent stages:

```sql
WITH st AS (
  SELECT cs.id, cs.campaign_id, cs.provider_phone_id, cs.sms_count, c.link_mode,
         to_char((cs.sent_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
  FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
  WHERE cs.org_id = $org AND cs.creative_id = $id AND cs.sent_at IS NOT NULL
),
se AS (SELECT stage_id,
              count(*) FILTER (WHERE status = 'sent')::int AS sent,
              count(*) FILTER (WHERE offer_reached_at IS NOT NULL)::int AS reached
       FROM stage_sends WHERE org_id = $org AND stage_id IN (SELECT id FROM st) GROUP BY 1),
k AS (SELECT stage_id, sum(sales)::int AS sales, sum(visit_clicks_clean)::int AS visits
      FROM keitaro_stage_results WHERE org_id = $org AND stage_id IN (SELECT id FROM st) GROUP BY 1),
cc AS (SELECT st.campaign_id, coalesce(st.provider_phone_id, -1) AS phone, st.day,
              count(DISTINCT c2.contact_id)::int AS clickers
       FROM counted_clickers c2 JOIN st ON st.id = c2.stage_id GROUP BY 1, 2, 3)
SELECT st.campaign_id, coalesce(st.provider_phone_id, -1) AS phone, st.day,
       sum(CASE WHEN st.link_mode = 'tracked' THEN coalesce(se.sent, 0) ELSE st.sms_count END)::int AS sends,
       sum(CASE WHEN st.link_mode = 'tracked' THEN coalesce(se.reached, 0) END)::int AS reached,
       sum(coalesce(k.sales, 0))::int AS conversions,
       (coalesce(max(cc.clickers), 0)
         + sum(CASE WHEN st.link_mode <> 'tracked' THEN coalesce(k.visits, 0) ELSE 0 END))::int AS clicks_human
FROM st
LEFT JOIN se ON se.stage_id = st.id
LEFT JOIN k ON k.stage_id = st.id
LEFT JOIN cc ON cc.campaign_id = st.campaign_id AND cc.phone = coalesce(st.provider_phone_id, -1) AND cc.day = st.day
GROUP BY 1, 2, 3
```

Then one label query: campaign name + `ARRAY(SELECT g.name FROM contact_groups g WHERE g.id = ANY(c.audience_contact_group_ids) ORDER BY g.name)` per campaign, and `phone_number` per sending-number id. Return `{ creative_id, creative_slug, data }` newest first, or `null` when the creative is not in the org.

### Task 3: `getCampaignAudit`

`AUDIT_STATUSES = ["active", "paused", "completed"]`. One statement joining `campaigns` (org + status) → non-archived `campaign_stages` → per-stage `stage_sends` counts (`WHERE campaign_id IN (the campaigns)`, served by the campaign index — measured 568ms for all active campaigns) → per-stage Keitaro sales/revenue → `creatives.slug` → `offers.name`; group names as in Task 2. Reshape in JS: per campaign `{ campaign_id, campaign_name, offer: { id, name }, group_names, stage_count, last_send_date, total_conversions, revenue, stages: [{ stage_id, stage_seq, label, split_index, behavioral_tier, status, scheduled_date, sent_date, sent, reached, conversions, creative_slug }] }`, stages ordered by `stage_number, split_index`; campaigns by `last_send_date` desc (nulls last) then id desc.

### Task 4: Routes + route map

- `app/api/creatives/[id]/usage/route.ts`: `requireApiMembership({ route: "creatives/[id]/usage", method: "GET" })`, `can(role, "creatives.view")`, positive-integer id (400), `null` result → 404, `maxDuration = 60` (the most-reused creative measured 5.3s).
- `app/api/campaigns/audit/route.ts`: `requireApiMembership({ route: "campaigns/audit", method: "GET" })`, `can(role, "campaigns.view") && can(role, "stages.view")`, `status` via `isAuditStatus` (default `active`, else 400), `maxDuration = 60`.
- Route map entries beside `creatives/[id]` and `campaigns/list`.

### Task 5: Docs; Task 6: verify, ship, smoke — same shape as PRs 2–3.
