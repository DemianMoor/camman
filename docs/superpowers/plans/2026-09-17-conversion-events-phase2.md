# Conversion Events — Phase 2 (live ingest + Tier-2 alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the `conversion_events` ledger live on the `*/5` Keitaro poll tick. Every way that can go wrong pages Telegram once, not every tick. `keitaro_stage_results`, `stage_sends` and every reader stay exactly as they are.

**Architecture:**
- `/api/keitaro/poll` calls Phase 1's `ingestKeitaroConversions` after the aggregate poll and the counted-clicker refresh. It uses a rolling 7-day ET window (`liveIngestRange`, pure) and its own try/catch.
- On the cron path only, a new `lib/conversions/monitor.ts` turns the ingest outcome and a whole-ledger health read into seven alerts, latched in `alert_state` through `notifyOnTransition` / `clearAlert`. Five are on fixed keys: three for the ingest plus one `combo_cap_exceeded` key per combo kind. `unmapped` and `type_conflicts` are keyed per problem combo, so each new combo pages once, repeats don't re-page, and a combo that disappears is cleared — unless its kind is past the 10-combo cap, where no combo key of that kind clears and the kind's cap key pages instead (decision 14).
- The route then stamps a `conversion-events-ingest` heartbeat, last and only for a complete window. `/api/cron/tracking-monitors` (hourly) watches that heartbeat on its own fixed key.
- Decisions are pure functions with a pure test. The DB side is proven in a rolled-back transaction on camman-v2 with a stub sender.

**Tech Stack:** Next.js 16 route handlers · TypeScript · Drizzle ORM 0.45.2 · Postgres (Supabase, transaction pooler) · Telegram via `notifyTelegram` (plain text) · tsx verification scripts (no test framework — `check()` PASS/FAIL scripts, exit 1 on failure).

**Builds on:** [2026-09-17-conversion-events-phase1.md](2026-09-17-conversion-events-phase1.md) ("Later phases" item 1) and [specs/2026-09-17-multi-event-conversions-recon.md](../specs/2026-09-17-multi-event-conversions-recon.md).

## Global Constraints

- **Phase 1 must be complete first, at `feat/conversion-events-p1` 72501c7 or later.** That is Phase 1's PR #193, still unmerged at planning time because it waits on the prod migration.
  - `lib/conversions/ingest.ts` must export `ingestKeitaroConversions(database: typeof db, opts: { range: KeitaroReportRange; dryRun?: boolean }): Promise<IngestResult>`.
  - That `IngestResult` must carry `statusOnlyInBatch`, `orgMismatch` and `orgMismatchSamples`.
  - `fetchKeitaroConversionLedger` must refuse a malformed 200, not only a truncated page.
  - `docs/04-features/conversion-events.md` must exist, and migration 0181 must be on camman-v2.
- **Merge order: Phase 2's PR must not merge before #193.**
- **Phase 2 needs NO migration.** It uses the 0181 tables, `alert_state` (0154) and `cron_locks` (0103).
- **Merging turns on prod writes to `conversion_events`** (plus `alert_state` and `cron_locks` rows) every 5 minutes. **STOP: do not merge until the controller confirms 0181 is applied to prod.**
- **No change to `keitaro_stage_results`, `stage_sends` or any reader.** Existing numbers must be byte-identical. The poll's existing response fields are unchanged; only new fields are added. (Bug-2 and Phase 3 are separate.)
- **DB tests run against camman-v2 (`.env.demo` `DATABASE_URL`), never prod.** Each DB test script refuses the prod project ref `rtdarhkkjwcetlmruftl`. Tests never reach real Telegram: every sender is an injected stub, and the DB test also unsets `TELEGRAM_*`.
- Alerts are **plain text** (`notifyTelegram` sends without `parse_mode`), prefixed `🟠 Tier-2 conversions:`. They are latched with `notifyOnTransition` / `clearAlert`: `fetch_failed`, `invalid_rows`, `org_mismatch` and the heartbeat on **fixed** keys; `unmapped` and `type_conflicts` on one key per problem combo, `conversion_events:unmapped:<offer>:<keitaro_type>` and `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>` (decision 14, fix wave 2), listed and paged most-recently-changed first, with one more fixed key per kind for the combos past the cap, `conversion_events:combo_cap_exceeded:unmapped` and `conversion_events:combo_cap_exceeded:type_conflicts` (fix wave 3). They are cross-org, so `orgId` is omitted and `alert_state.org_id` stays NULL.
- Alert evaluation and the heartbeat stamp run **only on the cron (bearer) path**. The ingest itself runs on both paths.
- Unknown network/type → `event_type_id` NULL and `status` NULL — never a purchase (Phase 1). Such rows are what the `unmapped` alert reports.
- Never interpolate a JS array into a Drizzle `sql` template; use the query builder (`inArray`, `.values([...])`).
- In `ON CONFLICT … SET` expressions, write the table's column / `excluded.col` literally; don't use `${table.col}`.
- Lint only changed files (`npx eslint <files>`). `npm run lint` walks other worktrees.
- `npx tsc --noEmit -p .` can take several minutes; allow up to 10. A timeout is not a pass.
- Docs are part of done (CLAUDE.md "Documentation maintenance"). This plan writes `2026-09-17` in every date. If you execute on a later day, use that day instead (07-conventions: dates come from the current date in context).
- Branch off `origin/main` or `origin/feat/conversion-events-p1` (Task 1 Step 1 decides), never local `main`.
- Commit trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Design decisions made in this plan (flagged for approval)

The controller's brief fixed the scope. These are the calls it did not settle:

1. **`fetch_failed` is debounced, and a throw is a failed tick (controller decisions, 2026-09-17).**
   - **A failed cron tick** is either a refused window (`ok:false`) or an ingest that **threw** (e.g. a DB error in lookups or the upsert). For a throw, the thrown message is the alert's error text.
   - **Refused covers every case Phase 1 refuses** (72501c7): a Keitaro HTTP error or timeout, a **malformed** 200 (not JSON with a `rows` array and a numeric `total`, e.g. an HTML bot challenge), and a **truncated** page (`rows < total`). The key stays `fetch_failed`; its text and the docs name all of them.
   - **Debounce:** on a failed tick the monitor reads the `conversion-events-ingest` heartbeat age (the last *complete* ingest) through `checkHeartbeats`. `fetch_failed` fires only when that is older than `FETCH_FAILED_DEBOUNCE_MINUTES` (15) or was never recorded. Otherwise the tick does nothing: no fire, no clear. A complete window still clears it, and a failed tick never stamps the heartbeat.
   - **Resolution:** `checkHeartbeats` rounds the age to 0.1h, so the rule works in 6-minute steps. A last success under 15 min old reads as ≤12 min; one 15 min or older reads as ≥18 min. With `*/5` ticks, the page lands on the 3rd or 4th consecutive failed tick.
2. **`invalid_rows` is left untouched on a failed tick** (refused or thrown). Nothing was parsed, so it can neither prove nor clear the condition.
3. **`unmapped` and `type_conflicts` are evaluated on every cron tick, including ticks whose fetch failed.** They read the table, not the batch. DB check A8b proves it: a row of a new unmapped combo is paged by a refused tick, and an early return for failed ticks before the ledger read turns it red.
4. **Evaluation order:**
   - The ingest decisions are applied first, so a failed tick past the debounce still pages even if the health read then fails.
   - A monitor failure is reported in `conversion_events_error` as `monitor: …`, appended after a thrown ingest message when there is one, and blocks the heartbeat stamp.
   - As a consequence, a long Keitaro outage pages twice: `fetch_failed` after ~15 min, then the heartbeat within ~2h. They are different signals.
5. **The window is 7 ET calendar days, computed on the ET date string:** today − 6 days at 00:00:00 through now. `pollKeitaro`'s `now − (N−1)×24h` would lose a day in the DST fall-back week (test R3). The window ignores `?windowDays`, which stays the aggregate poll's knob.
6. **Alert lines built from external text are clipped to 300 characters.** This covers Keitaro error bodies and unparseable-row samples, since Telegram caps a message at 4,096.
7. **The unmapped and conflict combo reads are exported SQL constants, `UNMAPPED_COMBOS_SQL` and `CONFLICT_COMBOS_SQL`.** Each is one statement whose `WHERE` is written exactly as its partial index's predicate. It returns the `LEDGER_MAX_COMBOS` **most recently changed** combos (`ORDER BY max(ce.updated_at) DESC`, then every `GROUP BY` column — fix wave 3, decision 14), plus the combo count and the row total over every combo (window aggregates over the groups, computed before the `LIMIT`). Both are pure values, so they live in Task 1: the pure test renders them with `PgDialect` and asserts the ranking (L13), and the DB test `EXPLAIN`s the exact statements with `enable_seqscan = off` and asserts the partial index is used (M6/M7).
8. **`docs/05-flows.md` flow G is updated** (CLAUDE.md rule 3). The brief's doc list did not name it, but its diagram would otherwise be wrong.
9. **The watcher call in `tracking-monitors` is not try/caught.** If its read throws, that job's own heartbeat stamp is skipped, and tells-monitors reports tracking-monitors stale. A swallowed error would silently stop the watch.
10. **Merge timing (Task 5).** Merge between HH:40 and HH:15. The first `*/5` poll tick then stamps the new heartbeat before `tracking-monitors` runs at `:37`; otherwise it pages "has NEVER recorded a run" once, falsely.
11. **Not alerted (explicitly):**
    - `unresolved` conversions. They include legitimate non-CamMan traffic, so they are only counted in the response.
    - An `ok` window with zero conversions. That is a quiet week, not an error.
    - `statusOnlyInBatch` (controller decision). A status-only row that already has a locked event type is fine. A brand-new one has a NULL event type, so it is already an unmapped row in the table, and the table-level `unmapped` alert reports it.
12. **Noise:** resolved by decision 1. A single transient Keitaro timeout, or a throw, no longer pages. Only ~15 min without a complete window does.
13. **`conversion_events:org_mismatch`, the 5th latched alert (controller decision, 2026-09-17).**
    - **Fires** on a cron tick whose ingest is `ok:true` with `orgMismatch > 0`, with the count and up to 3 of `orgMismatchSamples` (`event_id stored_org→resolved_org`).
    - **Clears** on an `ok:true` tick with `orgMismatch = 0`. A failed tick (refused or thrown) makes no decision, because nothing was upserted.
    - **No debounce:** it is a data-integrity signal. Those rows were not written, and a resolution that points a ledger row into another org needs a human.
14. **`unmapped` and `type_conflicts` are keyed per PROBLEM COMBO (controller decision, fix wave 2, 2026-09-17; replaces fix wave 1's newest-row-id keys), listed by RECENCY with a per-kind cap alert and collision-proof keys (fix wave 3).** Both alerts read the whole table, all-time.
    - **Why not a fixed key:** one old unfixed row kept the alert firing and hid every later problem until the count returned to 0.
    - **Why not the newest row's id (fix wave 1, dropped):** a type conflict only ever arises on UPDATE of an existing, older row, and an existing row turns unmapped the same way (its Keitaro type changes to an unmapped one, or its rule is archived). `max(id)` doesn't move, so neither paged. And a steady stream of new unmapped rows for one offer and type re-paged on every `*/5` tick, up to 288 a day.
    - **Keys:**
      - `conversion_events:unmapped:<offer>:<keitaro_type>`
      - `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`
      - `<offer>` is `offer_id` when set, else `k<keitaro_offer_id>` when set, else `none`. The two combo statements drop `keitaro_offer_id` when `offer_id` is set, so they group the same way.
      - Each other part is lowercased, anything outside `[a-z0-9_-]` becomes `_` (so `:` and `>` stay separators), and it is clipped to 40 characters. **When that changed the raw part — its case, a replaced character, or the 40-character clip — `~` plus the first 6 hex characters of the raw part's sha256 is appended (fix wave 3), so raw parts that sanitise alike keep different keys.** An already-clean part is used as is, so a clean part's key is byte-identical to fix wave 2's and can never meet a suffixed one (`~` is outside the clean set). A NULL event key is the raw part `?`, so it becomes `_~8a8de8`. Keys stay deterministic and bounded (a part is at most 47 characters).
      - Built only from the combo, never from counts or samples: `unmappedAlertKey(combo)` / `typeConflictAlertKey(combo)`, under `CONVERSION_ALERT_KEY_PREFIXES`. `CONVERSION_ALERT_KEYS` holds the fixed keys: the three ingest ones plus the two `combo_cap_exceeded` keys (fix wave 3), five in all.
    - **Each cron tick** (`decideLedgerAlerts(health, firingKeys)`, applied through the same `applyDecisions` as the fixed keys):
      - **A combo present now** gets `notifyOnTransition` on its key. It pages once, when the combo first appears or re-appears after clearing. More rows of the same combo never page again.
      - **A key firing under either prefix whose combo is no longer present** gets `clearAlert` (re-armed). There is no prefix-wide clear and no copied UPDATE. The firing keys are read with `starts_with(alert_key, $prefix)`, which needs no LIKE escaping (`readFiringLedgerKeys`). Keys outside both prefixes are never touched; DB check S6 uses decoys to prove it.
      - Two distinct combos no longer share a key (the hash suffix above). One key still maps to one decision, so even a hash collision would page once, with the later combo's text, and the latch would make the duplicate a no-op.
    - **Cap:** `LEDGER_MAX_COMBOS = 10` combos per kind are listed and paged, the **most recently changed** first — `max(ce.updated_at) DESC`, ties broken by every `GROUP BY` column so the order is total. Telegram allows a bot about 20 messages a minute in a group, and both kinds can page on the same tick. A refused send stays pending and retries on the next tick.
      - **Recency, not size (fix wave 3).** Fix wave 2 ranked by `total DESC`, so with 10 combos already firing a new small combo ranked 11th and never paged at all, and the "N more" line only travelled on a page some other combo happened to send. `updated_at` is set on insert and on every ingest `UPDATE` (the upsert's `setWhere` skips no-op writes), so a brand-new combo — including one an `UPDATE` creates, a conflict or an existing row turning unmapped — ranks first however small it is. DB checks P1/P2a prove it; ranking by `total` again turns P2a red.
      - Past the cap, **every** page of that kind ends with `N more <kind> combo(s) are not listed or paged …`. The controller's brief said to append it to the first page, but the first combo is usually already latched, so its text is never sent again.
      - Past the cap, **no combo key of that kind is cleared**: a combo ranked past the cap can't be told apart from a resolved one, and clearing it would re-page it when it climbs back. Clears resume once the combo count is back to `LEDGER_MAX_COMBOS` or fewer.
      - **One more FIXED key per kind (fix wave 3):** `conversion_events:combo_cap_exceeded:unmapped` and `conversion_events:combo_cap_exceeded:type_conflicts`. Each fires (`notifyOnTransition`) while its kind's `combo_count` exceeds the cap and clears (`clearAlert`) at or below it, so crossing the cap always pages once even when every listed combo is already latched. Both names are deliberately **outside** both combo prefixes (`conversion_events:unmapped:` / `conversion_events:type_conflicts:`), so `readFiringLedgerKeys` never reads them and the stale-combo clear can never touch one; pure K1 asserts that. They are in `CONVERSION_ALERT_KEYS` (now five fixed keys), so the DB test's setup clears them like the others. Their text is plain: the kind, the combo count, the cap, and the SQL to list every combo of that kind.
      - **Residual gap:** a new combo can still go unpaged while capped if more than `LEDGER_MAX_COMBOS` combos are touched by the same ingest transaction (one `now()`, so their `updated_at` ties and the tiebreak decides). The kind's cap key is firing in exactly that state, which is the signal to go read the whole list.
    - **Alert text per combo (plain text):** the combo's count, then the offer (`<name> (offer <id>)`, `Keitaro offer <id> (no CamMan offer)` or `no offer`) and the Keitaro type or the locked → conflicting event pair. Then the count created in the last 24h (for a conflict: first seen in the last 24h, by `event_type_conflict_at`), the first-seen time in ET for a conflict, up to 3 sample `keitaro_event_id`s, and the fix hint (add a mapping rule / resolve the conflict). Every line is clipped to 300 characters.
    - **Removed with fix wave 1's design:** `ledgerAlertKey`, `FiringLedgerIds`, `readFiringLedgerIds`, `LedgerAlertDecision`, `clearAlertsByPrefix` and its LIKE escaping, `applyLedgerDecisions`, the step-back guard, the `*_newest_id` fields and the per-row samples. `lib/alerts/alert-state.ts` is unchanged. `evaluateConversionAlerts` still returns `{ health, ingestDecisions, ledgerDecisions }` (both arrays are `ConversionAlertDecision[]`), and no caller reads it.
    - **Kept from fix wave 1:** the `fetch_failed` age reads `N min ago` under 120 minutes and `X.Y h ago` from 120 on (`never recorded` is unchanged). M0b neutralises pre-existing problem rows inside the rolled-back transaction instead of requiring an empty preview ledger. Failed ticks still re-read the ledger (decision 3).
    - **Not org-scoped (fix wave 4 finding; follow-up, before a second org sends Keitaro traffic):** `offer_id` is a global serial, so combos keyed by it are implicitly org-unique — but `none:<type>` and `k<keitaro_offer_id>:<type>` are not, and `event_types.key` is per-org, so two orgs' problems on the same combo merge into one alert: one page with a summed count and mixed samples, clearing only once **every** org's rows for that combo are gone. Inert today (one real org sends Keitaro traffic). Fix: add `ce.org_id` to both combo `GROUP BY`s and as the leading key part, and clear the existing firing rows under both prefixes in the same deploy.

## File Structure

| File | Responsibility |
|---|---|
| `lib/conversions/keitaro-row.ts` (modify) | + `LIVE_INGEST_DAYS`, `liveIngestRange(now)` — pure 7-ET-day window |
| `lib/conversions/monitor.ts` (create) | fixed alert keys (three ingest + one `combo_cap_exceeded` per combo kind), combo key prefixes + collision-proof builders (`unmappedAlertKey` / `typeConflictAlertKey`), `LedgerHealth` / combo types, plain-text formatters, the recency-ranked `UNMAPPED_COMBOS_SQL` / `CONFLICT_COMBOS_SQL`, pure `decideIngestAlerts` / `decideLedgerAlerts`; DB `readLedgerHealth`, `evaluateConversionAlerts`, `watchIngestHeartbeat` |
| `lib/reporting/cron-heartbeat.ts` (modify) | + `HEARTBEAT_JOBS.conversionEventsIngest` |
| `app/api/keitaro/poll/route.ts` (modify) | ingest after poll + clicker refresh; cron-only alerts + heartbeat; new response fields |
| `app/api/cron/tracking-monitors/route.ts` (modify) | watches the ingest heartbeat (cron path) |
| `scripts/test-conversion-monitor.ts` (create) | pure: window + every alert decision/text |
| `scripts/test-conversion-monitor-db.ts` (create) | camman-v2, rolled back: health read, index use, latched transitions, heartbeat watch |
| `docs/04-features/conversion-events.md`, `keitaro-poll.md`, `crons.md`, `docs/05-flows.md`, `docs/CHANGELOG.md` (modify) | docs |

---

### Task 1: Live ingest window + alert decisions (pure)

> **Fix waves 1, 2 and 3 (2026-09-17) changed this task's output. The code below is the current state, as committed in fix wave 3.** It is not the original Task 1 commit (e88593a, 22 pure checks), fix wave 1's (dbfba2c, 30 checks with per-newest-row keys) or fix wave 2's (c754f89, 34 checks). Since e88593a:
> - `CONVERSION_ALERT_KEYS` holds five fixed keys: `fetchFailed` / `invalidRows` / `orgMismatch` plus `unmappedComboCap` / `typeConflictComboCap` (fix wave 3).
> - The ledger alerts are keyed per problem combo (decision 14): new `CONVERSION_ALERT_KEY_PREFIXES`, `LEDGER_MAX_COMBOS`, `unmappedAlertKey` / `typeConflictAlertKey`, the `UnmappedCombo` / `ConflictCombo` combo types, and `decideLedgerAlerts(h, firingKeys)`.
> - Key parts carry a `~<6 hex of sha256(raw)>` suffix whenever sanitising changed them (fix wave 3), so `lib/conversions/monitor.ts` imports `createHash` from `node:crypto`.
> - The two combo statements, `UNMAPPED_COMBOS_SQL` / `CONFLICT_COMBOS_SQL`, are pure values and now live in this task (Step 5), ranked by `max(ce.updated_at) DESC` (fix wave 3). Task 2 only appends the DB functions that run them.
> - The `fetch_failed` age reads `N min ago` / `X.Y h ago`.
>
> The pure test has **39** checks: R1–R4, A1–A7, D1–D5, O1–O2, combo keys C1–C5, ledger decisions L1–L13, H1, X1, K1.

**Files:**
- Modify: `lib/conversions/keitaro-row.ts` (import line 1; append at end of file)
- Create: `lib/conversions/monitor.ts`
- Test: `scripts/test-conversion-monitor.ts`

**Interfaces:**
- Consumes:
  - `IngestResult` from `lib/conversions/ingest.ts` (Phase 1 at 72501c7): `{ ok: boolean; dryRun: boolean; range: KeitaroReportRange; fetched: number; invalid: number; invalidSamples: string[]; unresolved: number; unresolvedSamples: string[]; rows: number; unmappedInBatch: number; statusOnlyInBatch: number; inserted: number; updated: number; unchanged: number; typeConflicts: number; orgMismatch: number; orgMismatchSamples: string[]; error: string | null }`. `orgMismatchSamples` holds up to 5, formatted `event_id existing_org→new_org`.
  - `KeitaroReportRange = { from: string; to: string; timezone: string }` from `lib/keitaro/client.ts`
- Produces:
  - `LIVE_INGEST_DAYS = 7`
  - `liveIngestRange(now: Date): KeitaroReportRange`
  - `CONVERSION_ALERT_KEYS = { fetchFailed: "conversion_events:fetch_failed"; invalidRows: "conversion_events:invalid_rows"; orgMismatch: "conversion_events:org_mismatch"; unmappedComboCap: "conversion_events:combo_cap_exceeded:unmapped"; typeConflictComboCap: "conversion_events:combo_cap_exceeded:type_conflicts" }` — the cap keys must not start with either combo prefix (decision 14)
  - `CONVERSION_ALERT_KEY_PREFIXES = { unmapped: "conversion_events:unmapped:"; typeConflicts: "conversion_events:type_conflicts:" }`
  - `INGEST_HEARTBEAT_ALERT_KEY = "heartbeat:conversion-events-ingest"`
  - `LEDGER_MAX_COMBOS = 10`: combos listed and paged per kind per tick, most recently changed first
  - `interface UnmappedCombo { offer_id: number | null; keitaro_offer_id: number | null; offer_name: string | null; keitaro_type: string; total: number; last_24h: number; sample_event_ids: string[] }`. `keitaro_offer_id` is set only when `offer_id` is null. `last_24h` counts by `created_at`.
  - `interface ConflictCombo { offer_id: number | null; keitaro_offer_id: number | null; offer_name: string | null; locked_event_key: string | null; conflicting_event_key: string | null; total: number; last_24h: number; since: string | null; sample_event_ids: string[] }`. `last_24h` counts by `event_type_conflict_at`; `since` is the earliest `event_type_conflict_at` as ISO-8601 UTC.
  - `interface LedgerHealth { unmapped_total: number; unmapped_combo_count: number; unmapped_combos: UnmappedCombo[]; conflict_total: number; conflict_combo_count: number; conflict_combos: ConflictCombo[] }`. `*_total` is rows and `*_combo_count` is combos, both over every combo; `*_combos` is the `LEDGER_MAX_COMBOS` most recently changed.
  - `unmappedAlertKey(c: UnmappedCombo): string` → `conversion_events:unmapped:<offer>:<keitaro_type>`
  - `typeConflictAlertKey(c: ConflictCombo): string` → `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>` (sanitised, with the collision-proof `~` suffix; decision 14)
  - `UNMAPPED_COMBOS_SQL: SQL`, `CONFLICT_COMBOS_SQL: SQL`: the grouped combo statements on the partial-index predicates, ranked by `max(ce.updated_at) DESC` (decision 7). Pure values; `readLedgerHealth` (Task 2) runs them.
  - `type ConversionAlertDecision = { alertKey: string; state: "firing"; text: string } | { alertKey: string; state: "ok" }`
  - `type IngestOutcome = { kind: "result"; result: IngestResult } | { kind: "threw"; range: KeitaroReportRange; error: string }`
  - `FETCH_FAILED_DEBOUNCE_MINUTES = 15`
  - `ingestFailed(outcome: IngestOutcome): boolean`: true for a throw or `ok:false`
  - `decideIngestAlerts(outcome: IngestOutcome, lastSuccessAgeMinutes: number | null): ConversionAlertDecision[]`. `lastSuccessAgeMinutes` is minutes since the last complete ingest (`null` = never recorded) and is only consulted for a failed tick.
  - `decideLedgerAlerts(h: LedgerHealth, firingKeys: readonly string[]): ConversionAlertDecision[]`. It decides each kind's `combo_cap_exceeded` key (firing over the cap, ok at or below it), fires every listed combo, clears firing keys under the prefixes whose combo is gone (unless that kind is past the cap), and ignores any other key.
  - `formatIngestHeartbeatAlert(breach: string): string`
  - module-private `MAX_SAMPLES = 3` (used again in Task 2)

- [ ] **Step 1: Branch + preconditions**

```bash
cd C:/AFF/camman/.claude/worktrees/conv-events-recon
git status --short
git fetch origin
gh pr view 193 --json state,headRefName,headRefOid --jq '"\(.state) \(.headRefName) \(.headRefOid)"'
```

Expected: `git status` is clean apart from untracked `docs/superpowers/plans/2026-09-17-conversion-events-phase2.md`. Commit or stash nothing else. If other changes are present, stop and ask. `gh` prints `MERGED feat/conversion-events-p1 <sha>` or `OPEN feat/conversion-events-p1 <sha>`.

If the recon worktree no longer exists, create one and run every later command from it:

```bash
git -C C:/AFF/camman fetch origin
git -C C:/AFF/camman worktree add C:/AFF/camman/.claude/worktrees/conv-events-p2 origin/main
cd C:/AFF/camman/.claude/worktrees/conv-events-p2
```

Then follow **A** or **B**:

**A — #193 is `MERGED`:**

```bash
git checkout -b feat/conversion-events-p2 origin/main
mkdir -p .superpowers/sdd && echo "main $(git rev-parse HEAD)" > .superpowers/sdd/phase2-base.txt
```

**B — #193 is `OPEN`** (the expected case; it waits on the prod migration):

```bash
git rev-parse feat/conversion-events-p1 origin/feat/conversion-events-p1   # must print the SAME sha twice; if not, stop — Phase 1 has unpushed or newer commits
git merge-base --is-ancestor 72501c7 origin/feat/conversion-events-p1 && echo "p1 includes 72501c7"   # must print; if not, stop — this plan targets 72501c7 or later
git checkout -b feat/conversion-events-p2 origin/feat/conversion-events-p1
mkdir -p .superpowers/sdd && echo "p1 $(git rev-parse HEAD)" > .superpowers/sdd/phase2-base.txt
```

(`.superpowers/` is git-excluded. Task 5 reads this file to know whether the PR is stacked.)

Then verify Phase 1 is in the base and the tooling links exist:

```bash
grep -c "export async function ingestKeitaroConversions" lib/conversions/ingest.ts
grep -c "typeConflicts: number" lib/conversions/ingest.ts
grep -c "statusOnlyInBatch: number" lib/conversions/ingest.ts
grep -c "orgMismatch: number" lib/conversions/ingest.ts
grep -c "malformed response" lib/keitaro/client.ts
ls docs/04-features/conversion-events.md scripts/test-conversion-lookups.ts
[ -d node_modules ] || cmd //c "mklink /J node_modules C:\AFF\camman\node_modules"
[ -f .env.local ] || cmd //c "mklink /H .env.local C:\AFF\camman\.env.local"
```

Expected: `1`, `1`, `1`, `2` (the upsert's return type and `IngestResult`), `1`, then both paths printed. A `0` anywhere means the base predates 72501c7: stop. (Unlink later with `cmd //c "rmdir node_modules"`. Never `rm -rf` a junction.)

- [ ] **Step 2: Write the failing test**

`scripts/test-conversion-monitor.ts`:

```ts
// Pure checks for the Phase 2 live-ingest window and the conversion ledger alert
// decisions. No DB, no network, no Telegram.
// Run: npx tsx scripts/test-conversion-monitor.ts
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { IngestResult } from "../lib/conversions/ingest";
import { liveIngestRange } from "../lib/conversions/keitaro-row";
import {
  CONFLICT_COMBOS_SQL,
  CONVERSION_ALERT_KEYS,
  CONVERSION_ALERT_KEY_PREFIXES,
  FETCH_FAILED_DEBOUNCE_MINUTES,
  INGEST_HEARTBEAT_ALERT_KEY,
  LEDGER_MAX_COMBOS,
  UNMAPPED_COMBOS_SQL,
  decideIngestAlerts,
  decideLedgerAlerts,
  formatIngestHeartbeatAlert,
  ingestFailed,
  typeConflictAlertKey,
  unmappedAlertKey,
  type ConflictCombo,
  type ConversionAlertDecision,
  type IngestOutcome,
  type LedgerHealth,
  type UnmappedCombo,
} from "../lib/conversions/monitor";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const PREFIX = "🟠 Tier-2 conversions:";
const K = CONVERSION_ALERT_KEYS;

type Firing = Extract<ConversionAlertDecision, { state: "firing" }>;
const stateOf = (ds: ConversionAlertDecision[], key: string) => ds.find((d) => d.alertKey === key)?.state;
const firingText = (ds: ConversionAlertDecision[], key: string): string =>
  ds.find((d): d is Firing => d.alertKey === key && d.state === "firing")?.text ?? "";

console.log("live ingest window");
const r1 = liveIngestRange(new Date("2026-09-17T14:05:00Z"));
check(
  "R1 7 ET calendar days: today − 6 days 00:00:00 → now, in ET",
  r1.from === "2026-09-11 00:00:00" && r1.to === "2026-09-17 10:05:00" && r1.timezone === "America/New_York",
  JSON.stringify(r1),
);
const r2 = liveIngestRange(new Date("2026-09-18T02:30:00Z"));
check(
  "R2 the ET date is used, not the UTC date (22:30 ET is still the 17th)",
  r2.from === "2026-09-11 00:00:00" && r2.to === "2026-09-17 22:30:00",
  JSON.stringify(r2),
);
const r3 = liveIngestRange(new Date("2026-11-02T04:30:00Z"));
check(
  "R3 DST fall-back week keeps all 7 days (now − 144h would start on 10-27)",
  r3.from === "2026-10-26 00:00:00" && r3.to === "2026-11-01 23:30:00",
  JSON.stringify(r3),
);
const r4 = liveIngestRange(new Date("2027-01-03T15:00:00Z"));
check(
  "R4 crosses a year boundary",
  r4.from === "2026-12-28 00:00:00" && r4.to === "2027-01-03 10:00:00",
  JSON.stringify(r4),
);

console.log("\ningest alerts");
const run = (over: Partial<IngestResult>): IngestResult => ({
  ok: true,
  dryRun: false,
  range: { from: "2026-09-11 00:00:00", to: "2026-09-17 10:05:00", timezone: "America/New_York" },
  fetched: 12,
  invalid: 0,
  invalidSamples: [],
  unresolved: 3,
  unresolvedSamples: [],
  rows: 9,
  unmappedInBatch: 0,
  statusOnlyInBatch: 0,
  inserted: 1,
  updated: 0,
  unchanged: 8,
  typeConflicts: 0,
  orgMismatch: 0,
  orgMismatchSamples: [],
  error: null,
  ...over,
});

const result = (over: Partial<IngestResult>): IngestOutcome => ({ kind: "result", result: run(over) });
const refused = result({
  ok: false,
  fetched: 0,
  rows: 0,
  unchanged: 0,
  error: "Keitaro conversions/log truncated: 1000 of 1200 rows",
});
const threw: IngestOutcome = {
  kind: "threw",
  range: { from: "2026-09-11 00:00:00", to: "2026-09-17 10:05:00", timezone: "America/New_York" },
  error: "connect ECONNREFUSED 10.0.0.1:6543",
};

const failedDs = decideIngestAlerts(refused, 20);
check(
  "A1 refused window, last complete ingest 20 min ago → only fetch_failed, firing (invalid_rows and org_mismatch left as they are)",
  failedDs.length === 1 && stateOf(failedDs, K.fetchFailed) === "firing",
  JSON.stringify(failedDs),
);
const fetchText = firingText(failedDs, K.fetchFailed);
check(
  "A2 fetch_failed text: prefix, the error, the window, the last-success age",
  fetchText.startsWith(PREFIX) &&
    fetchText.includes("truncated: 1000 of 1200 rows") &&
    fetchText.includes("2026-09-11 00:00:00 → 2026-09-17 10:05:00 America/New_York") &&
    fetchText.includes("Last complete ingest: 20 min ago"),
  fetchText,
);

const okDs = decideIngestAlerts(result({}), null);
check(
  "A3 complete clean window → fetch_failed ok (a successful run clears), invalid_rows ok, org_mismatch ok",
  okDs.length === 3 &&
    stateOf(okDs, K.fetchFailed) === "ok" &&
    stateOf(okDs, K.invalidRows) === "ok" &&
    stateOf(okDs, K.orgMismatch) === "ok",
  JSON.stringify(okDs),
);

const invalidDs = decideIngestAlerts(
  result({
    invalid: 4,
    invalidSamples: [
      "event_id=∅ conversion_type=Lead datetime=2026-09-17 09:00:00 revenue=0",
      "event_id=bad-dt conversion_type=Lead datetime=2026-09-17T09:00:00Z revenue=0",
      "event_id=no-type conversion_type=∅ datetime=2026-09-17 09:00:00 revenue=0",
      "event_id=fourth conversion_type=∅ datetime=∅ revenue=∅",
    ],
  }),
  null,
);
const invalidText = firingText(invalidDs, K.invalidRows);
check(
  "A4 unparseable rows → invalid_rows firing with the count and at most 3 samples; fetch_failed ok",
  stateOf(invalidDs, K.fetchFailed) === "ok" &&
    invalidText.startsWith(PREFIX) &&
    invalidText.includes("4 Keitaro conversion row(s)") &&
    invalidText.includes("event_id=bad-dt") &&
    invalidText.includes("event_id=no-type") &&
    !invalidText.includes("event_id=fourth"),
  invalidText,
);

const hugeText = firingText(
  decideIngestAlerts(result({ ok: false, error: `Keitaro conversions/log HTTP 502: ${"x".repeat(5000)}` }), null),
  K.fetchFailed,
);
check(
  "A5 an unbounded Keitaro error body is clipped (Telegram caps a message at 4,096 chars)",
  hugeText.length > 0 && hugeText.length < 1500,
  `length ${hugeText.length}`,
);
const ageText = (minutes: number) => firingText(decideIngestAlerts(refused, minutes), K.fetchFailed);
check(
  "A6 last-success age under 120 min reads as whole minutes (114 → 114 min ago, 17.6 → 18 min ago)",
  ageText(114).includes("Last complete ingest: 114 min ago.") &&
    ageText(17.6).includes("Last complete ingest: 18 min ago."),
  ageText(114),
);
check(
  "A7 last-success age of 120 min or more reads as hours with one decimal (120 → 2.0 h ago, 186 → 3.1 h ago)",
  ageText(120).includes("Last complete ingest: 2.0 h ago.") &&
    ageText(186).includes("Last complete ingest: 3.1 h ago.") &&
    !ageText(120).includes("min ago"),
  ageText(186),
);

console.log("\nfetch_failed debounce");
const freshDs = decideIngestAlerts(refused, 5);
check(
  "D1 refused window, last complete ingest 5 min ago → no decision at all (no fire, no clear)",
  freshDs.length === 0,
  JSON.stringify(freshDs),
);
// A malformed 200 (Phase 1 72501c7) is refused like a truncated page: same key.
const malformed = result({
  ok: false,
  fetched: 0,
  rows: 0,
  unchanged: 0,
  error:
    "Keitaro conversions/log malformed response (expected JSON with a rows array and a numeric total): <html>challenge</html>",
});
const neverDs = decideIngestAlerts(malformed, null);
check(
  "D2 malformed response, no complete ingest ever recorded → fetch_failed firing, names the malformed page, says never",
  neverDs.length === 1 &&
    stateOf(neverDs, K.fetchFailed) === "firing" &&
    firingText(neverDs, K.fetchFailed).includes("malformed response") &&
    firingText(neverDs, K.fetchFailed).includes("Last complete ingest: never recorded"),
  JSON.stringify(neverDs),
);
check(
  "D3 the debounce is 15 min, and a last success exactly that old does not fire (older than, not equal)",
  FETCH_FAILED_DEBOUNCE_MINUTES === 15 && decideIngestAlerts(refused, FETCH_FAILED_DEBOUNCE_MINUTES).length === 0,
);
const threwDs = decideIngestAlerts(threw, 20);
const threwText = firingText(threwDs, K.fetchFailed);
check(
  "D4 an ingest that THREW is a failed tick: stale → only fetch_failed, firing, with the thrown message and window",
  ingestFailed(threw) &&
    ingestFailed(refused) &&
    !ingestFailed(result({})) &&
    threwDs.length === 1 &&
    threwText.startsWith(PREFIX) &&
    threwText.includes("connect ECONNREFUSED 10.0.0.1:6543") &&
    threwText.includes("2026-09-11 00:00:00 → 2026-09-17 10:05:00 America/New_York"),
  threwText,
);
check(
  "D5 an ingest that threw with a fresh heartbeat (5 min) → no decision (same debounce)",
  decideIngestAlerts(threw, 5).length === 0,
);

console.log("\norg mismatch");
const orgDs = decideIngestAlerts(
  result({
    orgMismatch: 4,
    orgMismatchSamples: [
      "ev-a 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
      "ev-b 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
      "ev-c 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
      "ev-d 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b",
    ],
  }),
  null,
);
const orgText = firingText(orgDs, K.orgMismatch);
check(
  "O1 complete window with orgMismatch > 0 → org_mismatch firing (no debounce) with the count and at most 3 samples; fetch_failed still clears",
  stateOf(orgDs, K.fetchFailed) === "ok" &&
    orgText.startsWith(PREFIX) &&
    orgText.includes("4 conversion(s) resolved to a different org") &&
    orgText.includes("ev-a 00000000-0000-4000-8000-00000000000a→00000000-0000-4000-8000-00000000000b") &&
    orgText.includes("ev-c ") &&
    !orgText.includes("ev-d ") &&
    orgText.includes("2026-09-11 00:00:00 → 2026-09-17 10:05:00 America/New_York"),
  orgText,
);
const orgClearDs = decideIngestAlerts(result({ orgMismatch: 0, invalid: 1, invalidSamples: ["event_id=x"] }), null);
check(
  "O2 complete window with orgMismatch = 0 → org_mismatch ok (clears), independent of invalid_rows firing",
  stateOf(orgClearDs, K.orgMismatch) === "ok" && stateOf(orgClearDs, K.invalidRows) === "firing",
  JSON.stringify(orgClearDs),
);


console.log("\nledger combo keys");
const P = CONVERSION_ALERT_KEY_PREFIXES;
const unm = (over: Partial<UnmappedCombo>): UnmappedCombo => ({
  offer_id: null,
  keitaro_offer_id: null,
  offer_name: null,
  keitaro_type: "trash",
  total: 1,
  last_24h: 0,
  sample_event_ids: ["ev-1"],
  ...over,
});
const conf = (over: Partial<ConflictCombo>): ConflictCombo => ({
  offer_id: 134,
  keitaro_offer_id: null,
  offer_name: "Psycho Book",
  locked_event_key: "registration",
  conflicting_event_key: "purchase",
  total: 1,
  last_24h: 1,
  since: "2026-09-17T14:00:00Z",
  sample_event_ids: ["ev-conflict"],
  ...over,
});
// A ledger read that lists every combo (under the cap) unless `over` says otherwise.
const ledger = (
  unmapped: UnmappedCombo[],
  conflicts: ConflictCombo[],
  over: Partial<LedgerHealth> = {},
): LedgerHealth => ({
  unmapped_total: unmapped.reduce((n, c) => n + c.total, 0),
  unmapped_combo_count: unmapped.length,
  unmapped_combos: unmapped,
  conflict_total: conflicts.reduce((n, c) => n + c.total, 0),
  conflict_combo_count: conflicts.length,
  conflict_combos: conflicts,
  ...over,
});
const firingKeysOf = (ds: ConversionAlertDecision[]) => ds.filter((d) => d.state === "firing").map((d) => d.alertKey);
const okKeysOf = (ds: ConversionAlertDecision[]) => ds.filter((d) => d.state === "ok").map((d) => d.alertKey);
const sameKeys = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const keysOnly = (ds: ConversionAlertDecision[]) => JSON.stringify(ds.map((d) => `${d.state} ${d.alertKey}`));

const psycho = unm({
  offer_id: 134,
  offer_name: "Psycho Book",
  keitaro_type: "deposit",
  total: 5,
  last_24h: 2,
  sample_event_ids: ["ev-a", "ev-b", "ev-c", "ev-d"],
});
const k41 = unm({ keitaro_offer_id: 41, keitaro_type: "trash" });
const noOffer = unm({ keitaro_type: "lead" });
const regToPurchase = conf({ total: 3, sample_event_ids: ["ev-x", "ev-y", "ev-z", "ev-w"] });

const builtKeys = [
  unmappedAlertKey(psycho),
  unmappedAlertKey(k41),
  unmappedAlertKey(noOffer),
  unmappedAlertKey(unm({ offer_id: 134, keitaro_offer_id: 41 })),
  typeConflictAlertKey(regToPurchase),
  typeConflictAlertKey(conf({ offer_id: null, keitaro_offer_id: 41, offer_name: null })),
];
check(
  "C1 combo keys: unmapped:<offer>:<keitaro type>, type_conflicts:<offer>:<locked>><conflicting>; offer = offer_id, else k<keitaro offer id>, else none",
  JSON.stringify(builtKeys) ===
    JSON.stringify([
      "conversion_events:unmapped:134:deposit",
      "conversion_events:unmapped:k41:trash",
      "conversion_events:unmapped:none:lead",
      "conversion_events:unmapped:134:trash",
      "conversion_events:type_conflicts:134:registration>purchase",
      "conversion_events:type_conflicts:k41:registration>purchase",
    ]),
  JSON.stringify(builtKeys),
);
const oddKey = unmappedAlertKey(unm({ keitaro_type: "First Deposit: 2>1 ✓" }));
const longKey = unmappedAlertKey(unm({ keitaro_type: "x".repeat(200) }));
const oddConflictKey = typeConflictAlertKey(conf({ locked_event_key: "Reg:A>B", conflicting_event_key: null }));
// The suffixes are the first 6 hex characters of sha256 of the raw part, written
// out: sha256("First Deposit: 2>1 ✓") = 1239dd…, sha256("x"×200) = aa20c2…,
// sha256("Reg:A>B") = 34b636…, sha256("?") (a NULL event key) = 8a8de8….
check(
  "C2 key parts are sanitised (lowercase; anything outside [a-z0-9_-] → _, so ':' and '>' can't forge a separator), clipped to 40 chars, and a part sanitising changed carries ~<6 hex of sha256(raw)>",
  oddKey === "conversion_events:unmapped:none:first_deposit__2_1__~1239dd" &&
    longKey === `conversion_events:unmapped:none:${"x".repeat(40)}~aa20c2` &&
    oddConflictKey === "conversion_events:type_conflicts:134:reg_a_b~34b636>_~8a8de8" &&
    [...builtKeys, oddKey, longKey, oddConflictKey].every((k) => /^[a-z0-9_:>~-]+$/.test(k)),
  JSON.stringify({ oddKey, longKey, oddConflictKey }),
);
check(
  "C3 a combo's key ignores its counts, samples, since and offer name — a growing stream keeps one key",
  unmappedAlertKey(k41) ===
    unmappedAlertKey({ ...k41, total: 900, last_24h: 300, sample_event_ids: ["ev-new"], offer_name: "Renamed" }) &&
    typeConflictAlertKey(regToPurchase) ===
      typeConflictAlertKey({ ...regToPurchase, total: 50, since: "2026-09-18T01:00:00Z", sample_event_ids: [] }),
);
const typeKeys = ["first deposit", "first:deposit", "first>deposit", "first_deposit", "First_Deposit"].map((t) =>
  unmappedAlertKey(unm({ keitaro_type: t })),
);
const longKeys = [`${"x".repeat(40)}y`, `${"x".repeat(40)}z`].map((t) => unmappedAlertKey(unm({ keitaro_type: t })));
const pairKeys = [
  conf({ locked_event_key: "reg a", conflicting_event_key: "purchase" }),
  conf({ locked_event_key: "reg:a", conflicting_event_key: "purchase" }),
  conf({ locked_event_key: "reg_a", conflicting_event_key: "purchase" }),
].map(typeConflictAlertKey);
check(
  "C4 raw parts that sanitise alike get DIFFERENT keys: types differing only in a replaced character or in case, types differing only past the 40-char clip, event keys differing only in a replaced character; and a key is deterministic",
  new Set(typeKeys).size === typeKeys.length &&
    new Set(longKeys).size === longKeys.length &&
    longKeys[0] === `conversion_events:unmapped:none:${"x".repeat(40)}~3c9486` &&
    new Set(pairKeys).size === pairKeys.length &&
    unmappedAlertKey(unm({ keitaro_type: "first deposit" })) === typeKeys[0],
  JSON.stringify({ typeKeys, longKeys, pairKeys }),
);
const clean40 = "a".repeat(40);
check(
  "C5 an already-clean part (lowercase [a-z0-9_-], at most 40 chars) gets no suffix, byte-identical to the pre-hash keys; every key stays bounded",
  unmappedAlertKey(unm({ keitaro_type: "trash" })) === "conversion_events:unmapped:none:trash" &&
    unmappedAlertKey(unm({ keitaro_type: "first_deposit-2" })) === "conversion_events:unmapped:none:first_deposit-2" &&
    unmappedAlertKey(unm({ keitaro_type: clean40 })) === `conversion_events:unmapped:none:${clean40}` &&
    typeConflictAlertKey(conf({})) === "conversion_events:type_conflicts:134:registration>purchase" &&
    builtKeys.every((k) => !k.includes("~")) &&
    [...builtKeys, oddKey, longKey, ...typeKeys, ...longKeys].every((k) => k.length <= "conversion_events:unmapped:".length + 11 + 1 + 47),
  JSON.stringify(builtKeys),
);

console.log("\nledger alerts (per problem combo)");
const capKeys = [K.unmappedComboCap, K.typeConflictComboCap];
const cleanDs = decideLedgerAlerts(ledger([], []), []);
check(
  "L1 clean ledger, nothing firing → no combo decision; both cap keys ok (under the cap)",
  cleanDs.length === 2 && sameKeys(okKeysOf(cleanDs), capKeys),
  keysOnly(cleanDs),
);

const sickDs = decideLedgerAlerts(ledger([psycho, k41, noOffer], [regToPurchase]), []);
const unmappedText = firingText(sickDs, unmappedAlertKey(psycho));
check(
  "L2 unmapped page for one combo: its count, offer name + id, Keitaro type, created-in-24h count, samples, the fix",
  unmappedText.startsWith(PREFIX) &&
    unmappedText.includes(
      "5 conversion(s) for Psycho Book (offer 134) with Keitaro type deposit have no event-type mapping (2 created in the last 24h).",
    ) &&
    unmappedText.includes("Sample Keitaro event ids: ev-a, ev-b, ev-c") &&
    unmappedText.includes("Fix: add a conversion_event_mappings row"),
  unmappedText,
);
const k41Text = firingText(sickDs, unmappedAlertKey(k41));
const noOfferText = firingText(sickDs, unmappedAlertKey(noOffer));
check(
  "L3 offer label: the Keitaro offer id when no CamMan offer, else 'no offer'",
  k41Text.includes("1 conversion(s) for Keitaro offer 41 (no CamMan offer) with Keitaro type trash") &&
    noOfferText.includes("1 conversion(s) for no offer with Keitaro type lead"),
  `${k41Text}\n---\n${noOfferText}`,
);
const conflictText = firingText(sickDs, typeConflictAlertKey(regToPurchase));
check(
  "L4 type_conflicts page for one combo: its count, offer, locked → now-mapped event pair, first-seen-in-24h count, first seen in ET, samples, the doc",
  conflictText.startsWith(PREFIX) &&
    conflictText.includes(
      "3 conversion(s) for Psycho Book (offer 134) changed Keitaro type to one that maps to a different event: locked registration → now purchase (1 first seen in the last 24h).",
    ) &&
    conflictText.includes("First seen: Sep 17, 2026 10:00 AM ET") &&
    conflictText.includes("Sample Keitaro event ids: ev-x, ev-y, ev-z") &&
    conflictText.includes('"Event-type conflicts"'),
  conflictText,
);
check(
  "L5 samples are capped at 3 per page (the 4th sample id never appears)",
  !unmappedText.includes("ev-d") && !conflictText.includes("ev-w"),
  `${unmappedText}\n---\n${conflictText}`,
);
check(
  "L6 new combos, nothing firing → one firing decision per combo on its own key, no clears beyond the two under-cap cap keys",
  sickDs.length === 6 &&
    sameKeys(okKeysOf(sickDs), capKeys) &&
    sameKeys(firingKeysOf(sickDs), [
      unmappedAlertKey(psycho),
      unmappedAlertKey(k41),
      unmappedAlertKey(noOffer),
      typeConflictAlertKey(regToPurchase),
    ]),
  keysOnly(sickDs),
);
const grownK41 = { ...k41, total: 7, last_24h: 7, sample_event_ids: ["ev-7", "ev-6", "ev-5"] };
const latchedDs = decideLedgerAlerts(ledger([grownK41], []), [unmappedAlertKey(k41)]);
check(
  "L7 the same combo already firing, with more rows since → 'firing' on the SAME key again and no combo key cleared (notifyOnTransition's latch makes it no new page — DB S1b)",
  keysOnly(latchedDs) ===
    JSON.stringify([`ok ${K.unmappedComboCap}`, `ok ${K.typeConflictComboCap}`, `firing ${unmappedAlertKey(k41)}`]),
  keysOnly(latchedDs),
);
const staleDs = decideLedgerAlerts(ledger([k41], []), [
  unmappedAlertKey(k41),
  unmappedAlertKey(psycho),
  typeConflictAlertKey(regToPurchase),
  "conversion_events:unmapped", // no trailing colon: outside the prefix
  "conversionXevents:unmapped:1",
  K.fetchFailed,
]);
check(
  "L8 firing keys whose combo is gone → ok, under both prefixes; a present combo stays firing; keys outside the prefixes get no stale decision (only the two cap keys, from the cap rule)",
  staleDs.length === 5 &&
    sameKeys(okKeysOf(staleDs), [unmappedAlertKey(psycho), typeConflictAlertKey(regToPurchase), ...capKeys]) &&
    sameKeys(firingKeysOf(staleDs), [unmappedAlertKey(k41)]),
  keysOnly(staleDs),
);
const spaced = unm({ keitaro_type: "first deposit", total: 9 });
const underscored = unm({ keitaro_type: "first_deposit", total: 2 });
const collideDs = decideLedgerAlerts(ledger([spaced, underscored], []), []);
check(
  "L9 two combos whose Keitaro types sanitise alike → two keys and two pages, each with its own count (the hash suffix keeps them apart)",
  unmappedAlertKey(spaced) !== unmappedAlertKey(underscored) &&
    collideDs.length === 4 &&
    firingText(collideDs, unmappedAlertKey(spaced)).includes("9 conversion(s)") &&
    firingText(collideDs, unmappedAlertKey(underscored)).includes("2 conversion(s)"),
  keysOnly(collideDs),
);
const listed = Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) => unm({ keitaro_type: `type-${i}`, total: 20 - i }));
const pastCapKey = unmappedAlertKey(unm({ keitaro_type: "past-the-cap" }));
const staleConflictKey = typeConflictAlertKey(conf({ conflicting_event_key: "lead" }));
const cappedDs = decideLedgerAlerts(
  ledger(listed, [regToPurchase], { unmapped_combo_count: LEDGER_MAX_COMBOS + 4 }),
  [pastCapKey, staleConflictKey, K.unmappedComboCap],
);
const cappedTexts = firingKeysOf(cappedDs)
  .filter((k) => k.startsWith(P.unmapped))
  .map((k) => firingText(cappedDs, k));
check(
  "L10 over the cap (10 combos per kind): the 10 listed combos page and every unmapped page names the 4 more; no unmapped combo key clears (past the cap is not resolved), while type_conflicts, under its cap, still clears",
  LEDGER_MAX_COMBOS === 10 &&
    cappedTexts.length === 10 &&
    cappedTexts.every((t) => t.includes("4 more unmapped combo(s) are not listed or paged")) &&
    !firingText(cappedDs, typeConflictAlertKey(regToPurchase)).includes("not listed or paged") &&
    sameKeys(okKeysOf(cappedDs), [staleConflictKey, K.typeConflictComboCap]),
  `${keysOnly(cappedDs)}\n${cappedTexts[0]}`,
);
const capText = firingText(cappedDs, K.unmappedComboCap);
check(
  "L11 the cap key fires while the kind is over the cap — one decision on the fixed key (it is not a stale combo key), naming the kind, the combo count, the cap and what to do",
  cappedDs.filter((d) => d.alertKey === K.unmappedComboCap).length === 1 &&
    capText.startsWith(PREFIX) &&
    capText.includes("14 unmapped combos exist, more than the 10 per kind that are listed and paged.") &&
    capText.includes("Only the 10 most recently changed unmapped combos page.") &&
    capText.includes("WHERE event_type_id IS NULL OR status IS NULL") &&
    firingText(
      decideLedgerAlerts(ledger([], listed.map(() => regToPurchase), { conflict_combo_count: 11 }), []),
      K.typeConflictComboCap,
    ).includes("11 type-conflict combos exist, more than the 10 per kind"),
  capText,
);
const atCapDs = decideLedgerAlerts(ledger(listed, [], { unmapped_combo_count: LEDGER_MAX_COMBOS }), [
  pastCapKey,
  K.unmappedComboCap,
]);
check(
  "L12 back at the cap (exactly 10): the cap key clears, no page names more combos, and stale combo keys clear again",
  sameKeys(okKeysOf(atCapDs), [pastCapKey, ...capKeys]) &&
    firingKeysOf(atCapDs).length === LEDGER_MAX_COMBOS &&
    !firingText(atCapDs, unmappedAlertKey(listed[0])).includes("not listed or paged"),
  keysOnly(atCapDs),
);
// The statement's own ORDER BY: the last one, since array_agg has its own.
const orderBy = (q: SQL) => {
  const text = new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ");
  return text.slice(text.lastIndexOf("ORDER BY") + "ORDER BY ".length).split(" LIMIT")[0];
};
check(
  "L13 both combo statements rank by RECENCY, not by size: ORDER BY max(ce.updated_at) DESC first, then every GROUP BY column (so a new 1-row combo is listed and paged even when 10 bigger ones exist — DB P2)",
  orderBy(UNMAPPED_COMBOS_SQL) === "max(ce.updated_at) DESC, 1 NULLS LAST, 2 NULLS LAST, 3" &&
    orderBy(CONFLICT_COMBOS_SQL) === "max(ce.updated_at) DESC, 1 NULLS LAST, 2 NULLS LAST, 3, 4",
  JSON.stringify([orderBy(UNMAPPED_COMBOS_SQL), orderBy(CONFLICT_COMBOS_SQL)]),
);

console.log("\nheartbeat alert");
const breach =
  "Conversion events ingest (Keitaro poll tick) last ran 3h ago (tolerance 1h). Its silence cannot be read as healthy.";
const hbText = formatIngestHeartbeatAlert(breach);
check("H1 heartbeat text: prefix + the breach line", hbText.startsWith(PREFIX) && hbText.includes(breach), hbText);

console.log("\nplain text + keys");
const texts = [
  fetchText,
  invalidText,
  hugeText,
  threwText,
  orgText,
  unmappedText,
  k41Text,
  noOfferText,
  conflictText,
  cappedTexts[0] ?? "",
  capText,
  hbText,
];
const MARKUP = /<\/?[a-z][^>]*>|\*[^*\n]+\*|__[^_\n]+__|`/i;
check(
  "X1 no HTML or Markdown in any alert (notifyTelegram sends without parse_mode)",
  texts.every((t) => t.length > 0 && !MARKUP.test(t)),
  texts.filter((t) => t.length === 0 || MARKUP.test(t)).join("\n---\n"),
);
check(
  "K1 the fixed keys, the combo key prefixes and the heartbeat key are the strings the docs and alert_state rows name; neither cap key starts with a combo prefix, so the stale-combo clear can never touch one",
  K.fetchFailed === "conversion_events:fetch_failed" &&
    K.invalidRows === "conversion_events:invalid_rows" &&
    K.orgMismatch === "conversion_events:org_mismatch" &&
    K.unmappedComboCap === "conversion_events:combo_cap_exceeded:unmapped" &&
    K.typeConflictComboCap === "conversion_events:combo_cap_exceeded:type_conflicts" &&
    Object.keys(K).length === 5 &&
    P.unmapped === "conversion_events:unmapped:" &&
    P.typeConflicts === "conversion_events:type_conflicts:" &&
    Object.keys(P).length === 2 &&
    capKeys.every((k) => !k.startsWith(P.unmapped) && !k.startsWith(P.typeConflicts)) &&
    INGEST_HEARTBEAT_ALERT_KEY === "heartbeat:conversion-events-ingest",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/test-conversion-monitor.ts`
Expected: FAIL — `Cannot find module '../lib/conversions/monitor'`.

- [ ] **Step 4: Add `liveIngestRange` to `lib/conversions/keitaro-row.ts`**

Replace line 1

```ts
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
```

with

```ts
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
```

and append at the end of the file (after `etDayWindows`):

```ts

// The live ingest's window (Phase 2, /api/keitaro/poll): ET "today − 6 days"
// 00:00:00 through now = 7 ET calendar days. Calendar arithmetic on the ET DATE
// string, not now − 6×24h: across a DST fall-back week the 24h arithmetic starts
// a day late (scripts/test-conversion-monitor.ts R3). Keitaro filters
// conversions/log by a conversion's CURRENT datetime, and a re-post moves that
// forward, so an in-place update of an older conversion re-enters this window.
export const LIVE_INGEST_DAYS = 7;

export function liveIngestRange(now: Date): KeitaroReportRange {
  const nowEt = formatInCampaignTimezone(now, "yyyy-MM-dd HH:mm:ss");
  const fromDay = new Date(
    Date.parse(`${nowEt.slice(0, 10)}T00:00:00Z`) - (LIVE_INGEST_DAYS - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return { from: `${fromDay} 00:00:00`, to: nowEt, timezone: CAMPAIGN_TIMEZONE };
}
```

- [ ] **Step 5: Create `lib/conversions/monitor.ts` (pure part)**

```ts
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import type { IngestResult } from "@/lib/conversions/ingest";
import type { KeitaroReportRange } from "@/lib/keitaro/client";

// =============================================================================
// CONVERSION LEDGER MONITOR — Phase 2 of multi-event conversions.
// docs/04-features/conversion-events.md ("Live ingest and alerts").
//
// /api/keitaro/poll ingests the last 7 ET days of Keitaro conversions into
// conversion_events on every */5 tick. Each way that can go wrong pages Telegram
// ONCE, latched in alert_state via notifyOnTransition, and re-armed with
// clearAlert once the condition is gone.
//
//   conversion_events:fetch_failed      failed ticks — the window was refused
//                                       (Keitaro HTTP error, timeout, MALFORMED
//                                       200, TRUNCATED page) or the ingest threw —
//                                       AND no complete ingest for over
//                                       FETCH_FAILED_DEBOUNCE_MINUTES (debounced:
//                                       one transient failure never pages)
//   conversion_events:invalid_rows      Keitaro rows parseKeitaroLedgerRow rejected
//   conversion_events:org_mismatch      existing ledger rows this run resolved to
//                                       ANOTHER org — not written (no debounce:
//                                       a data-integrity signal)
//   conversion_events:unmapped:<offer>:<keitaro type>
//                                       ledger rows, all-time, with a NULL event
//                                       type or status — one key per combo
//   conversion_events:type_conflicts:<offer>:<locked>><conflicting>
//                                       ledger rows whose Keitaro type now maps to
//                                       a different event than their locked one —
//                                       one key per combo
//   conversion_events:combo_cap_exceeded:unmapped
//   conversion_events:combo_cap_exceeded:type_conflicts
//                                       that kind has more than LEDGER_MAX_COMBOS
//                                       problem combos
//   heartbeat:conversion-events-ingest  no complete ingest for over an hour
//                                       (checked by /api/cron/tracking-monitors)
//
// NOT alerted: unresolved conversions (no stage, no offers.keitaro_offer_id).
// They include legitimate non-CamMan traffic; the poll response counts them.
// Nor statusOnlyInBatch: a brand-new status-only row has a NULL event type, so
// the table-level unmapped alert already reports it.
//
// fetch_failed, invalid_rows, org_mismatch, the two combo_cap_exceeded keys and
// the heartbeat are FIXED keys: one standing condition = one page.
//
// unmapped and type_conflicts read the whole table, all-time, and are keyed per
// PROBLEM COMBO. <offer> is the CamMan offer id, else k<Keitaro offer id>, else
// none (see unmappedAlertKey / typeConflictAlertKey). On every tick:
//   - each combo present pages ONCE, when it first appears or re-appears after
//     clearing; more rows of the same combo never page again, so a steady stream
//     of one unmapped type doesn't flood, and a row that turns into a problem by
//     UPDATE (a conflict, or an existing row turning unmapped) pages whenever its
//     combo is new;
//   - a firing key whose combo is gone is cleared (re-armed) — unless its kind
//     is past the cap (below);
//   - at most LEDGER_MAX_COMBOS combos per kind are listed and paged: the most
//     recently changed, by max(updated_at). updated_at is set on insert and on
//     every ingest UPDATE, so a combo an UPDATE creates ranks first too. Past the
//     cap the rest are named as a count in each page, that kind's
//     combo_cap_exceeded key pages once (and clears once the kind is back to
//     LEDGER_MAX_COMBOS or fewer), and no combo key of that kind clears (a combo
//     past the cap can't be told from a resolved one).
// See decideLedgerAlerts.
//
// The poll is cross-org, so these alerts are too — alert_state.org_id stays NULL
// (nullable because "some alerts are global rather than per-org").
//
// ⚠️ PLAIN TEXT. notifyTelegram() sends without parse_mode, so markup would
// render literally. No HTML or Markdown in any formatter below.
// =============================================================================

export const CONVERSION_ALERT_KEYS = {
  fetchFailed: "conversion_events:fetch_failed",
  invalidRows: "conversion_events:invalid_rows",
  orgMismatch: "conversion_events:org_mismatch",
  // One per combo kind. Deliberately NOT under either combo prefix below
  // ("conversion_events:unmapped:" / "conversion_events:type_conflicts:"), so
  // the stale-combo read never sees them and never clears them.
  unmappedComboCap: "conversion_events:combo_cap_exceeded:unmapped",
  typeConflictComboCap: "conversion_events:combo_cap_exceeded:type_conflicts",
} as const;

// Per-combo keys: prefix + combo (unmappedAlertKey, typeConflictAlertKey).
export const CONVERSION_ALERT_KEY_PREFIXES = {
  unmapped: "conversion_events:unmapped:",
  typeConflicts: "conversion_events:type_conflicts:",
} as const;

export const INGEST_HEARTBEAT_ALERT_KEY = "heartbeat:conversion-events-ingest";

// Combos listed — and so paged — per kind per tick, most recently changed
// first. Telegram allows a bot about 20 messages a minute in a group, and both
// kinds can page on the same tick. A send it refuses stays pending and retries
// on the next tick.
export const LEDGER_MAX_COMBOS = 10;

const PREFIX = "🟠 Tier-2 conversions:";
const MAX_SAMPLES = 3;
// Telegram caps a message at 4,096 characters, and Keitaro error bodies and
// unparseable-row samples are external text of unbounded length.
const MAX_LINE = 300;
const MAX_KEY_PART = 40;

function clip(s: string): string {
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s;
}

interface ComboOffer {
  offer_id: number | null; // the attributed CamMan offer
  keitaro_offer_id: number | null; // only when offer_id is null
  offer_name: string | null; // the CamMan offer's name
}

export interface UnmappedCombo extends ComboOffer {
  keitaro_type: string;
  total: number;
  last_24h: number; // by created_at
  sample_event_ids: string[]; // newest created first, at most MAX_SAMPLES
}

export interface ConflictCombo extends ComboOffer {
  locked_event_key: string | null;
  conflicting_event_key: string | null;
  total: number;
  last_24h: number; // by event_type_conflict_at (the conflict's first sighting)
  since: string | null; // earliest event_type_conflict_at, ISO-8601 UTC; rendered in ET
  sample_event_ids: string[]; // newest conflict first, at most MAX_SAMPLES
}

export interface LedgerHealth {
  unmapped_total: number; // rows, across every combo
  unmapped_combo_count: number; // every combo, including any past the cap
  unmapped_combos: UnmappedCombo[]; // the LEDGER_MAX_COMBOS most recently changed
  conflict_total: number;
  conflict_combo_count: number;
  conflict_combos: ConflictCombo[];
}

export type ConversionAlertDecision =
  | { alertKey: string; state: "firing"; text: string }
  | { alertKey: string; state: "ok" };

// What one cron tick's ingest produced: a result (complete, or a refused window
// with ok:false), or a throw caught by the poll route.
export type IngestOutcome =
  | { kind: "result"; result: IngestResult }
  | { kind: "threw"; range: KeitaroReportRange; error: string };

// fetch_failed debounce (controller decision 2026-09-17): a failed tick pages
// only when the last COMPLETE ingest (the conversion-events-ingest heartbeat) is
// older than this, or was never recorded. With */5 ticks a single transient
// Keitaro timeout or throw never pages.
export const FETCH_FAILED_DEBOUNCE_MINUTES = 15;

// A throw and a refused window (ok:false) are the same failure for alerting.
export function ingestFailed(outcome: IngestOutcome): boolean {
  return outcome.kind === "threw" || !outcome.result.ok;
}

// One key part: lowercased, anything outside [a-z0-9_-] → "_", at most
// MAX_KEY_PART characters. ":" and ">" separate the parts, so a part never
// contains them. When that changed the raw part (case, a replaced character,
// truncation), "~" + the first 6 hex characters of the raw part's sha256 are
// appended, so raw parts that sanitise alike still get different keys. An
// already-clean part is used as is, and can't meet a suffixed one: "~" is never
// in a clean part. Deterministic, and at most MAX_KEY_PART + 7 characters.
function keyPart(s: string): string {
  const clean = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, MAX_KEY_PART);
  return clean === s ? clean : `${clean}~${createHash("sha256").update(s).digest("hex").slice(0, 6)}`;
}

function offerKeyPart(c: ComboOffer): string {
  if (c.offer_id !== null) return String(c.offer_id);
  return c.keitaro_offer_id !== null ? `k${c.keitaro_offer_id}` : "none";
}

// Built from the combo only — never its counts or samples — so more rows of
// the same combo keep the same key.
export function unmappedAlertKey(c: UnmappedCombo): string {
  return `${CONVERSION_ALERT_KEY_PREFIXES.unmapped}${offerKeyPart(c)}:${keyPart(c.keitaro_type)}`;
}

export function typeConflictAlertKey(c: ConflictCombo): string {
  const pair = `${keyPart(c.locked_event_key ?? "?")}>${keyPart(c.conflicting_event_key ?? "?")}`;
  return `${CONVERSION_ALERT_KEY_PREFIXES.typeConflicts}${offerKeyPart(c)}:${pair}`;
}

function windowLine(range: KeitaroReportRange): string {
  return `Window: ${range.from} → ${range.to} ${range.timezone}`;
}

// "18 min ago" under two hours; "3.1 h ago" from there.
function formatAgo(minutes: number): string {
  return minutes < 120 ? `${Math.round(minutes)} min ago` : `${(minutes / 60).toFixed(1)} h ago`;
}

function formatFetchFailedAlert(outcome: IngestOutcome, lastSuccessAgeMinutes: number | null): string {
  const range = outcome.kind === "threw" ? outcome.range : outcome.result.range;
  const error =
    outcome.kind === "threw" ? `ingest threw: ${outcome.error}` : (outcome.result.error ?? "(no error message)");
  return [
    `${PREFIX} the conversion ledger ingest keeps failing. Nothing from the failed windows was written.`,
    windowLine(range),
    `Error: ${clip(error)}`,
    `Last complete ingest: ${lastSuccessAgeMinutes === null ? "never recorded" : formatAgo(lastSuccessAgeMinutes)}.`,
    "The conversion_events ledger is not updated while this lasts. Repeated timeouts or HTTP errors: Keitaro or the network is down. A malformed response (a 200 that is not JSON with a rows array and a numeric total, e.g. an HTML bot challenge): something other than the Keitaro API answered. A truncated page: 7 days of conversions no longer fit one Keitaro page and the window needs splitting. A thrown error is also in the poll's conversion_events_error and the Vercel logs.",
  ].join("\n");
}

function formatInvalidRowsAlert(ingest: IngestResult): string {
  return [
    `${PREFIX} ${ingest.invalid} Keitaro conversion row(s) could not be parsed and are NOT in the ledger.`,
    windowLine(ingest.range),
    ...ingest.invalidSamples.slice(0, MAX_SAMPLES).map((s) => `- ${clip(s)}`),
    "Compare the samples with KEITARO_LEDGER_COLUMNS (lib/keitaro/client.ts) and parseKeitaroLedgerRow (lib/conversions/keitaro-row.ts).",
  ].join("\n");
}

function formatOrgMismatchAlert(ingest: IngestResult): string {
  return [
    `${PREFIX} ${ingest.orgMismatch} conversion(s) resolved to a different org than their stored ledger row and were NOT written.`,
    windowLine(ingest.range),
    ...ingest.orgMismatchSamples.slice(0, MAX_SAMPLES).map((s) => `- ${clip(s)}`),
    "Samples are event_id stored_org→resolved_org. org_id is fixed at insert, so the stored row keeps its org, attribution and event type. Find which lookup now points into another org (stage tracking id, stage_sends id or offers.keitaro_offer_id) before correcting anything by SQL. See docs/04-features/conversion-events.md.",
  ].join("\n");
}

function offerLabel(c: ComboOffer): string {
  if (c.offer_id !== null) return `${clip(c.offer_name ?? "?")} (offer ${c.offer_id})`;
  return c.keitaro_offer_id !== null ? `Keitaro offer ${c.keitaro_offer_id} (no CamMan offer)` : "no offer";
}

function samplesLine(ids: readonly string[]): string {
  return clip(`Sample Keitaro event ids: ${ids.slice(0, MAX_SAMPLES).join(", ")}`);
}

// Appended to every page of a kind whose combos exceed the cap; [] otherwise.
function pastCapLine(kind: string, comboCount: number): string[] {
  return comboCount > LEDGER_MAX_COMBOS
    ? [
        `${comboCount - LEDGER_MAX_COMBOS} more ${kind} combo(s) are not listed or paged (cap: ${LEDGER_MAX_COMBOS} combos per kind, the most recently changed listed). No ${kind} combo alert clears while the cap is exceeded.`,
      ]
    : [];
}

// The kind's combo_cap_exceeded key: firing while the kind has more combos than
// the cap, ok at or below it.
function comboCapDecision(alertKey: string, kind: string, comboCount: number, fix: string): ConversionAlertDecision {
  if (comboCount <= LEDGER_MAX_COMBOS) return { alertKey, state: "ok" };
  return {
    alertKey,
    state: "firing",
    text: [
      `${PREFIX} ${comboCount} ${kind} combos exist, more than the ${LEDGER_MAX_COMBOS} per kind that are listed and paged.`,
      `Only the ${LEDGER_MAX_COMBOS} most recently changed ${kind} combos page. The rest are not paged, and no ${kind} combo alert clears until ${LEDGER_MAX_COMBOS} or fewer combos remain; this alert clears then too.`,
      fix,
    ].join("\n"),
  };
}

function formatUnmappedAlert(c: UnmappedCombo, pastCap: string[]): string {
  return [
    `${PREFIX} ${c.total} conversion(s) for ${offerLabel(c)} with Keitaro type ${clip(c.keitaro_type)} have no event-type mapping (${c.last_24h} created in the last 24h).`,
    "They are stored but never counted as a purchase or as revenue.",
    samplesLine(c.sample_event_ids),
    "Fix: add a conversion_event_mappings row for this offer or its network and this Keitaro type; rows inside the 7-day live window heal on the next tick. A row first seen through a status-only rule (e.g. rejected) has no event type to heal into and needs one set by SQL. See docs/04-features/conversion-events.md.",
    ...pastCap,
  ].join("\n");
}

function formatTypeConflictAlert(c: ConflictCombo, pastCap: string[]): string {
  return [
    `${PREFIX} ${c.total} conversion(s) for ${offerLabel(c)} changed Keitaro type to one that maps to a different event: locked ${clip(c.locked_event_key ?? "?")} → now ${clip(c.conflicting_event_key ?? "?")} (${c.last_24h} first seen in the last 24h). The locked event type was kept.`,
    `First seen: ${formatCampaignDateTime(c.since)}`,
    samplesLine(c.sample_event_ids),
    'Decide which event is right: see "Event-type conflicts" in docs/04-features/conversion-events.md.',
    ...pastCap,
  ].join("\n");
}

export function formatIngestHeartbeatAlert(breach: string): string {
  return [
    `${PREFIX} the ledger ingest has not completed a window recently.`,
    breach,
    "Check the /api/keitaro/poll cron: conversion_events_error in its response, the Vercel logs, and any conversion_events:fetch_failed alert.",
  ].join("\n");
}

// Decisions from ONE cron tick's ingest outcome.
//   complete window → clear fetch_failed; fire or clear invalid_rows; fire or
//     clear org_mismatch (no debounce).
//   failed tick (refused — HTTP error, timeout, malformed, truncated — or threw)
//     → fire fetch_failed only when the last complete ingest is older than
//     FETCH_FAILED_DEBOUNCE_MINUTES or was never recorded; otherwise NO decision
//     (neither fire nor clear). invalid_rows and org_mismatch never get a
//     decision on a failed tick: nothing was parsed or upserted.
// lastSuccessAgeMinutes: minutes since the conversion-events-ingest heartbeat,
// null = never recorded. Only consulted for a failed tick.
export function decideIngestAlerts(
  outcome: IngestOutcome,
  lastSuccessAgeMinutes: number | null,
): ConversionAlertDecision[] {
  if (outcome.kind === "result" && outcome.result.ok) {
    const ingest = outcome.result;
    return [
      { alertKey: CONVERSION_ALERT_KEYS.fetchFailed, state: "ok" },
      ingest.invalid > 0
        ? { alertKey: CONVERSION_ALERT_KEYS.invalidRows, state: "firing", text: formatInvalidRowsAlert(ingest) }
        : { alertKey: CONVERSION_ALERT_KEYS.invalidRows, state: "ok" },
      ingest.orgMismatch > 0
        ? { alertKey: CONVERSION_ALERT_KEYS.orgMismatch, state: "firing", text: formatOrgMismatchAlert(ingest) }
        : { alertKey: CONVERSION_ALERT_KEYS.orgMismatch, state: "ok" },
    ];
  }
  if (lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes <= FETCH_FAILED_DEBOUNCE_MINUTES) {
    return [];
  }
  return [
    {
      alertKey: CONVERSION_ALERT_KEYS.fetchFailed,
      state: "firing",
      text: formatFetchFailedAlert(outcome, lastSuccessAgeMinutes),
    },
  ];
}

// Decisions from the whole-ledger combo read (all-time, all orgs) and the keys
// currently firing under the two combo prefixes.
//   each kind's combo_cap_exceeded key → firing while that kind has more than
//     LEDGER_MAX_COMBOS combos, ok at or below it.
//   every listed combo → firing on its key. notifyOnTransition pages only on the
//     transition, so a combo already firing sends nothing.
//   a firing key under a prefix that no listed combo builds → ok (cleared, so
//     the combo pages again if it comes back) — unless that kind is past the
//     cap, where no combo key of that kind is cleared.
// Keys outside both prefixes, the cap keys included, get no stale-key decision.
export function decideLedgerAlerts(h: LedgerHealth, firingKeys: readonly string[]): ConversionAlertDecision[] {
  const P = CONVERSION_ALERT_KEY_PREFIXES;
  const K = CONVERSION_ALERT_KEYS;
  const unmappedPastCap = pastCapLine("unmapped", h.unmapped_combo_count);
  const conflictPastCap = pastCapLine("type-conflict", h.conflict_combo_count);
  const present = new Map<string, string>(); // key → page text
  for (const c of h.unmapped_combos) present.set(unmappedAlertKey(c), formatUnmappedAlert(c, unmappedPastCap));
  for (const c of h.conflict_combos) present.set(typeConflictAlertKey(c), formatTypeConflictAlert(c, conflictPastCap));
  const clearable = (key: string) =>
    (key.startsWith(P.unmapped) && unmappedPastCap.length === 0) ||
    (key.startsWith(P.typeConflicts) && conflictPastCap.length === 0);
  return [
    comboCapDecision(
      K.unmappedComboCap,
      "unmapped",
      h.unmapped_combo_count,
      "Fix: list every combo (conversion_events rows WHERE event_type_id IS NULL OR status IS NULL, grouped by offer_id, keitaro_offer_id and keitaro_type) and add the missing conversion_event_mappings rows. See docs/04-features/conversion-events.md.",
    ),
    comboCapDecision(
      K.typeConflictComboCap,
      "type-conflict",
      h.conflict_combo_count,
      'Fix: list every combo (conversion_events rows WHERE conflicting_event_type_id IS NOT NULL, grouped by offer_id, keitaro_offer_id, event_type_id and conflicting_event_type_id) and decide each: see "Event-type conflicts" in docs/04-features/conversion-events.md.',
    ),
    ...[...present].map(([alertKey, text]): ConversionAlertDecision => ({ alertKey, state: "firing", text })),
    ...firingKeys
      .filter((key) => !present.has(key) && clearable(key))
      .map((alertKey): ConversionAlertDecision => ({ alertKey, state: "ok" })),
  ];
}

// ── Combo statements (pure values, run by readLedgerHealth) ─────────────────

// One statement per kind: the LEDGER_MAX_COMBOS most recently changed combos
// with their counts and samples, plus the combo count and row total over EVERY
// combo (window aggregates over the groups, computed before the LIMIT). Ranked
// by max(updated_at) DESC — set on insert and on every ingest UPDATE, so a new
// combo ranks first even when it is the smallest, including one an UPDATE
// creates — then by every GROUP BY column, so the order is total. Each WHERE is
// written EXACTLY as its partial index's predicate (migration 0181), so the
// planner can read only that small index's rows however large the ledger grows.
// The per-combo sample array aggregates every row of its combo before slicing:
// fine for problem rows, which the partial index keeps few. <offer> is offer_id,
// else keitaro_offer_id (the CASE drops the Keitaro id when a CamMan offer is
// set), matching offerKeyPart. Exported so scripts/test-conversion-monitor-db.ts
// can EXPLAIN the very statements readLedgerHealth runs, and
// scripts/test-conversion-monitor.ts can check their ranking.
export const UNMAPPED_COMBOS_SQL = sql`
  SELECT ce.offer_id,
         CASE WHEN ce.offer_id IS NULL THEN ce.keitaro_offer_id END AS keitaro_offer_id,
         ce.keitaro_type,
         min(o.name) AS offer_name,
         count(*)::int AS total,
         count(*) FILTER (WHERE ce.created_at >= now() - interval '24 hours')::int AS last_24h,
         (array_agg(ce.keitaro_event_id ORDER BY ce.created_at DESC, ce.id DESC))[1:${MAX_SAMPLES}] AS sample_event_ids,
         count(*) OVER ()::int AS combo_count,
         (sum(count(*)) OVER ())::int AS row_total
  FROM conversion_events ce
  LEFT JOIN offers o ON o.id = ce.offer_id
  WHERE ce.event_type_id IS NULL OR ce.status IS NULL
  GROUP BY 1, 2, 3
  ORDER BY max(ce.updated_at) DESC, 1 NULLS LAST, 2 NULLS LAST, 3
  LIMIT ${LEDGER_MAX_COMBOS}`;

export const CONFLICT_COMBOS_SQL = sql`
  SELECT ce.offer_id,
         CASE WHEN ce.offer_id IS NULL THEN ce.keitaro_offer_id END AS keitaro_offer_id,
         lt.key AS locked_event_key,
         mt.key AS conflicting_event_key,
         min(o.name) AS offer_name,
         count(*)::int AS total,
         count(*) FILTER (WHERE ce.event_type_conflict_at >= now() - interval '24 hours')::int AS last_24h,
         to_char(min(ce.event_type_conflict_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS since,
         (array_agg(ce.keitaro_event_id ORDER BY ce.event_type_conflict_at DESC NULLS LAST, ce.id DESC))[1:${MAX_SAMPLES}] AS sample_event_ids,
         count(*) OVER ()::int AS combo_count,
         (sum(count(*)) OVER ())::int AS row_total
  FROM conversion_events ce
  LEFT JOIN offers o ON o.id = ce.offer_id
  LEFT JOIN event_types lt ON lt.id = ce.event_type_id
  LEFT JOIN event_types mt ON mt.id = ce.conflicting_event_type_id
  WHERE ce.conflicting_event_type_id IS NOT NULL
  GROUP BY 1, 2, 3, 4
  ORDER BY max(ce.updated_at) DESC, 1 NULLS LAST, 2 NULLS LAST, 3, 4
  LIMIT ${LEDGER_MAX_COMBOS}`;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-conversion-monitor.ts`
Expected: `39 passed, 0 failed`, exit 0. The historical commits recorded 22 (e88593a), 30 (dbfba2c, fix wave 1) and 34 (c754f89, fix wave 2).

Run: `npx tsx scripts/test-conversion-ledger-rows.ts`
Expected: `38 passed, 0 failed` (Phase 1's count at 72501c7; if Phase 1 moved on, the count its CHANGELOG entry records). This is a regression check for the `keitaro-row.ts` edit.

If L4 fails only on the `First seen:` time string, print `formatCampaignDateTime("2026-09-17T14:00:00Z")` and compare. The expected value is `Sep 17, 2026 10:00 AM ET` (EDT = UTC−4). Fix the code, not the expectation.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint lib/conversions/keitaro-row.ts lib/conversions/monitor.ts scripts/test-conversion-monitor.ts
git add lib/conversions/keitaro-row.ts lib/conversions/monitor.ts scripts/test-conversion-monitor.ts
git commit -m "feat(conversions): live 7-day ingest window + pure Tier-2 alert decisions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Ledger health read, latched alerts, ingest heartbeat (DB)

> **Fix waves 1, 2 and 3 (2026-09-17) changed this task's output. The code below is the current state, as committed in fix wave 3.** It is not the original Task 2 commit (2b2a0da, 27 DB checks), fix wave 1's (dbfba2c, 33 checks with per-newest-row keys and a LIKE prefix clear) or fix wave 2's (c754f89, 36 checks).
> - **Combo reads:** the count constants are now `UNMAPPED_COMBOS_SQL` / `CONFLICT_COMBOS_SQL`, one grouped statement per kind ranked by recency (decision 7) and declared in Task 1, and `readLedgerHealth` returns per-combo groups.
> - **Firing keys:** module-private `readFiringLedgerKeys` reads the firing keys under both prefixes with `starts_with`. `decideLedgerAlerts` turns them into fires and `clearAlert`s, applied through the same `applyDecisions` as the fixed keys (decision 14).
> - **Return value and failure contract:** `evaluateConversionAlerts` returns `{ health, ingestDecisions, ledgerDecisions }`. Its comment states the failure contract: if the heartbeat-age read throws, nothing pages and the ledger alerts are skipped for that tick, so the caller must catch.
>
> The DB test has **43** checks:
> - **Setup:** M0 fixtures. M0b neutralises pre-existing problem rows inside the transaction.
> - **Reads:** M1–M5 cover combos, counts, the offer rule, samples, and a conflict set by UPDATE, with M1b on the realistic status-only row (`event_type_id` NULL, `status` `rejected` — the shape ingest inserts through a status-only rule, unmapped through the `event_type_id` arm). M6/M7 EXPLAIN the combo statements. M8 checks the cap in a savepoint, and that the listing is by recency, not size.
> - **First ticks:** A1–A3. A2 also clears leftover in-prefix keys.
> - **Controller scenarios:**
>   - S1a/S1b (a) a new combo pages once, and a stream of it doesn't
>   - S2 (b) another new combo pages
>   - S3 (c) an existing mapped row turned unmapped by UPDATE pages
>   - S4a/S4b (d) a conflict set on an existing row by UPDATE pages, and a second of the same combo doesn't
>   - S5a/S5b (e) a resolved combo clears, and it pages again when it reappears
>   - A8b (f) a refused tick still pages a new combo
>   - S6 (g) the decoys outside the prefixes are untouched after a full heal
> - **The cap (fix wave 3), P1–P5:** ten combos of 2 rows page once each at the cap; a brand-new 1-row 11th combo still pages (recency ranking) and crossing the cap pages the `combo_cap_exceeded` key exactly once, while the combo that dropped off the listing is NOT cleared; a latched tick sends nothing; back at the cap the cap key clears and combo clears resume; then everything heals.
> - **Fixed keys:** A6–A14, then B1–B3 for the heartbeat.
> - **Residue:** Z1.
>
> Page counts are per step (`pagesDuring`), not running totals.

**Files:**
- Modify: `lib/reporting/cron-heartbeat.ts` (`HEARTBEAT_JOBS`, after the `trackingMonitors` entry)
- Modify: `lib/conversions/monitor.ts` (replace the 3-line import block; append a DB section)
- Test: `scripts/test-conversion-monitor-db.ts` (camman-v2 only; rolled back)

**Interfaces:**
- Consumes:
  - everything Task 1 produced
  - `notifyOnTransition(dbc, { alertKey, orgId?, text, send? })` and `clearAlert(dbc, { alertKey, orgId? })` from `lib/alerts/alert-state.ts`
  - `checkHeartbeats(dbc, HeartbeatExpectation[]): Promise<HeartbeatStatus[]>`, `heartbeatBreaches(statuses): string[]`, `recordHeartbeat(dbc, jobName)`, `type DbOrTx`, `type HeartbeatStatus` from `lib/reporting/cron-heartbeat.ts`
  - schema export `conversion_events` (0181)
- Produces:
  - `HEARTBEAT_JOBS.conversionEventsIngest = { job_name: "conversion-events-ingest", max_age_hours: 1, label: "Conversion events ingest (Keitaro poll tick)" }`
  - `readLedgerHealth(dbc: DbOrTx): Promise<LedgerHealth>`: runs Task 1's two statements, per-combo groups (at most `LEDGER_MAX_COMBOS` per kind, most recently changed first) with the row total and combo count over every combo
  - module-private `readFiringLedgerKeys(dbc): Promise<string[]>`: `alert_key`s with `state = 'firing'` under either prefix, via `starts_with`
  - `evaluateConversionAlerts(dbc: DbOrTx, outcome: IngestOutcome, opts?: { send?: (text: string) => Promise<boolean> }): Promise<{ health: LedgerHealth; ingestDecisions: ConversionAlertDecision[]; ledgerDecisions: ConversionAlertDecision[] }>`
    - On a failed tick it reads the heartbeat age (`checkHeartbeats`, in minutes) for the debounce.
    - On every tick it applies `decideLedgerAlerts(readLedgerHealth, readFiringLedgerKeys)` through `notifyOnTransition` / `clearAlert`.
  - `watchIngestHeartbeat(dbc: DbOrTx, opts?: { send?: (text: string) => Promise<boolean> }): Promise<HeartbeatStatus>`

- [ ] **Step 1: Write the failing DB test**

`scripts/test-conversion-monitor-db.ts`:

```ts
import "./_env-preload";

import { inArray, like, sql, type SQL } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import { db } from "../db/client";
import { conversion_events } from "../db/schema";
import { clearAlert } from "../lib/alerts/alert-state";
import type { IngestResult } from "../lib/conversions/ingest";
import {
  CONFLICT_COMBOS_SQL,
  CONVERSION_ALERT_KEYS,
  INGEST_HEARTBEAT_ALERT_KEY,
  LEDGER_MAX_COMBOS,
  UNMAPPED_COMBOS_SQL,
  evaluateConversionAlerts,
  readLedgerHealth,
  watchIngestHeartbeat,
  type IngestOutcome,
  type LedgerHealth,
} from "../lib/conversions/monitor";
import { HEARTBEAT_JOBS, recordHeartbeat } from "../lib/reporting/cron-heartbeat";

// The conversion ledger monitor's DB side, run through the REAL exported
// functions inside a transaction that always rolls back. Every page goes to a
// stub sender; TELEGRAM_* is also unset so a missed injection cannot reach the
// channel. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-conversion-monitor-db.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}
const RUN = `test-cm-${Date.now()}`;
const K = CONVERSION_ALERT_KEYS;
// Written out, not imported: the keys the docs and alert_state rows name.
const UNM = "conversion_events:unmapped:";
const CONF = "conversion_events:type_conflicts:";
// The per-kind cap keys. Neither is under a combo prefix, so the stale-combo
// clear never sees them.
const CAP_UNM = "conversion_events:combo_cap_exceeded:unmapped";
const CAP_CONF = "conversion_events:combo_cap_exceeded:type_conflicts";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function alertRow(tx: Tx, key: string) {
  const rows = (await tx.execute(sql`
    SELECT state, last_notified_at IS NOT NULL AS notified, org_id IS NULL AS global
    FROM alert_state WHERE alert_key = ${key}
  `)) as unknown as { state: string; notified: boolean; global: boolean }[];
  return rows[0];
}

// Every non-ok key under the combo prefixes, sorted in JS.
async function firingKeys(tx: Tx, prefixes: string[] = [UNM, CONF]): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of prefixes) {
    const rows = (await tx.execute(sql`
      SELECT alert_key FROM alert_state
      WHERE starts_with(alert_key, ${prefix}::text) AND state <> 'ok'
    `)) as unknown as { alert_key: string }[];
    keys.push(...rows.map((r) => r.alert_key));
  }
  return keys.sort();
}
const sameKeys = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Proves the statement CAN be answered from the named index: with seq scans
// disabled, a predicate that doesn't match the partial index's predicate falls
// back to a (penalised) seq scan and the index name is absent from the plan.
async function usesIndex(tx: Tx, query: SQL, index: string): Promise<boolean> {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  const plan = await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
  await tx.execute(sql`SET LOCAL enable_seqscan = on`);
  return JSON.stringify(plan).includes(index);
}

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
    return true;
  };
  // The pages a step sent.
  const pagesDuring = async (step: () => Promise<unknown>): Promise<string[]> => {
    const n = sent.length;
    await step();
    return sent.slice(n);
  };
  const preexisting = await readLedgerHealth(db);

  try {
    await db.transaction(async (tx) => {
      const [org] = (await tx.execute(
        sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`,
      )) as unknown as { id: string }[];
      const types = (await tx.execute(
        sql`SELECT id, key FROM event_types WHERE org_id = ${org.id}::uuid`,
      )) as unknown as { id: number; key: string }[];
      const purchase = types.find((t) => t.key === "purchase")?.id ?? null;
      const registration = types.find((t) => t.key === "registration")?.id ?? null;
      const [offer] = (await tx.execute(
        sql`SELECT id, name FROM offers WHERE org_id = ${org.id}::uuid ORDER BY id LIMIT 1`,
      )) as unknown as { id: number; name: string }[];
      check(
        "M0 fixtures: seeded event types and an offer exist for the first org",
        purchase !== null && registration !== null && offer !== undefined,
        JSON.stringify({ types, offer }),
      );
      if (purchase === null || registration === null || offer === undefined) throw new Rollback();

      // Neutralise any pre-existing problem rows INSIDE the rolled-back tx, so the
      // clear/re-fire checks start from a clean ledger without requiring one.
      await tx.execute(sql`
        UPDATE conversion_events
        SET event_type_id = COALESCE(event_type_id, ${purchase}), status = COALESCE(status, 'approved')
        WHERE event_type_id IS NULL OR status IS NULL
      `);
      await tx.execute(sql`
        UPDATE conversion_events
        SET conflicting_event_type_id = NULL, event_type_conflict_at = NULL
        WHERE conflicting_event_type_id IS NOT NULL
      `);
      const before = await readLedgerHealth(tx);
      check(
        `M0b pre-existing problem rows neutralised in the tx (${preexisting.unmapped_total} unmapped, ${preexisting.conflict_total} conflicting) → no problem rows, no combos`,
        before.unmapped_total === 0 &&
          before.conflict_total === 0 &&
          before.unmapped_combo_count === 0 &&
          before.conflict_combo_count === 0 &&
          before.unmapped_combos.length === 0 &&
          before.conflict_combos.length === 0,
        JSON.stringify(before),
      );
      if (before.unmapped_total !== 0 || before.conflict_total !== 0) throw new Rollback();

      for (const key of [...Object.values(K), INGEST_HEARTBEAT_ALERT_KEY]) {
        await clearAlert(tx, { alertKey: key });
      }
      await tx.execute(sql`
        UPDATE alert_state SET state = 'ok'
        WHERE starts_with(alert_key, ${UNM}::text) OR starts_with(alert_key, ${CONF}::text)
      `);
      const seedFiring = (key: string) =>
        tx.execute(sql`
          INSERT INTO alert_state (alert_key, state, since, last_notified_at)
          VALUES (${key}, 'firing', now(), now())
          ON CONFLICT (alert_key) DO UPDATE SET state = 'firing', last_notified_at = now()
        `);
      // Firing keys OUTSIDE both prefixes (the pre-combo fixed key has no trailing
      // colon; the others differ by one character): never touched (g).
      const decoys = ["conversion_events:unmapped", "conversionXevents:unmapped:1", "conversion_events:typeXconflicts:1"];
      // Firing keys INSIDE the prefixes that no combo builds (fix wave 1's per-row
      // format): stale, so the first tick clears them without a page.
      const leftovers = [`${UNM}1`, `${CONF}1`];
      for (const key of [...decoys, ...leftovers]) await seedFiring(key);

      const id = (s: string) => `${RUN}-${s}`;
      const rowIds = new Map<string, number>();
      // Records each inserted row's id under its name (keitaro_event_id minus the run prefix).
      const insertRows = async (rows: PgInsertValue<typeof conversion_events>[]) => {
        const inserted = await tx
          .insert(conversion_events)
          .values(rows)
          .returning({ id: conversion_events.id, keitaro_event_id: conversion_events.keitaro_event_id });
        for (const r of inserted) rowIds.set(r.keitaro_event_id.slice(RUN.length + 1), r.id);
      };
      const rowId = (name: string) => rowIds.get(name) ?? -1;
      const mappedRow = (name: string, eventTypeId: number, age: string): PgInsertValue<typeof conversion_events> => ({
        keitaro_event_id: id(name),
        org_id: org.id,
        keitaro_status: "sale",
        keitaro_type: "sale",
        offer_id: offer.id,
        event_type_id: eventTypeId,
        status: "approved",
        occurred_at: new Date("2026-09-05T12:00:00Z"),
        created_at: sql`now() - ${age}::interval`,
      });
      // NULL event type and NULL status, no attribution unless `over` adds it.
      const unmappedRow = (
        name: string,
        keitaroType: string,
        over: Partial<PgInsertValue<typeof conversion_events>> = {},
      ): PgInsertValue<typeof conversion_events> => ({
        keitaro_event_id: id(name),
        org_id: org.id,
        keitaro_status: keitaroType,
        keitaro_type: keitaroType,
        occurred_at: new Date("2026-09-16T12:00:00Z"),
        ...over,
      });
      const byName = (names: string[]) => inArray(conversion_events.keitaro_event_id, names.map(id));
      // What upsertConversionEvents writes on an EXISTING row whose re-posted
      // Keitaro type maps to a different event than the locked one: the raw type
      // moves, the event type stays, and the conflict is recorded (conflict_at is
      // COALESCE(existing, now())). Conflicts never arise at insert.
      const conflictOnUpdate = (names: string[], keitaroType: string, mapsTo: number) =>
        tx
          .update(conversion_events)
          .set({
            keitaro_type: keitaroType,
            keitaro_status: keitaroType,
            conflicting_event_type_id: mapsTo,
            event_type_conflict_at: sql`COALESCE(conversion_events.event_type_conflict_at, now())`,
            updated_at: sql`now()`,
          })
          .where(byName(names));
      // …and when the new Keitaro type maps to nothing (or its rule was archived):
      // status becomes NULL, the locked event type stays.
      const unmapOnUpdate = (names: string[], keitaroType: string) =>
        tx
          .update(conversion_events)
          .set({ keitaro_type: keitaroType, keitaro_status: keitaroType, status: null, updated_at: sql`now()` })
          .where(byName(names));
      const healSet = { event_type_id: purchase, status: "approved", conflicting_event_type_id: null, event_type_conflict_at: null };
      const heal = (names: string[]) => tx.update(conversion_events).set(healSet).where(byName(names));

      // EXISTING, healthy rows first — the lowest ids, created days ago. They
      // become problems later only through UPDATE, as the live ingest makes them.
      await insertRows([
        mappedRow("old-mapped", purchase, "10 days"),
        mappedRow("old-p1", purchase, "5 days"),
        mappedRow("old-p2", purchase, "4 days"),
        mappedRow("old-r1", registration, "6 days"),
      ]);
      await insertRows([
        // one combo (Keitaro offer 41, no CamMan offer; trash) with 4 rows, newest
        // first by name, each last changed when it was created
        ...[1, 2, 3, 4].map((n) =>
          unmappedRow(`trash-${n}`, "trash", {
            keitaro_offer_id: 41,
            created_at: sql`now() - ${`${n} minutes`}::interval`,
            updated_at: sql`now() - ${`${n} minutes`}::interval`,
          }),
        ),
        // What ingest INSERTS for a row first seen through a status-only mapping
        // (the seeded PsychoBook "rejected" rule): a status, but NO event type. It
        // is unmapped through the event_type_id arm, not the status arm. CamMan
        // offer + Keitaro offer 41, created 3 days ago and re-posted just now, so
        // it is the most recently changed combo while being the smallest.
        unmappedRow("rej", "rejected", {
          offer_id: offer.id,
          keitaro_offer_id: 41,
          status: "rejected",
          created_at: sql`now() - interval '3 days'`,
        }),
        // fully mapped — never counted
        mappedRow("clean", purchase, "0 days"),
      ]);
      await conflictOnUpdate(["old-r1"], "sale", purchase);
      const [{ now_utc }] = (await tx.execute(
        sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS now_utc`,
      )) as unknown as { now_utc: string }[];

      const h = await readLedgerHealth(tx);
      const [rej, trash] = h.unmapped_combos;
      check(
        "M1 unmapped = event type NULL OR status NULL, one group per combo (offer, Keitaro type), MOST RECENTLY CHANGED first — the 1-row rejected combo, re-posted now, ahead of the 4-row trash combo; mapped rows excluded",
        h.unmapped_total === 5 &&
          h.unmapped_combo_count === 2 &&
          h.unmapped_combos.length === 2 &&
          rej?.keitaro_type === "rejected" &&
          rej.total === 1 &&
          trash?.keitaro_type === "trash" &&
          trash.total === 4,
        JSON.stringify(h.unmapped_combos),
      );
      const [rejRow] = (await tx.execute(sql`
        SELECT event_type_id, status FROM conversion_events WHERE keitaro_event_id = ${id("rej")}
      `)) as unknown as { event_type_id: number | null; status: string | null }[];
      check(
        "M1b a first-seen status-only row, exactly as ingest inserts one (event_type_id NULL, status 'rejected'), counts as unmapped — through the event_type_id arm of the predicate, which a 'status IS NULL' read would miss",
        rejRow?.event_type_id === null &&
          rejRow.status === "rejected" &&
          rej?.total === 1 &&
          JSON.stringify(rej.sample_event_ids) === JSON.stringify([id("rej")]),
        JSON.stringify({ rejRow, rej }),
      );
      check(
        "M2 each combo's last-24h count is by created_at, not updated_at (the rejected row was changed just now but created 3 days ago)",
        trash?.last_24h === 4 && rej?.last_24h === 0,
        JSON.stringify(h.unmapped_combos),
      );
      check(
        "M3 combo offer: no CamMan offer → keitaro_offer_id, no name; a CamMan offer → offer_id + name, and its keitaro_offer_id is dropped (offer_id wins)",
        trash?.offer_id === null &&
          trash.keitaro_offer_id === 41 &&
          trash.offer_name === null &&
          rej?.offer_id === offer.id &&
          rej.offer_name === offer.name &&
          rej.keitaro_offer_id === null,
        JSON.stringify(h.unmapped_combos),
      );
      check(
        "M4 combo samples: newest created first, at most 3",
        JSON.stringify(trash?.sample_event_ids) === JSON.stringify([id("trash-1"), id("trash-2"), id("trash-3")]) &&
          JSON.stringify(rej?.sample_event_ids) === JSON.stringify([id("rej")]),
        JSON.stringify(h.unmapped_combos.map((c) => c.sample_event_ids)),
      );
      const [c1] = h.conflict_combos;
      check(
        "M5 a conflict set by UPDATE on an existing row, grouped per combo (offer, locked event, conflicting event): count, first-seen-in-24h count, first seen as UTC ISO, samples",
        h.conflict_total === 1 &&
          h.conflict_combo_count === 1 &&
          c1?.offer_id === offer.id &&
          c1.offer_name === offer.name &&
          c1.keitaro_offer_id === null &&
          c1.locked_event_key === "registration" &&
          c1.conflicting_event_key === "purchase" &&
          c1.total === 1 &&
          c1.last_24h === 1 &&
          c1.since === now_utc &&
          JSON.stringify(c1.sample_event_ids) === JSON.stringify([id("old-r1")]),
        JSON.stringify({ combos: h.conflict_combos, now_utc }),
      );
      check(
        "M6 the unmapped combo statement is answerable from conversion_events_unmapped_idx",
        await usesIndex(tx, UNMAPPED_COMBOS_SQL, "conversion_events_unmapped_idx"),
      );
      check(
        "M7 the conflict combo statement is answerable from conversion_events_type_conflict_idx",
        await usesIndex(tx, CONFLICT_COMBOS_SQL, "conversion_events_type_conflict_idx"),
      );
      let capped: LedgerHealth | undefined;
      try {
        await tx.transaction(async (sp) => {
          await sp.insert(conversion_events).values(
            Array.from({ length: 11 }, (_, i) =>
              [1, 2].map((n) =>
                unmappedRow(`cap-${i}-${n}`, `cap-${String(i).padStart(2, "0")}`, {
                  updated_at: sql`now() - ${`${i + 1} hours`}::interval`,
                }),
              ),
            ).flat(),
          );
          capped = await readLedgerHealth(sp);
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      const afterCap = await readLedgerHealth(tx);
      check(
        "M8 over the cap (11 more combos of 2 rows, changed 1–11h ago, in a savepoint): the 10 MOST RECENTLY CHANGED are listed — the 1-row rejected combo and the 4-row trash combo ahead of the bigger but older cap-* ones, whose oldest three drop out — while the combo count and row total still cover all 13 combos / 27 rows; the savepoint rolled back",
        LEDGER_MAX_COMBOS === 10 &&
          JSON.stringify(capped?.unmapped_combos.map((c) => c.keitaro_type)) ===
            JSON.stringify(["rejected", "trash", ...Array.from({ length: 8 }, (_, i) => `cap-0${i}`)]) &&
          capped?.unmapped_combo_count === 13 &&
          capped.unmapped_total === 27 &&
          afterCap.unmapped_combo_count === 2 &&
          afterCap.unmapped_total === 5,
        JSON.stringify({
          count: capped?.unmapped_combo_count,
          total: capped?.unmapped_total,
          listed: capped?.unmapped_combos.map((c) => `${c.keitaro_type}:${c.total}`),
        }),
      );

      const okRun: IngestResult = {
        ok: true,
        dryRun: false,
        range: { from: "2026-09-11 00:00:00", to: "2026-09-17 10:05:00", timezone: "America/New_York" },
        fetched: 4,
        invalid: 0,
        invalidSamples: [],
        unresolved: 0,
        unresolvedSamples: [],
        rows: 4,
        unmappedInBatch: 0,
        statusOnlyInBatch: 0,
        inserted: 0,
        updated: 0,
        unchanged: 4,
        typeConflicts: 0,
        orgMismatch: 0,
        orgMismatchSamples: [],
        error: null,
      };
      const failedRun: IngestResult = {
        ...okRun,
        ok: false,
        fetched: 0,
        rows: 0,
        unchanged: 0,
        error: "Keitaro conversions/log truncated: 1000 of 1200 rows",
      };
      const invalidRun: IngestResult = {
        ...okRun,
        invalid: 2,
        invalidSamples: [
          "event_id=∅ conversion_type=Lead datetime=2026-09-17 09:00:00 revenue=0",
          "event_id=bad conversion_type=∅ datetime=2026-09-17 09:00:00 revenue=0",
        ],
      };
      const ok: IngestOutcome = { kind: "result", result: okRun };
      const refused: IngestOutcome = { kind: "result", result: failedRun };
      const invalid: IngestOutcome = { kind: "result", result: invalidRun };
      const threw: IngestOutcome = { kind: "threw", range: okRun.range, error: "connect ECONNREFUSED 10.0.0.1:6543" };
      const tick = (outcome: IngestOutcome = ok) => pagesDuring(() => evaluateConversionAlerts(tx, outcome, { send }));
      // The ingest heartbeat (last COMPLETE ingest) that the fetch_failed debounce reads.
      const setLastSuccess = (watermark: SQL) =>
        tx.execute(sql`
          INSERT INTO cron_locks (job_name, watermark)
          VALUES (${HEARTBEAT_JOBS.conversionEventsIngest.job_name}, ${watermark})
          ON CONFLICT (job_name) DO UPDATE SET watermark = excluded.watermark
        `);

      const keyTrash = `${UNM}k41:trash`;
      const keyRej = `${UNM}${offer.id}:rejected`;
      const keyRegPurchase = `${CONF}${offer.id}:registration>purchase`;
      const a1 = await tick();
      check(
        "A1 first tick → one page per problem combo, most recently changed first: rejected (the CamMan offer), trash (Keitaro offer 41), registration → purchase",
        a1.length === 3 &&
          a1[0].includes(`1 conversion(s) for ${offer.name} (offer ${offer.id}) with Keitaro type rejected`) &&
          a1[1].includes("4 conversion(s) for Keitaro offer 41 (no CamMan offer) with Keitaro type trash") &&
          a1[1].includes(id("trash-1")) &&
          a1[2].includes("locked registration → now purchase") &&
          a1[2].includes(id("old-r1")),
        JSON.stringify(a1),
      );
      const [aTrash, aRej, aConf, aFetch, aInv, aOrg, aCapU, aCapC, aLeft1, aLeft2] = await Promise.all(
        [
          keyTrash,
          keyRej,
          keyRegPurchase,
          K.fetchFailed,
          K.invalidRows,
          K.orgMismatch,
          CAP_UNM,
          CAP_CONF,
          ...leftovers,
        ].map((k) => alertRow(tx, k)),
      );
      check(
        "A2 alert_state: exactly the three combo keys firing under the prefixes, delivered and org-less; the five fixed keys (both cap keys included, the ledger being far under the cap) ok; the leftover in-prefix keys cleared without a page (as clearAlert leaves a row)",
        sameKeys(await firingKeys(tx), [keyTrash, keyRej, keyRegPurchase]) &&
          [aTrash, aRej, aConf].every((r) => r?.state === "firing" && r.notified && r.global) &&
          [aFetch, aInv, aOrg, aCapU, aCapC].every((r) => r?.state === "ok") &&
          [aLeft1, aLeft2].every((r) => r?.state === "ok" && r.notified && r.global),
        JSON.stringify({ firing: await firingKeys(tx), aTrash, aRej, aConf, aFetch, aInv, aOrg, aCapU, aCapC, aLeft1, aLeft2 }),
      );
      const a3 = await tick();
      check(
        "A3 next tick, nothing changed → no page, the same firing keys",
        a3.length === 0 && sameKeys(await firingKeys(tx), [keyTrash, keyRej, keyRegPurchase]),
        JSON.stringify(a3),
      );

      const keyLead = `${UNM}none:lead`;
      await insertRows([unmappedRow("lead-1", "lead")]);
      const s1a = await tick();
      check(
        "S1a (a) a row of a NEW combo (no offer, lead) → exactly one page, on unmapped:none:lead",
        s1a.length === 1 &&
          s1a[0].includes("1 conversion(s) for no offer with Keitaro type lead") &&
          (await alertRow(tx, keyLead))?.notified === true,
        JSON.stringify(s1a),
      );
      await insertRows([unmappedRow("lead-2", "lead")]);
      const s1b = await tick();
      const s1c = await tick();
      check(
        "S1b (a) another row of the SAME combo, then one more tick → no page on either (a stream doesn't flood); the key stays firing",
        s1b.length === 0 && s1c.length === 0 && (await alertRow(tx, keyLead))?.state === "firing",
        JSON.stringify([...s1b, ...s1c]),
      );

      const keyLeadK41 = `${UNM}k41:lead`;
      await insertRows([unmappedRow("lead-k41", "lead", { keitaro_offer_id: 41 })]);
      const s2 = await tick();
      check(
        "S2 (b) a row of another NEW combo (same type, Keitaro offer 41) → one more page, on unmapped:k41:lead",
        s2.length === 1 &&
          s2[0].includes("1 conversion(s) for Keitaro offer 41 (no CamMan offer) with Keitaro type lead") &&
          (await alertRow(tx, keyLeadK41))?.state === "firing",
        JSON.stringify(s2),
      );

      const keyChargeback = `${UNM}${offer.id}:chargeback`;
      await unmapOnUpdate(["old-mapped"], "chargeback");
      const s3 = await tick();
      check(
        "S3 (c) an EXISTING mapped row (lowest id, created 10 days ago) turned unmapped by UPDATE — its Keitaro type changed to an unmapped one → pages for its new combo",
        s3.length === 1 &&
          s3[0].includes(`1 conversion(s) for ${offer.name} (offer ${offer.id}) with Keitaro type chargeback`) &&
          s3[0].includes("(0 created in the last 24h)") &&
          s3[0].includes(id("old-mapped")) &&
          (await alertRow(tx, keyChargeback))?.state === "firing" &&
          rowId("old-mapped") < rowId("trash-1"),
        JSON.stringify(s3),
      );

      const keyPurchaseReg = `${CONF}${offer.id}:purchase>registration`;
      await conflictOnUpdate(["old-p1"], "lead", registration);
      const s4a = await tick();
      check(
        "S4a (d) a type conflict set on an EXISTING row by UPDATE (conflicting_event_type_id + event_type_conflict_at = now(), as ingest writes it) → pages for its combo",
        s4a.length === 1 &&
          s4a[0].includes(`1 conversion(s) for ${offer.name} (offer ${offer.id}) changed Keitaro type`) &&
          s4a[0].includes("locked purchase → now registration") &&
          s4a[0].includes(id("old-p1")) &&
          (await alertRow(tx, keyPurchaseReg))?.state === "firing",
        JSON.stringify(s4a),
      );
      await conflictOnUpdate(["old-p2"], "lead", registration);
      const s4b = await tick();
      const s4bCombo = (await readLedgerHealth(tx)).conflict_combos.find((c) => c.locked_event_key === "purchase");
      check(
        "S4b (d) a second conflict of the SAME combo on another existing row → no page; the key stays firing and the combo now counts 2",
        s4b.length === 0 && (await alertRow(tx, keyPurchaseReg))?.state === "firing" && s4bCombo?.total === 2,
        JSON.stringify({ s4b, s4bCombo }),
      );

      await heal(["lead-1", "lead-2", "old-p1", "old-p2"]);
      const s5a = await tick();
      const [clearedLead, clearedConflict] = [await alertRow(tx, keyLead), await alertRow(tx, keyPurchaseReg)];
      check(
        "S5a (e) combos resolved (the lead rows healed, the purchase → registration conflicts cleared) → their keys cleared as clearAlert leaves a row (delivered stamp kept, org-less), no page; the other combos stay firing",
        s5a.length === 0 &&
          clearedLead?.state === "ok" &&
          clearedLead.notified &&
          clearedLead.global &&
          clearedConflict?.state === "ok" &&
          sameKeys(await firingKeys(tx), [keyTrash, keyRej, keyRegPurchase, keyLeadK41, keyChargeback]),
        JSON.stringify({ s5a, firing: await firingKeys(tx), clearedLead, clearedConflict }),
      );
      await unmapOnUpdate(["lead-2"], "lead");
      await conflictOnUpdate(["old-p1"], "lead", registration);
      const s5b = await tick();
      check(
        "S5b (e) the same two combos reappear → each pages again (re-armed), on the same keys",
        s5b.length === 2 &&
          s5b.some((t) => t.includes("for no offer with Keitaro type lead")) &&
          s5b.some((t) => t.includes("locked purchase → now registration")) &&
          (await alertRow(tx, keyLead))?.state === "firing" &&
          (await alertRow(tx, keyPurchaseReg))?.state === "firing",
        JSON.stringify(s5b),
      );

      await tx
        .update(conversion_events)
        .set(healSet)
        .where(like(conversion_events.keitaro_event_id, `${RUN}-%`));
      const s6 = await tick();
      const decoyRows = await Promise.all(decoys.map((k) => alertRow(tx, k)));
      check(
        "S6 every problem row healed → every key under both prefixes cleared, no page; (g) the firing decoy keys outside the prefixes are untouched",
        s6.length === 0 &&
          (await firingKeys(tx)).length === 0 &&
          decoyRows.every((r) => r?.state === "firing"),
        JSON.stringify({ s6, firing: await firingKeys(tx), decoyRows }),
      );

      // The cap (LEDGER_MAX_COMBOS per kind): ten unmapped combos of 2 rows each,
      // last changed 1–10 hours ago, then a brand-new combo of ONE row.
      const tenType = (i: number) => `ten-${String(i).padStart(2, "0")}`;
      const tenNames = Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) => [`${tenType(i)}-1`, `${tenType(i)}-2`]).flat();
      const tenKeys = Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) => `${UNM}none:${tenType(i)}`);
      await insertRows(
        Array.from({ length: LEDGER_MAX_COMBOS }, (_, i) =>
          [1, 2].map((n) =>
            unmappedRow(`${tenType(i)}-${n}`, tenType(i), { updated_at: sql`now() - ${`${i + 1} hours`}::interval` }),
          ),
        ).flat(),
      );
      const p1 = await tick();
      check(
        "P1 ten unmapped combos (2 rows each) → one page each; AT the cap, not past it, so the combo_cap_exceeded key stays ok and no cap page is sent",
        p1.length === LEDGER_MAX_COMBOS &&
          sameKeys(await firingKeys(tx), tenKeys) &&
          (await alertRow(tx, CAP_UNM))?.state === "ok" &&
          !p1.some((t) => t.includes("unmapped combos exist")),
        JSON.stringify({ pages: p1.length, firing: await firingKeys(tx) }),
      );
      const keyEleventh = `${UNM}none:eleventh`;
      await insertRows([unmappedRow("eleventh", "eleventh")]);
      const p2 = await tick();
      check(
        "P2a a NEW 11th combo of one row, against ten bigger ones already firing → it is listed and pages exactly once, because the listing ranks by recency, not by size; none of the ten re-pages",
        p2.filter((t) => t.includes("with Keitaro type eleventh")).length === 1 &&
          (await alertRow(tx, keyEleventh))?.state === "firing" &&
          p2.filter((t) => /with Keitaro type ten-/.test(t)).length === 0,
        JSON.stringify(p2),
      );
      const capRow = await alertRow(tx, CAP_UNM);
      check(
        "P2b crossing the cap → exactly one more page, on the fixed combo_cap_exceeded key (11 combos, cap 10), delivered; and the least recently changed combo, now unlisted, is NOT cleared",
        p2.length === 2 &&
          p2.filter((t) => t.includes("11 unmapped combos exist, more than the 10")).length === 1 &&
          capRow?.state === "firing" &&
          capRow.notified &&
          capRow.global &&
          (await alertRow(tx, tenKeys[LEDGER_MAX_COMBOS - 1]))?.state === "firing",
        JSON.stringify({ p2, capRow }),
      );
      const p3 = await tick();
      check(
        "P3 still past the cap, nothing changed → no page (the cap key is latched like any other)",
        p3.length === 0 && (await alertRow(tx, CAP_UNM))?.state === "firing",
        JSON.stringify(p3),
      );
      await heal([`${tenType(LEDGER_MAX_COMBOS - 1)}-1`, `${tenType(LEDGER_MAX_COMBOS - 1)}-2`]);
      const p4 = await tick();
      check(
        "P4 back to ten combos (at the cap) → the cap key clears without a page, and combo clears resume: the healed combo's key goes ok while the other ten stay firing",
        p4.length === 0 &&
          (await alertRow(tx, CAP_UNM))?.state === "ok" &&
          (await alertRow(tx, tenKeys[LEDGER_MAX_COMBOS - 1]))?.state === "ok" &&
          sameKeys(await firingKeys(tx), [...tenKeys.slice(0, LEDGER_MAX_COMBOS - 1), keyEleventh]),
        JSON.stringify({ p4, firing: await firingKeys(tx) }),
      );
      await heal([...tenNames, "eleventh"]);
      const p5 = await tick();
      check(
        "P5 every cap-scenario row healed → no page, and nothing firing under either prefix (the fixed-key checks below start clean)",
        p5.length === 0 && (await firingKeys(tx)).length === 0,
        JSON.stringify({ p5, firing: await firingKeys(tx) }),
      );

      // fetch_failed: debounced on the last COMPLETE ingest (the heartbeat), and
      // a throw is a failed tick exactly like a refused window.
      await setLastSuccess(sql`now() - interval '5 minutes'`);
      const a6 = await tick(refused);
      check(
        "A6 refused window, last complete ingest 5 min ago → debounced: no page, fetch_failed untouched (ok)",
        a6.length === 0 && (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(a6),
      );
      await setLastSuccess(sql`now() - interval '20 minutes'`);
      const a7 = await tick(refused);
      check(
        "A7 refused window, last complete ingest 20 min ago → fetch_failed pages with the error",
        a7.length === 1 && a7[0].includes("truncated: 1000 of 1200 rows"),
        JSON.stringify(a7),
      );
      const a8 = await tick(refused);
      check("A8 still refused and stale → no second page (latched)", a8.length === 0, JSON.stringify(a8));

      // (f) A failed tick must still re-read the ledger (design decision 3).
      const keyUpsell = `${UNM}${offer.id}:upsell`;
      await insertRows([unmappedRow("upsell", "upsell", { offer_id: offer.id })]);
      const a8b = await tick(refused);
      check(
        "A8b (f) a refused tick still re-reads the ledger: a row of a new combo → that tick pages it on unmapped:<offer>:upsell, and fetch_failed stays firing without a second page",
        a8b.length === 1 &&
          a8b[0].includes(`for ${offer.name} (offer ${offer.id}) with Keitaro type upsell`) &&
          (await alertRow(tx, keyUpsell))?.state === "firing" &&
          (await alertRow(tx, K.fetchFailed))?.state === "firing",
        JSON.stringify(a8b),
      );

      await setLastSuccess(sql`now() - interval '5 minutes'`);
      const a9 = await tick(refused);
      check(
        "A9 a debounced failure never clears: fresh heartbeat + refused → no page, fetch_failed still firing",
        a9.length === 0 && (await alertRow(tx, K.fetchFailed))?.state === "firing",
        JSON.stringify(a9),
      );
      const a10 = await tick();
      check(
        "A10 complete window → fetch_failed cleared, no page",
        a10.length === 0 && (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(a10),
      );
      await setLastSuccess(sql`NULL::timestamptz`);
      const a11 = await tick(threw);
      check(
        "A11 an ingest that THREW, no complete ingest ever recorded → fetch_failed pages again with the thrown message",
        a11.length === 1 && a11[0].includes("connect ECONNREFUSED 10.0.0.1:6543") && a11[0].includes("never recorded"),
        JSON.stringify(a11),
      );

      const a12 = await tick(invalid);
      check(
        "A12 unparseable rows → invalid_rows pages with the count and a sample (and the complete window clears fetch_failed silently)",
        a12.length === 1 &&
          a12[0].includes("2 Keitaro conversion row(s)") &&
          a12[0].includes("event_id=bad") &&
          (await alertRow(tx, K.fetchFailed))?.state === "ok",
        JSON.stringify(a12),
      );
      const a13 = await tick(invalid);
      check("A13 still unparseable → no second page", a13.length === 0, JSON.stringify(a13));
      const a14 = await tick();
      check(
        "A14 clean complete window → invalid_rows cleared, no page",
        a14.length === 0 && (await alertRow(tx, K.invalidRows))?.state === "ok",
        JSON.stringify(a14),
      );

      await setLastSuccess(sql`now() - interval '3 hours'`);
      let stale: Awaited<ReturnType<typeof watchIngestHeartbeat>> | undefined;
      const b1 = await pagesDuring(async () => {
        stale = await watchIngestHeartbeat(tx, { send });
      });
      check(
        "B1 stale ingest heartbeat → one page naming the job",
        stale?.stale === true && b1.length === 1 && b1[0].includes("Conversion events ingest (Keitaro poll tick)"),
        JSON.stringify({ stale, b1 }),
      );
      const b2 = await pagesDuring(() => watchIngestHeartbeat(tx, { send }));
      check("B2 still stale → no second page", b2.length === 0, JSON.stringify(b2));
      await recordHeartbeat(tx, HEARTBEAT_JOBS.conversionEventsIngest.job_name);
      let fresh: Awaited<ReturnType<typeof watchIngestHeartbeat>> | undefined;
      const b3 = await pagesDuring(async () => {
        fresh = await watchIngestHeartbeat(tx, { send });
      });
      check(
        "B3 fresh heartbeat → cleared, no page",
        fresh?.stale === false && b3.length === 0 && (await alertRow(tx, INGEST_HEARTBEAT_ALERT_KEY))?.state === "ok",
        JSON.stringify(fresh),
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const [left] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM conversion_events WHERE keitaro_event_id LIKE ${`${RUN}%`}`,
  )) as unknown as { n: number }[];
  const after = await readLedgerHealth(db);
  check(
    "Z1 rolled back — no test rows left, pre-existing unmapped/conflict row and combo counts unchanged",
    left.n === 0 &&
      after.unmapped_total === preexisting.unmapped_total &&
      after.conflict_total === preexisting.conflict_total &&
      after.unmapped_combo_count === preexisting.unmapped_combo_count &&
      after.conflict_combo_count === preexisting.conflict_combo_count,
    JSON.stringify({
      left: left.n,
      before: [preexisting.unmapped_total, preexisting.conflict_total],
      after: [after.unmapped_total, after.conflict_total],
    }),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-monitor-db.ts`
Expected: `Target DB: camman-v2 (preview)`, then the run aborts with a `TypeError` saying `readLedgerHealth` is not a function, exit 1. The test calls it for the pre-existing counts before M0.

- [ ] **Step 3: Register the heartbeat job**

In `lib/reporting/cron-heartbeat.ts`, replace

```ts
  trackingMonitors: {
    job_name: "tracking-monitors",
    max_age_hours: 3, // hourly cadence, ~2 missed runs
    label: "Keitaro tracking-gap monitor (hourly)",
  },
```

with

```ts
  trackingMonitors: {
    job_name: "tracking-monitors",
    max_age_hours: 3, // hourly cadence, ~2 missed runs
    label: "Keitaro tracking-gap monitor (hourly)",
  },
  // The conversion_events ledger ingest (Phase 2), which rides the */5 Keitaro
  // poll tick (app/api/keitaro/poll/route.ts). Stamped LAST, and only after a
  // COMPLETE window was ingested and the ledger alerts were evaluated. Watched
  // by /api/cron/tracking-monitors via watchIngestHeartbeat
  // (lib/conversions/monitor.ts) — never by the poll itself. 1h is ~12 missed
  // ticks.
  conversionEventsIngest: {
    job_name: "conversion-events-ingest",
    max_age_hours: 1,
    label: "Conversion events ingest (Keitaro poll tick)",
  },
```

- [ ] **Step 4: Add the DB section to `lib/conversions/monitor.ts`**

Replace the three `@/` import lines

```ts
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import type { IngestResult } from "@/lib/conversions/ingest";
import type { KeitaroReportRange } from "@/lib/keitaro/client";
```

with

```ts
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import type { IngestResult } from "@/lib/conversions/ingest";
import type { KeitaroReportRange } from "@/lib/keitaro/client";
import {
  HEARTBEAT_JOBS,
  checkHeartbeats,
  heartbeatBreaches,
  type DbOrTx,
  type HeartbeatStatus,
} from "@/lib/reporting/cron-heartbeat";
```

and append at the end of the file:

```ts

// ── DB: ledger health, alert application, ingest heartbeat ──────────────────

type Send = (text: string) => Promise<boolean>;

type ComboTotals = { combo_count: number; row_total: number };

// Whole ledger, all orgs (the alerts are global). Two small reads per cron tick.
export async function readLedgerHealth(dbc: DbOrTx): Promise<LedgerHealth> {
  const unmapped = (await dbc.execute(UNMAPPED_COMBOS_SQL)) as unknown as (UnmappedCombo & ComboTotals)[];
  const conflicts = (await dbc.execute(CONFLICT_COMBOS_SQL)) as unknown as (ConflictCombo & ComboTotals)[];
  return {
    unmapped_total: unmapped[0]?.row_total ?? 0,
    unmapped_combo_count: unmapped[0]?.combo_count ?? 0,
    unmapped_combos: unmapped.map((r) => ({
      offer_id: r.offer_id,
      keitaro_offer_id: r.keitaro_offer_id,
      offer_name: r.offer_name,
      keitaro_type: r.keitaro_type,
      total: r.total,
      last_24h: r.last_24h,
      sample_event_ids: r.sample_event_ids,
    })),
    conflict_total: conflicts[0]?.row_total ?? 0,
    conflict_combo_count: conflicts[0]?.combo_count ?? 0,
    conflict_combos: conflicts.map((r) => ({
      offer_id: r.offer_id,
      keitaro_offer_id: r.keitaro_offer_id,
      offer_name: r.offer_name,
      locked_event_key: r.locked_event_key,
      conflicting_event_key: r.conflicting_event_key,
      total: r.total,
      last_24h: r.last_24h,
      since: r.since,
      sample_event_ids: r.sample_event_ids,
    })),
  };
}

// The keys currently firing under the two combo prefixes. starts_with needs no
// escaping (both prefixes contain "_", a LIKE wildcard).
async function readFiringLedgerKeys(dbc: DbOrTx): Promise<string[]> {
  const P = CONVERSION_ALERT_KEY_PREFIXES;
  const rows = (await dbc.execute(sql`
    SELECT alert_key FROM alert_state
    WHERE state = 'firing'
      AND (starts_with(alert_key, ${P.unmapped}::text) OR starts_with(alert_key, ${P.typeConflicts}::text))
  `)) as unknown as { alert_key: string }[];
  return rows.map((r) => r.alert_key);
}

async function applyDecisions(
  dbc: DbOrTx,
  decisions: readonly ConversionAlertDecision[],
  send: Send | undefined,
): Promise<void> {
  for (const d of decisions) {
    // Both helpers are best-effort and never throw; org-less because the
    // conversion alerts are global.
    if (d.state === "firing") {
      await notifyOnTransition(dbc, { alertKey: d.alertKey, text: d.text, send });
    } else {
      await clearAlert(dbc, { alertKey: d.alertKey });
    }
  }
}

// Minutes since the last COMPLETE ingest (the conversion-events-ingest
// heartbeat), or null when none was ever recorded. Read through checkHeartbeats,
// which rounds the age to 0.1h, so the debounce resolves in 6-minute steps: a
// last success under 15 min old reads as ≤ 12, one 15 min or older as ≥ 18.
async function readLastSuccessAgeMinutes(dbc: DbOrTx): Promise<number | null> {
  const [status] = await checkHeartbeats(dbc, [HEARTBEAT_JOBS.conversionEventsIngest]);
  return status.age_hours === null ? null : status.age_hours * 60;
}

// Cron path of /api/keitaro/poll, right after the ingest — including an ingest
// that THREW (the route passes { kind: "threw" }). The ledger alerts are
// evaluated on EVERY tick, failed ones included: they read the table, not the
// batch. `send` is injectable only for the DB test.
//
// Failure contract — the READS are not best-effort and propagate; the caller
// must catch (the poll route reports `monitor: …` and does not stamp the
// heartbeat). The alert writes are best-effort and never throw.
//   - Heartbeat-age read (failed ticks only, for the fetch_failed debounce): it
//     runs before any decision, so if it throws NOTHING pages and the ledger
//     alerts are skipped for that tick.
//   - The ingest decisions are applied next, so a failed tick past the debounce
//     still pages even if the ledger combo or firing-key read then throws; only
//     the ledger alerts are skipped for that tick.
export async function evaluateConversionAlerts(
  dbc: DbOrTx,
  outcome: IngestOutcome,
  opts: { send?: Send } = {},
): Promise<{
  health: LedgerHealth;
  ingestDecisions: ConversionAlertDecision[];
  ledgerDecisions: ConversionAlertDecision[];
}> {
  const lastSuccessAgeMinutes = ingestFailed(outcome) ? await readLastSuccessAgeMinutes(dbc) : null;
  const ingestDecisions = decideIngestAlerts(outcome, lastSuccessAgeMinutes);
  await applyDecisions(dbc, ingestDecisions, opts.send);
  const health = await readLedgerHealth(dbc);
  const ledgerDecisions = decideLedgerAlerts(health, await readFiringLedgerKeys(dbc));
  await applyDecisions(dbc, ledgerDecisions, opts.send);
  return { health, ingestDecisions, ledgerDecisions };
}

// Dead-man for the ingest, called by /api/cron/tracking-monitors (hourly) — a
// job that is dead cannot report itself dead, so the poll never calls this.
// A NULL watermark (never ran) counts as stale, as everywhere else.
export async function watchIngestHeartbeat(
  dbc: DbOrTx,
  opts: { send?: Send } = {},
): Promise<HeartbeatStatus> {
  const [status] = await checkHeartbeats(dbc, [HEARTBEAT_JOBS.conversionEventsIngest]);
  const [breach] = heartbeatBreaches([status]);
  if (breach !== undefined) {
    await notifyOnTransition(dbc, {
      alertKey: INGEST_HEARTBEAT_ALERT_KEY,
      text: formatIngestHeartbeatAlert(breach),
      send: opts.send,
    });
  } else {
    await clearAlert(dbc, { alertKey: INGEST_HEARTBEAT_ALERT_KEY });
  }
  return status;
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: exit 0, no output.

- [ ] **Step 6: Run the DB test on camman-v2, then the pure test again**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-monitor-db.ts`
Expected: `Target DB: camman-v2 (preview)`, then `43 passed, 0 failed`, exit 0. The historical commits recorded 27 (2b2a0da), 33 (dbfba2c, fix wave 1) and 36 (c754f89, fix wave 2).

Run: `npx tsx scripts/test-conversion-monitor.ts`
Expected: `39 passed, 0 failed`.

Failure guide. Fix the cause; never loosen a check.
- **M0b fails:** the in-transaction neutralisation left problem rows. For example, the first org has no `purchase` event type to map them to. Read the printed health; don't delete rows.
- **M6/M7 fail:** paste the statement into `EXPLAIN` by hand on camman-v2 and read the plan. The WHERE must match the index predicate from migration 0181 textually.
- **M8 fails:** the `LIMIT` moved before the window aggregates (a subquery), so `combo_count` / `row_total` only cover the listed combos — or the `ORDER BY` no longer starts with `max(ce.updated_at) DESC`, so the listing is by size again (P2a then fails too).
- **A3/S1b/S4b/A8/A13/B2 send:** the key is not stable (it must be built from the combo only, never from counts or samples), or `notifyOnTransition` is bypassed.
- **A2/S5a/S6 keys stay firing, or S5b sends nothing:** stale keys are not cleared. A firing key under a prefix whose combo is absent must get `clearAlert`, unless that kind is past the cap.
- **M1b fails:** the unmapped predicate was narrowed (e.g. to `status IS NULL`), so a row ingest inserted through a status-only rule — `event_type_id` NULL with a `status` — is no longer read as unmapped. Restore `ce.event_type_id IS NULL OR ce.status IS NULL`, textually as migration 0181's index predicate.
- **P2a sends nothing:** the combo listing is ranked by size again, so the new 1-row combo falls past the cap. It must be `ORDER BY max(ce.updated_at) DESC` first.
- **P2b sends nothing or twice, or P3/P4 page:** the `combo_cap_exceeded` decision isn't going through `notifyOnTransition` / `clearAlert`, or the cap key was given a name under a combo prefix, so the stale-combo clear flaps it.
- **S3 or S4a sends nothing:** the alert keys moved back to something an UPDATE of an existing row doesn't change, such as the newest row id.
- **S6 decoys cleared:** the firing-key read matches keys outside the prefixes. Use `starts_with`, not an unescaped `LIKE`.
- **A8b sends nothing:** failed ticks no longer read the ledger (decision 3).
- **A6 or A9 page, or A7/A11 don't:** the debounce isn't reading the `conversion-events-ingest` watermark, or it compares in hours instead of minutes. Log `readLastSuccessAgeMinutes`; it should be ~6 at 5 min, ~18 at 20 min, and null for a NULL watermark.
- **B1 throws on `job_name`:** Step 3's registry entry is missing. `HEARTBEAT_JOBS` is a `Record<string, …>`, so tsc cannot catch that.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint lib/conversions/monitor.ts lib/reporting/cron-heartbeat.ts scripts/test-conversion-monitor-db.ts
git add lib/conversions/monitor.ts lib/reporting/cron-heartbeat.ts scripts/test-conversion-monitor-db.ts
git commit -m "feat(conversions): ledger health read, latched Tier-2 alerts, ingest heartbeat watch

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the poll tick and the heartbeat watcher

> **cd4fa85 (2026-09-17) changed `maxDuration` on `app/api/keitaro/poll/route.ts` after this task's block was written** — `230` (below the 240s `CRON_LEASE_MS` cron lease), not the `300` the block below originally shipped; the block has been updated to match the committed file.

**Files:**
- Modify: `app/api/keitaro/poll/route.ts` (whole file below)
- Modify: `app/api/cron/tracking-monitors/route.ts` (whole file below)

**Interfaces:**
- Consumes:
  - `ingestKeitaroConversions`, `type IngestResult` (Phase 1)
  - `liveIngestRange` (Task 1)
  - `type IngestOutcome` (Task 1)
  - `evaluateConversionAlerts`, `watchIngestHeartbeat` (Task 2)
  - `HEARTBEAT_JOBS.conversionEventsIngest`, `recordHeartbeat`
- Produces: the `/api/keitaro/poll` response gains `conversion_events: IngestResult | null` and `conversion_events_error: string | null`. Every existing field is unchanged.

- [ ] **Step 1: Replace `app/api/keitaro/poll/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { ingestKeitaroConversions, type IngestResult } from "@/lib/conversions/ingest";
import { liveIngestRange } from "@/lib/conversions/keitaro-row";
import { evaluateConversionAlerts, type IngestOutcome } from "@/lib/conversions/monitor";
import { withCronLease } from "@/lib/cron/lease";
import { pollKeitaro } from "@/lib/keitaro/poll";
import { can } from "@/lib/permissions";
import { refreshCountedClickers } from "@/lib/reporting/counted-clickers";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Keitaro 5-minute poll. Vercel Cron hits this on a schedule (see vercel.json)
// with `Authorization: Bearer <CRON_SECRET>`. Also callable manually by an
// operator+ (e.g. to verify the live connection or force a refresh) — the
// manual path resolves the caller's org only for the permission check; the
// poll itself maps results to orgs by sub_id_3 either way.
//
// ?windowDays=N overrides the rolling lookback window (default 3) of the
// aggregate poll only. Each tick also keeps the conversion_events ledger live
// over its own 7-day window — see ingestConversionLedger below.
export const dynamic = "force-dynamic";
// Must die before the cron lease (CRON_LEASE_MS, lib/cron/lease.ts) expires at
// 240s, or two ticks could overlap. Typical runs are low single-digit seconds;
// if a tick is killed at 230s, the ledger ingest's transaction rolls back and
// retries on the next tick.
export const maxDuration = 230;
// Pin to Frankfurt (eu-central-1), co-located with Supabase, so this job's DB
// round-trips don't cross the Atlantic (~90ms each). Per-route only — do NOT set
// a global region; US-facing routes such as the /r/[code] redirect stay in the US.
export const preferredRegion = "fra1";


// Conversion events ledger (Phase 2 — docs/04-features/conversion-events.md).
// Rides this tick AFTER the aggregate poll and the clicker refresh and is fully
// isolated from both: its own Keitaro fetch (the last 7 ET days, independent of
// ?windowDays), its own transaction, its own try/catch. It writes ONLY
// conversion_events — keitaro_stage_results and stage_sends are untouched — and
// a failure here never changes the poll's result.
//
// Alerts and the heartbeat are CRON-ONLY: a manual refresh still ingests but
// never pages and never vouches for the scheduled job's liveness. A THROWN
// ingest is a failed tick for alerting exactly like a refused window: it feeds
// the same debounced fetch_failed decision, with the thrown message as the
// error text. The unmapped and type_conflicts ledger alerts are evaluated on
// every cron tick, failed ones included (they read the table), and are keyed
// per problem combo (lib/conversions/monitor.ts): each new combo pages once,
// repeats never re-page, and a combo that disappears is cleared — unless its
// kind is past the LEDGER_MAX_COMBOS cap, where that kind's fixed
// combo_cap_exceeded key pages instead and no combo key of it clears. The heartbeat
// is stamped LAST and only for a complete (ok) window, so a tick that was
// refused, threw, or whose alert evaluation threw leaves it stale for
// /api/cron/tracking-monitors to notice.
async function ingestConversionLedger(
  isCron: boolean,
): Promise<{ result: IngestResult | null; error: string | null }> {
  const range = liveIngestRange(new Date());
  let outcome: IngestOutcome;
  try {
    outcome = { kind: "result", result: await ingestKeitaroConversions(db, { range }) };
  } catch (err) {
    console.error("[keitaro/poll] conversion ledger ingest failed", err);
    outcome = { kind: "threw", range, error: err instanceof Error ? err.message : String(err) };
  }
  const result = outcome.kind === "result" ? outcome.result : null;
  const ingestError = outcome.kind === "threw" ? outcome.error : null;
  if (!isCron) return { result, error: ingestError };
  try {
    await evaluateConversionAlerts(db, outcome);
    if (result?.ok) {
      await recordHeartbeat(db, HEARTBEAT_JOBS.conversionEventsIngest.job_name);
    }
  } catch (err) {
    console.error("[keitaro/poll] conversion ledger monitor failed", err);
    const monitorError = `monitor: ${err instanceof Error ? err.message : String(err)}`;
    return { result, error: ingestError ? `${ingestError}; ${monitorError}` : monitorError };
  }
  return { result, error: ingestError };
}

// EPC's denominator must advance on the SAME tick as its numerator. Revenue
// lands here every 5 minutes; if counted clickers refreshed independently, EPC
// would drift between rebuilds and snap back at each one — an artifact that
// reads exactly like a real trend on the platform's primary metric. So the
// incremental pass rides this poll. It is additive and stateless (6h lookback,
// no cursor), so a failure here can never strand data; the daily full rebuild
// is the repair path. Never let a poll failure mask a refresh failure or vice
// versa — they are reported separately.
async function pollAndRefresh(windowDays: number | undefined, isCron: boolean) {
  const poll = await pollKeitaro(db, { windowDays });
  let clickers: unknown = null;
  let clickersError: string | null = null;
  try {
    clickers = await refreshCountedClickers(db, "incremental");
  } catch (err) {
    clickersError = err instanceof Error ? err.message : String(err);
    console.error("[keitaro/poll] counted-clicker refresh failed", err);
  }
  const ledger = await ingestConversionLedger(isCron);
  return {
    ...poll,
    counted_clickers: clickers,
    counted_clickers_error: clickersError,
    conversion_events: ledger.result,
    conversion_events_error: ledger.error,
  };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    // Triggering a results sync is an import-shaped action (operator+).
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const windowRaw = Number(req.nextUrl.searchParams.get("windowDays"));
  const windowDays =
    Number.isFinite(windowRaw) && windowRaw > 0
      ? Math.min(30, Math.floor(windowRaw))
      : undefined;

  // Scheduled (cron) runs are single-runner: a prior tick whose SQL is still
  // draining server-side after a timeout-kill must not get piled on. Manual
  // operator runs bypass the lease (they must not silently no-op).
  if (bearerMatches) {
    const leased = await withCronLease("keitaro-poll", () =>
      pollAndRefresh(windowDays, true),
    );
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true,
        reason: "prior_run_in_progress",
        skippedCount: leased.skippedCount,
      });
    }
    return NextResponse.json(leased.result);
  }

  const result = await pollAndRefresh(windowDays, false);

  // A degraded run (fetch failed) returns 200 with degraded:true so the cron
  // doesn't flap red on a transient Keitaro hiccup — it logs and retries next
  // cycle. The body surfaces everything needed to debug (incl. unmatched
  // sub_id_3 samples when nothing maps back to a CamMan stage).
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
```

- [ ] **Step 2: Replace `app/api/cron/tracking-monitors/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { requireApiMembership } from "@/lib/api/helpers";
import { watchIngestHeartbeat } from "@/lib/conversions/monitor";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  formatTrackingGapAlert,
  runTrackingGapMonitor,
  trackingGapAlertKey,
} from "@/lib/reporting/tracking-gap";

// Keitaro tracking-gap monitor.
//
// A landing page missing its Keitaro visit script produces NO other symptom:
// sends succeed, DLRs arrive, redirects may even keep landing, and the Overview
// tab renders "Clickers 0" as though nobody clicked. This job is the only thing
// that notices.
//
// Breach-only, latched per stage: a periodic all-clear trains people to ignore
// the channel, and an unlatched threshold check would page every hour for as
// long as the condition held. Auth mirrors /api/cron/tells-monitors.
// The alert key, message formatter, and the no-visits predicate live in
// lib/reporting/tracking-gap.ts rather than here — they're shared with
// app/api/keitaro/reports/route.ts and the verify scripts, so they belong in
// lib/, not duplicated into this route module.
//
// Also the dead-man for the conversion_events ledger ingest, which rides the */5
// Keitaro poll (app/api/keitaro/poll/route.ts) and so cannot watch itself — see
// watchIngestHeartbeat in lib/conversions/monitor.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  // Org scope for the human path only. The bearer/cron path stays cross-org
  // (undefined orgId) — it must watch every org. A signed-in session only
  // ever gets its own org's breach rows.
  let orgId: string | undefined;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId;
  }

  const report = await runTrackingGapMonitor(db, { orgId });

  // Only the scheduler notifies. A human hitting this route gets the findings in
  // the response body without spraying the channel.
  if (bearerMatches) {
    for (const b of report.breaches) {
      // notifyOnTransition is best-effort by contract and swallows its own
      // errors, so one bad stage cannot stop the rest from being evaluated.
      await notifyOnTransition(db, {
        alertKey: trackingGapAlertKey(b.stage_id),
        orgId: b.org_id,
        text: formatTrackingGapAlert(b),
      });
    }
    // Re-arm stages that recovered, so a stage that regresses after a fix can
    // alert again. Without this the latch is a one-shot for the life of the row.
    for (const { stage_id, org_id } of report.clean_stages) {
      await clearAlert(db, { alertKey: trackingGapAlertKey(stage_id), orgId: org_id });
    }
    // Conversion ledger ingest dead-man (HEARTBEAT_JOBS.conversionEventsIngest),
    // latched on a fixed key: a stale ingest pages once and re-arms when a
    // complete window is ingested again. Deliberately NOT try/caught — if its
    // read throws, the stamp below is skipped and tells-monitors reports THIS
    // job stale, instead of the watch silently stopping.
    await watchIngestHeartbeat(db);
    // Stamp AFTER the work, so a run that threw does not look healthy.
    await recordHeartbeat(db, HEARTBEAT_JOBS.trackingMonitors.job_name);
  }

  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
```

- [ ] **Step 3: Check that the diff is additive**

```bash
git diff --stat
git diff app/api/keitaro/poll/route.ts | grep '^-' | grep -v '^---'
git diff app/api/cron/tracking-monitors/route.ts | grep '^-' | grep -v '^---'
```

Expected: `git diff --stat` lists exactly the two route files. The removed lines are only:
- poll route: the old `// ?windowDays=N overrides the rolling lookback window (default 3).` comment line, the `async function pollAndRefresh(windowDays: number | undefined) {` signature, the old `return { ...poll, counted_clickers: clickers, counted_clickers_error: clickersError };`, and the two `pollAndRefresh(windowDays)` call lines
- tracking-monitors: nothing

A bare `-` (a blank line git realigned) is harmless. Any other removed line means existing behavior changed. Restore it.

- [ ] **Step 4: Type-check and lint**

Run: `npx tsc --noEmit -p .`
Expected: exit 0, no output.

Run: `npx eslint app/api/keitaro/poll/route.ts app/api/cron/tracking-monitors/route.ts`
Expected: no problems.

- [ ] **Step 5: Commit**

```bash
git add app/api/keitaro/poll/route.ts app/api/cron/tracking-monitors/route.ts
git commit -m "feat(conversions): keep the ledger live on the Keitaro poll tick; watch its heartbeat

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/04-features/conversion-events.md` (Phase 1 doc)
- Modify: `docs/04-features/keitaro-poll.md` (line 3; end of §3; §5 first bullet)
- Modify: `docs/04-features/crons.md` (line 3; §2 two rows; §3 `/api/keitaro/poll`; §4)
- Modify: `docs/05-flows.md` (line 3; flow G)
- Modify: `docs/CHANGELOG.md` (new first entry)
- Add: `docs/superpowers/plans/2026-09-17-conversion-events-phase2.md` (this plan)

`docs/03-data-model.md` and `06-integrations.md` don't change: there is no schema, env var or dependency change. `07-conventions.md` doesn't change either; no new rule was learned. The DST-safe window is documented in code and in the feature doc.

The anchors below quote the Phase 1 doc as its plan wrote it. If review changed a sentence, apply the same change under the same heading (`## Event-type conflicts`, `## How to add an event type or a mapping`, `## Not built yet`).

- [ ] **Step 1: `docs/04-features/conversion-events.md`**

Keep `_Last updated: 2026-09-17_` (or set it to today). Replace the status line

```markdown
**Status:** Phase 1 — ledger + backfill. **Nothing reads the ledger yet.** Revenue, EPC, the purchased tier, segment purchase rules, drip and reports still read `stage_sends.sale_*` and `keitaro_stage_results` until Phase 3.
```

with

```markdown
**Status:** Phase 2 — the ledger is kept live on the `*/5` Keitaro poll tick, with Tier-2 Telegram alerts. **Nothing reads the ledger yet.** Revenue, EPC, the purchased tier, segment purchase rules, drip and reports still read `stage_sends.sale_*` and `keitaro_stage_results` until Phase 3.
```

In `## Event-type conflicts`, replace the bullet

```markdown
- Phase 2 alerts on it
```

with

```markdown
- the live poll tick pages Telegram once per new problem combo (`conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`, see [Live ingest and alerts](#live-ingest-and-alerts-phase-2)). More conflicts of the same combo don't re-page, and the key clears once that combo has no conflicting rows left — unless more than 10 conflict combos exist, where no conflict combo key clears until the count is back to 10 or fewer
- after a row's conflicting type changes again (say `purchase` then `lead` against the same locked type), `event_type_conflict_at` is kept, so the new combo's page reports the ORIGINAL conflict time as its first seen — `COALESCE(conversion_events.event_type_conflict_at, now())` only fills a NULL
```

In `## How to add an event type or a mapping`, replace

```markdown
Rows stored before a rule existed are healed on the next ingest of their window (sticky `COALESCE` fills NULLs). Re-run the backfill to heal older windows.
```

with

```markdown
Rows stored before a rule existed are healed on the next ingest of their window (sticky `COALESCE` fills NULLs). The live poll tick re-ingests the last 7 ET days every 5 minutes, so recent rows heal on their own, and a combo's `conversion_events:unmapped:<offer>:<keitaro_type>` alert clears once none of its rows remain (while more than 10 unmapped combos exist, clears wait until the count is back to 10 or fewer). Re-run the backfill to heal older windows. A row first seen through a status-only rule (e.g. PsychoBook `rejected`) has a status but no event type, and no mapping can heal it. Set its event type by SQL after deciding which event it is.
```

Insert this section immediately before `## Not built yet`:

````markdown
## Live ingest and alerts (Phase 2)

**Where it runs.** `/api/keitaro/poll` (`*/5`), after `pollKeitaro` and the counted-clicker refresh ([app/api/keitaro/poll/route.ts](../../app/api/keitaro/poll/route.ts)):

1. `ingestKeitaroConversions(db, { range: liveIngestRange(now) })`. The window is the last **7 ET calendar days**: today minus 6 days at 00:00:00 through now ([lib/conversions/keitaro-row.ts](../../lib/conversions/keitaro-row.ts)).
   - Calendar arithmetic, so a DST week never shortens it.
   - Independent of `?windowDays`, which stays the aggregate poll's knob.
   - Keitaro filters by a conversion's *current* `datetime`, and a re-post moves that forward, so an in-place update of an older conversion comes back into the window.
2. Its own try/catch. A throw is reported as `conversion_events_error` and never fails the poll, its response or `keitaro_stage_results`. On the cron path the throw also counts as a failed tick for the debounced `fetch_failed` alert (below). The ledger step writes only `conversion_events`.
3. **Cron path only:** `evaluateConversionAlerts` ([lib/conversions/monitor.ts](../../lib/conversions/monitor.ts)). Then, last and only for a complete window (`ok:true`), `recordHeartbeat("conversion-events-ingest")`. The manual "Refresh from Keitaro" path ingests but never pages or stamps.

The poll response gains `conversion_events` (the `IngestResult`, or `null` when the ingest threw) and `conversion_events_error`. See [keitaro-poll.md §5](keitaro-poll.md).

**Alerts.** Tier-2, plain text, prefixed `🟠 Tier-2 conversions:`. Each is latched in `alert_state` through `notifyOnTransition` / `clearAlert`: a standing condition pages once, and the key re-arms after it clears. The alerts are cross-org, so `alert_state.org_id` is NULL.
- `fetch_failed`, `invalid_rows`, `org_mismatch`, the two `combo_cap_exceeded` keys and the heartbeat use **fixed** keys.
- `unmapped` and `type_conflicts` read the whole ledger, all-time, and use **one key per problem combo**.
  - A fixed key would stay firing on one old unfixed row and hide every later problem.
  - A key on the newest problem row's id would miss conflicts, which only arise when an existing row is updated. It would also miss existing rows that turn unmapped, and page on every tick for a stream of new unmapped rows.
- The combo keys:
  - `conversion_events:unmapped:<offer>:<keitaro_type>`
  - `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`
  - `<offer>` is the CamMan `offer_id`, else `k<keitaro_offer_id>`, else `none`.
  - Other parts are lowercased, with anything outside `[a-z0-9_-]` turned into `_` and clipped to 40 characters. When any of that changed the raw part, `~` plus the first 6 hex characters of its sha256 is appended, so two Keitaro types that sanitise alike (`First Deposit` and `first:deposit`) never share one alert. An already-clean part carries no suffix.
  - A combo key can MOVE when attribution fills in: a combo keyed `k41:trash` becomes `<offer>:trash` once `offers.keitaro_offer_id` is set on the CamMan offer and the next tick refreshes the rows. That is one extra page (the new key) and one clear (the old key), not a new problem.
- Each tick:
  - **A new problem combo pages once**, including one created by an UPDATE (a conflict, or an existing row turning unmapped). More rows of the same combo **don't re-page**, so a steady stream of one unmapped type sends one page.
  - **A combo that disappears is cleared** (its key goes to `ok`), unless its kind is past the cap (next bullet). If it comes back, it pages again.
  - At most **10 combos per kind** (`LEDGER_MAX_COMBOS`) are listed and paged, the **most recently changed first** (`max(updated_at)`, which the ingest moves on every insert and every real update). So a brand-new combo pages even when it is the smallest and 10 others are already firing.
  - Past the cap, every page of the kind says how many more combos exist, that kind's `conversion_events:combo_cap_exceeded:*` key pages once, and no **combo** key of that kind clears until the count is back to 10 or fewer.
  - See `CONVERSION_ALERT_KEY_PREFIXES` / `unmappedAlertKey` / `typeConflictAlertKey` / `decideLedgerAlerts` in [lib/conversions/monitor.ts](../../lib/conversions/monitor.ts).
- Each combo page names:
  - the offer and the Keitaro type (or the locked → conflicting event pair)
  - the combo's row count and how many were created in the last 24h (for a conflict, first seen in the last 24h), plus the first-seen time in ET for a conflict
  - up to 3 sample `keitaro_event_id`s, and the fix

| Key | Fires when | Clears when | What to do |
|---|---|---|---|
| `conversion_events:fetch_failed` | a **failed tick** — the window was refused (Keitaro HTTP error, timeout, a **malformed** 200 that isn't JSON with a `rows` array and a numeric `total` such as an HTML bot challenge, or a **truncated** page, `rows < total`) or the ingest **threw** (its message is the error text) — **and** the last complete ingest (the heartbeat) is older than `FETCH_FAILED_DEBOUNCE_MINUTES` (15) or was never recorded. A failed tick inside the 15 minutes does nothing: no fire, no clear. So one transient failure never pages; with `*/5` ticks the page lands on the 3rd–4th consecutive failure (the heartbeat age is read at 0.1h resolution). Nothing from a failed window is written | the next complete window | Repeated timeouts or 5xx: Keitaro or the network is down. Malformed: something other than the Keitaro API answered (bot challenge, proxy, error page). A truncation means 7 days of conversions no longer fit one Keitaro page, and the live window needs splitting (code change). A throw is also in `conversion_events_error` and the Vercel logs |
| `conversion_events:invalid_rows` | a complete window held rows `parseKeitaroLedgerRow` rejected. Those conversions are **not** in the ledger | a complete window with 0 invalid rows. A failed tick leaves it unchanged | Compare the samples with `KEITARO_LEDGER_COLUMNS` / `parseKeitaroLedgerRow` |
| `conversion_events:org_mismatch` | a complete window had `orgMismatch > 0`: existing ledger rows this run resolved to a **different org** than they were stored under. Those rows were **not written** (`org_id` is fixed at insert). The alert carries the count and up to 3 samples `event_id stored_org→resolved_org`. **No debounce**: this is a data-integrity signal | a complete window with `orgMismatch = 0`. A failed tick leaves it unchanged | Find which lookup now points into another org (stage tracking id, `stage_sends` id or `offers.keitaro_offer_id`) and fix that. Correct the ledger row by SQL only after deciding which org is right (approval required) |
| `conversion_events:unmapped:<offer>:<keitaro_type>` (one key per combo) | ledger rows, all-time, with `event_type_id` or `status` NULL (read via `conversion_events_unmapped_idx`), grouped by offer and Keitaro type. **Pages once per new problem combo**, whether the rows were inserted or an existing row turned unmapped (its Keitaro type changed, or its rule was archived). **Repeats don't re-page**: more rows of the same combo never send another page | **the combo disappears**: none of its rows is unmapped any more. If it reappears, it pages again. While more than 10 unmapped combos exist, no unmapped combo key clears (the `combo_cap_exceeded:unmapped` key is firing then) | Add the mapping for that offer or network and Keitaro type (see above). Rows inside the 7-day window heal on the next tick. Older rows need `scripts/backfill-conversion-events.ts --apply` (prod write, needs approval). A status-only row needs its event type set by SQL |
| `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>` (one key per combo) | rows with `conflicting_event_type_id` set (via `conversion_events_type_conflict_idx`), grouped by offer and locked → conflicting event type. A conflict only arises when an existing row is updated. **Pages once per new problem combo**; **repeats don't re-page**: another conflict of the same combo sends nothing | **the combo disappears**: none of its rows still conflicts. If it reappears, it pages again. While more than 10 conflict combos exist, no conflict combo key clears (the `combo_cap_exceeded:type_conflicts` key is firing then) | See [Event-type conflicts](#event-type-conflicts) |
| `conversion_events:combo_cap_exceeded:unmapped` / `:type_conflicts` (fixed, one per kind) | that kind has more than 10 problem combos, so only its 10 most recently changed are listed and paged. The page names the kind, the combo count, the cap and the SQL that lists every combo of the kind. Neither key is under a combo prefix, so the stale-combo clear never touches them | the kind is back to 10 or fewer combos. Combo clears of that kind resume at the same moment | Read the whole list with the page's SQL and work it down. A new combo still pages while capped (recency ranking), unless more than 10 combos change in the same tick |
| `heartbeat:conversion-events-ingest` | no complete ingest for over **1h** (`HEARTBEAT_JOBS.conversionEventsIngest`). Checked hourly by `/api/cron/tracking-monitors`, never by the poll itself | the heartbeat is fresh again | Check the poll cron: `conversion_events_error` in its response, the Vercel logs, and any `fetch_failed` alert. A long outage pages twice by design: `fetch_failed` after ~15 min, the heartbeat within ~2h |

**Not alerted:**
- `unresolved` conversions (no stage, no `offers.keitaro_offer_id`). They include legitimate non-CamMan traffic, so they are only counted in the poll response.
- A complete window with zero conversions, which is a quiet week.
- `statusOnlyInBatch`. A status-only row that already has a locked event type is fine. A brand-new one has a NULL event type, so it is an unmapped row in the table, and its combo's `conversion_events:unmapped:<offer>:<keitaro_type>` key already reports it.

**Inspect state (read-only):**

```sql
SELECT alert_key, state, since, last_notified_at FROM alert_state
WHERE alert_key LIKE 'conversion_events:%' OR alert_key = 'heartbeat:conversion-events-ingest'
ORDER BY alert_key;
SELECT watermark, now() - watermark AS age FROM cron_locks WHERE job_name = 'conversion-events-ingest';
```

Don't flip a key to `ok` by hand; that hides a real condition. Fix the cause, and the next tick clears it (the next hourly run, for the heartbeat). A firing `unmapped:<offer>:<keitaro_type>` / `type_conflicts:<offer>:<locked_key>><conflicting_key>` row names one problem combo. It stays firing until **none** of that combo's rows is a problem any more — and, while its kind's `combo_cap_exceeded` key is firing, until that kind is back to 10 or fewer combos as well.

**Checks:**
- `scripts/test-conversion-monitor.ts` (pure, 39):
  - the window, including DST and a year boundary
  - every decision, including the `fetch_failed` debounce (fresh / stale / never / exactly 15 min), a malformed response and a thrown ingest
  - the `fetch_failed` age text (`N min ago` under 120 min, `X.Y h ago` from 120 min)
  - `org_mismatch` fire/clear with samples
  - combo keys: the format and offer rule, sanitisation and clipping, the `~<hash>` suffix (parts that sanitise alike get different keys; a clean part gets no suffix), and that counts and samples never change a key
  - combo decisions: a new combo fires, the same combo fires on the same key, a stale firing key clears, keys outside the prefixes are ignored, and the 10-combo cap (named on each page, no combo clears past it, the `combo_cap_exceeded` key firing over the cap and clearing at it)
  - the combo statements rank by `max(ce.updated_at) DESC`, not by size
  - per-combo text facts, samples capped at 3, no markup, the five fixed keys and the prefixes
- `scripts/test-conversion-monitor-db.ts` (camman-v2 only, rolled back, 43):
  - pre-existing problem rows are neutralised inside the transaction
  - combo reads: counts, the offer rule, samples, a status-only row (`event_type_id` NULL, `status` `rejected`) read as unmapped, a conflict set by UPDATE; partial-index use; the cap with the combo count and row total over every combo, listed by recency
  - the same combo on successive ticks pages once; a new combo pages; an existing row turned unmapped by UPDATE pages; a conflict set on an existing row by UPDATE pages, and a second one of the same combo doesn't
  - a resolved combo's key clears and pages again when the combo reappears; leftover in-prefix keys clear; decoy keys outside the prefixes stay untouched
  - a new 1-row combo pages against ten bigger firing combos, crossing the cap pages the `combo_cap_exceeded` key once, the combo that drops off the listing is not cleared, and clears resume when the kind is back at the cap
  - a failed tick still pages a new combo
  - the debounce against a real `cron_locks` watermark (5 min / 20 min / NULL; a debounced failure never clears; a throw pages)
````

In `## Not built yet`, delete the bullet that starts with `- **Phase 2:**` (the whole bullet).

- [ ] **Step 2: `docs/04-features/keitaro-poll.md`**

Replace line 3 `_Last updated: 2026-07-10_` with `_Last updated: 2026-09-17_`.

At the end of §3, insert this paragraph between the one ending ``in [`lib/keitaro/funnel.ts`](../../lib/keitaro/funnel.ts), not stored.`` and `## 4. Storage (`keitaro_stage_results`, migrations 0061 + 0062)`:

```markdown
**Then, in the route — the conversion ledger (Phase 2, 2026-09-17).** After
`pollKeitaro` and the counted-clicker refresh, `/api/keitaro/poll` calls
`ingestKeitaroConversions(db, { range: liveIngestRange(now) })`. That is a separate
`conversions/log` fetch of **all** conversion types over the last **7 ET calendar
days** (it ignores `?windowDays`), upserted into `conversion_events` keyed on Keitaro
`event_id`. It never touches `keitaro_stage_results`, so this section's numbers are
unchanged, and its own try/catch means a failure never fails the poll. On the cron
path it then evaluates the Tier-2 ledger alerts and stamps the
`conversion-events-ingest` heartbeat. See [conversion-events.md](conversion-events.md).
```

In §5, replace

```markdown
- `GET|POST /api/keitaro/poll` — cron (CRON_SECRET) or manual (operator+,
  `result_imports.create`). `?windowDays=N`. Returns
  `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, classification_degraded, visit_campaigns_matched, unmatched_samples, error }`.
```

with

```markdown
- `GET|POST /api/keitaro/poll` — cron (CRON_SECRET) or manual (operator+,
  `result_imports.create`). `?windowDays=N` (aggregate poll only). Returns
  `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, classification_degraded, visit_campaigns_matched, unmatched_samples, error, counted_clickers, counted_clickers_error, conversion_events, conversion_events_error }`.
  - `conversion_events`: the ledger ingest's `IngestResult`, or `null` when the ingest threw. Fields: `ok`, `dryRun`, `range`, `fetched`, `invalid`/`invalidSamples`, `unresolved`/`unresolvedSamples` (samples include `sub_id_1`), `rows`, `unmappedInBatch`, `statusOnlyInBatch`, `inserted`/`updated`/`unchanged`, `typeConflicts`, `orgMismatch`/`orgMismatchSamples`, `error`. `ok:false` with `error` means the window was refused (Keitaro HTTP error, timeout, a malformed 200 that isn't JSON with a `rows` array and a numeric `total`, or a truncated page) and nothing was written.
  - `conversion_events_error`: the thrown message when the ingest threw; `monitor: …` when the cron path's alert evaluation or heartbeat stamp threw (appended after `; ` if the ingest also threw); `null` otherwise. On the cron path a thrown ingest also counts as a failed tick for the debounced `conversion_events:fetch_failed` alert.
```

- [ ] **Step 3: `docs/04-features/crons.md`**

Replace line 3 `_Last updated: 2026-09-14_` with `_Last updated: 2026-09-17_`.

In the §2 table, replace

```markdown
| `/api/keitaro/poll` | `*/5 * * * *` | pull Keitaro clicks/conversions → `keitaro_stage_results` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
```

with

```markdown
| `/api/keitaro/poll` | `*/5 * * * *` | pull Keitaro clicks/conversions → `keitaro_stage_results`; then ingest the last 7 ET days of Keitaro conversions into the `conversion_events` ledger (the cron path also evaluates the Tier-2 ledger alerts and stamps the `conversion-events-ingest` heartbeat) | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
```

and in the `/api/cron/tracking-monitors` row replace

```markdown
latched per stage via `alert_state`, re-arms on recovery. See [tracking-attribution.md §7c](tracking-attribution.md) |
```

with

```markdown
latched per stage via `alert_state`, re-arms on recovery. See [tracking-attribution.md §7c](tracking-attribution.md). Also the dead-man for the conversion ledger ingest: pages once (fixed key `heartbeat:conversion-events-ingest`) when `HEARTBEAT_JOBS.conversionEventsIngest` is over 1h old, clears when fresh — see [conversion-events.md](conversion-events.md) |
```

In §3 `/api/keitaro/poll`, replace the bullet that starts ``- Returns `{ ok, degraded, range,`` with:

```markdown
- **Conversion ledger ingest (Phase 2, 2026-09-17).** After the poll and the counted-clicker refresh, the route calls `ingestKeitaroConversions` ([lib/conversions/ingest.ts](../../lib/conversions/ingest.ts)) over a rolling **7-day** ET window (`liveIngestRange`, independent of `?windowDays`) and upserts `conversion_events`.
  - It is isolated from the poll: its own fetch, transaction and try/catch. A throw lands in `conversion_events_error` and never changes the poll's result or `keitaro_stage_results`.
  - It runs on the manual path too.
- **Cron path only:** `evaluateConversionAlerts` ([lib/conversions/monitor.ts](../../lib/conversions/monitor.ts)) latches seven Tier-2 Telegram alerts in `alert_state`: fixed keys `conversion_events:fetch_failed`, `:invalid_rows`, `:org_mismatch`, `:combo_cap_exceeded:unmapped`, `:combo_cap_exceeded:type_conflicts`, and one key per problem combo, `conversion_events:unmapped:<offer>:<keitaro_type>` and `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`. The combo alerts are evaluated on every tick, failed ones included. Each new combo pages once, repeats don't re-page, and a key clears when its combo disappears — except while its kind has more than 10 combos, when the kind's `combo_cap_exceeded` key pages instead and no combo key of it clears.
  - A refused window (HTTP error, timeout, malformed or truncated page) **or a thrown ingest** is a failed tick. `fetch_failed` fires only once the last complete ingest is over 15 min old (`FETCH_FAILED_DEBOUNCE_MINUTES`) or was never recorded; a failed tick inside that neither fires nor clears.
  - Then, last and only when the window was complete (`ok:true`), it runs `recordHeartbeat("conversion-events-ingest")`.
  - `/api/cron/tracking-monitors` watches that heartbeat. See [conversion-events.md](conversion-events.md).
- Returns `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, classification_degraded, visit_campaigns_matched, unmatched_samples, error, counted_clickers, counted_clickers_error, conversion_events, conversion_events_error }` — `conversion_events` is the `IngestResult` (including `unresolved`), or `null` when the ingest threw. See [keitaro-poll.md](keitaro-poll.md). Read stored results via `GET /api/keitaro/results?campaign_id=<id>` or the cross-campaign `GET /api/keitaro/reports` (the `/reports` page).
```

In §4, insert after the first bullet (the one starting `- Reads/writes `clicks`, `geoip_cache``):

```markdown
- `keitaro/poll` also writes `conversion_events`, reading `stage_sends`, `campaign_stages`, `campaigns`, `offers` and `conversion_event_mappings`. On the cron path it reads `conversion_events`/`offers`/`event_types` for the ledger alerts and writes `alert_state` plus the `cron_locks` row `conversion-events-ingest`. `tracking-monitors` reads that `cron_locks` row and writes `alert_state`.
```

- [ ] **Step 4: `docs/05-flows.md` flow G**

Replace line 3 `_Last updated: 2026-09-14_` with `_Last updated: 2026-09-17_`.

Replace the whole mermaid block under `## G. Keitaro results poll (every 5 min)`, and the `>` note right after it, with:

````markdown
```mermaid
sequenceDiagram
  participant Cron as */5 keitaro/poll
  participant Poll as pollKeitaro
  participant Ledger as ingestKeitaroConversions
  participant K as Keitaro Admin API
  participant DB
  participant TG as Telegram
  participant CRM as /api/keitaro/results
  Cron->>Poll: GET /api/keitaro/poll (Bearer CRON_SECRET)
  Poll->>K: POST /report/build (3-day ET window, group day+sub_id_3)
  K-->>Poll: rows[{day, sub_id_3, clicks, leads, sales, revenue, epc…}]
  Poll->>DB: resolve sub_id_3 → campaign_stages.tracking_id (stage/campaign/org)
  loop each matched row
    Poll->>DB: UPSERT keitaro_stage_results (org_id, stage_id, stat_date)
  end
  Note over Poll,DB: idempotent (last-write-wins) — re-poll overwrites, never double-counts;<br/>unmatched/blank sub_id_3 counted + sampled, not written
  Cron->>Ledger: then the conversion ledger (rolling 7-day ET window, own try/catch)
  Ledger->>K: POST /conversions/log (all conversion types, refused if malformed or truncated)
  K-->>Ledger: rows[{event_id, tid, sub_id_1, sub_id_3, conversion_type, revenue, status_history…}]
  Ledger->>DB: UPSERT conversion_events ON keitaro_event_id (one transaction)
  opt cron path only
    Cron->>DB: read ledger problem combos (unmapped, type conflicts) + firing combo keys + heartbeat age on a failed or thrown tick (fetch_failed 15-min debounce)
    Cron->>TG: page on a transition into firing (alert_state latch, one page per new unmapped/conflict combo, most recently changed first, plus a per-kind combo_cap_exceeded page past the 10-combo cap), clear keys whose condition or combo is gone
    Cron->>DB: stamp conversion-events-ingest heartbeat (complete windows only)
  end
  CRM->>DB: GET results?campaign_id → per-stage + campaign rollup (derived rates)
```

> `sub_id_3` carries the **stage** tracking id, so rows are per-stage; campaign totals = SUM across stages. Per-recipient SALE detail is a **separate** poll keyed on `sub_id_1` (flow H). The ledger step writes only `conversion_events` (plus `alert_state` / `cron_locks` on the cron path); `/api/cron/tracking-monitors` watches its heartbeat. See [04-features/conversion-events.md](04-features/conversion-events.md).
````

- [ ] **Step 5: `docs/CHANGELOG.md`**

Insert as the first entry, directly after the intro paragraph (`A running log of documentation-affecting changes. …`), followed by one blank line:

```markdown
2026-09-17 - Conversion events ledger, Phase 2: kept live + Tier-2 alerts. **No migration** (uses 0181, `alert_state` 0154, `cron_locks` 0103). `/api/keitaro/poll` now ingests the last 7 ET days of Keitaro conversions into `conversion_events` after the aggregate poll and the counted-clicker refresh: own try/catch, response adds `conversion_events` / `conversion_events_error`, and `keitaro_stage_results`, `stage_sends` and every reader are unchanged. On the cron path, seven latched Telegram alerts: on fixed keys, `conversion_events:fetch_failed` (a refused — HTTP error, timeout, malformed or truncated page — or thrown ingest, debounced: fires only when the last complete ingest is over 15 min old or never recorded, so one transient failure never pages; the age reads `N min ago` / `X.Y h ago`), `:invalid_rows`, `:org_mismatch` (rows resolved to another org and not written; no debounce); on one key per problem combo, `conversion_events:unmapped:<offer>:<keitaro_type>` (all-time) and `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>`, evaluated on every tick, failed ones included. Each new combo pages once, including a conflict or an unmapped type that an UPDATE puts on an existing row. Repeats of the same combo don't re-page, a combo key clears when its combo disappears, and at most 10 combos per kind are listed and paged — the most recently changed, so a brand-new small combo pages even against ten bigger ones. A combo key part that needed sanitising carries a `~<6 hex of sha256>` suffix, so types that sanitise alike keep separate alerts. Past the cap, the fixed keys `conversion_events:combo_cap_exceeded:unmapped` / `:type_conflicts` page once (and clear at 10 or fewer), while no combo key of that kind clears. Then the `conversion-events-ingest` heartbeat, stamped last and only for a complete window; `/api/cron/tracking-monitors` pages on `heartbeat:conversion-events-ingest` when it is over 1h old. Unresolved conversions and `statusOnlyInBatch` are counted, not alerted (a brand-new status-only row is already a table-level unmapped row). New [lib/conversions/monitor.ts](../lib/conversions/monitor.ts); `liveIngestRange` (DST-safe calendar window) in [lib/conversions/keitaro-row.ts](../lib/conversions/keitaro-row.ts). Checks: test-conversion-monitor 39 (pure), test-conversion-monitor-db 43 (camman-v2, rolled back), Phase 1's test-conversion-ledger-rows 38 / test-conversion-events-upsert 17 / test-conversion-lookups 7 re-run; tsc; eslint on changed files. — docs updated: 04-features/conversion-events.md, 04-features/keitaro-poll.md, 04-features/crons.md, 05-flows.md (flow G), plan.
```

- [ ] **Step 6: Docs check + commit**

Run: `npm run check:docs`
Expected: exit 0.

```bash
git add docs/04-features/conversion-events.md docs/04-features/keitaro-poll.md docs/04-features/crons.md docs/05-flows.md docs/CHANGELOG.md docs/superpowers/plans/2026-09-17-conversion-events-phase2.md
git diff --cached --stat
git commit -m "docs(conversions): Phase 2 — live ledger ingest, Tier-2 alerts, heartbeat

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Expected `--stat`: the six doc files. `CHANGELOG.md` shows insertions only.

---

### Task 5: Review, PR, gated merge, prod checks

No new code. Steps marked **(controller)** are the controller's. **STOP** steps need the controller's explicit go-ahead in the conversation.

- [ ] **Step 1: Whole-branch checks**

```bash
cd C:/AFF/camman/.claude/worktrees/conv-events-recon
cat .superpowers/sdd/phase2-base.txt          # "main <sha>" or "p1 <sha>"
BASE_SHA=$(cut -d' ' -f2 .superpowers/sdd/phase2-base.txt)
git fetch origin
git diff --name-only "$BASE_SHA"...HEAD | sort
npx tsc --noEmit -p .
npx eslint lib/conversions/keitaro-row.ts lib/conversions/monitor.ts lib/reporting/cron-heartbeat.ts app/api/keitaro/poll/route.ts app/api/cron/tracking-monitors/route.ts scripts/test-conversion-monitor.ts scripts/test-conversion-monitor-db.ts
npx tsx scripts/test-conversion-monitor.ts
npx tsx scripts/test-conversion-ledger-rows.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-monitor-db.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-events-upsert.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-lookups.ts
npm run check:docs
```

Expected:
- The file list is exactly:

  ```
  app/api/cron/tracking-monitors/route.ts
  app/api/keitaro/poll/route.ts
  docs/04-features/conversion-events.md
  docs/04-features/crons.md
  docs/04-features/keitaro-poll.md
  docs/05-flows.md
  docs/CHANGELOG.md
  docs/superpowers/plans/2026-09-17-conversion-events-phase2.md
  lib/conversions/keitaro-row.ts
  lib/conversions/monitor.ts
  lib/reporting/cron-heartbeat.ts
  scripts/test-conversion-monitor-db.ts
  scripts/test-conversion-monitor.ts
  ```

  Nothing under `db/`, `lib/keitaro/`, `lib/conversions/ingest.ts` or `build-rows.ts`. That is the "no reader / no aggregate change" proof.
- tsc exit 0 and eslint no problems.
- Tests, in run order:
  - Phase 2 pure: 39/0
  - Phase 1 pure: 38/0
  - Phase 2 DB: 43/0
  - Phase 1 upsert: 17/0
  - Phase 1 lookups: 7/0

  Every DB run prints `Target DB: camman-v2 (preview)`. The three Phase 1 counts are as of 72501c7. If Phase 1 moved on, expect the counts in its CHANGELOG entry, always with 0 failed. Phase 2 doesn't touch those scripts, so a regression there is a Phase 2 bug.
- `check:docs` exit 0.

- [ ] **Step 2: Code review**

Run the whole-branch review with `superpowers:requesting-code-review` against `$BASE_SHA`. Fix the findings, commit them with the trailer, and re-run Step 1.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/conversion-events-p2
```

If `phase2-base.txt` says `main`:

```bash
gh pr create --title "Conversion events ledger — Phase 2 (live ingest + Tier-2 alerts)" --body "$(cat <<'EOF'
Phase 2 of multi-event conversions: the conversion_events ledger is kept live on the */5 Keitaro poll tick, and every way it can go wrong pages Telegram once.

- /api/keitaro/poll: after the aggregate poll and the counted-clicker refresh, ingest the last 7 ET days of Keitaro conversions (own try/catch; response adds conversion_events / conversion_events_error). keitaro_stage_results, stage_sends and every reader are unchanged.
- Cron path: latched Tier-2 alerts, then the conversion-events-ingest heartbeat (stamped last, complete windows only). Fixed keys conversion_events:fetch_failed, :invalid_rows, :org_mismatch. fetch_failed covers HTTP errors, timeouts, malformed and truncated pages and thrown ingests, debounced: it pages only when the last complete ingest is over 15 min old or never recorded. org_mismatch has no debounce.
- conversion_events:unmapped:<offer>:<keitaro_type> and conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key> use one key per problem combo. A new combo pages once, including a conflict or unmapped type an UPDATE puts on an existing row. Repeats of the same combo don't re-page, so a stream of one unmapped type can't flood. A key clears when its combo disappears and pages again if the combo returns. At most 10 combos per kind are listed and paged, the most recently changed first, so a brand-new small combo pages even against ten bigger ones; past the cap the fixed keys conversion_events:combo_cap_exceeded:unmapped / :type_conflicts page once and no combo key of that kind clears until the count is back to 10 or fewer. A key part that needed sanitising carries a ~<6 hex of sha256> suffix, so two Keitaro types that sanitise alike keep separate alerts. Evaluated on every cron tick, failed ones included.
- /api/cron/tracking-monitors: pages on heartbeat:conversion-events-ingest when the ingest heartbeat is over 1h old.
- No migration. Do not merge before #193, and only after 0181 is applied to prod — the live tick writes conversion_events.

Plan: docs/superpowers/plans/2026-09-17-conversion-events-phase2.md
Checks: test-conversion-monitor 39/0 (pure), test-conversion-monitor-db 43/0 (camman-v2, rolled back), Phase 1 test-conversion-ledger-rows 38/0, test-conversion-events-upsert 17/0, test-conversion-lookups 7/0, tsc, eslint on changed files, check:docs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If it says `p1`, run the same command with `--base feat/conversion-events-p1` added. Also add this line above `Plan:` in the body: `Stacked on #193 (feat/conversion-events-p1). Retarget to main after #193 merges.`

Then: `gh pr view --json number,url --jq '"\(.number) \(.url)"'`. Record the PR number as `PR` for the steps below.

- [ ] **Step 4: Preview deploy green**

Run: `gh pr checks <PR> --watch`
Expected: the Vercel preview check passes. Previews don't run crons and Phase 2 has no migration, so camman-v2 is untouched by the deploy.

- [ ] **Step 5: STOP (controller)**

**STOP: do not merge until the controller confirms 0181 is applied to prod.** Merging also starts prod writes to `conversion_events`, `alert_state` and `cron_locks` every 5 minutes. The controller's confirmation covers that too.

**Merge order: this PR must not merge before #193.** Check with `gh pr view 193 --json state --jq .state`; it must print `MERGED`.

- [ ] **Step 6: Retarget a stacked PR (only if `phase2-base.txt` says `p1`)**

Wait until #193 is `MERGED` (`gh pr view 193 --json state --jq .state`). Then:

```bash
P1_BASE=$(cut -d' ' -f2 .superpowers/sdd/phase2-base.txt)
git fetch origin
git rebase --onto origin/main "$P1_BASE" feat/conversion-events-p2
git log --oneline origin/main..HEAD        # expect only the Phase 2 commits
```

This force-pushes a feature branch, which is a CLAUDE.md §11 destructive operation. **Get the controller's go-ahead first**, then:

```bash
git push --force-with-lease origin feat/conversion-events-p2
gh pr edit <PR> --base main
echo "main $(git merge-base HEAD origin/main)" > .superpowers/sdd/phase2-base.txt
```

Re-run Step 1 and wait for Step 4 to be green again.

- [ ] **Step 7: Merge (controller-confirmed), timed**

Preconditions:
- #193 is `MERGED`.
- The PR base is `main` (Step 6 done if the PR was stacked).
- The controller confirmed 0181 on prod (Step 5).

Merge between **HH:40 and HH:15**. The prod deploy is then READY and at least one `*/5` poll tick stamps `conversion-events-ingest` before `tracking-monitors` runs at `:37`. Merging later than that risks one false "has NEVER recorded a run" page.

```bash
[ "$(gh pr view 193 --json state --jq .state)" = "MERGED" ] && [ "$(gh pr view <PR> --json baseRefName --jq .baseRefName)" = "main" ] && echo "merge order ok"   # must print; if not, stop
gh pr merge <PR> --squash
MERGE_SHA=$(gh pr view <PR> --json mergeCommit --jq .mergeCommit.oid); echo "$MERGE_SHA"
```

- [ ] **Step 8: Prod deployment READY**

The production environment is `Production – camman` (en dash), not `Production`:

```bash
DEP_ID=$(gh api "repos/{owner}/{repo}/deployments?sha=$MERGE_SHA&environment=Production%20%E2%80%93%20camman" --jq '.[0].id')
gh api "repos/{owner}/{repo}/deployments/$DEP_ID/statuses" --jq '.[0].state'
```

Expected: `success`. If it is still `pending`/`in_progress`, re-run in a minute. On `failure`/`error`, read the Vercel build log and stop. The controller can check the same thing with the Vercel MCP `list_deployments`.

- [ ] **Step 9: Ledger live on prod (controller, read-only SQL)**

About 10 minutes after READY, run on prod (Supabase MCP `execute_sql`, project `rtdarhkkjwcetlmruftl`). Run it again ~10 minutes later:

```sql
SELECT count(*) AS rows, max(updated_at) AS last_update, max(created_at) AS last_insert FROM conversion_events;
SELECT watermark, now() - watermark AS age FROM cron_locks WHERE job_name = 'conversion-events-ingest';
SELECT alert_key, state, since, last_notified_at FROM alert_state
WHERE alert_key LIKE 'conversion_events:%' OR alert_key = 'heartbeat:conversion-events-ingest'
ORDER BY alert_key;
SELECT max(synced_at) AS aggregate_synced FROM keitaro_stage_results;
```

Also run once, read-only (controller): `EXPLAIN (ANALYZE, BUFFERS)` of both exported combo statements — `UNMAPPED_COMBOS_SQL` and `CONFLICT_COMBOS_SQL` (`lib/conversions/monitor.ts`) — against prod, and record the chosen plan and the timings. Also run `SELECT count(*) FROM conversion_events;` and, from the Vercel logs, the poll tick's wall time for the first few ticks. Rationale: both statements are all-time aggregates and run on **every** `*/5` cron tick (288×/day); the `EXPLAIN` checks in `scripts/test-conversion-monitor-db.ts` only prove the partial index CAN serve them — they force `enable_seqscan = off` — on a near-empty preview table, and `array_agg` materialises every row of a combo before slicing to `MAX_SAMPLES`. Prod, at real row counts, is the first honest read of plan choice and cost.

Expected:
- **Heartbeat:** `watermark` age is under 10 minutes on both readings, and later on the second.
- **Ledger rows:** `rows` / `last_update` / `last_insert` advance only when Keitaro has new or changed conversions. In a quiet 10 minutes they may not, and the watermark is the liveness proof.
- **Combo statement cost:** record the `EXPLAIN` plan and timings for both statements, the `conversion_events` row count, and the first few ticks' wall time on the card (Step 11). No seqscan should appear without the `enable_seqscan = off` hack; escalate before Step 11 if one does.
- **Alert keys:**
  - Five fixed `conversion_events:*` rows (`fetch_failed`, `invalid_rows`, `org_mismatch`, `combo_cap_exceeded:unmapped`, `combo_cap_exceeded:type_conflicts`), state `ok` — the two cap keys only if the ledger has 10 or fewer combos of that kind. (This holds after the first COMPLETE tick. If the first tick after merge fails and lands inside the `fetch_failed` debounce window, it makes no ingest decision at all — no fire, no clear — so these rows don't exist yet until a tick completes.)
  - `conversion_events:unmapped:<offer>:<keitaro_type>` and `conversion_events:type_conflicts:<offer>:<locked_key>><conflicting_key>` rows exist only for problem combos that have existed. A clean ledger inserts no row for them, because a combo key is only cleared once it is firing.
  - Each `firing` combo row is one problem combo that is (or was, while capped) among its kind's 10 most recently changed; its message is in Telegram, and the controller decides. More combo rows can be `firing` than a kind currently lists: nothing clears while that kind is past the cap.
  - The first tick after merge pages at most the combos it lists — up to 10 per kind of the backfilled ledger, the most recently changed — plus each kind's `combo_cap_exceeded` page when that kind has more. It does NOT page every backfilled combo. A firing `combo_cap_exceeded` row is the signal to list the whole kind with the SQL in its message.
- **Aggregate poll:** `aggregate_synced` is within 10 minutes (the poll is unharmed).

- [ ] **Step 10: Heartbeat watcher on prod (controller)**

After the first `:37` following READY, re-run the `alert_state` query. Expected: a `heartbeat:conversion-events-ingest` row in state `ok` and no heartbeat page in Telegram.

- [ ] **Step 11: Close out**

- Post the Step 9/10 readings on the card.
- Update memory: a Phase 2 LIVE note with the keys, the heartbeat and the merge-timing gotcha.
- Unlink the junction if this plan created one: `cmd //c "rmdir node_modules"`. Never `rm -rf` it.
- **If this phase is ever reverted:** a revert leaves `conversion_events:*` rows in `alert_state` (some possibly `firing`) with nothing left to clear them — `notifyOnTransition` only pages on an `ok`→`firing` transition, so a later re-merge will NOT re-page combos that are still standing. A revert must therefore be followed by an approval-gated `UPDATE alert_state SET state='ok' WHERE alert_key LIKE 'conversion_events:%' OR alert_key = 'heartbeat:conversion-events-ingest'`. Also, a revert restores `maxDuration = 300` on `/api/keitaro/poll` (> the 240s `CRON_LEASE_MS` cron lease TTL) — cd4fa85 should be cherry-picked back onto `main` so the route still dies before its own lease.
