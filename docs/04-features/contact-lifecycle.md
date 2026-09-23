# Feature — Contact lifecycle status

_Last updated: 2026-09-22_

**PR 1 of 5: the data layer only.** The statuses are computed and stored, and
nothing reads them yet. Segment rules (PR 3), the campaign lifecycle chips and
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
| `stage_send_lifecycle` | status-at-send for the cohort report (filled in PR 2 / PR 5) |
| `campaigns.lifecycle_rules` | false on every pre-existing campaign; gates the PR 4 eligibility layers |

Code: [lib/engagement/](../../lib/engagement/) — `constants.ts`, `status-sql.ts`
(the rules), `refresh.ts` (the orchestrator), `settings.ts`, `monitor.ts` — plus
[app/api/cron/refresh-contact-engagement/route.ts](../../app/api/cron/refresh-contact-engagement/route.ts)
and [scripts/engagement-backfill.ts](../../scripts/engagement-backfill.ts).

**A contact with no `contact_engagement` row reads as `new` everywhere.** That is
the contract, so a contact uploaded seconds ago is correct before the job has
seen it, and the incremental run never has to create rows for contacts nothing
has happened to.

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
  also picks up click re-classifications and group-membership changes. An
  incremental run falls back to full when the last success is missing or more
  than 24 h old.
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

## 6. Monitoring

Heartbeats `contact-engagement` (every 15 min) and `contact-engagement-full`
(nightly) in `cron_locks`, stamped only when every org succeeded. The hourly
`/api/cron/tracking-monitors` watches the 15-minute job; the 15-minute job
watches the nightly one. Neither vouches for itself
([lib/engagement/monitor.ts](../../lib/engagement/monitor.ts)).

Both watches are **silent while no org has the engine on** — a switched-off job
is not a stale one — and they honour the first-run grace, so the deploy that
introduces them cannot page.

## 7. Tests

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
