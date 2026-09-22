# Contact lifecycle status + segmentation for the clickers / non-clickers plan — design

_Date: 2026-09-22 · Status: approved 2026-09-22 (decisions + spec review changes to §7.1, §9, §14)_
_Recon read at `origin/main` 8ed1ee7 (re-checked at 4067c87: the 6 newer commits touch only lookup tests + test-safety conventions). Prod figures measured read-only on 2026-09-21 ~22:00 UTC._
_Related: ClickUp 869f53efz (per-offer repeat rule, Y days / N times) — separate card, same eligibility path (§11)._

## 1. Goal

Every contact carries a **lifecycle status** computed by rules: `new`, `cold`, `hot`,
`warm`, `freeze`, `suppressed`. Campaigns select their audience by status (lifecycle
chips) instead of by ever more segments, and the send pipeline enforces the freeze
cadence, suppression and "bought this offer" rules. Operators see why leads were
excluded, and a cohort report shows performance per status.

**Constraints (from the task):** no new campaign type; frozen audiences of activated
campaigns never change; every migration's SQL is shown and approved before it is
applied to prod; status is never computed inside the send loop; tests for every
transition and for the eligibility table in §13.

**Out of scope:** a built-in weekly offer cap (handled with Excl segments, §9);
drip journeys (their messages still count toward a contact's facts, but drip routing
is unchanged); the campaign-wide `export-all-phones` CSV (it bypasses all eligibility
today and keeps doing so; the per-stage export gets the new rules).

## 2. Findings that shaped the design

| Finding | Consequence |
|---|---|
| No per-contact status, message count, last-message or last-click is stored anywhere; `stage_sends` has no `contact_id`-leading index. Full recounts on prod: per-contact sends **19.5s**, exact last human click **43s**, "messages in last 30 days" **16.4s** (over the 10s segment-preview limit). | Store facts per contact; maintain them with a job (§5). |
| `offer_exposures` is UNIQUE per (contact, offer): it holds only the **first** exposure. Recounting "times / last got offer X" from sends takes **21.9s** for the largest offer (532K contacts). | 869f53efz needs a new per (contact, offer, campaign) table — in this migration (§4). |
| `buildStageEligibilityExclusions` has only the 3 content-dedup layers; its layer list is hard-coded in 4 places. The Prepare dialog shows no exclusion reasons at all. | New labelled layers + one data-driven layer list (§8). |
| The snapshot deletes prior-offer contacts from the frozen pool permanently. | 869f53efz must change snapshot + preview together with the stage layer (§11). |
| Buyers are excluded only on behavioural lanes (tier 4) or via a segment rule. | New "bought this offer" layer (§8). |
| The drain re-checks only opt-outs and the 1-hour dedup. Prepare can run days before the send. | Freeze cadence, suppressed and buyer are re-checked at send time too (§8.4). |
| The chip predicate (No-status / Opt-in / Clickers / Not-clicked) is copied in 5 places in `lib/audience-snapshot.ts`. | One shared lifecycle-chip builder replaces all 5 (§7). |
| `clickers` (chip) contacts 83,456 ⊆ `counted_clickers` contacts 83,479. | Old "Clickers" chip ≈ ever-clicked; the Hot/Warm mapping is close (§7.3). |
| 134,915 contacts (15.6%) are in 2+ active groups; Weight Loss ∩ Weight Loss Y = 89,881 (96% of WL Y); 55,316 are in no active group. | "Strictest across active groups" rule (§3) — an override on one WL group effectively governs the other for most contacts. |
| 36 manual/CSV campaigns left no `stage_sends`; 14,671 contacts were messaged only there. | Decision: they are **New** (§3). |
| Status estimate today (defaults, click = counted_clickers): cold 448K, opted-out 175.5K, freeze **133K (125K messaged in the last 14 days)**, new 54K, hot 32.8K, warm 31.8K. | Day-one: ~36% of the recently-messaged audience becomes "freeze not due". Accepted; dry-run first (§12). |
| `opt_outs.reason = 'suppressed'` already means Global Suppression; `lib/drip/lifecycle.ts` already exists. | UI relabels the opt-out reason "Global suppression"; code uses the name `engagement` for the new module/tables. |

## 3. Status definitions

### 3.1 Facts (per contact)

- **Message** = a `stage_sends` row with `status = 'sent'` (any campaign, incl. drip). CSV/manual sends leave no row and do not count — so CSV-only contacts are **New** (decision 7).
- **Human click** = a click passing the existing classification: `clicks.classification = 'human' AND clicks.scored_at IS NOT NULL` (`HUMAN_CLICK`, `lib/reporting/counted-clickers.ts`), joined to the contact through `links.contact_id`. Conversion-only "rescued" counted clickers (16 contacts) are not clicks.
- `msgs_total`, `last_sent_at`, `first_click_at`, `last_click_at`.
- `msgs_since_click` = messages sent after `last_click_at` (= `msgs_total` if never clicked).
- `msgs_7d / msgs_14d / msgs_30d / msgs_90d` (for the fixed-window segment rule).
- Freeze clock: `freeze_entered_at` (status became freeze), `freeze_started_at` (first message sent after `freeze_entered_at`), `freeze_msgs` (messages sent after `freeze_entered_at`).

### 3.2 Rules — evaluated in this order, first match wins

| # | Status | Condition |
|---|---|---|
| 1 | **hot** | `last_click_at ≥ now − hot_days` (30) |
| 2 | **warm** | `last_click_at ≥ now − warm_days` (120) |
| 3 | **new** | `msgs_total = 0` |
| 4 | **suppressed** | previous status is `suppressed` (sticky — only a human click, i.e. rule 1, leaves it) |
| 5 | **suppressed** | previous status is `freeze` AND rule 6's condition still holds AND `freeze_started_at ≤ now − suppress_after_days` (60) AND `freeze_msgs ≥ suppress_min_freeze_messages` (2) |
| 6 | **freeze** | `msgs_since_click ≥ freeze_after_messages` (10) |
| 7 | **cold** | otherwise |

Consequences, stated so nobody has to derive them:

- **Any → hot** on a human click; the click resets `msgs_since_click` to 0 and clears the freeze clock.
- **hot → warm** at 31 days, **warm → cold** at 121 days without a click. A contact that got ≥ 10 messages *after* its last click then goes straight to **freeze** on the same run (decision 1).
- **Freeze with no messages stays freeze indefinitely** (`freeze_started_at` stays NULL).
- **Suppressed needs both** 60 days since the first in-freeze message **and** ≥ 2 in-freeze messages.
- **Existing contacts:** the backfill sets `freeze_entered_at` = backfill time for everyone already in freeze, so no message before launch counts toward suppression. **No contact is suppressed at launch**; the earliest possible suppression is launch + 60 days (decision 3).
- **Threshold raised** so a freeze contact is now below it → **freeze → cold**, clock cleared (reason `threshold_change`). Suppressed is not undone by threshold changes.
- **Opt-outs** stay a separate state: status is still computed for opted-out contacts, and they are always excluded, as today.

### 3.3 Thresholds

| Setting | Default | Scope | Strictest (contact in several groups) |
|---|---|---|---|
| `hot_days` | 30 | org only | — |
| `warm_days` | 120 | org only | — |
| `freeze_after_messages` | 10 | org + group override | lowest |
| `freeze_cadence_days` | 14 | org + group override | longest |
| `suppress_after_days` | 60 | org + group override | shortest |
| `suppress_min_freeze_messages` | 2 | org + group override | lowest |

- A group's effective value = its override, or the org default when blank.
- A contact's effective value = the strictest effective value across its **active** groups (`contact_groups.status = 'active'`). A contact in no active group uses the org default.
- Example: group A overrides cadence to 7 and group B has no override (so 14). A contact in both gets **14**. A contact in A only gets 7.
- The effective set used for each evaluation is stored on the contact row and on every transition (decision: history records the threshold set in effect).
- Changes take effect on the **next job run**, never instantly:
  - A threshold edit sets `lifecycle_settings.reevaluate_requested_at`. The next 15-minute run then re-evaluates every contact from the stored facts, which takes seconds.
  - A group membership change or a group archive/restore takes effect on the next nightly run.

## 4. Data model — migration 0187 (one migration; SQL shown for approval before prod; 0186 was taken on main by 0186_stage_delivery_rollup)

All new tables have `org_id` and RLS enabled, with a SELECT policy restricted to the user's own org (`current_org_id()`).

**`contact_engagement`** (one row per contact):
- **Key and status:**
  - `contact_id` PK → `contacts` ON DELETE CASCADE; `org_id`
  - `status` CHECK (`new`, `cold`, `hot`, `warm`, `freeze`, `suppressed`); `status_changed_at`
- **Message facts:**
  - `msgs_total`, `msgs_since_click`, `msgs_7d`, `msgs_14d`, `msgs_30d`, `msgs_90d` (int, default 0)
  - `first_sent_at`, `last_sent_at`
- **Click facts:** `first_click_at`, `last_click_at`
- **Freeze clock:** `freeze_entered_at`, `freeze_started_at`, `freeze_msgs`
- **Thresholds:**
  - `freeze_cadence_days` (smallint): the effective cadence, stored so Prepare and send can read it cheaply
  - `thresholds` (jsonb): the effective set plus its source (org, or the group ids)
- `computed_at`
- Indexes: `(org_id, status)`, `(org_id, last_sent_at)`, `(org_id, last_click_at)`.
- **A missing row is read as `new` everywhere** (`coalesce(status, 'new')`). A contact uploaded minutes ago is therefore correct before the job has run.

**`contact_engagement_transitions`** (history):
- `id` bigserial, `org_id`, `contact_id` → contacts CASCADE
- `from_status` (NULL for the initial backfill row), `to_status`
- `reason` CHECK (`backfill`, `first_message`, `freeze_threshold`, `freeze_expired`, `human_click`, `click_aged_warm`, `click_aged_cold`, `threshold_change`)
- `thresholds` jsonb, `created_at`
- Indexes: `(contact_id, created_at)`, `(org_id, created_at)`.
- Shape copied from `send_circuit_events`.

**`lifecycle_settings`** (org singleton, `notification_settings` pattern: a missing row falls back to the defaults in code):
- `org_id` PK
- the six thresholds, as smallint with CHECK ranges; `warm_days > hot_days`
- `reevaluate_requested_at`, `updated_at`, `updated_by`
- Edits are audited in the existing `org_setting_events`.

**`contact_groups`** gains four nullable override columns: `freeze_after_messages`, `freeze_cadence_days`, `suppress_after_days`, `suppress_min_freeze_messages`. NULL means inherit.

**`campaigns.lifecycle_rules`** boolean NOT NULL DEFAULT false:
- The create route sets it to true once PR 4 ships.
- Every campaign that exists at release stays false (legacy). Only drafts are converted (§7.3).
- This single flag is what "new checks apply only to campaigns created after launch" keys off.

**`stage_sends.status`** CHECK gains `skipped_ineligible`:
- A terminal status for send-time drops, with the reason in `last_error` (`suppressed`, `freeze_cadence`, `bought_offer`).
- Same shape as migration 0116, which added `skipped_opted_out`.
- The 12 app files that enumerate send statuses (send panel, activity, autopilot, today, preflight breakdown, scheduled…) all gain the new bucket.

**`stage_send_lifecycle`** (the report's status-at-send; send records are never rewritten):
- `stage_send_id` PK → `stage_sends` ON DELETE CASCADE, `org_id`
- `status`, `reconstructed` boolean, `created_at`

**`contact_offer_campaigns`** (data for 869f53efz):
- `org_id`, `contact_id` → contacts CASCADE, `offer_id`, `campaign_id` → campaigns CASCADE
- `first_sent_at`, `last_sent_at`, `messages`
- PK `(contact_id, offer_id, campaign_id)`; index `(org_id, offer_id, contact_id)`
- "Times got offer X in other campaigns" = row count with `campaign_id <> current`. "Last got" = `max(last_sent_at)`.

**`segment_rules.rule_type`** CHECK is extended with the 8 new types (§9). `db/schema.ts` mirrors every change.

## 5. The engagement job

**Where it runs:** `/api/cron/refresh-contact-engagement`, under `withCronLease` (6-minute lease, `maxDuration` 300). The code lives in `lib/engagement/`.

**Incremental run, every 15 minutes** (minutes staggered off the busy slots in `vercel.json`, after `propagate-clickers`):
1. **Collect the touched contacts:**
   - sends with `sent_at` since the watermark minus a 30-minute overlap (index `(sent_at, contact_id)`);
   - human clicks scored since the watermark (index `(classification, scored_at)` → `links.contact_id`);
   - contacts that have no engagement row yet;
   - contacts whose status may have changed only because time passed: hot or warm past their window, and freeze past its suppression window. These come from indexed reads on `contact_engagement`.
2. **Recount their facts from the full history.** Sends are read through the `(org_id, phone, sent_at) WHERE status='sent'` index and clicks through `links_contact_id_idx`. This is idempotent, so the overlap is safe and nothing is double-counted. The same pass refreshes their `contact_offer_campaigns` rows.
3. **Evaluate status and write.**
   - Status comes from one SQL CASE builder, `engagementStatusSql()`, the single definition of §3.2. The job, the settings preview and the tests all use it.
   - Only changed rows are written (`IS DISTINCT FROM`).
   - Each change inserts one transition row.
4. If `reevaluate_requested_at` is later than the last full evaluation, re-evaluate every contact from the stored facts. This reads no send records.

**Nightly full run** (about 06:40 UTC, 02:40 ET):
- It recounts all facts org-wide in two set-based passes (measured 19.5s + 43s), recomputes the rolling windows, and re-evaluates everything.
- It picks up click reclassifications and any drift.
- It runs on the session-mode connection with a raised `statement_timeout`, as in `lib/reporting/refresh-session.ts`.

**Freshness:**
- Status and facts are at most 15 minutes behind. The 1-hour send dedup already prevents two messages within that span.
- `msgs_Nd` windows decay nightly for contacts with no new activity, so they can overcount by up to 1 day.

**Monitoring:**
- A heartbeat is written on each successful run.
- A Telegram alert fires if the last successful incremental run is more than 45 minutes old. Eligibility depends on this job.

**Not in the send loop:**
- The drain only reads `contact_engagement` (§8.4); it never computes status.
- No trigger is added to `stage_sends`.

**Retention caveat:** the proposed 180-day `stage_sends` retention would make the nightly recount drop history. Before retention lands, that card must fold old counts into the facts table or switch the nightly run to incremental-only.

## 6. Settings, group overrides, visibility

- **Settings → Lifecycle** (`/settings/lifecycle`, new permission `lifecycle.configure` for manager and above):
  - The six thresholds, with `hot_days` and `warm_days` marked "applies to all groups".
  - **Preview before saving:** the proposed values are run through `engagementStatusSql()` over the stored facts and return the transition counts the next run would make, e.g. "cold → freeze 12,345 · freeze → cold 0 · freeze → suppressed 0". This takes seconds.
  - Save writes an `org_setting_events` audit row.
- **Contact group edit form:**
  - Four override inputs, where blank means inherit.
  - Next to each field, the effective value, e.g. "Effective: 10 (org default)".
  - The same preview, scoped to the group's contacts, before save.
  - Validated in the group PATCH and gated by `lifecycle.configure`.
- **Contacts list:** a Lifecycle column plus a multi-select status filter. The opt-out reason `suppressed` is relabelled "Global suppression" in the statuses column and in the import UI (the DB value is unchanged).
- **Contact detail** (`/contacts/[id]`), a Lifecycle panel showing:
  - status and since when;
  - messages total, last message, last human click;
  - the freeze clock;
  - the effective thresholds and their source;
  - the last 20 transitions.

## 7. Campaign Audience block

### 7.1 Layout and behaviour

- A row of **lifecycle chips** — **New · Hot/Warm · Cold · Freeze** — sits at the top of the Audience block, under the header and above Segments / Contact groups / Cap.
- **Multi-select, combined with OR.** Hot/Warm is one chip that selects both statuses.
- **At least one chip is required to save or activate.** Otherwise the save is blocked with "Select at least one lifecycle status."
  - This is a deliberate exception to "drafts save with zero required fields" (CLAUDE.md §10b).
  - New campaigns start with **Cold selected only** (owner decision, 2026-09-22 spec review).
- **Suppressed and opted-out contacts are always excluded** and are never shown as chips.
- **No-status, Opt-in, Clickers and Not-clicked are removed** from the UI.
- The Freeze chip carries a helper note showing the **effective cadence of the selected contact groups**: _"Only contacts whose last message is N+ days ago are eligible at Prepare."_
  - N is each selected group's effective `freeze_cadence_days` (its override, else the org default).
  - If the selected groups differ, the note shows the range, e.g. "14–21 days, depending on the contact's groups".
  - With no group selected, N is the org default.
  - The note is informational. A contact's own cadence is the strictest across *all* its active groups, so a contact also in a non-selected group can have a longer one.
- **Stored shape:** `audience_filters.lifecycle_statuses: ('new'|'hot'|'warm'|'cold'|'freeze')[]`, validated in `audienceFiltersSchema`.
  - The chip writes both `hot` and `warm`, so splitting the chip later needs no migration.
  - The old keys stay in the schema so legacy campaigns still parse.

### 7.2 Semantics

- **The chips are evaluated at activation (snapshot) against the stored status.**
  - A contact's status can change after activation, for example cold → freeze. The chip set is not re-applied at Prepare.
  - The status-based rules in §8 are re-applied at Prepare, so such a contact is then subject to the freeze cadence.
- **One shared builder, `lifecycleChipPredicate()`**, replaces the five copies of the old chip predicate:
  - `buildQualifierFromRelation`, `previewAudience`, `computeStageAudienceCountForDraft`, the batch draft counts and the draft eligibility preview all use it.
  - Legacy campaigns (`lifecycle_rules = false`) keep the old predicate through the same builder.
- **The `campaign_audience_pool` booleans** (`was_clicker_at_snapshot`, …) are still written, because stage-level toggles read them. Stage toggles are unchanged.

### 7.3 Legacy campaigns

- A campaign with `lifecycle_rules = false` keeps its stored filters and its behaviour.
- On open, the UI maps its filters to chips for display:
  - `include_clickers` → Hot/Warm;
  - `include_not_clicked` or `include_no_status` → New + Cold + Freeze;
  - `include_opt_in` has no equivalent and is ignored (3 completed campaigns).
- The mapping is approximate by nature. The old chips meant "ever clicked"; the new ones are based on recency.
- **Drafts that exist when PR 4 is released are converted:** `lifecycle_rules = true` and the mapped chips are stored. There are 0 drafts today.

### 7.4 Audience preview

For lifecycle campaigns, the campaign-level preview shows:

- the qualified audience broken down by status: New / Hot / Warm / Cold / Freeze;
- how many of the Freeze contacts are "not due right now";
- the excluded counts, as exclusive buckets in this priority order:
  1. opted out
  2. suppressed
  3. bought this offer
  4. status not selected
  5. in use elsewhere
  6. 869f53efz's buckets, once that card ships

## 8. Eligibility — one path

### 8.1 Layers

`StageEligibilityExclusions` (`lib/sends/eligibility.ts`) becomes a **labelled, ordered list of layers** instead of fixed fields. `applyEligibilityExcept`, `eligibilityUnion`, the recipients fallback, reconciliation and the preview all iterate that one list, so a layer is added in one place. The new layers apply only when `campaigns.lifecycle_rules = true`:

| Layer | Contacts excluded |
|---|---|
| `suppressed` | `coalesce(ce.status,'new') = 'suppressed'` |
| `bought_offer` | purchasers of the campaign's offer. Uses the same SQL as the `made_purchase_for_offer` segment rule (the campaign's offer + `purchasedClause()`), extracted into one shared builder so the two can't drift. |
| `freeze_not_due` | `ce.status = 'freeze' AND ce.last_sent_at > now() − ce.freeze_cadence_days` |
| _(869f53efz)_ `offer_limit`, `offer_cooldown` | from `contact_offer_campaigns`, other campaigns only (§11) |
| existing `creative`, `in_flight`, `offer` | unchanged |

### 8.2 Where each rule runs

| Rule | Activation (snapshot) | Prepare / materialization | Send time (drain) |
|---|---|---|---|
| Opt-out | ✓ (today) | ✓ (today) | ✓ (today) |
| Suppressed | ✓ | ✓ | ✓ |
| Bought this offer | ✓ | ✓ | ✓ |
| Lifecycle chips | ✓ | — | — |
| Freeze cadence | — (pool keeps freeze contacts) | ✓ | ✓ (live) |
| In use / content dedup / lanes / carrier / split | as today | as today | as today |

The layers run inside `stageRecipientsSql`, so send materialization, the per-stage export, preflight, the preflight breakdown and reconciliation all pick them up.

### 8.3 Exclusion reasons

- Every surface counts each lead **once**, in this fixed priority order: opted out → suppressed → bought this offer → freeze not due → _(offer limit → offer cooldown)_ → saw this creative → in flight elsewhere. The existing buckets (stage filter, split, lane, 1-hour dedup, carrier) follow in their current order.
- The source is the extended `computePreflightBreakdown`.
- It is shown in three places:
  - **The Prepare dialog**, which shows none today. It gains an "Excluded: 1,200 suppressed · 340 freeze not due · 95 bought this offer · …" line.
  - **The stage editor preview.**
  - **The preflight result.**
- The send panel shows send-time drops: "Skipped at send: N freeze cadence · M bought this offer · K suppressed".

### 8.4 Send-time re-check (drain)

In `lib/sends/drain.ts`, after the opt-out and 1-hour dedup checks, and only for lifecycle campaigns, the drain runs one query per claimed batch:

- **suppressed:** reads `contact_engagement.status`.
- **freeze cadence:** the status is `freeze` and there is a live `stage_sends` row sent to that phone within `freeze_cadence_days`. This uses the same `(org_id, phone, sent_at)` index as the 1-hour dedup.
- **bought this offer:** `conversion_events` by `contact_id`.

Rows that fail get `skipped_ineligible` with the reason in `last_error`. This is a read plus an UPDATE, like the opt-out check; no status is computed. It catches the case of two campaigns Prepared for the same freeze contact on the same day.

## 9. New segment rule types

Every type follows the existing convention: the direction is part of the type name, and the operator is `is` only, except for `lifecycle_status`. All of them read `contact_engagement`, so they are fast and inside the 10s preview limit.

| rule_type | Value | Meaning |
|---|---|---|
| `messages_sent_at_least` | N (any positive integer) | `msgs_total ≥ N` |
| `messages_sent_at_most` | N | `msgs_total ≤ N` (a missing row counts as 0) |
| `messages_sent_in_period_at_least` | `{count: N, days: 7\|14\|30\|90}` (new shape `count_in_period`) | `msgs_<days>d ≥ N` |
| `last_message_more_than_n_days_ago` | N (**any**) | `last_sent_at < now − N days` |
| `last_message_in_last_n_days` | N (**any**) | `last_sent_at ≥ now − N days` |
| `last_click_more_than_n_days_ago` | N | `last_click_at < now − N days` |
| `last_click_in_last_n_days` | N | `last_click_at ≥ now − N days` |
| `lifecycle_status` | set of the six statuses; `is` / `is_not` | `coalesce(status,'new') = ANY(set)` |

- **Never messaged / never clicked** contacts match **neither** direction of the "last message" or "last click" rules. Use `lifecycle_status is new` to reach them. This also means an Excl segment "last message in the last 3 days" never removes new contacts.
- **Each type is registered in all 8 places:**
  1. `RULE_TYPES`
  2. `validateValueByShape`
  3. `isRuleComplete`
  4. `verifyValueOwnership` (the new shapes go on its allow-list)
  5. `ruleInnerQuery`
  6. the DB CHECK constraint
  7. `db/schema.ts`
  8. the RulesPanel `ValueControl`, which needs a number input labelled "messages" or "days", a count + period control, and status pills

  `scripts/test-segment-rule-type-registration.ts` guards items 1, 6 and 7.
- Existing rule types and existing segments are untouched.
- **Weekly caps** (decision 5) are built by the operator as segments toggled **Excl** on the campaign. Excl segments are evaluated at **activation** and frozen, as today. A campaign activated long before its first stage therefore applies the cap as of activation (see §14).
- **Activate-dialog warning** (owner decision, 2026-09-22 spec review):
  - Shown when a lifecycle campaign has at least one Excl segment and its earliest scheduled stage is more than 24 hours after the moment of activation.
  - Text: _"Excl segments are applied now, not at send."_
  - It is a warning, not a block; activation still proceeds on confirm.
  - With no stage scheduled yet, there is nothing to compare, so no warning.

## 10. Cohort report

**Status-at-send:**
- **From launch:** status is stamped at Prepare. `insertStageSends` (`lib/sends/kickoff.ts`) becomes `WITH ins AS (INSERT … RETURNING id, contact_id) INSERT INTO stage_send_lifecycle SELECT …` joined to `contact_engagement`. This is one statement in the same transaction, and it applies to every campaign, legacy included, because stamping changes no behaviour.
- **Backfill, 60 days back:** a script, dry-run by default, with `--apply`. It works in batches of one ET day, off-peak, and is resumable (days already stamped are skipped).
  - For each sent row, status is reconstructed from the facts as of `sent_at`: new, hot, warm, cold or freeze, using current thresholds; never suppressed.
  - Rows are written with `reconstructed = true`.
  - The UI marks any period that includes reconstructed rows.

**Page:** Reports → **Lifecycle** (a standalone tab: `/reports/lifecycle` + `/api/reports/lifecycle`, a route-map entry like the other report routes).
- Period controls are the same as Overview: From/To dates in ET, default the last 7 ET days, maximum 92 days.
- **Rows:** New, Cold, Hot, Warm, Freeze, Suppressed, then the rollups **Clickers** (hot + warm) and **Non-clickers** (new + cold + freeze + suppressed), then Total. Sends older than the backfill appear as "Unclassified".

**Metrics:** per recipient, grouped by the stamped status, and dated by **send date**.

| Metric | Source |
|---|---|
| Sends | `stage_sends` with status `sent` in the period |
| CTR | human clickers ÷ sends. Clickers come from `counted_clickers`, joined on the send's (stage, contact). |
| CR | sales ÷ human clickers |
| Sales, revenue | the ledger (`purchasedClause()`), joined through `stage_send_id`. Revenue is approved only. |
| Opt-out rate | `opt_out_attributions` joined through `stage_send_id`, ÷ sends |
| Cost | per send: `coalesce(cost_per_sms, stage rate) × (1 + opted out)`, the Overview formula at send grain |

A footnote states that these per-recipient numbers do not add up to Overview's totals, which come from Keitaro stage aggregates, as on By Group. Manual stage-level sales tallies are not split by cohort.

## 11. 869f53efz — how it plugs in

This spec ships the data (`contact_offer_campaigns`, maintained by the job) and the labelled-layer framework. 869f53efz then adds:

- the `offer_limit` and `offer_cooldown` layers: counts and last date over **other** campaigns carrying the offer, so stage 2 of the current campaign is never blocked by stage 1;
- the same Y/N predicate at activation, **replacing** the permanent "ever got this offer" DELETE in `snapshotAudience`, and in the `previewAudience` `oe_set` — otherwise the snapshot would drop contacts for good that the Y/N rule should re-admit;
- its buckets in the §8.3 order.

Legacy campaigns with the toggle on keep today's "ever got" behaviour, as the card requires. The drip `same_offer` rule is left alone. The two §13 rows marked 869f53efz are its acceptance tests, run on the same harness.

## 12. Backfill and launch sequence

1. Apply migration 0187 to prod, **after the SQL has been approved**. The migration adds tables and columns only, so it is applied before the code that uses it.
2. Deploy PR 1 with the job in **dry-run** mode. It computes everything and writes nothing.
3. **Dry-run report:**
   - counts per status, org-wide and per active contact group (a contact in several groups is counted in each, noted on the report);
   - the transitions it would write;
   - how many freeze contacts are "not due" today.
4. After approval, switch to write mode:
   - The first full run writes every contact, with a `backfill` transition carrying its thresholds.
   - Existing freeze contacts get `freeze_entered_at` = now, so nobody is suppressed at launch.
   - `contact_offer_campaigns` is populated.
   - The cron goes live.
5. After that, PRs 2–5 (§15).

## 13. Tests

**Test safety** (per `docs/07-conventions.md`, 2026-09-22):
- Tests run against the preview database only: `_env-preload` first, then `_require-preview-db`.
- They build their own world with `scripts/_fictional-phones.ts`.
- They clean up by the PKs captured with `RETURNING`.
- No provider HTTP: the drain tests mock the provider and neutralise its key.
- A script whose writes happen inside a library is listed in `GUARDED_VIA_LIBRARY`.

**Transitions.** Fixtures are run through `engagementStatusSql()` in a rolled-back transaction. One case each:

- new → cold on the first message;
- cold → freeze at exactly `freeze_after_messages`, and not at one message fewer;
- freeze with 0 in-freeze messages stays freeze after 200 days;
- freeze → suppressed at 60 days + 2 messages. It does **not** happen at 59 days + 2 messages, or at 60 days + 1 message;
- suppressed stays suppressed when thresholds are raised;
- any → hot on a human click, from cold, freeze, suppressed and warm;
- a click clears the freeze clock and `msgs_since_click`;
- hot → warm at day 31;
- warm → cold at day 121;
- warm → cold → freeze on the same run when ≥ 10 messages were sent since the last click;
- a threshold lowered: cold → freeze. A threshold raised: freeze → cold;
- backfilled freeze contacts can't be suppressed before launch + 60 days;
- a non-human click (bot, prefetch, suspect, unknown, or unscored) changes nothing.

**Threshold resolution:**
- strictest per field across the active groups;
- the "blank = org default" example in §3.3;
- archived groups are ignored;
- no active group → org defaults;
- the transition row carries the effective set.

**Eligibility table (Y=7, N=5).** Fixtures run through `stageRecipientsSql` and the drain:

| Status | Msgs | Last msg | Last click | Times got offer | Last got offer | Eligible? | Enforced by |
|---|---|---|---|---|---|---|---|
| new | 0 | never | none | 0 | never | yes | — |
| cold | 6 | 3d | none | 2 | 10d | yes | — |
| cold | 6 | 3d | none | 2 | 4d | no — cooldown | 869f53efz |
| cold (stored) | 10 | 3d | none | 1 | 20d | no — must be freeze | evaluator ⇒ freeze, `freeze_not_due` |
| freeze | 12 | 10d | none | 1 | 20d | no — freeze not due | `freeze_not_due` |
| freeze | 12 | 15d | none | 1 | 20d | yes | — |
| hot | 20 | 2d | 5d | 5 | 20d | no — offer limit | 869f53efz |
| warm | 20 | 2d | 45d | 3 | 20d | yes | — |
| suppressed | 30 | 20d | none | 0 | never | no | `suppressed` |

**Plus:**
- a buyer of offer X is excluded from an X campaign and allowed in a Y campaign;
- send-time re-check: a freeze contact Prepared in two campaigns, where the second send gets `skipped_ineligible` / `freeze_cadence`, and a purchase recorded after Prepare gives `bought_offer`;
- legacy campaigns (`lifecycle_rules = false`) produce byte-identical recipients before and after;
- the chip mapping for legacy campaigns;
- each new segment rule type, against fixtures;
- an incremental run gives the same rows as a full run on the same world, in one `REPEATABLE READ` transaction;
- report metrics on a fixture world with known stamps.

## 14. Known limitations

- **Day one:** about 125K freeze contacts are "not due" for up to 14 days (accepted).
- **Freshness:**
  - Stored status and facts are up to 15 minutes old.
  - The `msgs_Nd` windows can be up to 1 day stale.
  - Group-membership changes apply nightly.
  - `contact_offer_campaigns` is also up to 15 minutes old. An offer sent in the last 15 minutes may be missed at Prepare; the in-use exclusion usually covers this.
- **Checks that are not repeated at send time:** Excl-segment caps and 869f53efz's rule are evaluated at activation and Prepare only. Freeze, suppressed and buyer are re-checked at send. The activate dialog warns when Excl segments meet a first stage more than 24 hours out (§9).
- **CSV/manual sends are invisible** to the facts. Contacts messaged only that way read as New, and those messages never count toward freeze.
- **The cohort report is per recipient** and does not add up to Overview.
- **`export-all-phones` bypasses all eligibility**, both today and after this change.
- **The Weight Loss / Weight Loss Y overlap:** a stricter override on either group governs about 90K shared contacts.

## 15. Rollout — small PRs

Each PR updates `docs/` per CLAUDE.md, including a new `docs/04-features/contact-lifecycle.md`.

| PR | Contents | Merge gate |
|---|---|---|
| 1 | Migration 0187, the `lib/engagement` job (dry-run switch), dry-run report, heartbeat + alert | SQL approval → prod apply; dry-run approval → write mode (a data write — asks first) |
| 2 | Contacts column + filter, contact detail panel, Settings → Lifecycle, group overrides, preview counts, status-at-send stamping at Prepare, "Global suppression" relabel | ship on green |
| 3 | The 8 segment rule types | ship on green |
| 4 | Audience block redesign, lifecycle chips + shared predicate, Freeze note with effective cadence, activate-dialog Excl warning, labelled layers, send-time re-check, exclusion reasons (Prepare dialog / stage preview / preflight / send panel), `lifecycle_rules` gating, draft conversion | **ask before merge** (changes who is sent) |
| 5 | Lifecycle report tab + 60-day reconstruction script | reconstruction `--apply` asks first (data write, off-peak) |
| — | 869f53efz on top of PR 4 | its own card |

## 16. Choices made in this spec — override any of them

1. Never-messaged or never-clicked contacts match neither direction of the "last message" or "last click" rules (§9).
2. ~~New campaigns start with all four chips selected~~ — superseded at spec review: **Cold only** (§7.1).
3. The one-chip minimum applies to drafts too, an exception to the draft rule (§7.1).
4. Raising a threshold moves freeze → cold. Suppressed is sticky; only a click leaves it (§3.2).
5. A human click is `HUMAN_CLICK` only. Conversion-only "rescued" clickers don't count (§3.1).
6. Chips filter at activation only. Status rules re-apply at Prepare and send (§7.2, §8.2).
7. Send-time drops get a new status, `skipped_ineligible`, with the reason in `last_error` (§4, §8.4).
8. `contact_offer_campaigns` is maintained by the job, not by a send trigger, keeping the send path unchanged (§4, §5).
9. `lifecycle.configure` is a new permission for manager and above (§6).
10. Drafts that exist at PR 4 release are converted to lifecycle campaigns (§7.3). There are 0 today.
11. Drip journeys and `export-all-phones` are out of scope (§1).
