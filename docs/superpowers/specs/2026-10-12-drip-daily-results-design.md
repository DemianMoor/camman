# Drip campaign "Daily results" tab: design and plan (FOR APPROVAL, nothing built)

_2026-10-12. Recon read at `origin/main` 6d8788b8 (#349). Prod measurements are drip-scoped and read-only._

---

## ✅ Approved 2026-10-12, with these rulings (they override anything below)

| # | Ruling |
|---|---|
| Q1 | Partner-report definitions throughout. **Add a Lookup cost column** = admitted leads × the calibrated lookup rate (`getCalibratedLookupRate()`, the same trailing-90-day rate the partner report applies). It is exact per campaign because a lead is admitted to at most one campaign. Lookups for leads that were never admitted (including landlines) stay in the partner report only. **Profit = revenue − send cost − lookup cost; ROI = Profit ÷ (send cost + lookup cost)**, null when that sum is 0. Lookup cost is **computed at read time** from the stored `admitted` count × the current rate, never stored, so it moves with the rate exactly as the partner report does. |
| Q2 | (a). The column is labelled **"Leads admitted"**: leads admitted to this campaign, counted on the ET day they were received (`lead_events.received_at`). |
| Q3 | Click **rows**. CTR is labelled **"clicks per send"**. **Conv % = sales ÷ clicks.** The Cohort view adds **"Revenue per admitted lead"** = Σ revenue ÷ Σ admitted. |
| Q4 | Sends are dated by `sent_at`. |
| Q5 | Change events in the Activity log: OK. |
| Q6 | Backfill the test campaigns (994/1006/1604/1605) too. |
| Schema | `stage_id` / `partner_key_id` are **`ON DELETE RESTRICT`**, not SET NULL. SET NULL would fold a deleted stage's cells into the NULL lead row and a deleted key's cells into the Unattributed bucket under `UNIQUE NULLS NOT DISTINCT`. Checked at `origin/main` ed7e9591: `deleteStage` (`lib/stages/delete-stage.ts`) only hard-deletes a stage with **no** sends on it or its lanes, so any stage that owns cells is already undeletable, and its existing `23503 → 409` mapping covers the backstop. No app path hard-deletes `partner_keys`. |
| Plan | Start with PR #1 (change logging). **Stop at the reconciliation gate for the owner's OK before PR #4.** |

Note on Q1's "exact": an admitted lead whose number was already in the lookup cache (~1% at last measurement) cost nothing, so the column slightly overstates. The owner's rule is applied as stated; this caveat goes in the column tooltip.

## 0. Before approval: where the brief conflicts with the code

The brief says "exactly the same formulas as the partner report **and** Overview". Those two reports **disagree with each other** on four metrics, so one tab cannot match both on those columns.

| Metric | Partner report (`lib/reporting/partner-report.ts`) | Overview (`lib/reporting/stage-funnel.ts`) |
|---|---|---|
| Sent | `stage_sends` status `sent` by `sent_at`; only sends that reach a non-sandbox lead | same, but every send on the stage |
| Send cost | `COALESCE(ss.cost_per_sms, phone's current rate)` × sends, plus each opt-out at the rate of the send it answered | **identical** (`dripCostByStageInRange`) |
| Opt-outs | `opt_outs.created_at` | `opt_out_attributions.created_at`. **Same value** (every writer stamps both from one anchor) |
| **Clicks** | clean click **rows** (`classification NOT IN bot/prefetch/suspect`), repeats included, by `clicked_at` | Keitaro `visit_clicks_clean` by Keitaro `stat_date` (falls back to `counted_clickers` on a tracking gap) |
| **Sales / revenue** | ledger, joined on `stage_send_id`, dated by **`created_at` (detection)**, read live | ledger projected into `keitaro_stage_results` by **`stage_id`**, dated by **`occurred_at`**, lags the poll |
| **Profit** | revenue − (send cost **+ lookup cost**) | revenue − send cost (no lookup cost) |
| ROI | NET ÷ (send + lookup cost), null at 0 | **no ROI column** |
| Delivered % | always `null` | stage rollup over DLR-capable sends, ranges ≤ 14 days only |
| Conv % | none | "Sales CR" = sales ÷ **offer redirects** |

The brief also says Activity counts "the same way the funnel **Today** column counts". The funnel dates sales by `occurred_at`, not detection, and dates "Sent" by `first_send_at`, the **queue** time rather than `sent_at`.

**My recommendation (Q1):** take the **partner report** as the definition for every column it has, because it is the only one of the three with a lead/partner grain, which the Cohort view and the partner breakdown both need. Then:

- Overview agrees exactly on **Sent, Cost, Opt-outs**.
- Overview agrees on **Sales/Revenue over ranges**; single days can differ (detection vs occurred date).
- Overview **never** agrees on **Clicks** (it counts Keitaro visits). That gap already exists between Overview and the funnel, and you accepted it on 10-07.

On lookup cost, I recommend **Cost = send cost only**, so Profit = Overview's Profit. Lookup cost is spent per partner × tag **before** routing, and campaigns 1606 and 1683 share tag `aca`, so it has no honest per-campaign value (see Q2). ROI = Profit ÷ Cost, computed from summed money (`profitAndRoi()`).

---

## 1. Rollup schema (migration **0208**)

0206 and 0207 are claimed by the open PRs #350 and #351, so this starts at 0208.

```sql
CREATE TABLE drip_daily_rollup (
  id              bigserial PRIMARY KEY,
  org_id          uuid    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id     integer NOT NULL REFERENCES campaigns(id)     ON DELETE CASCADE,
  basis           text    NOT NULL CHECK (basis IN ('activity','cohort')),
  day_et          date    NOT NULL,   -- activity: the event's ET day; cohort: the ET day of admission (routed_at)
  stage_id        integer NULL REFERENCES campaign_stages(id) ON DELETE RESTRICT,
                                       -- NULL = the campaign-level lead row (leads/admitted have no stage)
  partner_key_id  integer NULL REFERENCES partner_keys(id)    ON DELETE RESTRICT,
                                       -- NULL = sends with no non-sandbox lead (kept so stage totals stay complete)
  -- lead counters (stage_id IS NULL rows only)
  leads_received   integer NOT NULL DEFAULT 0,
  admitted         integer NOT NULL DEFAULT 0,
  admitted_carried integer NOT NULL DEFAULT 0,  -- same-day = admitted − carried
  -- send counters (stage rows)
  first_sends      integer NOT NULL DEFAULT 0,
  followup_sends   integer NOT NULL DEFAULT 0,
  dlr_sent         integer NOT NULL DEFAULT 0,  -- denominator for Delivered % (DLR-capable sends)
  delivered        integer NOT NULL DEFAULT 0,
  clicks           integer NOT NULL DEFAULT 0,
  opt_outs         integer NOT NULL DEFAULT 0,
  sales            integer NOT NULL DEFAULT 0,
  revenue          numeric(12,4) NOT NULL DEFAULT 0,  -- approved only
  send_cost        numeric(12,4) NOT NULL DEFAULT 0,  -- sends at rate + opt-outs at the answered send's rate
  latency_hist     integer[] NULL,                    -- first sends only; fixed log buckets, see §2
  refreshed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drip_daily_rollup_cell UNIQUE NULLS NOT DISTINCT
    (campaign_id, basis, day_et, stage_id, partner_key_id)
);
CREATE INDEX drip_daily_rollup_read ON drip_daily_rollup (org_id, campaign_id, basis, day_et);
-- RLS: ENABLE + SELECT-only `org_id = current_org_id()` policy, no write policies (mirrors 0146/0186).
ALTER TABLE org_settings ADD COLUMN drip_daily_results_enabled boolean NOT NULL DEFAULT false;
```

**Grain.** The brief asks for campaign × stage × **tier** × partner × day. Tier is a pure function of the stage: a lane stage carries `behavioral_tier` + `parent_stage_id`. So it is **not a key column**; the read joins `campaign_stages` for tier, parent and label. Storing it would let a stage edit leave a stale copy.

**Partner** = `partner_key_id` (the finest grain). Partner (0200) is one join away, and "By partner" groups on it.

**Size.** About 90 days × ~10 stages × 1–3 keys × 2 bases ≈ 2–5K rows per campaign. All drip history since 08-24 is **80,706 sends / 80,765 journeys** (prod, 10-12), so the backfill is seconds.

### Why "no-lead" rows exist
The partner report silently drops sends with no journey or with a sandbox lead. If the rollup did the same, per-stage totals would undercount Overview, and the rollup couldn't stand in for stage history (§6). Those sends land in `partner_key_id IS NULL`. They show as "Unattributed" in the partner breakdown, which today should be zero or near zero.

---

## 2. How each metric is computed

Every cell is built from the **existing report fragments**, not a rewrite: the `viaLead` LATERAL, `purchasesBySendSelect`, `terminalCte` + `DELIVERY_COUNTS`, and the `rateExpr` cost expression. This is the conventions rule "a rollup that replaces a live query is derived from it". Day bounds use `etDayBounds`/`fromZonedTime`, half-open and sargable; nothing does `AT TIME ZONE … ::date` on an indexed column.

| Column | Activity basis: dated by | Cohort basis: rows = journeys `routed_at` in day D | Source path |
|---|---|---|---|
| Leads admitted (Q2) | `lead_events.received_at` of leads **admitted to this campaign**, by ET day | n/a (—) | `drip_journeys → lead_events` |
| Lookup cost (Q1) | read time: `admitted` × `getCalibratedLookupRate()` | same | not stored |
| Revenue per admitted lead (Cohort only) | — | Σ revenue ÷ Σ admitted | read time |
| Admitted / same-day / carried | `drip_journeys.routed_at`; carried = `carried_days > 0` | = cohort size | same rule as the funnel's `CarrySplit` |
| First sends | `ss.sent_at` where `ss.id = journey.first_send_id` | the cohort's first sends, any day | journey's `first_send_id` |
| Follow-up sends | other `status='sent'` drip sends by `sent_at` | the cohort's other sends, any day | `viaLead` |
| Delivered % | delivered ÷ DLR-capable sends, **by send day** (as Overview) | cohort's sends | `terminalCte`/`DELIVERY_COUNTS` + `isDlrCapable` |
| Clicks, CTR | clean click rows by `clicked_at`; CTR = clicks ÷ sends | the cohort's clicks | partner report's click CTE |
| Opt-outs % | `opt_outs.created_at`; ÷ sends | the cohort's opt-outs | `opt_out_attributions → stage_sends` |
| Sales, Conv % | purchases by `conversion_events.created_at` (detection); Conv % = sales ÷ clicks (Q3) | the cohort's sales | `purchasesBySendSelect` |
| Cost | `COALESCE(ss.cost_per_sms, phone rate, 0)` per send by `sent_at` + per opt-out by its date | the cohort's sends + opt-outs | identical to `dripCostByStageInRange` |
| Revenue | approved revenue by detection | the cohort's | `approvedRevenueClause` |
| Profit, ROI | revenue − cost; profit ÷ cost, `null` at 0 | same | `profitAndRoi()` on summed money |
| Median lead-to-send | first sends by `sent_at`; value = `sent_at − lead_events.received_at` | the cohort's first sends | the #350 definition (excludes carried + re-check leads), but anchored on `lead_events.received_at` because **`lead_inbox` rows are DELETEd after processing** (`lib/drip/enrichment.ts:331`) |

- **Every column is additive except the median.** Totals and multi-day ranges sum the counters and money, then recompute every ratio from the sums. They never average ratios.
- **The median** is stored as a fixed log-bucket histogram (24 buckets, 5 s → 48 h). The totals row and any range sum the histograms and interpolate the median. That is exact to the bucket (±~15% at the median); it is labelled "≈".
- **Clicks stay additive** only because we count click rows. If you want unique clickers (Q3), the counter stops being additive across days and partners, and totals need a different store.

**Totals row** = Σ over the visible rows' cells for the selected range, **recomputed from the summed cells**. Under "By stage", lane rows nest under their parent stage; the parent row shows its own sends. Leads and Admitted appear only on the total row (they have no stage).

---

## 3. Refresh and recompute strategy

One new cron, `/api/cron/drip-daily-rollup`, at **`*/10`** offset to `:07,:17,…`. That makes 35 of Vercel's 40. The pattern is copied from `delivery-rollup`:

- a `withCronLease` lease;
- a per-org transaction with `statement_timeout`;
- upserts with `WHERE … IS DISTINCT FROM EXCLUDED`;
- deletion of vanished cells;
- heartbeats with `first_run_grace_hours`.

| Tier | Scope | When |
|---|---|---|
| Fresh | today (ET), both bases | every run (10 min). Drip-scoped, about 10–20K sends/day today, so it is cheap |
| Settle | the last **14 ET days**, both bases (or `H + 3` days if longer, where H is the maturity horizon below) | runs from inside the cron when the last settle is ≥ 3 h old |
| Reconcile | the **frozen** window, days 15–21 back: stored vs live in one REPEATABLE READ snapshot | nightly in the 05:00–06:00 UTC quiet slot; latched Telegram alert on any diff |

**Why 14 days.** What can still change a past cell, measured on prod drip data:

- **Sends** land within **≤ 15 h** of admission (p99 14.6 h; follow-ups ≤ 1,440 min configured).
- **Conversions** are detected within p50 0.8 h / p99 **57 h** / max **68 h** of admission (196 events).
- **Opt-out attribution** has a 72 h window.
- **Delivery receipts:** txr sends `undelivered` callbacks up to ~3 days after the send.
- **Click scoring** reclassifies within hours.
- **Payout status flips:** approvals are effectively immediate (60 days of data: max 0.07 days).
- Manual opt-out imports can backdate an opt-out.

The longest of these is ≈ 3 days. 14 days gives ≥ 4× margin, and it matches the existing 14-day reports-rollup convention. The nightly reconcile on the frozen window is the proof that 14 is enough. If it ever fires, we widen the window based on the measured tail rather than guess.

Note that a 60-day "lag" reading would mislead you: the 2026-09-18 ledger backfill (1,492 rows stamped that day) makes `created_at − sent_at` look like a 27-day median. Drip data postdates it.

**Still maturing marker.** A cohort row is "maturing" until `day + H`. H = the longest configured follow-up chain for the campaign (sum of `drip_followup_minutes` along the stage path, rounded up to days) + 3 days of outcome tail. It is about 4 days for 1606/1637/1683 today. It is computed from config at read time, so changing a follow-up moves the marker honestly.

**Rollup cadence vs read rate (the 09-23 rule).** The page is read a handful of times a day, so a 10-minute cron is more refresh than reads. It is kept anyway, because:

- the brief forbids raw `stage_sends` at page load;
- each run is drip-scoped and costs milliseconds, not the 1.4 s / 708-block full scan that killed `refresh-contact-stats`.

I will measure the real per-run cost on a scheduled tick after ship and report it.

**Freshness label.** The tab shows "as of HH:MM ET" from the heartbeat. Today's row can lag up to 10 minutes.

---

## 4. Change-marker source

There is no history today for anything except pause/resume (`campaign_circuit_events`) and lifecycle status (`campaign_events.campaign_status_changed`). Stage window, creative and active edits, cap, cutoff, carry-over and admission close are only overwritten in place (`drip_campaign_configs.updated_at`).

**Proposal: no new table.** The existing `campaign_events` (append-only, `event_type` text, `metadata` jsonb, `stage_id`) gets new types, written with `logCampaignEvent` in the same transaction as the edit:

| event_type | written in | metadata |
|---|---|---|
| `drip_config_changed` | `PUT /api/campaigns/[id]/drip-config` | `{changes: {campaign_cap:{from,to}, routing_daily_admission_cap, admission_cutoff_minutes, carry_days, start_at, end_at, daily_cap}}`, diffed so a no-op save writes nothing |
| `drip_stage_changed` | stage PATCH (drip fields) + `/drip-followups` | `{changes: {window_start_min, window_end_min, creative_id, drip_active, drip_followup_minutes}}` |
| (existing) `campaign_status_changed` | already written | pause/resume via status |
| (existing) `campaign_circuit_events` | already written | send-latch pause/resume |
| (existing) `org_setting_events` | already written for org settings | org-default carry/cutoff, if they change (no app route writes them on main today) |

- **Markers exist only from the day this ships.** History before then can't be reconstructed, apart from pause/resume. That is why this is the **first** PR, so markers start accumulating while the rollup is being built.
- Side effect to approve: these events will also appear in the campaign's existing **Activity log** timeline. I think that's a feature.
- Admission "closes" means the campaign `end_at` / cutoff. Both are in `drip_config_changed`.

---

## 5. UI sketch

The detail page has no page-level tabs today. For drip campaigns only, the "Drip settings" section becomes `Tabs` (`components/ui/tabs.tsx`): **Settings | Daily results**. Regular campaigns render exactly as now.

```
Drip settings | [Daily results]                                     as of 2:40 PM ET
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ (Activity | Cohort) ⓘ    Range [7d|30d|Since launch|Custom ▾]   Breakdown [None ▾]  │
│                                                                 (Table | Chart)     │
  Day ET  │Leads│Admitted (same/carr)│First│F-up│Dlv% │Clicks/CTR │Opt% │Sales/Conv│ Cost │ Rev │Profit│ ROI │ ~L→S
 ─────────┼─────┼────────────────────┼─────┼────┼─────┼───────────┼─────┼──────────┼──────┼─────┼──────┼─────┼──────
  TOTAL   │9,812│ 9,640 (9,420 / 220)│9,601│ 410│ 96.2│1,021/10.2%│ 1.4%│ 88 / 8.6%│ $102 │ $144│  $42 │ 41% │ 6.5m
  Oct 12  │  596│   596   (596 / 0)  │  590│  12│ 97.0│   58/ 9.6%│ 1.1%│  4 / 6.9%│ $6.10│$6.83│ $0.73│ 12% │ 6.7m
 ⚑Oct 11  │  …  ← ⚑ title="Stage 2 window 09:00–17:00 → 10:00–18:00; carry_days 0 → 1"
 ◐Oct 10  │  …  ← Cohort view only: ◐ title="still maturing until Oct 14"
 (numbers illustrative)
 Breakdown = By stage:  ▸ Stage 1 "Intro"        (row per stage, per day)
                           ├ Ignored lane
                           ├ Clicked lane
                           └ Offer lane
 Breakdown = By partner: pml · bsd · Unattributed
```

```
Chart mode:   Line metric [ROI ▾]   (ROI | CTR | Conv % | Opt-out % | Sends)
  $ ┤      ▇            ▇                         ── ROI %  (right axis)
    ┤  ▇   ▇  ▇    ▇    ▇   ▇                      ▇  Profit (left axis, red when < 0)
    ┼──┼───┼──┼────┼────┼───┼──
       │        ⚑ (ReferenceLine + tooltip: what changed)
     Oct 6 … Oct 12 (ET)
```

**Breakdown in chart mode.**
- **None:** profit bars + one line.
- **By stage / By partner:** stacked profit bars per group + the line for the total. That caps it at the brief's 2–3 series, because the line never splits.

**Implementation pieces.**
- Recharts `ComposedChart` (bars + `Line yAxisId="right"` + `ReferenceLine`) loaded via `next/dynamic` with `ssr:false`, like `chart-panel.tsx`. It is new to the repo: no ComposedChart, dual axis or ReferenceLine exists yet.
- The segmented control copies the inline "Group by" control in `keitaro-report.tsx`. There is no ToggleGroup primitive.
- Persistence uses `usePersistedFilters("campaign.dailyResults", …)`, which already wraps every storage access in try/catch. It stores view, basis, range, breakdown and line metric per browser.
- Tooltips use native `title=`, as everywhere else; there is no Tooltip primitive.
- Totals and nested rows reuse the hand-written `<tfoot>` pattern (`partner-report-view.tsx`) and the expandable-row pattern (`delivery-report.tsx`).

**Reads.**
- One endpoint: `GET /api/campaigns/[id]/daily-results?basis=&from=&to=&breakdown=`.
- It reads only `drip_daily_rollup` + `campaign_stages` + `campaign_events`/`campaign_circuit_events` (markers).
- It is gated on `org_settings.drip_daily_results_enabled` **and** `campaign.type='drip'`, and needs `campaigns.view`.
- Expected under 100 ms server-side for 90 days (thousands of rows on an index), well under the 1 s page target.
- I will measure it on prod after flip.

---

## 6. Retention card 869enz8ge (stage_sends 180-day DELETE)

**Plain answer: once shipped, this rollup does NOT on its own make the retention delete safe.** It satisfies the gate **for drip stages only**.

The card's gate requires permanent per-campaign **and** per-stage lifetime sent / delivered / clicks / opt-outs / sales / revenue / cost **for every campaign**. Regular campaigns are ~97% of `stage_sends` and are untouched here.

**For drip stages, it does satisfy the card's rollup requirement, provided four things hold:**
- the `basis='activity'` cells are permanent (nothing ever deletes them);
- they are complete per stage: the `partner_key_id IS NULL` bucket is why;
- they are additive (the click-row definition is why);
- they are reconciled against live rows while those rows exist (§7).

Σ activity cells over all days = that stage's lifetime figure. Cells older than the 14-day recompute window are never recomputed, so a later DELETE (180 days) cannot rewrite them.

**Rollup-first is necessary, not sufficient.** The recon found readers that would still break or **rewrite data** after a delete. For the retention card, not this PR:
- `recomputeStageTotalCost` would rewrite an old stage's `total_cost` toward 0;
- the counted-clickers full rebuild's Rule-F rescue;
- the nightly engagement full recount (`msgs_total`, `last_sent_at`);
- audience-pools `max(sent_at)`;
- the segment rules `sent_from_provider_phone`, `reached_offer*` and `texted_in_last_period` (windows up to 1 year);
- Overview's `send_date` basis.

**Path to the full gate later:** the activity basis is campaign-type-agnostic, and its stage rows don't need a lead. Running the same job over regular campaigns, with `partner_key_id` NULL, is what would satisfy the card. That is a follow-up I'd propose on the card, not in v1.

---

## 7. Backfill and reconciliation

- **Backfill:** `scripts/backfill-drip-daily-rollup.ts` runs the same refresh function over 2026-08-24 → today for all drip campaigns, test campaigns included (994/1006/1604/1605 can be hidden by the archived filter, but their rows exist).
- **Reconciliation:** `scripts/verify-drip-daily-rollup.ts`, read-only, runs in one REPEATABLE READ snapshot over **4 ranges**:
  - 08-24..10-05 (test era),
  - 10-06..10-12 (live week),
  - a single day (10-08),
  - since launch.
- **Against the partner report (all shared columns, exact):** Σ rollup partner rows across drip campaigns per key = `getPartnerReport` sent, send cost, clicks, opt-outs, sales, revenue.
- **Against Overview drip ON (exact):** per drip stage, Total Sent, Cost and Opt-outs.
  - Sales and revenue are reported **with the delta explained**: detection vs occurred day, and `stage_id` vs `stage_send_id` join.
  - Clicks are not compared; it's a different population.
- **Known drift source to watch:** drip sends before 10-07 have no rate snapshot and are priced at the phone's **current** rate. The rollup freezes that price once the cells leave the 14-day window, so a later rate edit on phone 285 would make the live reports move while the rollup doesn't. The reconcile run must happen before any such edit. The nightly reconcile only covers frozen days, which is consistent with this.
- Empty scope = failure; the input scope is printed first.
- The heavy half (Overview at "since launch") runs in the 05:00–06:00 UTC slot. Block counts are reported so measurement traffic isn't read as load.
- **Evidence** goes on card 869enz8ge (and 869ency4b) after you've seen it.

---

## 8. PR split

| # | PR | Migration | Live effect |
|---|---|---|---|
| 1 | **Change-event logging**: `drip_config_changed`, `drip_stage_changed` via `logCampaignEvent` in the 3 routes; diff helper + test | none | events start accruing (visible in Activity log) |
| 2 | **Rollup table + flag**: migration 0208, preview-first on camman-v2, RLS | 0208 (applied to prod before #3 merges) | none |
| 3 | **Rollup job**: `lib/reporting/drip-daily-rollup.ts`, cron + `vercel.json` + heartbeats + reconcile; preview write tests (isolated `__DRIP_DAILY_ROLLUP_TEST__` org, hand-anchored cells, midnight-boundary fixture, cohort late-sale fixture, poisoned-cell red proof); backfill + verify scripts | — | dark: fills a table nobody reads |
| — | **Gate:** prod backfill → reconciliation evidence posted → your OK | | |
| 4 | **API + Table view** (Activity/Cohort, presets, breakdowns, totals, markers, maturing) behind the flag | — | dark |
| 5 | **Chart view** (ComposedChart, line picker, ReferenceLine markers) | — | dark |
| — | **Flip** `drip_daily_results_enabled` on prod; measure page load at 90 days; screenshots | | live |

PR #1 is independent and should go first: every day it ships earlier is a day of markers we'd otherwise never have.

## 9. Out of scope, and which parts become trivial after this

- **CSV export:** trivial. The API already returns the exact rows; this is the routed-leads export pattern.
- **Regular campaigns:** the **Activity** basis is reusable as-is (stage rows, partner NULL), and it is the same work as finishing the retention gate (§6). **Cohort** has no meaning without admission.
- **Partner-facing version:** small, not trivial. The data is there (partner grain), but it needs the signed-link scope + `stripRevenueForPartner` gating.

## 10. Risks

1. **Definitions (Q1/Q3).** Whichever we pick, some column will disagree with Overview or the funnel on single days. Each column's tooltip names its dating.
2. **Leads received per campaign is ill-defined (Q2).** Intake is counted per partner × tag before routing; two campaigns share `aca`.
3. **"Carried" history.** `carried_days` was added in 0204 (10-12) with default 0 and no backfill, so every admission before today reads "same-day" even when it was a backlog admission (e.g. 1637 while paused).
4. **Lead-to-send** reuses #350's definition, which is not merged. I'd copy the definition, not import the code.
5. **Pre-10-07 cost** uses current rates (no snapshot; owner chose no backfill), so the rollup freezes that price (§7).
6. **Migration races.** The two Vercel preview projects race to migrate camman-v2, so expect one red preview on PR #2; redeploy.
7. **Cron budget** goes 34 → 35 of 40.
8. **First-time chart work:** ComposedChart/dual-axis/ReferenceLine are new to the repo. They are in the bundle only via dynamic import.

## 11. Open questions

- **Q1. Definition source.** Partner report as the definition (recommended), with Cost = send cost and Profit = Overview Profit? Or include lookup cost (= partner NET)?
- **Q2. Leads received.** (a) Leads **admitted to this campaign** counted on their received day (recommended; exact and per-campaign, but excludes leads that expired or were unroutable). Or (b) the tag's partner intake (`lead_intake_daily`, includes landlines), marked "shared with campaign X" when another campaign uses the tag.
- **Q3. Clicks and Conv %.** Clicks = clean click **rows** (partner report, additive; recommended) or unique clickers (funnel)? Conv % = sales ÷ clicks (recommended), sales ÷ first sends, or sales ÷ admitted leads in the Cohort view?
- **Q4. Activity "Sent" dating.** `sent_at` (recommended; matches cost and the partner report) rather than the funnel Today's `first_send_at` (queue time). They differ by minutes.
- **Q5. Change-event logging appearing in the Activity log timeline.** OK?
- **Q6. Archived test campaigns.** Should 994/1006/1604/1605 get backfilled rows (recommended, for the retention completeness argument)?
