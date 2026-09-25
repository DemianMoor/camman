# Feature — Contact lifecycle status

_Last updated: 2026-09-25_

**PR 1, 2a, 2b and 3 shipped.** The statuses are computed and stored, the
thresholds that decide them are editable (§8), every send records the status it
was prepared under, `contacts.lifecycle_status` carries a queryable projection
(§3a), and the statuses are visible on the contacts list and the contact detail
page (§3c), and eight segment rule types select on lifecycle facts (§3d).
Campaign lifecycle chips and the eligibility layers (PR 4) and the cohort
report (PR 5) follow. Segment rules (PR 3), the campaign lifecycle chips and
the eligibility layers (PR 4) and the cohort report (PR 5) follow.
Design: [2026-09-22-contact-lifecycle-status-design.md](../superpowers/specs/2026-09-22-contact-lifecycle-status-design.md).

## 1. What it is

Every contact carries one status, recomputed from its own send and click history:

| Status | Meaning |
|---|---|
| `new` | never received a campaign message |
| `cold` | messaged, never clicked (or its last click has aged out) |
| `hot` | a human click within `hot_days` (30) |
| `warm` | a human click within `warm_days` (120) |
| `freeze` | `freeze_after_messages` (10) messages since the last click, with no click |
| `suppressed` | 60 days in freeze with ≥ 2 messages sent in freeze, still no click |

Order matters: the rules are evaluated top to bottom and the first match wins, so
a click always beats a message count. The whole definition lives in ONE SQL
builder, `evaluationSelectSql` in
[lib/engagement/status-sql.ts](../../lib/engagement/status-sql.ts).

**Names.** The code says "engagement" because `lib/drip/lifecycle.ts` already
means the drip-journey lifecycle and `opt_outs.reason = 'suppressed'` already
means Global Suppression. The user-facing label is still "Suppressed".

## 2. Definitions this depends on

- **A message** is a `stage_sends` row with `status = 'sent'`. CSV / manual sends
  leave no row, so a contact messaged only that way reads as `new`.
- **A human click** is `HUMAN_CLICK` from
  [lib/reporting/counted-clickers.ts](../../lib/reporting/counted-clickers.ts) —
  `classification = 'human' AND scored_at IS NOT NULL` — joined to the contact
  through `links.contact_id`. Bot, prefetch, suspect and unscored clicks never count.
- **The freeze clock.** `freeze_entered_at` is stamped when a contact enters
  freeze; `freeze_started_at` / `freeze_msgs` count only messages sent *after*
  that. This is why a backfilled freeze contact cannot be suppressed at launch:
  its clock starts at the backfill instant.
- **Thresholds** come from the org's `lifecycle_settings` row (or the defaults in
  [lib/engagement/constants.ts](../../lib/engagement/constants.ts)), then the
  **strictest** value across the contact's **active** contact groups: lowest
  `freeze_after_messages`, longest `freeze_cadence_days`, shortest
  `suppress_after_days`, lowest `suppress_min_freeze_messages`. A group with a
  blank override contributes the org value, so a contact in one overriding group
  and one plain group gets the org value where the plain group is stricter.
  `hot_days` and `warm_days` are org-wide and cannot be overridden per group.

## 3. Where it lives

| Object | Role |
|---|---|
| `contact_engagement` | one row per contact: facts, status, freeze clock, effective cadence, `thresholds` jsonb, `time_due_at` |
| `contact_engagement_transitions` | every status change, with the thresholds in effect and a reason |
| `lifecycle_settings` | org thresholds + `engine_mode` (the job's on/off switch) |
| `contact_groups.{freeze_after_messages, freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages}` | per-group overrides, NULL = inherit |
| `contact_offer_campaigns` | per (contact, offer, campaign) exposure — the grain ClickUp 869f53efz needs |
| `stage_send_lifecycle` | status-at-send, written at Prepare (§3b); read by the PR 5 cohort report |
| `contacts.lifecycle_status` | denormalised PROJECTION of `contact_engagement.status` (§3a) |
| `campaigns.lifecycle_rules` | false on every pre-existing campaign; gates the PR 4 eligibility layers |

Code: [lib/engagement/](../../lib/engagement/) — `constants.ts`, `status-sql.ts`
(the rules), `refresh.ts` (the orchestrator), `settings.ts`, `monitor.ts` — plus
[app/api/cron/refresh-contact-engagement/route.ts](../../app/api/cron/refresh-contact-engagement/route.ts)
and [scripts/engagement-backfill.ts](../../scripts/engagement-backfill.ts).

**A contact with no `contact_engagement` row reads as `new` everywhere.** That is
the contract, so a contact uploaded seconds ago is correct before the job has
seen it, and the incremental run never has to create rows for contacts nothing
has happened to.

### 3a. `contacts.lifecycle_status` — the projection (migration 0188)

`contact_engagement.status` is the source of truth. `contacts.lifecycle_status`
is a copy of it on the `contacts` row, maintained by the job.

It exists because the contacts list filters by status and sorts newest-first,
and those two facts live in different tables — so no index can answer "the
newest 21 contacts whose status is X". Status also correlates strongly with age
(freeze and suppressed contacts are by definition the old, heavily-messaged
ones), so the planner had to walk `contacts` by `created_at` a very long way
before finding a page. Measured on production, page query:

| filter | before 0188 | bar |
|---|---|---|
| cold | 18 ms | 300 ms |
| new | 4 ms | 300 ms |
| warm | 572 ms | 300 ms |
| freeze | 3,931 ms | 300 ms |
| suppressed | 13,413 ms | 300 ms |

Three predicate shapes were measured (correlated `EXISTS`, correlated scalar
`coalesce`, and both ANDed). Each has a different pathological case, because the
problem is the absence of an index rather than the spelling of the `WHERE`
clause. Index `contacts_org_lifecycle_created_idx (org_id, lifecycle_status,
created_at DESC)` turns every one of those into a range scan.

Rules for anyone touching it:

- **Only [lib/engagement/refresh.ts](../../lib/engagement/refresh.ts) writes it**,
  in the same transaction as the `contact_engagement_transitions` row, so a
  status change and its projection commit together or not at all.
- The write is guarded by `IS DISTINCT FROM`, which keeps it to genuinely
  changed rows **and** makes the projection **self-healing**: a row that drifted
  (a failed transaction, or the window between 0188's backfill and the job
  deploying) is corrected by the next run that evaluates it. A `--mode=full`
  recount therefore reconciles everything.
- A contact the job has never seen keeps the column default `'new'`, which is
  the same contract `contact_engagement`'s missing row follows.
- Read it for filtering and sorting. Read `contact_engagement` for anything that
  needs the facts behind the status, and for correctness-critical reads.

### 3b. Status-at-send

`stage_send_lifecycle` records the status a contact held **when the send was
prepared**, because send rows are never rewritten and the cohort report has to
group by the status that applied at the time, not today's.

It is written by a CTE inside `bulkInsertStageSends`
([lib/sends/kickoff.ts](../../lib/sends/kickoff.ts)) — the same statement that
inserts the sends, so a stamp cannot exist without its send and it costs no
extra round trip. `ON CONFLICT (stage_send_id) DO NOTHING` keeps
re-materialization idempotent, matching the send insert's own conflict clause.
It reads `contact_engagement` directly, not the projection. Stamping changes no
send behaviour, so it applies to every campaign, legacy ones included.

### 3c. Where the statuses are visible

**Contacts list** (`/contacts`) — a **Lifecycle** column between Status
indicators and Groups, and a multi-select **Filter by lifecycle** beside the
groups filter. Both read `contacts.lifecycle_status`.

- The column is deliberately **not sortable**. The list API's `SORT_COLUMNS` is
  a two-key whitelist (`phone_number`, `created_at`) and an unrecognised
  `sortBy` falls back to `created_at` silently, so a sortable header would look
  like it worked and would not.
- The filter persists per browser through `usePersistedFilters("contacts.filters")`,
  is included in `filtersAreDefault` (so "Reset filters" appears for it), and
  clears the row selection when it changes.
- **CSV export does not carry it.** `/api/contacts/export` has no `group_ids`
  support either, so "export respects the filters" is already untrue for groups;
  giving export filter parity is its own change, not a rider on this one.

**Contact detail** (`/contacts/[id]`) — a **Lifecycle** card above Attributes:
status and since when, messages total, last message, last human click, the
freeze clock, the effective thresholds and their source, and the last 20
transitions newest-first.

- **Send cadence renders only in Freeze.** Cadence throttling does not apply in
  any other status, so showing "every 14d" on a hot or cold contact would read
  as if it limited their sends.
- A contact the job has never evaluated reads **"New — not yet evaluated"**
  rather than inventing a `status_changed_at`. A missing `contact_engagement`
  row IS `new`, but it is not the same as a row that says `new`.
- The data comes from two extra lookups in the `Promise.all` that
  `GET /api/contacts/[id]` already runs — no new endpoint, so no route-map entry.
- `thresholds.override_group_ids` is resolved to group names from the groups the
  route already returns, so it costs no extra query.

### 3d. The segment rule types (migration 0189)

Eight rule types read lifecycle facts. Seven read `contact_engagement`;
`lifecycle_status` reads the `contacts.lifecycle_status` projection (§3a).

| rule_type | value | meaning |
|---|---|---|
| `messages_sent_at_least` | any N | `msgs_total >= N` |
| `messages_sent_at_most` | any N | `msgs_total <= N`, **a missing row counts as 0** |
| `messages_sent_in_period_at_least` | `{count, days: 7\|14\|30\|90}` | `msgs_<days>d >= count` |
| `last_message_more_than_n_days_ago` | any N | `last_sent_at < now - N days` |
| `last_message_in_last_n_days` | any N | `last_sent_at >= now - N days` |
| `last_click_more_than_n_days_ago` | any N | `last_click_at < now - N days` |
| `last_click_in_last_n_days` | any N | `last_click_at >= now - N days` |
| `lifecycle_status` | a set of the six statuses, `is` / `is_not` | `lifecycle_status = ANY(set)` |

Three contracts worth knowing before using them:

- **Never messaged / never clicked matches NEITHER direction.** `last_sent_at IS
  NULL` fails `< now - N` and `>= now - N` alike, so an "Excl" segment built on
  "last message in the last 3 days" never removes a brand-new contact. Reach
  those contacts with `lifecycle_status is new` instead.
- **"At most N messages" includes contacts the job has not reached.** They have
  no `contact_engagement` row and have been sent nothing, so 0 <= N. The rule is
  driven from `contacts` with a `LEFT JOIN` precisely so that case exists.
- **The windows on `messages_sent_in_period_at_least` are fixed at 7/14/30/90**
  because they ARE the stored `msgs_Nd` columns. Every other rule takes a free N.

The facts are up to 15 minutes old (§14), so a rule reading them is too.

### 3e. The audience chips (PR 4b)

A campaign with `lifecycle_rules = true` picks its audience with five status
chips -- **New / Hot / Warm / Cold / Freeze** -- instead of the four legacy
toggles (`include_no_status`, `include_clickers`, `exclude_clickers`,
`include_opt_in`). The chips OR together and read the 3a projection, so the
predicate is one indexed equality per chip rather than a join.

Three contracts:

- **An empty chip set matches NOBODY, not everybody.** Of the two readings, the
  one that silently messages the entire contact base is the one that must not
  be the default. The form enforces at least one chip, the validator enforces
  it again, and `scripts/test-lifecycle-chips.ts` C4/C5 assert the SQL does too
  -- an empty set and a missing key both match nobody.
- **`suppressed` is not an offerable chip.** It is the end of the lifecycle, not
  an audience you pick. It is excluded as a *layer* (below) so the reason is
  reported rather than silently absent from a chip list.
- **A legacy campaign is completely unaffected.** With `lifecycle_rules = false`
  the old predicate decides and the `lifecycle_statuses` key is ignored
  entirely. This is held by a byte-identical-SQL gate, not by inspection -- see
  section 8.

### 3f. The three send-time layers (PR 4b)

For a lifecycle campaign, `buildStageEligibilityExclusions` adds three
exclusion layers ahead of the content-dedup ones, ordered by
`EXCLUSION_PRIORITY` in [lib/sends/eligibility.ts](../../lib/sends/eligibility.ts):

| layer | excludes | source |
|---|---|---|
| `suppressed` | `lifecycle_status = 'suppressed'` | the 3a projection |
| `bought_offer` | bought this campaign's offer | `purchasedOfferContacts()`, shared with the `made_purchase_for_offer` segment rule |
| `freeze_not_due` | in Freeze AND `last_sent_at > now() - freeze_cadence_days` | `contact_engagement`, per contact |

- **The order is the contract.** A lead caught by two layers is reported under
  the first. Change the order and you change which bucket the number lands in.
- **The freeze cadence is read PER CONTACT**, from the column the job stores --
  no threshold lookup, no join back to `contact_groups`. Two Freeze contacts
  messaged on the same day can differ purely because their group overrides
  differ.
- **`bought_offer` has ONE definition**, shared with the segment rule, so a rule
  and a send-time exclusion cannot disagree about who has bought what.
- **None of the three filters `messaging_status`.** `gateEligible()` gates the
  whole audience -- the same decision PR 3 made for the segment rules, for the
  same reason.

Neither `freeze_not_due` nor `bought_offer` is baked into the frozen pool, and
neither should be: freeze due-ness moves with the clock and purchases keep
arriving after activation, so freezing either would freeze a decision that has
to be made at send time. `suppressed` never enters the audience in the first
place, because it is not a chip.

### 3g. Why a lead was not sent to

The reasons are reported in four places -- the preflight breakdown, the Prepare
dialog, the eligibility preview and the autopilot view. They are the same
buckets because every shape **spreads** `LifecycleExclusionCounts` rather than
listing keys, and `LIFECYCLE_EXCLUSION_KEYS` is *derived* from
`EXCLUSION_PRIORITY` by difference. A missing bucket is a compile error, not a
number that quietly reads zero -- which is what it would look like, and is
indistinguishable from "nobody was excluded for that reason".

The audience preview additionally reports (`AudiencePreviewResult.lifecycle`):

- `by_status` -- the audience split by status; sums to `total_matching`.
- `excluded` -- leads NOT in the audience, **partitioned**: opted out ->
  suppressed -> status not selected -> in use elsewhere. Audience + buckets =
  the whole base, each lead counted once. `in_use_elsewhere` is only counted
  when `exclude_in_use_contacts` is ON, because with it off those leads send.
- `send_time` -- `freeze_not_due` and `bought_offer`, which **overlay** the
  audience: those leads ARE in it and WILL be snapshotted, and the send skips
  them on the day. They are subsets of `total_matching`, not buckets, so they
  do not participate in the partition identity.

### 3h. The Excl-timing warning

Activating a lifecycle campaign with at least one Excl segment whose earliest
scheduled stage is more than 24 h away shows: _"Excl segments are applied now,
not at send."_ A warning, not a block; no scheduled stage means no gap, so no
warning.

The decision is one pure function
([lib/campaigns/excl-timing-warning.ts](../../lib/campaigns/excl-timing-warning.ts))
that both mount sites call, because the failure mode is not "the warning is
wrong" but "the warning is right on the detail page and absent on the list
page" -- which reads to an operator as *nothing to worry about*. The list page
prefetches `GET /api/campaigns/[campaignId]` when the dialog opens rather than
widening the list route, and holds the confirm button until it lands.

### 3i. The send-time re-check (PR 4c)

Prepare applies the three layers of 3f when a stage materializes. The drain
applies them again, once per claimed batch, immediately after the opt-out and
1-hour-dedup gates. Rows that fail become `skipped_ineligible` with the reason
in `last_error`.

**Why twice.** The window between materialization and dispatch is often hours,
because pacing spreads a stage out. In it a contact can become suppressed, buy
the offer, or be messaged by ANOTHER campaign and land back inside their freeze
cadence. Prepare cannot know any of that.

⚠️ **The freeze check reads `stage_sends`, not `contact_engagement`, and that
is the point.** `contact_engagement.last_sent_at` is written by a 15-minute
cron, so it is stale by construction — it cannot see a message sent ten minutes
ago. Reading it here would make the re-check agree with Prepare, and agreeing
with Prepare is exactly what would make it pointless, since Prepare already
ran. It matches on PHONE, not contact_id, for the same reason the 1-hour dedup
does: the cadence is a promise to the person holding the handset.

⚠️ **It fails OPEN.** If the check throws, the batch is dispatched anyway. A few
contacts getting a message they would have been spared is recoverable; a stage
halting mid-drain with rows stuck in `sending` is not, because `sending` rows
are never re-claimed. The failure increments `recheckFailedBatches` and is
logged, so a batch with no numbers reads as **missing**, not as zero.

The module itself throws rather than swallowing — it cannot know whether its
caller can proceed without it, so the drain owns that decision. The drain takes
an injectable `recheckEligibility` seam beside `sendSms`/`isEnabled`, because a
fail-open path that cannot be made to fail on purpose is an untested claim.

The reasons surface in the send panel: "Skipped at send: 340 freeze not due ·
95 bought this offer · 12 suppressed".

### 3j. When a campaign becomes a lifecycle campaign (PR 4c)

A new campaign gets `lifecycle_rules = true` **only while
`lifecycle_settings.engine_mode = 'write'`** (owner decision, 2026-09-25). The
statuses the chips select on are maintained by the job; with the engine off
they are frozen at whenever it stopped, so a campaign picking "Hot" would
target whoever was hot that day rather than whoever is hot now.

- The create route reads the engine **inside its insert transaction**. A read
  before it could disagree with the insert if the switch flipped in between,
  and nothing downstream could tell which engine was live.
- When it falls back, the editor shows the legacy chips plus _"Lifecycle engine
  is off — campaign uses legacy filters"_ — and only when the engine is
  genuinely off. A campaign that is legacy because it predates the feature gets
  no such note, because that is not something an operator can act on.
- The fallback is audited into `org_setting_events` under
  `lifecycle.campaign_fallback`. Only the fallback: the table is a list of
  exceptions, not a log of every create. Without it, a campaign created during
  an engine outage is indistinguishable months later from one deliberately made
  legacy.
- **Existing campaigns are never converted.** Their audience recipes were
  chosen under different semantics, and re-interpreting a stored
  `audience_filters` would change who they reach.

## 4. The job

`refreshContactEngagement` ([lib/engagement/refresh.ts](../../lib/engagement/refresh.ts))
runs inside the caller's transaction and stages everything through ANALYZEd
`ON COMMIT DROP` temp tables.

- **incremental** (every 15 min at `:10/:25/:40/:55`) recounts only contacts with
  a send or a newly scored human click since the last success minus a 30-minute
  overlap, and additionally re-evaluates rows whose `time_due_at` has passed —
  hot → warm, warm → cold and freeze → suppressed need no event, so they must not
  wait for the nightly run. Per-contact recounts reach a contact's sends through
  `stage_sends_org_phone_sent_idx` (`org_id`, `phone`, `sent_at`) `WHERE status='sent'`,
  the only index that can: `stage_sends` has none leading with `contact_id`.
- **full** (`?mode=full`, 06:35 UTC) recounts every contact of the org in three
  passes (human clicks, send facts, offer exposures) and evaluates everyone. It
  also picks up click re-classifications and group-membership changes. Measured
  on prod 2026-09-23: **230 s for 906,082 contacts**.
- **An incremental run escalates to full** when its touched set exceeds
  `INCREMENTAL_MAX_TOUCHED` (20,000), or when the last success is missing or
  more than `FULL_FALLBACK_HOURS` (3 h) old. ⚠️ **This is load-bearing, not
  tuning.** The incremental path costs one index probe per touched contact; on
  2026-09-23 a send burst put **43,448** contacts in a single 15-minute window,
  the recount exceeded the statement timeout, and because `since` advances only
  on success every later run inherited a wider window — the job stalled for
  2.5 h until a full recount was run by hand. The escalation bounds that, and
  the short fallback stops a stall outliving one send burst. The dead-man did
  its job: `contact-engagement-stale` fired 55 minutes in.
- Recounts always read a contact's **full** history, so an overlapping window is
  idempotent. Only rows whose values changed are written.
- `dryRun` computes everything and skips every write.

**Freshness.** Status and facts are at most 15 minutes behind. The rolling
`msgs_7d/14d/30d/90d` windows decay only on the nightly run, so they can be up to
a day stale for a contact with no new activity.

**Not in the send loop.** No trigger is added to `stage_sends`; the drain only
ever reads `contact_engagement`.

## 5. Switching it on

The job skips any org whose `lifecycle_settings.engine_mode` is not `'write'`, so
the cron ships inert.

```bash
# 1. dry run against production — always rolls back, writes nothing
npx tsx --conditions=react-server scripts/engagement-backfill.ts --out dry-run.json

# 2. after the owner approves the numbers: the one-off backfill
npx tsx --conditions=react-server scripts/engagement-backfill.ts --apply
```

`--apply` does the full refresh with reason `backfill`, stamps both heartbeats,
sets `engine_mode = 'write'` and writes an `org_setting_events` audit row — all
in one transaction. It refuses if the org already has `contact_engagement` rows.

**Who may flip it.** `engine_mode` is part of the lifecycle configuration, so
the Settings screen that edits it (PR 2) is gated on **`lifecycle.configure`**
(manager and above), and every change is audited in `org_setting_events` under
the key `lifecycle.engine_mode`. The permission constant exists from PR 1 so
nothing can move the switch through the app before a gate exists for it; in PR 1
the only writer is the backfill script above, which writes the same audit row.

## 6. Configuring it

**Settings → Lifecycle** (`/settings/lifecycle`, permission `lifecycle.configure`,
manager and above; the page's own layout 404s for anyone else):

- the six org thresholds, each with its range and the code default beside it;
- **Preview changes** — what the proposed values would do, before saving;
- the **status engine** switch, with a confirm dialog in BOTH directions: turning
  it off stops every status moving and lets the stored ones go stale, and turning
  it on makes the next run apply everything that happened while it was off.

Save writes one `org_setting_events` row per **changed** field (`lifecycle.<field>`),
so an unchanged field leaves no trace, and stamps `reevaluate_requested_at`.

**Per-group overrides** live on the contact-group edit form: the four freeze and
suppression fields, blank meaning inherit. Each shows the value in force
("Effective: 10 (org default)" / "Effective: 8 (this group)"), and the form says
outright that a contact in several groups takes the **strictest** value across
its active groups rather than this group's. The same preview is available there,
scoped to the group being edited. The `lifecycle.configure` check on the group
PATCH fires only when an override is in the payload, so renaming a group still
needs nothing but `contact_groups.update`.

**How the preview works.** `previewLifecycleThresholds`
([lib/engagement/preview.ts](../../lib/engagement/preview.ts)) runs the same
`evaluationSelectSql` the job uses over the **stored** facts in
`contact_engagement`, with the proposed values injected through
[lib/engagement/thresholds-sql.ts](../../lib/engagement/thresholds-sql.ts). It
does not recount `stage_sends`, and it writes nothing. Measured on production
2026-09-23 over 877,943 contacts: **3.8 s warm, 10.9 s cold**. Contacts with no
`contact_engagement` row are skipped: they are `new` with zero messages, and no
threshold can change that.

**A saved threshold reaches everyone.** The save stamps
`lifecycle_settings.reevaluate_requested_at`; the next 15-minute run compares it
with the `contact-engagement-reeval` watermark in `cron_locks` and, when newer,
evaluates every stored row instead of only the touched and time-due ones. That
costs the evaluate pass only — no recount.

## 7. Monitoring

Heartbeats `contact-engagement` (every 15 min) and `contact-engagement-full`
(nightly) in `cron_locks`, stamped only when every org succeeded. The hourly
`/api/cron/tracking-monitors` watches the 15-minute job; the 15-minute job
watches the nightly one. Neither vouches for itself
([lib/engagement/monitor.ts](../../lib/engagement/monitor.ts)).

Both watches are **silent while no org has the engine on** — a switched-off job
is not a stale one — and they honour the first-run grace, so the deploy that
introduces them cannot page.

## 8. Tests

[scripts/test-engagement-db.ts](../../scripts/test-engagement-db.ts), preview DB only:

- **Part A** — 24 evaluator cases: every transition and both sides of every
  boundary (10 vs 9 messages, 30 vs 31 days, 120 vs 121, 59/60 days and 1/2
  in-freeze messages), the freeze clock, the reason and `time_due_at`.
- **Part B** — a fixture world with hand-derived expectations: the dry run writes
  nothing, the backfill, an idempotent re-run, an incremental run, "a full run
  right after an incremental one writes 0 rows", and the two time-driven moves.
  It also covers the strictest-threshold rule, archived groups being ignored, and
  bot / unscored clicks being ignored.
- **Part C** — the heartbeat watch: silent while off, one latched alert once on
  and missing past its grace.
- **Part D** — the settings preview: proposing the saved values moves nobody, a
  lowered freeze threshold moves exactly the contacts that qualify, a shrunken
  warm window ages the warm ones out, a group override reaches only that group,
  and nothing is written.
- **Part E (R1–R7)** — `reevaluate_requested_at`: the pure predicate's four
  cases, then the pair that matters — an ordinary incremental run does NOT see a
  new threshold, and the same run with `evaluateAll` does, recording a transition
  that carries the new thresholds.

[scripts/test-segment-rule-lifecycle.ts](../../scripts/test-segment-rule-lifecycle.ts)
covers the eight rule types (3d), 27 bars over L1-L12.

The PR 4b bars:

- [scripts/test-lifecycle-chips.ts](../../scripts/test-lifecycle-chips.ts) -- 10
  bars on the chip predicate, through the real qualifier. C4/C5 are the ones
  that matter: an empty and a missing chip set both match nobody.
- [scripts/test-lifecycle-eligibility-layers.ts](../../scripts/test-lifecycle-eligibility-layers.ts)
  -- 13 bars on the three layers. E4 pins the per-contact cadence with a pair
  differing ONLY in `freeze_cadence_days`; E13 compares the emitted SQL TEXT of
  the `bought_offer` layer against the segment rule's clause, because comparing
  the rows would only prove one function equals itself.
- [scripts/test-lifecycle-preview-breakdown.ts](../../scripts/test-lifecycle-preview-breakdown.ts)
  -- 14 bars on the breakdown, including the partition identity in both
  `exclude_in_use` states.
- [scripts/test-exclusion-bucket-drift.ts](../../scripts/test-exclusion-bucket-drift.ts)
  -- 9 bars that the four reporting shapes carry one bucket set, plus a SOURCE
  scan that no fifth copy exists. The source half is the load-bearing one: a
  copy that agrees today is exactly how the previous four drifted.
- [scripts/test-excl-timing-warning.ts](../../scripts/test-excl-timing-warning.ts)
  -- 16 bars; H10 feeds one campaign through BOTH mount paths and asserts they
  build an identical argument object.
- [scripts/test-lifecycle-switch.ts](../../scripts/test-lifecycle-switch.ts) --
  11 bars on the switch. K5/K6 assert the OTHER direction, because a one-sided
  test passes just as happily on a gate that can never turn on; K9-K11 read the
  route's SOURCE, because the rest of the file exercises a reproduction of its
  decision and would pass after the gate was deleted.
- [scripts/test-lifecycle-send-recheck.ts](../../scripts/test-lifecycle-send-recheck.ts)
  -- 14 bars on the send-time re-check. Every freeze fixture has
  `last_sent_at` NULL, so J2/J4 go red if anyone "tidies" the check back into
  reading `contact_engagement`. J11-J13 run the REAL `runStageDrain` in a
  rolled-back transaction; J13 proves the fail-open path by injecting a
  throwing re-check and asserting the batch still dispatched.
- [scripts/test-eligibility-layers-identical.ts](../../scripts/test-eligibility-layers-identical.ts)
  -- the byte-identical-SQL gate. It captures the SQL every real stage produces
  from `origin/main` and diffs it, so "legacy campaigns are untouched" is a
  measured claim over 5,368 query shapes rather than a reviewed one.

Plus [scripts/measure-lifecycle-preview.ts](../../scripts/measure-lifecycle-preview.ts),
a read-only production measurement whose every run rolls back, and
[scripts/measure-lifecycle-audience.ts](../../scripts/measure-lifecycle-audience.ts),
which produces the chip and per-layer counts against production **without
creating or flipping a campaign** -- `lifecycleRules` is a parameter on every one
of these paths, so the hypothetical is evaluated by passing `true`.

[scripts/dryrun-lifecycle-recheck.ts](../../scripts/dryrun-lifecycle-recheck.ts)
does the same for the send-time re-check: it mirrors the drain's claim
predicate (same ORDER BY, same batch size, minus `FOR UPDATE SKIP LOCKED` and
the UPDATE) and reports what each reason WOULD have skipped. It stops at ~10%
for any one reason, reports a reason that never fires as "never observed"
rather than as a measured 0, and splits the freeze figure by which signal
catches it -- both / send-time only / Prepare only -- because the headline
share alone cannot distinguish "the layers disagree" from "the cadence is
genuinely being violated".
