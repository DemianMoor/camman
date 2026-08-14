# Offer Group Report — per-recipient group attribution

_Design spec · 2026-08-14 · branch `fix/offer-group-report-attribution`_

> **Every figure in this spec is a snapshot, measured against production
> 2026-08-13/14.** The matviews refresh twice daily and campaigns 763 and 775 are
> still `active`: offer 96's true sends moved 88,536 → 93,176 and the org benchmark
> 3,106,967 → 3,135,015 *between two reads a day apart while this spec was being
> written*. The numbers below illustrate the mechanism and its magnitude; they are
> not expected values. **No verification criterion in §8 compares against a constant
> from this document** — each computes both sides in the same run.

## 1. Problem

On `/offers/[id]/report`, group rows do not show per-group metrics. They show the
**campaign's whole economics, replicated into every group the campaign targeted**.

`offer_group_report_mv` builds its economics with
`CROSS JOIN LATERAL unnest(group_ids)`
([0128:219‑231](../../../db/migrations/0128_offer_report_dedup_at_grain.sql#L219-L231)),
so a campaign that targeted 12 groups contributes its full sends, revenue, sales,
cost and opt-outs to all 12 rows. Clicks are fanned out the same way
([0128:234‑259](../../../db/migrations/0128_offer_report_dedup_at_grain.sql#L234-L259)):
migration 0128 deduplicated clickers *within* a cell but never required the clicker
to be a **member** of the group, so the EPC denominator is replicated alongside its
numerator.

Measured on offer 96 (Kinzeno · 15013 · Roller), 4 campaigns / 88,536 real sends:

| Campaign | targeted groups | sends |
|---|--:|--:|
| 753 | 12 | 31,561 |
| 755 | 12 | 37,199 |
| 763 | 1 | 9,771 |
| 775 | 7 | 10,005 |

753 + 755 = 68,760 lands on all twelve group rows — hence seven byte-identical rows
at 78,765 sends / 24 sales / $991.38. The footer sums those rows and reads
**904,926 sends, 10.2× the true 88,536**.

The bias direction is the opposite of the EPC workstream (migrations 0125–0128,
PRs #35–#47): there the org benchmark was the inflated half. Here the benchmark is
correct and the group rows are up to 17× too large, so **every group reads better
than the org average by construction** — again, on the one screen whose entire
purpose is that comparison.

A corroborating detail: **Sends and Sent 90d are the same quantity in the same row**
for this offer (all its sends fall inside 7 days), measured two different ways. They
disagree by 3.1× (78,765 vs 25,135). The honest number was already on screen, in the
next column.

### 1.1 Column inventory

| Column | Computed in | Verdict |
|---|---|---|
| Sends, Revenue, Sales, Cost, Opt-outs | `offer_group_report_mv` CTE `e` | replicated |
| Clicks (EPC denominator) | CTEs `cell_tracked` / `cell_manual` | replicated |
| RPM, Net RPM, EPC, Opt-out %, Net profit | `derive()`, [page.tsx:81‑87](<../../../app/(protected)/offers/[id]/report/page.tsx#L81-L87>) | replicated (functions of the above) |
| Footer "This offer · all groups" | [route.ts:53‑65](../../../app/api/offers/[id]/report/route.ts#L53-L65) | replication squared |
| `breakEvenPer1k` | [route.ts:67](../../../app/api/offers/[id]/report/route.ts#L67) | inflated inputs, ratio survives ($10.25 vs $10.28 true) |
| Sent 7d / 30d / 90d | CTEs `lp` / `lp2` | genuinely per-group |
| Fresh pool | CTE `fresh` | genuinely per-group |
| Org benchmark row | `offer_report_org_summary_mv` | already correct (campaign-grain, no `unnest`) |

## 2. Feasibility (measured against production)

Per-recipient attribution is available and, for the economics, exact:

- `stage_sends` carries `contact_id`, `converted_at`, `sale_revenue`.
- `opt_out_attributions.stage_send_id` is **100%** populated (83,248 / 83,248).
- `counted_clickers.contact_id` exists; **0** clicker rows lack a targeted-group membership.
- For offer 96 the per-recipient rollup reproduces the Keitaro stage aggregates
  exactly: Σ`sale_revenue` = $1,800.00 = Keitaro revenue; 24 converted rows = 24
  Keitaro sales.

Two constraints:

- **Cost cannot be read per recipient.** `stage_sends.cost_per_sms` is NULL on
  967,276 of 2,954,929 sent rows (32.7%) — Σ covers only $19,879 of $32,440.
  Cost is therefore derived from `campaign_stages.total_cost / (sent rows of that
  stage)`, which covers everything.
- **~4.9% of sends cannot reach a group row** — 152,929 of 3,135,015 on the
  §4.1.1 tracked-only basis (2026-08-14). Mostly sends performed entirely outside the
  app with a hand-recorded `sms_count`: 59 sent stages have no `stage_sends` rows,
  sitting in 28 campaigns, 21 affected in full and 7 partially (Lulutox-13759 loses
  7.2% of its sends, Kinzeno-14508 3.9%). **6 of 21 offers are 100% external** and
  will render no group rows; 15 have them. Two further campaigns have an empty
  `audience_contact_group_ids` (2 sends), and campaign 110 contributes 889 (§4.1.1).

### 2.1 Multi-group overlap

132,952 contacts belong to more than one group; 1.187 groups per attributed send on
offer 96. Full-count attribution is therefore **non-additive**: for offer 96 the
columns exceed the true totals by +18.7% (sends), +37.5% (revenue and sales), +19.1%
(clicks), +14.8% (opt-outs).

### 2.2 The manual-clicks fallback collapses

0128 falls back to Keitaro landing visits for stages with no `counted_clickers`, and
flags the mixed unit with `has_manual_stages` (33 of 80 cells today). Measured: of
938 sent stages, 22 have per-recipient sends but no clickers — and **all 22 have zero
Keitaro visits**. All 1,884 fallback visits sit on the 59 external stages, i.e. the
same bucket as the un-attributable sends.

Consequence: under per-recipient attribution a group row can never contain a
manual-fallback visit. `has_manual_stages` is provably always false at group grain and
is removed from group rows; it survives on the offer-totals and benchmark rows.

## 3. Decisions taken

Approved 2026-08-14. Both options were presented with numbers for each.

1. **Full count per group, non-additive** — not fractional 1/k shares. Each group
   gets the full count of sends/sales/opt-outs/clicks to its members, and the money
   columns follow the same rule so ratios stay coherent. This is the same
   dedup-at-display-grain rule 0128 applied to clicks, now applied to six columns.
   Rationale: the ratios then answer the operational question ("of the messages sent
   to Memory members, what did those recipients return"), and the two rules rank
   groups almost identically (one swap: Memory ↔ Blood Sugar), so footing was the
   only real difference. Cost: columns do not foot; refresh +1% instead of +26%.
2. **Targeted ∩ member** — a send is attributed to a group only if the campaign
   targeted it *and* the recipient belongs to it. `Sent 7/30/90d` currently uses the
   unrestricted rule and moves to match (small shifts, e.g. AstroEnergy
   14,444 → 14,380, Manifestation 24,067 → 23,898).
3. **Un-attributable sends are dropped from group rows and named in the footer** —
   not given a synthetic row, and the old fan-out is not retained as a fallback
   (that would mix two incompatible rules inside one column, the trap 0128 called
   out for clicks). The six fully-external offers render an empty table with the
   explanation instead of fabricated rows.
4. **No date dimension.** The report stays all-time. Tracked separately on ClickUp
   869egyapn.

## 4. Design

### 4.1 Data layer — migration 0132

`0130` and `0131` are already taken on `origin/main` (675bca5). Re-check the next
free number at implementation time.

Per [07-conventions.md](../../07-conventions.md), migrations are hand-authored: write
the SQL, clone the snapshot forward, add the journal entry, LF line endings with
`--> statement-breakpoint`.

| Object | Change |
|---|---|
| `offer_report_campaign_econ` (plain view) | **unchanged** |
| `offer_report_org_summary_mv` | **unchanged** — already campaign-grain and correct |
| `offer_report_offer_totals_mv` | **new** |
| `offer_group_report_mv` | **rebuilt** |

`offer_group_report_mv` depends on the view, so the rebuild is DROP + CREATE (as in
0128). The org summary matview is not dropped.

**`offer_report_offer_totals_mv`** — key `(org_id, offer_id)`, unique index for
`REFRESH … CONCURRENTLY`. Holds the offer-grain truth the footer needs:

- campaign-grain `sends`, `revenue`, `sales`, `cost`, `optouts` (Σ over
  `offer_report_campaign_econ`, no `unnest`);
- `clicks` — offer-grain `COUNT(DISTINCT contact_id)` over `counted_clickers` plus
  manual-stage visits, i.e. the existing `offer_clicks` / `offer_has_manual` logic
  moved out of the group matview;
- `has_manual_stages`;
- `attributable_sends` — `COUNT(DISTINCT stage_sends.id)` over sends that matched at
  least one targeted group. **Not** Σ of the group matview's `sends`: that sum is
  non-additive by design (105,056 vs 88,536 on offer 96) and using it here would
  reintroduce the very defect this spec removes.
- `unattributed_sends` = `sends − attributable_sends`. `unattributed_cost` follows
  the same distinct basis: `cost − Σ(rate.per_send over the distinct attributable
  sends)`. Defining both as residuals rather than enumerating causes means they
  absorbs all three of them: externally-recorded sends, campaigns with an empty
  `audience_contact_group_ids`, and (should any appear) recipients with no membership
  in a targeted group.

It exists for **every** offer with a sent campaign, including offers with zero
attributable sends — that is what lets the six fully-external offers still render a
footer and an explanation rather than a blank screen.

**`offer_group_report_mv`** — key unchanged `(org_id, offer_id, group_id)`. Drops
`offer_clicks`, `offer_has_manual` (moved to the totals matview) and
`has_manual_stages` (§2.2). Its economics and list-pressure columns come from a
single pass:

```sql
camp AS (
  SELECT c.id, c.org_id, c.offer_id, c.audience_contact_group_ids AS gids
  FROM public.campaigns c
  WHERE c.offer_id IS NOT NULL
    AND c.link_mode = 'tracked'          -- see §4.1.1
    AND EXISTS (SELECT 1 FROM public.campaign_stages s
                WHERE s.campaign_id = c.id AND s.sent_at IS NOT NULL)
),
-- Effective per-send cost from the STAGE, because stage_sends.cost_per_sms is NULL
-- on 32.7% of sent rows and would silently under-count older campaigns.
rate AS (
  SELECT cs.id AS stage_id,
         cs.total_cost / NULLIF(COUNT(ss.id), 0) AS per_send
  FROM public.campaign_stages cs
  LEFT JOIN public.stage_sends ss ON ss.stage_id = cs.id AND ss.status = 'sent'
  WHERE cs.sent_at IS NOT NULL AND cs.archived_at IS NULL
  GROUP BY cs.id, cs.total_cost
),
attr AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*)::bigint                                       AS sends,
    SUM(COALESCE(r.per_send, 0))::numeric(14,4)            AS cost,
    SUM(COALESCE(ss.sale_revenue, 0))::numeric(14,4)       AS revenue,
    COUNT(*) FILTER (WHERE ss.converted_at IS NOT NULL)::bigint AS sales,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '7 days')::bigint  AS sent_7d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d
  FROM public.stage_sends ss
  JOIN camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)   -- targeted ∩ member
  LEFT JOIN rate r ON r.stage_id = ss.stage_id
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
)
```

This single CTE replaces **both** `e` and `lp`/`lp2`. The expensive join
(`stage_sends ⋈ contact_contact_groups`, 3.69M rows) already runs today for the
list-pressure columns, so the economics ride along for free.

#### 4.1.1 Scope filters must match `offer_report_campaign_econ` branch for branch

The econ view does **not** apply one consistent scope. Verified against its source in
[0128:115‑165](../../../db/migrations/0128_offer_report_dedup_at_grain.sql#L115-L165):

| Econ view input | Predicate |
|---|---|
| campaign universe (`sent`) | campaigns with ≥1 stage where `sent_at IS NOT NULL` |
| tracked sends (`ts`) | `stage_sends.status = 'sent'` — **no** stage-level `sent_at` or `archived_at` filter |
| manual sends (`mc`) | `campaign_stages.sms_count` where `sent_at IS NOT NULL AND archived_at IS NULL` |
| cost (`cst`) | same as `mc` |
| opt-outs (`oo`) | no filter at all |
| `sends` column | `CASE WHEN link_mode = 'tracked' THEN ts ELSE mc END` |

So "align with the econ view" is per-column, not one predicate:

- `attr` mirrors `ts`: `status = 'sent'`, campaign in the universe, **no** stage-level
  filter. Adding `archived_at IS NULL` here would drop sends the footer still counts.
- `rate` mirrors `cst`: `sent_at IS NOT NULL AND archived_at IS NULL`. Sends on an
  archived stage therefore attribute at cost 0 — correct, because the footer excludes
  that stage's cost too. Both sides exclude it; the residual stays consistent.
  (0 sent rows sit on archived or unsent stages today, so this is latent, not live.)
- **`camp` is restricted to `link_mode = 'tracked'`, which is the load-bearing part.**
  For a manual-link-mode campaign the footer counts `sms_count` while per-recipient
  rows count actual sends, and the two are unrelated numbers. Campaign 110 (offer 58)
  has `sms_count = 0` across its stages but **889 real `stage_sends` rows**, all 889
  attributable — a campaign-grain residual of **−889**, masked only because offer 58
  is large enough to absorb it. Restricting `camp` to tracked drops those 889 sends
  from group rows and moves them into `unattributed_sends`, which takes the minimum
  campaign-grain residual from −889 to exactly **0**.

The restriction lives in `camp` so it applies uniformly to `attr`, `cell_clicks` and
`cell_optouts`. Applying it to sends alone would leave a manual campaign's opt-outs in
a group row with no denominator behind them.

Pre-existing, out of scope, named so it is not blamed on this change: campaign 110's
econ `sends` of 0 against 889 real sends is an under-count in the *existing* view — an
operator never recorded `sms_count` for an in-app manual-link-mode send. This spec
makes group rows consistent with that footer rather than silently disagreeing with it;
correcting the footer is separate work.

Two smaller CTEs gain the membership predicate 0128 omitted, deduplicated at cell
grain:

- `cell_clicks` — `counted_clickers ⋈ contact_contact_groups`,
  `COUNT(DISTINCT contact_id)`.
- `cell_optouts` — `opt_out_attributions ⋈ stage_sends (via stage_send_id) ⋈
  contact_contact_groups`, `COUNT(DISTINCT opt_out_id)`.

The `fresh` CTE is unchanged.

**Sales definition changes at group grain.** The campaign-grain view uses
`GREATEST(Σ keitaro.sales, Σ stage_manual_sales.delta)` per stage. Manual sales
(96 org-wide) carry no recipient, so a group row counts converted `stage_sends` rows
only. Group sales can therefore be lower than the campaign-grain figure for stages
whose manual tally exceeds Keitaro's; org-wide the per-recipient count is 812 against
842 campaign-grain. This is stated in the docs and is a consequence of decision 3,
not a separate choice.

### 4.2 API

[route.ts](../../../app/api/offers/[id]/report/route.ts) stops summing group rows.
`offerTotals` and `breakEvenPer1k` are read from `offer_report_offer_totals_mv`.
The response gains `unattributedSends` and `unattributedCost`; `offerHasManual`
moves to the same source. `getOfferGroupReport()` in
[lib/reporting/offer-group-report.ts](../../../lib/reporting/offer-group-report.ts)
grows a third `db.execute` for the totals row and drops the `offerClicks` /
`offerHasManual` passenger fields it currently reads off `groupRows[0]`.

`refreshOfferGroupReport()` refreshes three matviews and returns three durations.

### 4.3 UI

Columns, sort, colouring and CSV export are unchanged. Changes:

- Footer renders the offer-grain totals; it **will not foot** the columns above it.
- A line under the table states `N sends (X%) were recorded outside the app and are
  not in any group row`, shown only when `unattributedSends > 0`.
- The footnote is rewritten. The current one
  ([page.tsx:322‑332](<../../../app/(protected)/offers/[id]/report/page.tsx#L322-L332>))
  explains a Clicks column that is not rendered, and states "every other column is a
  plain sum … counted fully in each group" — which is exactly the behaviour being
  removed.
- `+manual` renders on the footer and benchmark rows only.
- An offer with rows but zero attributable sends shows the existing empty state plus
  the explanation.

### 4.4 Documentation

Mandatory per CLAUDE.md, and three definitions in the feature doc are already stale
regardless of this change:

- [04-features/offer-group-report.md:43](../../04-features/offer-group-report.md#L43)
  claims Sent 7/30/90d is `COUNT(DISTINCT contact_id)` "across all offers" — it is
  `COUNT(*)` and *is* offer-scoped (`lp2` groups by `c.offer_id`).
- [:44](../../04-features/offer-group-report.md#L44) describes Fresh pool as
  offer-scoped and opt-out-filtered — it is "no sent row in the last 90 days, any
  offer, no opt-out check".
- [:36](../../04-features/offer-group-report.md#L36) still carries the pre-0126
  clicks definition (`redirect_clicks_clean`).

Also update `03-data-model.md` + the Mermaid ERD (new matview), `07-conventions.md`
(the non-additive rule and the `cost_per_sms` NULL gotcha), and append a
`CHANGELOG.md` line.

## 5. What changes on screen — offer 96

_Matview snapshot of 2026-08-13. The offer is still live (campaigns 763 and 775 are
`active`), so the absolute figures have already moved — true sends 88,536 → 93,176 by
2026-08-14. The shape of the change is the point, not the values._

| Group | Sends now | after | Net RPM now | after | Opt-out % now | after |
|---|--:|--:|--:|--:|--:|--:|
| Nerve Pain | 78,765 | 4,747 | $12.59 | **$37.18** | 2.66% | 1.73% |
| Weight Loss Y | 78,765 | 9,654 | $12.59 | **$28.56** | 2.66% | 2.52% |
| Vision | 78,765 | 4,248 | $12.59 | **$24.70** | 2.66% | **5.96%** |
| Manifestation | 68,760 | 23,898 | $11.60 | **$18.03** | 2.15% | 2.42% |
| Weight Loss | 78,765 | 17,169 | $12.59 | **$15.87** | 2.66% | **3.19%** |
| Memory | 78,765 | 25,135 | $12.59 | **$7.69** | 2.66% | 2.28% |
| Blood Sugar | 78,765 | 5,369 | $12.59 | **$3.69** | 2.66% | 1.88% |
| AstroEnergy | 78,531 | 14,380 | $8.86 | **−$5.12** | 2.37% | **3.34%** |
| Ear Relief | 78,765 | 444 | $12.59 | **−$10.22** | 2.66% | 2.03% |
| Tests | 68,760 | 3 | $11.60 | −$10.19 | 2.15% | 0% |
| WL Signal Test | 68,760 | 9 | $11.60 | −$10.21 | 2.15% | 0% |
| Personal Numbers | 68,760 | **0 — row disappears** | $11.60 | — | 2.15% | — |
| **Footer** | **904,926** | **88,536** | | | | |

Five of twelve rows flip from above break-even (green) to below (red); three flip
opt-out % into red. AstroEnergy goes from "+$696 profit" to −$74. Column sums after
the change: 105,056 sends against an 88,536 footer (+18.7%).

Org benchmark row is unchanged: 3,106,967 sends / $56,116 / 904 sales.

## 6. Refresh cost

All components measured with `EXPLAIN ANALYZE` against production, 2026-08-13.

| | measured |
|---|--:|
| Current group matview query | 24.64s |
| Current org summary (documented total 35.6s ⇒ implied) | ~11s |
| New attribution CTE (replaces `lp`, 9.53s) | 9.96s |
| New offer-totals matview | 4.52s |
| **Projected total** | **~40.5s (+14%)** |

`maxDuration` on the refresh cron is 300s; no change needed.

## 7. Non-goals

- No date/period dimension (decision 4).
- No fractional-share column.
- No change to the org benchmark, to `offer_report_campaign_econ`, or to the
  `/reports` tabs and Overview route.
- No backfill and no writes to campaign or send data — this is a read-model change
  only.

## 8. Verification criteria

Checked before the change is called done. Comparisons are exact, not tolerances —
but **every one of them recomputes both sides in the same run**. Production keeps
sending and the matviews refresh twice daily, so any criterion phrased against a
number copied out of this document is measuring the calendar, not the code.

1. **Offer 96, per row:** new `sends` equals the row's own `sent_90d` for every group
   with sends — the same quantity by two paths, valid only while all of this offer's
   sends fall inside 90 days (assert that precondition, don't assume it: check
   `min(sent_at) >= now() - interval '90 days'` for the offer, and skip the criterion
   with a printed reason if it no longer holds).
2. **Offer 96, aggregate:** Σ group `sends` > footer (strictly, given a multi-group
   campaign exists) and footer == Σ `offer_report_campaign_econ.sends` for the offer,
   both read in the same transaction. Same for `revenue`. The *ratio* is the stable
   observable, not the absolute: the column should exceed the footer by roughly the
   multi-group overlap factor (~1.19× sends, ~1.38× revenue as of 2026-08-13) —
   print it, and treat a jump to ~10× as the defect having survived.
3. **Org-wide partition check.** Note first what does *not* count as evidence:
   `footer sends = attributable_sends + unattributed_sends` is an identity, because
   §4.1 defines `unattributed_sends` as the residual. It can never fail and verifies
   nothing. Two checks with actual teeth:

   a. **Σ footer sends over every offer == benchmark sends**, the right side read from
      `offer_report_org_summary_mv` in the same transaction (never transcribed) and
      pinned byte-identical by criterion 4. This catches campaigns leaking out of the
      offer partition — `camp`
      filters `offer_id IS NOT NULL`, so a sent campaign whose `offer_id` is NULL (or
      is set to an offer that then vanishes from the totals matview) drops out of the
      left side while staying in the benchmark — and it catches a dropped or
      duplicated offer row, which a per-offer check would not. Assert the offer row
      count **from the data**, not against a hardcoded 21.

      Caveat to print, not to hide: the benchmark universe is every campaign with a
      sent stage, including `offer_id IS NULL`, so the exact identity is
      `Σ footer + Σ sends of NULL-offer campaigns == benchmark sends`. The second
      term is 0 today. The script must print it rather than assume it, or a future
      NULL-offer campaign turns a real failure into a silent one.

   b. **`0 <= unattributed_sends <= sends` for every offer.** A negative residual is
      the tell of a scope mismatch between the totals matview and the attribution
      CTE — group rows claiming sends the footer never counted. Measured at campaign
      grain (the strictest form) this currently holds with a minimum of exactly 0
      under the §4.1.1 alignment, and fails on one campaign without it.
4. **Benchmark unchanged:** `offer_report_org_summary_mv` byte-identical before and
   after — snapshotted into a temp table (or a printed row) **immediately before** the
   migration runs and compared **immediately after**, in the same session. Do not
   compare against values transcribed earlier: this matview refreshes on the twice-
   daily cron, and it moved 3,106,967 → 3,135,015 in the 24h this spec took to write.
   The migration does not touch this matview, so the only legitimate difference is a
   cron refresh landing mid-run — if the values differ, establish which before
   treating it as a failure.
5. **No group row carries `has_manual_stages`** — the column is gone from the group
   matview; assert the offer-totals row still carries it where expected.
6. **Fully-external offers** — those with `attributable_sends = 0`, derived from the
   data rather than the id list 6/61/5/2/75/3 that held on 2026-08-14 — render zero
   group rows, a correct footer, and the un-attributed line. Assert that every offer
   in the totals matview is in exactly one of the two states (rows, or zero rows plus
   a non-zero footer); an offer with neither is a dropped row.
7. **Refresh timing** logged per matview and under 60s total.
8. `npx tsx scripts/verify-migration-integrity.ts` clean after apply.
9. Lint the changed files only; prove no new problems by linting
   `git show HEAD:<file>` and comparing totals.

A verification script following the pattern in
[scripts/verify-epc-surface-grains.ts](../../../scripts/verify-epc-surface-grains.ts)
covers 1–6. Note it needs `max > 1` connections or a transaction, or `Promise.all`
deadlocks and looks like a slow query.

## 9. Risks and gates

- **Migration + matview rebuild on the shared production database is gated on
  Dmytro's explicit go-ahead.** The migration file is committed first; the apply is a
  separate, approved step. Per the standing policy this is one of the stop-and-ask
  cases.
- The rebuild drops and recreates two matviews. Between DROP and the first REFRESH
  the report is empty; the DDL and the initial populate happen in one migration run,
  so the window is the length of the migration.
- Numbers on this screen will drop by up to 17× and five rows change colour. This is
  the correction, not a regression, but it is visible and worth flagging to anyone
  who has been reading the old figures.
- Work happens in the `og-attrib` worktree, never the shared `C:/AFF/camman`
  checkout.
