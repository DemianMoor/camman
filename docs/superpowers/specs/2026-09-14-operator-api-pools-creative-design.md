# Operator API — audience pools + creative lifetime rollups (design)

_Status: approved by the Owner 2026-09-14. Two PRs._

## Constraints (unchanged, non-negotiable)

- Read-only, aggregate-only: counts and sums only. No contact rows, no contact
  ids, no recipient phone numbers, no exports, no writes by the API.
- Same auth, token allowlist (`OPERATOR_ROUTE_MAP`), rate limit (300/hour, 1 per
  call) and usage logging as every other operator endpoint.
- Every query filters `org_id`.

## Recon — measured on prod, 2026-09-14

- `stage_sends` ≈ 4.83M rows. `sent_at IS NOT NULL` ⇔ `status = 'sent'`
  (4,783,284 of 4,783,284), so "received" is `status = 'sent'`.
- Offers: 40, of which 26 sent in the last 60 days. Contact groups: 21, 12
  active (fresh-counts reads active groups only). Memberships ≈ 1.02M. Contacts
  876K, 0 archived, 167,421 with an opt-out row; 708,911 eligible.
- Per-recipient tracker conversions: `stage_sends.converted_at` is set on exactly
  the `lead` (1,353) and `sale` (11) rows.
- `counted_clickers` holds full history (140,898 rows, earliest click
  2026-06-03; first stage sent 2026-05-29) and is rebuilt daily.
- All 1,868 sent stages have a `creative_id`; 408 creative × offer pairs; 26
  creatives ran on more than one offer.
- **Pool rollup, all offers × active groups × day buckets, one statement:**
  40.2s at default `work_mem` (31.2s at 128MB), 4,170 aggregate rows. Dominated
  by one seq scan of `stage_sends` grouped by (contact, offer): 16.8s alone.
  "Rested" needs each contact's last send of ANY offer, so this org-wide scan is
  unavoidable and covering every offer costs the same as covering 26.
- **All-time performance report** (`getPerformanceReport`, 2026-05-29..today):
  13.7s `conversion_date`, 12.0s `send_date`.
- fresh-counts precedent: `audience_fresh_counts` (0176), cron `11,41 * * * *`,
  no lease, `503 rollup_not_ready` only when never computed, `computed_at` +
  `stale_seconds` on every response.
- `/api/reports/performance` has `refreshedAt` = latest Keitaro sync, no cache,
  no `sortBy`, 92-day cap. RPM exists only client-side on the offer report page
  (`revenue / sends * 1000`).

## Decisions (Owner, 2026-09-14)

1. **Storage:** one new additive table (migration 0178) for both snapshots.
2. **Pools cover every offer in one pass** — no on-demand 10s path, no
   `truncated` flag (the spec's "60-day active + on-demand" is replaced: the scan
   is org-wide regardless).
3. **`dimension=creative` is API-only** — no Reports tab.

## 1. Storage — migration 0178 `operator_rollups`

```sql
CREATE TABLE public.operator_rollups (
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rollup_key  text NOT NULL,
  data        jsonb,
  computed_at timestamptz,
  duration_ms integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, rollup_key)
);
ALTER TABLE public.operator_rollups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operator_rollups_select_own_org" ON public.operator_rollups
  FOR SELECT USING (org_id = public.current_org_id());
```

Keys: `audience_pools`, `performance_creative_lifetime`. Hand-authored SQL +
snapshot + journal entry. Applied to production with `npm run db:migrate` after
the file is committed and before the code that reads it merges; the preview
project auto-applies it on the PR deploy.

## 2. `GET /api/audience/pools?offer_id={id}&rest_days=7`

Permission `contacts.stats` (same as fresh-counts). Route map
`"audience/pools": { methods: ["GET"], token: ["GET"] }`.

### Definitions

| Term | Definition |
|---|---|
| eligible | `contacts.is_archived = false` and no `opt_outs` row (the fresh-counts rule) |
| received offer X | a `stage_sends` row with `status = 'sent'` on a campaign whose `offer_id = X` |
| rested for N days | the contact's latest `status='sent'` send of ANY offer is ≥ N whole days before the snapshot instant, or the contact was never messaged |
| human click on X | a `counted_clickers` row on a campaign of offer X (the `clicks_human` membership) |
| converted X | any `status='sent'` send of offer X with `converted_at IS NOT NULL` |
| group | an active contact group; a contact in two groups counts in both |

Rest is measured from the **last message actually sent**, not from campaign
creation — deliberately different from fresh-counts, and documented as such.

### Rollup (cron)

`/api/cron/refresh-audience-pools`, schedule `29,59 * * * *`, `withCronLease`,
`maxDuration = 300`, per org with a try/catch per org, default `work_mem`.

One statement per org (the measured 40s shape):

- `last_pair` = per (contact, offer): `max(sent_at)`, `bool_or(converted_at IS NOT NULL)`
- `last_any` = per contact: `max(last_sent)`
- `clicked` = distinct (contact, offer) from `counted_clickers` ⋈ `campaigns`
- `eligible` = eligible contacts with `rest_bucket = least(31, floor(age_days))`,
  31 also for never messaged, age measured from the statement's `now()`
- aggregates, each per rest bucket:
  - `base[group]` and `base[total]` — eligible contacts
  - per offer, per group and total: `received`, `received_not_clicked`
    (not clicked and not converted), `clickers_non_buyers` (clicked and not
    converted)

Stored as `data = { version: 1, snapshot_at, groups: [{id, name}], base: {total: int[32], "<gid>": int[32]}, offers: { "<offer_id>": { received: {...}, received_not_clicked: {...}, clickers_non_buyers: {...} } } }`.
`computed_at` = the statement's `now()` (the rest reference instant).

### Read (endpoint)

With `tail(a, N) = Σ a[b] for b ≥ N` and `sum(a) = tail(a, 0)`, per group g
(and for `totals`):

| Field | Formula |
|---|---|
| `group_total_eligible` | `sum(base[g])` |
| `never_received` | `sum(base[g]) − sum(received[g])` |
| `never_received_rested` | `tail(base[g], N) − tail(received[g], N)` |
| `received_not_clicked_rested` | `tail(received_not_clicked[g], N)` |
| `clickers_non_buyers` | `sum(clickers_non_buyers[g])` |
| `clickers_non_buyers_rested` | `tail(clickers_non_buyers[g], N)` |

Buckets are whole days, capped at 31 ("31+ or never"), so any `rest_days` 0–30
is exact.

```json
{
  "offer_id": 118, "offer_name": "…", "rest_days": 7,
  "data": [
    { "group_name": "Manifestation", "group_total_eligible": 190000,
      "never_received": 120000, "never_received_rested": 98000,
      "received_not_clicked_rested": 40000,
      "clickers_non_buyers": 900, "clickers_non_buyers_rested": 610 }
  ],
  "totals": { "group_total_eligible": 708911, "never_received": …, … },
  "computed_at": "…", "stale_seconds": 340
}
```

`data` sorted by `group_total_eligible` desc. `totals` = all eligible contacts
in the org (group rows overlap and do not sum to it).

### Errors

- `400` (`field`) — `offer_id` missing / not a positive int4; `rest_days` not an
  integer 0–30.
- `404` — offer not in the org.
- `503 rollup_not_ready` — no snapshot yet.
- Offer absent from the snapshot: if it has no `status='sent'` send, answer from
  the snapshot with every received set empty (exact); if it has one (its first
  send happened after the snapshot) → `503 offer_not_in_rollup_yet`.

## 3. `dimension=creative` on `GET /api/reports/performance`

API-only: a separate `API_ONLY_DIMENSIONS = ["creative"]`, accepted by the
route, not added to `REPORT_DIMENSIONS` (which drives the Reports tabs).

### Rows

- Key `"{creative_id}:{offer_id}"`; `creative_id`, `offer_id`, label
  `"{slug} — {offer name}"` (offer code when the name is empty).
- Stage → creative = `campaign_stages.creative_id`; stage → offer =
  `campaigns.offer_id`. `StageMetrics` gains `creative_id`.
- Same columns as every dimension (`sent, opt_outs, clickers, redirects,
  counted_clickers, lifetime_clickers, lifetime_revenue, sales, revenue, cost,
  reached`) plus `gradePerf` (`clicks_human, click_to_reach_pct,
  reach_to_sale_pct, opt_rate`). `counted_clickers` is distinct at the creative
  × offer grain (`counted_clickers ⋈ campaign_stages` on `stage_id` for the
  stage's creative, `⋈ campaigns` for the offer), plus manual-mode visits.
- Creative fields: `first_sent_date`, `last_sent_date` (ET `YYYY-MM-DD`),
  `distinct_send_days` — over the row's stages whose `sent_at` falls in the
  range (lifetime: all); `null`/`null`/`0` when none did (a conversion_date row
  carried only by tails). `rpm` = `revenue / sent × 1000`, 2 decimals, `null`
  when `sent = 0` (also on `totals`).

### Params (all 400 on any other dimension)

| Param | Meaning |
|---|---|
| `range=lifetime` | all-time, from the hourly snapshot; ignores the 92-day cap; not combinable with `from`/`to` or `provider_phone_id` (400) |
| `offer_id` | only that offer's stages — rows AND totals (like `provider_phone_id`) |
| `min_sent` | integer ≥ 0, default 0; hides rows with `sent < min_sent`; totals unchanged; response `hidden_rows` |
| `sortBy` | `revenue` (default), `rpm`, `sent`, `click_to_reach_pct`; desc, nulls last, ties by `sent` desc then key |

Response: the existing shape plus `sort_by`, `min_sent`, `offer_id`,
`hidden_rows`; lifetime adds `computed_at`, `stale_seconds` and
`range: { lifetime: true, from, to, timezone }`. `refreshedAt` keeps its meaning
(latest tracker sync, as of the snapshot for lifetime).

### Lifetime snapshot (cron)

`/api/cron/refresh-creative-lifetime`, schedule `14 * * * *`, `withCronLease`,
`maxDuration = 300`. For each basis (`conversion_date`, `send_date`): one
all-time stage-metrics pass (first sent day .. today ET) grouped into creative
rows and per-offer totals (distinct clickers per offer). Stored under
`performance_creative_lifetime` as
`{ version: 1, bases: { conversion_date: { rows, totals, offer_totals, refreshedAt, from, to }, send_date: {…} } }`.
Lifetime requests filter / sort / hide from it; `offer_id` totals come from
`offer_totals`. `503 rollup_not_ready` before the first run.

## 4. Verification

Per PR: `npx tsc --noEmit`; `npx eslint <changed files>`; `npm run check:authz`;
`npm run check:docs`; read-only lib checks against prod; HTTP checks against a
local `next dev` on the prod DB before merge and `https://camman.vercel.app`
after; privacy sweep (no `contact_id`, no non-sending phone number) over every
body.

- **Pools:** the rollup statement and an independent per-contact recount
  (EXISTS-based, no buckets) run in ONE `REPEATABLE READ` transaction, so live
  sends cannot race and `now()` is shared. Two offers × two groups × `rest_days`
  0 / 7 / 30, exact. Invariants: `never_received + received = group_total`;
  every `*_rested` non-increasing in `rest_days`; `rest_days=0` rested = unrested;
  `clickers_non_buyers ≤ received`; `totals.group_total_eligible` = eligible count.
  Controls: non-zero `clickers_non_buyers` and `received_not_clicked_rested`.
  HTTP: 200 + keys, 400s naming the field, 404, never-sent offer answered.
- **Creative:** rows' `sent` sum = totals `sent`; a settled row's `sent`,
  `sales`, `counted_clickers` = independent SQL; `offer_id` totals = the
  `dimension=offer` row for that offer; lifetime snapshot rows = a live all-time
  computation in the same run; `sortBy` order; `min_sent` hides and counts;
  400s for the creative-only params elsewhere; `range=lifetime` 400s with
  `from`/`to`.

## 5. Delivery

| PR | Scope |
|---|---|
| 1 | migration 0178; pools lib + cron + endpoint + route map; docs (operator-api.md §2 + §9 line, 03-data-model.md + ERD, crons.md, operator-api-tokens.md, 07-conventions.md, CHANGELOG) |
| 2 | creative dimension (range + lifetime) + lifetime cron; docs (operator-api.md §3, reports-rollup.md, crons.md, CHANGELOG) |

PR 1 carries a migration: the file is committed, applied to production, and
verified with `scripts/verify-migration-integrity.ts` before merge (Owner
approved the table 2026-09-14).

## Out of scope

UI changes; changing fresh-counts; on-demand pool computation; contact-level
exports of any pool.
