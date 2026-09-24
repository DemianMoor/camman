# Feature — Contact lifecycle status

_Last updated: 2026-09-24_

**PR 1, 2a and 2b shipped.** The statuses are computed and stored, the
thresholds that decide them are editable (§8), every send records the status it
was prepared under, `contacts.lifecycle_status` carries a queryable projection
(§3a), and the statuses are visible on the contacts list and the contact detail
page (§3c). Nothing selects an audience by status yet. Segment rules (PR 3), the campaign lifecycle chips and
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

Plus [scripts/measure-lifecycle-preview.ts](../../scripts/measure-lifecycle-preview.ts),
a read-only production measurement whose every run rolls back.
