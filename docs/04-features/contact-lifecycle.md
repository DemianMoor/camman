# Feature — Contact lifecycle status

_Last updated: 2026-10-02_

**PR 1 through 4d shipped; PR 5 is open.** The statuses are computed and
stored, the thresholds that decide them are editable (§8), every send records
the status it was prepared under, `contacts.lifecycle_status` carries a
queryable projection (§3a), the statuses are visible on the contacts list and
the contact detail page (§3c), eight segment rule types select on lifecycle
facts (§3d), and campaigns pick their audience with the status chips and drop
the three lifecycle layers plus the offer cooldown/limit rules at send time
(§3e–§3f2). PR 5 adds the cohort report and the reconstruction that gives it
history (§3k).
Design: [2026-09-22-contact-lifecycle-status-design.md](../superpowers/specs/2026-09-22-contact-lifecycle-status-design.md).

## 1. What it is

Every contact carries one status, recomputed from its own send and click history:

| Status       | Meaning                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `new`        | never received a campaign message                                         |
| `cold`       | messaged, never clicked (or its last click has aged out)                  |
| `hot`        | a human click within `hot_days` (30)                                      |
| `warm`       | a human click within `warm_days` (120)                                    |
| `freeze`     | `freeze_after_messages` (10) messages since the last click, with no click |
| `suppressed` | 60 days in freeze with ≥ 2 messages sent in freeze, still no click        |

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
  freeze; `freeze_started_at` / `freeze_msgs` count only messages sent _after_
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

| Object                                                                                                           | Role                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `contact_engagement`                                                                                             | one row per contact: facts, status, freeze clock, effective cadence, `thresholds` jsonb, `time_due_at` |
| `contact_engagement_transitions`                                                                                 | every status change, with the thresholds in effect and a reason                                        |
| `lifecycle_settings`                                                                                             | org thresholds + `engine_mode` (the job's on/off switch)                                               |
| `contact_groups.{freeze_after_messages, freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages}` | per-group overrides, NULL = inherit                                                                    |
| `contact_offer_campaigns`                                                                                        | per (contact, offer, campaign) exposure — the grain ClickUp 869f53efz needs                            |
| `stage_send_lifecycle`                                                                                           | status-at-send, written at Prepare (§3b); read by the PR 5 cohort report                               |
| `contacts.lifecycle_status`                                                                                      | denormalised PROJECTION of `contact_engagement.status` (§3a)                                           |
| `campaigns.lifecycle_rules`                                                                                      | false on every pre-existing campaign; gates the PR 4 eligibility layers                                |

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

| filter     | before 0188 | bar    |
| ---------- | ----------- | ------ |
| cold       | 18 ms       | 300 ms |
| new        | 4 ms        | 300 ms |
| warm       | 572 ms      | 300 ms |
| freeze     | 3,931 ms    | 300 ms |
| suppressed | 13,413 ms   | 300 ms |

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

| rule_type                           | value                                      | meaning                                          |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `messages_sent_at_least`            | any N                                      | `msgs_total >= N`                                |
| `messages_sent_at_most`             | any N                                      | `msgs_total <= N`, **a missing row counts as 0** |
| `messages_sent_in_period_at_least`  | `{count, days: 7\|14\|30\|90}`             | `msgs_<days>d >= count`                          |
| `last_message_more_than_n_days_ago` | any N                                      | `last_sent_at < now - N days`                    |
| `last_message_in_last_n_days`       | any N                                      | `last_sent_at >= now - N days`                   |
| `last_click_more_than_n_days_ago`   | any N                                      | `last_click_at < now - N days`                   |
| `last_click_in_last_n_days`         | any N                                      | `last_click_at >= now - N days`                  |
| `lifecycle_status`                  | a set of the six statuses, `is` / `is_not` | `lifecycle_status = ANY(set)`                    |

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

The chip row is the **first thing in the Audience block**, directly under the
AUDIENCE header and above Segments / Contact groups / Audience cap (spec §7.1):
it is the first decision about who the campaign reaches, and the others narrow
what it selects.

⚠️ **The create form has THREE states, not two.** While the engine read is in
flight the answer is _not yet known_, and rendering that as "legacy" is a bug —
it showed a read-only chip row and the old Filters row with no explanation, for
as long as the request took. The row now says "checking the lifecycle engine…",
shows nothing as selected, and withholds the legacy Filters row until the
answer lands. The read is bounded (8s); on timeout or failure it falls back to
legacy **with** the engine-off note, never silently.

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
  an audience you pick. It is excluded as a _layer_ (below) so the reason is
  reported rather than silently absent from a chip list.
- **A legacy campaign is completely unaffected.** With `lifecycle_rules = false`
  the old predicate decides and the `lifecycle_statuses` key is ignored
  entirely. This is held by a byte-identical-SQL gate, not by inspection -- see
  section 8.

### 3e2. Who decides `lifecycleRules`, on every path

A campaign that EXISTS carries the answer in `campaigns.lifecycle_rules`. A
campaign being CREATED has no row yet, so the create-mode preview and the
create+activate snapshot must ask
`newCampaignUsesLifecycleRules()`
([lib/engagement/lifecycle-gate.ts](../../lib/engagement/lifecycle-gate.ts)) —
the same `engine_mode = 'write'` question the create route answers when it
writes the row.

| path                             | source of the flag                           |
| -------------------------------- | -------------------------------------------- |
| create-mode audience preview     | the gate (no row exists yet)                 |
| create + activate snapshot       | the gate — the same value written to the row |
| draft → active snapshot          | `campaigns.lifecycle_rules` off the row      |
| stage previews, preflight, drain | `campaigns.lifecycle_rules` off the row      |

⚠️ **`lifecycleRules` is REQUIRED on `AudiencePreviewInput`, and it was optional
until that caused a production bug.** Three call sites never passed it and an
optional default let them compile: the create-mode preview silently used the
legacy predicate (so toggling chips changed no number on screen), and BOTH
activation snapshots would have **frozen the legacy audience into a campaign
whose row said `lifecycle_rules = true`** — a pool and a campaign permanently
disagreeing about which predicate chose it, since a pool is never recomputed.
An optional default hides exactly the call sites nobody updated.

A campaign keeps the semantics it was created under: the draft→active snapshot
reads the row, not the engine's posture today.

### 3f. The three send-time layers (PR 4b)

For a lifecycle campaign, `buildStageEligibilityExclusions` adds three
exclusion layers ahead of the content-dedup ones, ordered by
`EXCLUSION_PRIORITY` in [lib/sends/eligibility.ts](../../lib/sends/eligibility.ts):

| layer            | excludes                                                   | source                                                                             |
| ---------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `suppressed`     | `lifecycle_status = 'suppressed'`                          | the 3a projection                                                                  |
| `bought_offer`   | bought this campaign's offer                               | `purchasedOfferContacts()`, shared with the `made_purchase_for_offer` segment rule |
| `freeze_not_due` | in Freeze AND `last_sent_at > now() - freeze_cadence_days` | `contact_engagement`, per contact                                                  |

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

**⚠️ CHANGED 2026-09-28 — all three are now AUDIENCE exclusions, applied when
the audience is chosen.** This section previously said the opposite: that
neither `freeze_not_due` nor `bought_offer` should be baked into the frozen
pool, because freeze due-ness moves with the clock and purchases keep arriving,
so the decision belonged at send time.

That reasoning missed that **the cap samples the pool first**. Campaign 1501
("Freeze - Atlass Coffee", offer 126) targeted the freeze cohort across four
Weight Loss groups. Of the 69,185 freeze contacts there, only ~2% were past
their 14-day rest period. Capped at 1,500 it drew 1,500 at *random* from all
69,185 — and the stage could send to **28**. `1,500 × (1,371 ÷ 69,185) = 30`;
the 28 was the arithmetic, not a fault. The other 1,472 were then *locked*: they
sat in an active campaign's pool, so `exclude_in_use_contacts` kept them out of
every other campaign while the campaign holding them could not message them.

The owner's ruling: "the audience on the campaign configuration level should
only show allowed sendable contacts... that should be the rule for every
lifecycle cohort."

Measured on production for the same recipe after the change: **1,340 sendable**
(1,371 due − 31 already in use), every one of them deliverable, against 1,500
of which 28 were.

**This cannot send to anyone the old code blocked.** `lib/sends/eligibility.ts`
still EXCEPTs the same layers on the day, so a lead who buys the offer or
re-enters freeze between activation and send is still caught. Selection-time
filtering only stops the pool being padded with people who cannot receive the
message — the same belt-and-braces as `exclude_prior_offer_contacts` (§10b).

The accepted cost: the pool is frozen to who is sendable on **activation day**,
so a contact who becomes due tomorrow is not in *that* campaign. These are
daily campaigns — tomorrow's picks them up — and a genuine multi-week trickle is
what drip campaigns are for.

`suppressed` never enters the audience in the first place, because it is not a
chip; it is applied anyway so the layer list is uniform.

### 3e2. The chips must reach the EDIT screen (2026-09-30)

`GET /api/campaigns/[campaignId]` uses an explicit `.select({...})`, and
`lifecycle_rules` was never in it. The editor resolves `lifecycleRules` from
that field, so it read `undefined === true` -> **false** for every saved
campaign, concluded the campaign was legacy, and rendered
`mapLegacyFiltersToChips()` -- the approximate mapping of the four legacy
booleans -- instead of the stored `audience_filters.lifecycle_statuses`.

Observed on production data via Playwright, before the fix: **all four chips
rendered as selected**, on a draft and on an activated campaign alike, with the
note "read-only, mapped from the filters below (approximate)". The selection was
stored and loaded correctly the whole time; only this one flag never arrived.

The flag is now selected and threaded `EditModeLoader -> Inner ->
useCampaignFormState`, and `CampaignDetail.lifecycle_rules` is **required**
(CLAUDE.md §11b) so a future caller cannot omit it silently.

⚠️ **Read-only must stay legible.** The chip styling applied a blanket
`opacity-60` whenever `!editable`, which dimmed the SELECTED chip too. An
activated campaign's audience is frozen, so it is *always* read-only — meaning
the one state where the operator most needs to know what was chosen was the
state that washed it out. Only unselected chips dim now; the cursor carries "you
cannot edit this". The tooltip also separates the two reasons a chip is
read-only: "this campaign predates lifecycle rules" vs "the audience was frozen
when this campaign was activated".

Guards: `scripts/test-lifecycle-chips.ts` PART R (R1/R2), red-proved against
`origin/main`. ⚠️ They are source scans and prove a file, not a screen — the
real verification was Playwright reading computed styles (Cold `opacity: 1` and
filled, the other three `opacity: 0.6` and outlined, on campaign 1538).

### 3f2. The offer rules — cooldown and limit (869f53efz, PR 4d)

Two more layers, for a campaign whose "Exclude leads who already got this
offer" toggle is on AND that was created with `offer_rules_enabled`:

| layer            | excludes                                                    |
| ---------------- | ----------------------------------------------------------- |
| `offer_limit`    | got this offer in **N or more other CAMPAIGNS** (default 5) |
| `offer_cooldown` | last got it **within Y days** (default 14 for new campaigns since 2026-10-02, `OFFER_COOLDOWN_DAYS_DEFAULT`; was 7) |

Both read `contact_offer_campaigns`, the per-(contact, offer, campaign) rollup
the engagement job maintains.

- ⚠️ **The limit counts CAMPAIGNS, not messages.** One sequence = 1 however
  many stages it sends. `count(*)` over rows, never `sum(messages)` — the
  `messages` column exists for reporting. The two readings agree on every
  fixture except one campaign with several messages, which is why
  `test-offer-limit-cooldown.ts` M6b exists.
- ⚠️ **The current campaign is carved out of both counts**, so stage 2 is never
  blocked by stage 1 and a drip does not cannibalise itself on its second
  message. That carve-out is why the table is keyed by campaign at all.
- **Exactly Y days ago is INSIDE the cooldown** — the rule is "more than Y days
  ago" to be eligible, the same `>` the freeze cadence uses.
- **A click does not reset either count.** Engagement and offer fatigue are
  different things.
- ⚠️ **The Y/N rule REPLACES "ever got this offer"; the two never stack.**
  Stacked, a contact past their cooldown would stay excluded forever and the
  feature would be inert. At activation, `snapshotAudience` runs one DELETE or
  the other — still a separate statement after `ANALYZE`, per the planner note
  in CLAUDE.md §10b.

**Which rule a campaign gets** is `campaigns.offer_rules_enabled`. It defaults
to FALSE in the column and is set true only by the create route, so the 673
campaigns that predate migration 0191 keep "ever got this offer" and nobody's
frozen pool changes meaning underneath them.

In the preview breakdown both land in `excluded`: they keep a lead out of the
**pool**. Since 2026-09-28 every lifecycle layer does, and the `send_time` group
is gone entirely (§3f, §3g).

### 3f4. The preview must apply the SAME offer rule as the freeze (2026-09-28)

PR 4d made the cooldown/limit pair **replace** the permanent "ever got this
offer" rule rather than stack with it, and changed `snapshotAudience`
accordingly — it builds its qualifier with `excludePriorOffer: false` and then
runs one DELETE or the other. `previewAudience` did not get that change. It
kept applying the permanent rule **and** merely reported the new ones, so the
screen and the activation answered differently.

Measured on production, Hot/Warm × three Weight Loss groups × one offer,
cooldown 30 / limit 5:

| | |
| --- | ---: |
| preview — what the operator sized the campaign from | **77** |
| snapshot — what activating it would have frozen | **1,907** |

The 77 was exactly "never received this offer, ever". The **1,830** contacts in
between had received it once or twice and had since rested past their cooldown:
shown as excluded, and would have been messaged anyway.

Two things were wrong and both had to be fixed:

- the permanent rule ran even when the Y/N rules did — now
  `excludePriorOffer && !offerRulesOn`, mirroring the snapshot;
- the Y/N layers were **reported but not subtracted**. They are AUDIENCE
  exclusions, so `total_matching` has to drop. The tell was that setting the
  cooldown to 0 did not move the audience while the cooldown bucket read
  117,975 — a bucket larger than the group it was drawn from.

⭐ **The regression bar is a CROSS-PATH one**
([scripts/test-preview-matches-snapshot.ts](../../scripts/test-preview-matches-snapshot.ts)).
Every other suite tests one function or the other, and each passed throughout;
only asserting that the two give the same answer catches a disagreement between
them. Red-proved against the old code: preview 1 against snapshot 2.

⚠️ **The two rules read different tables** — the Y/N pair counts campaigns in
`contact_offer_campaigns`, the permanent rule asks only whether an
`offer_exposures` row exists. A fixture that feeds one and not the other makes
the unfed rule look like it excludes nobody, which is exactly how the first
version of that bar mis-stated its expectation.

### 3g. Why a lead was not sent to

The reasons are reported in four places -- the preflight breakdown, the Prepare
dialog, the eligibility preview and the autopilot view. They are the same
buckets because every shape **spreads** `LifecycleExclusionCounts` rather than
listing keys, and `LIFECYCLE_EXCLUSION_KEYS` is _derived_ from
`EXCLUSION_PRIORITY` by difference. A missing bucket is a compile error, not a
number that quietly reads zero -- which is what it would look like, and is
indistinguishable from "nobody was excluded for that reason".

The audience preview additionally reports (`AudiencePreviewResult.lifecycle`):

- `by_status` -- the audience split by status; sums to `total_matching`.
- `excluded` -- leads NOT in the audience, **partitioned**: opted out ->
  suppressed -> status not selected -> bought offer -> freeze not due ->
  offer limit -> offer cooldown -> in use elsewhere. Audience + buckets = the
  whole base, each lead counted once. `in_use_elsewhere` is only counted when
  `exclude_in_use_contacts` is ON, because with it off those leads send.
- **There is no `send_time` group any more** (2026-09-28). `freeze_not_due` and
  `bought_offer` joined the partition when they became audience exclusions
  (§3f). `status_not_selected` also moved AHEAD of the cohort-specific layers,
  so a campaign targeting Hot no longer reports thousands of "freeze not due"
  against people who were never candidates for it — the old ordering did
  exactly that with the offer buckets, showing a cooldown bucket of 117,975
  beside an audience of 1,907.

### 3h. The Excl-timing warning

Activating a lifecycle campaign with at least one Excl segment whose earliest
scheduled stage is more than 24 h away shows: _"Excl segments are applied now,
not at send."_ A warning, not a block; no scheduled stage means no gap, so no
warning.

The decision is one pure function
([lib/campaigns/excl-timing-warning.ts](../../lib/campaigns/excl-timing-warning.ts))
that both mount sites call, because the failure mode is not "the warning is
wrong" but "the warning is right on the detail page and absent on the list
page" -- which reads to an operator as _nothing to worry about_. The list page
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

⚠️ **The form asks `/api/campaigns/lifecycle-mode`, not `/api/settings/lifecycle`**
(2026-09-28). The settings route is `null` in the operator route map —
`lifecycle.configure` is manager+ — so for an OPERATOR it 403'd every time, the
catch reported the engine as off, and every operator saw the legacy chips and
the "engine is off" note. That was not cosmetic, which the fallback's own
comment had assumed: the create route decides `lifecycle_rules` server-side from
the same posture, so the campaign became a lifecycle campaign anyway, carrying
legacy `audience_filters` with **no `lifecycle_statuses`** — which the chip
predicate reads as *match nobody* (§3e). The new route returns one boolean and
is gated on `campaigns.view`; the settings route stays denied.

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

### 3k. The cohort report (`/reports/lifecycle`, PR 5)

One row per lifecycle cohort, by send date in ET: sends, clickers, CTR, sales,
CR, revenue, opt-out rate and cost.
[lib/reporting/lifecycle-report.ts](../../lib/reporting/lifecycle-report.ts),
behind `GET /api/reports/lifecycle?from=&to=` (`campaigns.view`, **14-day
cap**, `maxDuration = 60`), rendered by
[components/reports/lifecycle-report.tsx](../../components/reports/lifecycle-report.tsx).

**The cohort comes from the stamp, never from `contacts.lifecycle_status`.**
`stage_send_lifecycle.status` is what the contact WAS when the message went
out; the live column is what they are now. Reading the live one would move
contacts between cohorts retroactively, so last week's number would change
every time you looked at it. Measured on stage 4791 nineteen hours after its
send: stamped hot 1,306 / warm 1,526, live hot 1,315 / warm 1,517 — nine
contacts had already moved.

Rows, in order: the six statuses, then `Clickers` (hot + warm) and
`Non-clickers` (the rest), then `Total`, then `Unclassified`.

- **`Unclassified` is a real row**, counting sends with no
  `stage_send_lifecycle` row. Omit it and the cohorts silently fail to sum to
  Total, and a reader concludes the tool is broken rather than that history is
  missing.
- **`Suppressed` shows a dash, not zeros**, with _"excluded by construction"_.
  Suppressed contacts never enter an audience, so the row is structurally
  empty; a 0 would read as a measurement somebody made.
- **Every ratio with no denominator is `null`, not 0.** A 0% CTR on zero sends
  is a statement nobody measured.

Four things the page says in its footer because a number above it would
otherwise be read as something else:

| Footer line | Why it is there |
| --- | --- |
| Sales/CR/Revenue **attributed only** | ~1,038 attributed sales across 3.88M sends. Unlabelled, that reads as catastrophic performance rather than as an attribution gap. |
| **CTR uses raw human clicks** | Overview uses `counted_clickers`, which lags the scoring cron. The same period gave 125 here and 112 there on stage 4791 at 19 h. An unexplained discrepancy between two tabs is worse than either number. |
| **Cost includes opt-out cost** | An opt-out reply is billed like a send, so a cohort with more opt-outs costs more per send. That is the point of the column, but only if the reader knows it. |
| **One status per contact per ET day** | For reconstructed periods the cohort is evaluated once per ET day, not per message (owner decision, 2026-09-27) — a contact messaged three times in a day carries one status for that day. |

⚠️ **The ET day becomes an instant in JS, via `etDayBounds`** — never
`<date> AT TIME ZONE 'America/New_York'` in SQL, which lands the boundary 8
hours early (see [07-conventions.md](../07-conventions.md)). The same mistake
sat in the reconstruction's `asOf` and in this window at once; both are now the
shared helper, and both carry a boundary bar that red-proves.

**Sources.** Sends from `stage_sends` (`status = 'sent'`); cohort from
`stage_send_lifecycle`; clicks from raw `clicks` + `links` under the imported
`HUMAN_CLICK`; opt-outs from `opt_out_attributions.stage_send_id`; sales
ledger-primary with `stage_sends.sale_*` as the fallback only where no ledger
event exists (4 such rows in 60 days), revenue for a send in both being the
ledger's approved-only sum.

⚠️ **The click join reads `(stage, contact)`, both columns.** That is the grain
`counted_clickers` keys on. On `contact_id` alone it counts every link the
contact ever clicked, org-wide, across every campaign — so a Hot contact
imports their whole click history into whichever cohort they sit in, and cohort
CTR measures the CONTACT instead of the send, inflated in exactly the cohorts
that clicking defines.

**The window is 92 days, the same as Overview — restored by the day rollup
(§3k3).** It was 14 for one PR, and the reason is worth keeping because it is
what the rollup exists to fix: Cohort CTR asks "did this (stage, contact) click", which is
per-recipient over `links` + `clicks` with no rollup behind it. On production:
2d ~13–19s, 5d ~18s, 7d ~21–26s, 14d ~34s — linear with a large constant, so 92
days is minutes. A cap the route cannot serve is worse than a smaller one: the
request burns the whole `maxDuration` and returns a 504 with nothing to show.

The rollup lifts it **without** changing where the clicks come from — raw
`HUMAN_CLICK` stays, so the cohort definition and the CTR still share a source.
A day is computed once and summed thereafter.

Two shapes in the query are load-bearing, both measured on a five-day window:

- **The click join is driven from the window's LINKS, by stage.** Driven from
  the sends instead — as a join or as an `EXISTS` — the planner led with
  `clicks_classification_scored_at_idx`, read EVERY human click in the org
  (195,235 rows) and did a `links_pkey` heap fetch for each at 0.276 ms. That is
  34.3s of a 42.4s window, and it does not depend on how much data is being
  reported on. Scanning links by `stage_id` reads comparable rows with adjacent
  heap pages, and the per-link probe into `clicks_link_id_idx` is index-only for
  the ~97% of links nobody clicked.
- **The stage rate is computed only for stages that need one.** It is a fallback
  for sends whose own `cost_per_sms` is NULL, and the pipeline snapshots that per
  row, so in practice almost none do. Counting every stage in the window cost
  7.4s of the same 42.4s to produce rates nothing then read. (Written as a scalar
  subquery inside the `LATERAL` it was also expanded TWICE per stage, because the
  `CASE` references `denom` twice.)

⚠️ **The temp-table fix from §10b was tried here and did NOT reproduce** — the
same five-day window ran 51.5s as a CTE and 53.6s materialized and `ANALYZE`d.
Nor could the variants be ranked afterwards: repeats of identical code on a
7-day window spanned 20.8s, 21.8s and 25.5s, so the spread between REPEATS is as
large as the gap between shapes. The simpler single statement is what ships.

**Cost** is `coalesce(the send's own cost_per_sms, the stage's implied rate)`
× `(1 + opted out)`. The implied rate divides `campaign_stages.total_cost` by
the same denominator that produced it —
`greatest(sms_count, the stage's sent rows) + opt_out_count`, from
[lib/stages/total-cost.ts](../../lib/stages/total-cost.ts) — so apportioning it
back across the stage's sends reproduces `total_cost` rather than a number near
it. `greatest(…)` is not defensive: an API stage leaves `sms_count` at 0 and
materializes one row per recipient, so dividing by `sms_count` alone would
divide by zero for every stage this report can see. Manual/CSV stages have no
per-recipient rows and so contribute nothing here at all — one of several
reasons this tab does not foot with Overview.

### 3k3. The day rollup (migration 0192)

`lifecycle_day_rollup` holds one row per **(org, ET day, cohort)**:
`sends`, `clickers`, `sales`, `revenue`, `opt_outs`, `cost`, `reconstructed`.
[lib/reporting/lifecycle-rollup.ts](../../lib/reporting/lifecycle-rollup.ts).

**One definition, two grains.** `lifecycleDayRowsSql` is `lifecycleReportSql`
with a single extra `GROUP BY` column — not a re-typed copy. Two spellings of
"what is a clicker" would agree on the day they were written and diverge
quietly after, and the rollup's whole claim is that its numbers ARE the
per-recipient numbers.

⚠️ **Counts are stored; ratios are derived.** CTR, CR and opt-out rate are
computed at read time from summed numerators and denominators. A stored per-day
ratio averaged across a window would weight a 200-send day like a 90,000-send
one — bar Q1 pins this with a fixture whose pooled CTR (57.14%) differs from
the average of its days (62.50%).

**The read is a hybrid: closed days from the rollup, today live.** A nightly
rollup cannot know about today, and mid-send-day "today" is exactly the number
an operator watches — the same reasoning, and the same split at ET midnight,
as Overview's Total Sent. So a 92-day window is a summation over 91 stored days
plus one day computed on the spot.

**Written by the engagement job's nightly full run** (06:35 UTC / 02:35 ET),
recomputing a **14-day trailing window** so late-scored clicks, conversions on
the 15-minute poll and opt-outs that arrive days later still land. It runs
**outside** the refresh transaction: the rollup is a read-side convenience, and
a reporting query must never be able to roll back `contact_engagement`, which
the send path reads. A rollup failure is logged and withholds nothing.

⚠️ **The refresh DELETEs the range then INSERTs it**, rather than upserting. An
upsert cannot remove a `(day, cohort)` cell that should no longer exist — after
the reconstruction stamps a send that was `__unclassified__`, that cell would
sit there forever and the cohorts would stop summing to Total. Bar R2 pins it.

**Staleness is reported as a timestamp, not a count of missing days.** The
obvious signal — "days in the window with no rollup row" — cannot be computed:
a day with zero sends legitimately has no row and is indistinguishable from a
day nobody has touched, so it cried wolf on every quiet Sunday. The page shows
when the closed half was last recomputed instead.

Days older than the nightly window are filled once by
[scripts/backfill-lifecycle-rollup.ts](../../scripts/backfill-lifecycle-rollup.ts),
chunked so each statement stays short and the run is resumable.

### 3k2. The reconstruction, and what it cannot know

[scripts/backfill-lifecycle-reconstruction.ts](../../scripts/backfill-lifecycle-reconstruction.ts)
fills `stage_send_lifecycle` for the sends that predate live stamping, marking
every row `reconstructed = true` so the page can flag a period.

It is a **replay, not a lookup**, because neither obvious source can answer
"what was this contact on 13 August": `contact_engagement` holds only current
rollups, and `contact_engagement_transitions` begins at the PR 1 backfill
instant, which is after every row this targets. So the facts are rebuilt from
raw `stage_sends` + `clicks`/`links` as of the day's end and fed to the one
evaluator, `evaluationSelectSql`. No threshold comparison is re-spelled.

What it cannot know, stated rather than hidden:

- **`suppressed` is never written** (spec §10). Suppression could not have
  happened before launch, so emitting it would be inventing history. A row the
  facts imply is suppressed becomes `freeze` — the status it must have passed
  through — and the coercions are counted and reported. (In practice the path
  is unreachable: the replay passes `prev_status = NULL`, and both suppressed
  rules require a previous status. The coercion is the belt to that braces.)
- **It uses TODAY'S thresholds and is a ONE-SHOT artifact.** It is not re-run
  after a threshold change (owner, 2026-09-27) — re-running would produce
  different history for the same day. Nothing is recorded per row; the run
  prints the thresholds in force and the page's note states them.
- **One status per contact per ET day.** Evaluating per send would be ~71K
  evaluations for a median day instead of one.
- **A reconstructed row can never be `new`**, because `asOf` is the END of the
  ET day and the day's own send is already counted. That day-end comes from
  `etDayBounds`; written as `(<date> + 1) AT TIME ZONE 'America/New_York'` it is
  16:00 ET, which truncates every day's facts and drops every send made after
  it.

Dry run by default; `--apply` writes. Resume is derived from the data — a day
is done when every `sent` row in it carries a stamp — never from a cursor file,
which lies after a partial failure. One transaction per ET day, so a failure
loses a day rather than the run. `--org` exists for the preview bar; production
keeps the single-org assertion.

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

The PR 5 bars:

- [scripts/test-lifecycle-reconstruction.ts](../../scripts/test-lifecycle-reconstruction.ts)
  -- 14 bars, run against the REAL script as a child process with `--org` on a
  throwaway org, because calling an extracted helper would test a copy of the
  replay rather than the command line that will be run against production.
  R1/R2 are the whole feature in one pair: the same contact, from the SAME
  single click, reconstructs as `hot` for a day 90 days ago and `warm` for
  yesterday. A replay that degraded into a lookup of the current status would
  return one value for both, so one of the two would go red. S1/S2 pin what it
  must never write (`suppressed`, `new`); T1-T3 pin resume by re-running a
  completed day; T4/T5 are SOURCE bars -- that resume reads the data rather
  than a cursor file, and that the suppressed coercion is in the INSERT and not
  only in the report.
- [scripts/test-lifecycle-report.ts](../../scripts/test-lifecycle-report.ts) --
  24 bars on the query. **B1 caught a real defect**: the click join first read
  `links.contact_id` alone, with no stage, which counts every link the contact
  ever clicked org-wide, so cohort CTR would have measured the contact instead
  of the send -- inflated in exactly the cohorts clicking defines. C2/C3 seed
  each sales source ALONE (a ledger-only buyer, a `sale_status`-only row, and
  one carrying both) because a fixture writing both together cannot tell the
  two readers apart. D4 pins the entire cost formula in one number: rate,
  opt-out doubling and a per-send override together. E1 asserts a cohort with
  no sends reports `null`, not 0%.

[scripts/dryrun-lifecycle-recheck.ts](../../scripts/dryrun-lifecycle-recheck.ts)
does the same for the send-time re-check: it mirrors the drain's claim
predicate (same ORDER BY, same batch size, minus `FOR UPDATE SKIP LOCKED` and
the UPDATE) and reports what each reason WOULD have skipped. It stops at ~10%
for any one reason, reports a reason that never fires as "never observed"
rather than as a measured 0, and splits the freeze figure by which signal
catches it -- both / send-time only / Prepare only -- because the headline
share alone cannot distinguish "the layers disagree" from "the cadence is
genuinely being violated".
