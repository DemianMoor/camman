# Feature — Cron Jobs

_Last updated: 2026-07-14_

## 1. Purpose
All scheduled/deferred work runs via **Vercel Cron** (no job queue — CLAUDE.md §12). Endpoints authenticated with `Authorization: Bearer <CRON_SECRET>`.

## 2. The jobs (`vercel.json`)
| Path | Schedule | Job | Auth |
|------|----------|-----|------|
| `/api/clicks/score-pending` | `3,18,33,48 * * * *` | enrich + score click rows (scoring only since W1.1) | CRON_SECRET only (503 if unset) |
| `/api/cron/propagate-clickers` | `8,23,38,53 * * * *` | propagate freshly-scored clean clicks → `clickers` (incremental watermark); `withCronLease` single-runner sharing the `propagate-clickers` `cron_locks` row | CRON_SECRET only (Bearer **or** `x-cron-secret`); 401 otherwise |
| `/api/opt-outs/poll` | `1,6,11,16,21,26,31,36,41,46,51,56 * * * *` | poll TextHub inbox for STOP intake (every 5 min, staggered off the two `*/5` jobs) | CRON_SECRET (GET, all orgs) **or** session operator+ (POST, own org) |
| `/api/cron/send-scheduled` | `*/5 * * * *` | fire scheduled tracked sends | CRON_SECRET (GET, all orgs) **or** session `campaigns.drain` (POST, own org) |
| `/api/keitaro/poll` | `*/5 * * * *` | pull Keitaro clicks/conversions → `keitaro_stage_results` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
| `/api/keitaro/poll-conversions` | `9,24,39,54 * * * *` | per-recipient SALE attribution → `stage_sends.sale_status` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
| `/api/keitaro/poll-offer-reaches` | `12,27,42,57 * * * *` | per-recipient OFFER-PAGE REACH (Level 2) → `stage_sends.offer_reached_at` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
| `/api/cron/telegram-report` | `0 * * * *` | send the daily/hourly performance report to Telegram (decides internally per Warsaw time) | CRON_SECRET only (Bearer **or** `x-cron-secret`); 401 otherwise |
| `/api/cron/refresh-offer-group-report` | `0 5,20 * * *` | rebuild the offer group report matviews (`offer_group_report_mv`, `offer_report_org_summary_mv`) | CRON_SECRET only (Bearer **or** `x-cron-secret`); 401 otherwise |
| `/api/cron/lookup-worker` | `*/2 * * * *` | drain the Telnyx number-lookup queue (`lib/telnyx/worker.ts`); single-runner lease | CRON_SECRET only (503 if unset, 401 otherwise) |
| `/api/cron/carrier-triage` | `17,47 * * * *` | drain `carrier_classify_queue` — batch unresolved carrier strings to `claude-haiku-4-5`, write confident buckets to `carrier_mappings` (`lib/carrier/ai-triage.ts`); `withCronLease` single-runner; per-run API-call cap | CRON_SECRET only (Bearer **or** `x-cron-secret`); 401 otherwise |

> **Schedules are staggered on purpose.** Previously the four `*/15` jobs all fired at `:00/:15/:30/:45` alongside the two `*/5` jobs — up to **5–6 crons at once**, each cold-starting and each grabbing pooler connections (the pool caps at `max:5` per instance against Supavisor's ~15-client ceiling). The `*/15` jobs now sit at distinct off-5 minute offsets (`3/6/8/9/12`, plus `carrier-triage` at `17/47`), so they never coincide with the `*/5` jobs or each other — peak concurrency drops from ~6 to ~2. `propagate-clickers` at `8` runs alone at that minute. `send-scheduled` and `keitaro/poll` stay on `*/5` (both latency-sensitive; two concurrent is fine).
>
> **Both per-recipient pollers batch their writes.** `poll-conversions` and `poll-offer-reaches` fold their matches in memory and flush via a single `UPDATE … FROM (VALUES …)` per 500-row chunk, not one `UPDATE … WHERE id = …` round-trip per conversion. Measured: ~200 sequential round-trips ≈ **12.4 s** of pooler latency vs **~53 ms** batched — material against the poll's budget on a busy sales day.

## 3. How each works

### `/api/clicks/score-pending` (click scoring)
- CRON_SECRET Bearer only; returns 401 on bad/missing secret, **503 if `CRON_SECRET` is unconfigured**.
- Params: `?mode=pending|rescore` (default pending), `?maxRows=N` (default 2000, ≤20000).
- Calls `scoreClicks()` ([`lib/links/score-clicks.ts`](../../lib/links/score-clicks.ts)); Node runtime (filesystem for the MaxMind `.mmdb`).
- **Scoring only since W1.1** — clicker propagation moved to its own cron (`/api/cron/propagate-clickers`, below). Previously this route called `propagateTrackedClickers()` best-effort after scoring, where a heavy scoring run ate the 60 s budget and starved it (watermark stalled ~5 h on 2026-07-14).
- Returns `{ mode, scored, byClassification, capped, degraded, enrichment }`. `degraded:true` ⇒ no rows scored (enrichment failed) — rows stay pending. See [tracking-attribution.md](tracking-attribution.md).

### `/api/cron/propagate-clickers` (clicker propagation)
- CRON_SECRET only (Bearer **or** `x-cron-secret`); 401 otherwise.
- Calls `propagateTrackedClickers()` ([`lib/links/propagate-clickers.ts`](../../lib/links/propagate-clickers.ts)) under `withCronLease("propagate-clickers", …)` to materialize freshly-scored clean (`human`) clicks into the `clickers` engagement table so segment clicker rules see them. Idempotent (`NOT EXISTS` guard) and incremental: an `scored_at` high-water mark in `cron_locks.watermark` bounds each run to `(watermark, now()−5min]`, advanced only after the INSERT commits.
- **Shared `cron_locks` row (by design):** `withCronLease` uses the `lease_until` column of the `propagate-clickers` row while `propagateTrackedClickers` uses its `watermark` column — distinct columns on the same row, so the lease and the progress marker compose.
- **W1.1 (2026-07-14):** split out of `score-pending` so a heavy scoring run can no longer starve it. Runs at `8,23,38,53` — 5 min after each `score-pending` tick (`3,18,33,48`) so freshly-scored clicks are available; the 5-min safety lag also defers any click scored right at the boundary to the next run.
- Returns `{ ok, inserted, watermarkFrom, watermarkTo }`, or `{ ok, skipped, skippedCount }` on lease contention.

### `/api/opt-outs/poll` (STOP intake)
- Polls each provider credential's TextHub `?inbox=true` endpoint and inserts new opt-outs (`opt_outs`, source `sms_inbound`, org-wide). The TextHub *push* callback is broken on their side, so intake pivoted to **polling**; the Stage-A inbound webhook is a dormant fallback. Manual "Poll now" button uses the POST path (operator+).
- **Cadence tightened to every 5 min (2026-07-19; was `*/15`).** TextHub's inbox is hard-capped at the 200 most-recent messages with no pagination (see `06-integrations.md` TextHub gotchas), so during a STOP-reply burst more than 200 replies could accumulate between 15-min polls and scroll off before ingest (~30% opt-out loss Jun 29–Jul 5). Polling every 5 min cuts the accumulation window 3× — a **mitigation, not a cure** (a >200 burst inside 5 min still overflows; the only true fix is pagination TextHub doesn't offer, or the CSV backfill). Safe to run this often: `withCronLease("opt-outs-poll")` prevents overlapping ticks, the reads are free, and `maxDuration = 60` ≪ the 5-min interval.
- **Campaign/stage attribution (migration 0075; latest-stage-only since 2026-06-24).** TextHub's inbox carries no campaign reference, so each STOP is reverse-matched to sends by phone + recency: the poller credits the **single most-recent stage that sent to that number within a 72h trailing window** (`OPT_OUT_ATTRIBUTION_WINDOW_HOURS`, anchored on the parsed `provider_received_at`) via `latestSendForAttribution` — **exactly one** `opt_out_attributions` row + one `campaign_stages.inbound_opt_out_count` bump. **One STOP ⇒ one stage.** (Tie-break on identical `sent_at`: higher `stage_id`, then higher `stage_send_id`.) Until 2026-06-24 it fanned out one row per stage in the window, so a sequence that messaged the same lead 2–3× counted the opt-out 2–3× and inflated the per-stage opt-out rate in `/reports` (ET 2026-06-23: 530 real opt-outs read as 996 rows). All inside the existing per-message transaction (idempotent via the `texthub_inbound_events` claim + `ON CONFLICT (opt_out_id, stage_id)`). The org-wide `opt_outs` row is unchanged — attribution is additive, never a suppression gate. No window match (CSV-only numbers, non-API providers, pre-pipeline sends) ⇒ org-wide opt-out only, counted `unattributed`. Backfills: [`scripts/backfill-optout-attributions.ts`](../../scripts/backfill-optout-attributions.ts) (initial credit) and [`scripts/backfill-optout-latest-stage.ts`](../../scripts/backfill-optout-latest-stage.ts) (collapse pre-2026-06-24 fan-out to latest-stage-only; dry-run by default, `--apply` to commit) — both anchor on `opt_outs.created_at`, our reliable UTC ingest clock. See [poll-opt-outs.ts](../../lib/sends/poll-opt-outs.ts).
- **TextHub `received_at` is US Mountain Time, not UTC (fixed 2026-06-19).** TextHub stamps inbound messages in Mountain wall-clock with no zone suffix (operator-confirmed); `parseProviderReceivedAt` interprets it in `America/Denver` (`TEXTHUB_RECEIVED_AT_TIMEZONE`) → true UTC, DST-aware (MDT/−6 summer, MST/−7 winter — the IANA zone resolves it per-date, no fixed offset). Previously parsed as UTC, which put the anchor up to 7h in the past so a campaign's **own** STOP replies tripped the upper bound (`sent_at <= anchor + 5min`) and were dropped as "send-after-stop" — the stage's opt-out counter read 0 while ~100 recipients had actually replied STOP. Empirically confirmed: across 132 messages (June, MDT) our ingest clock ran a rock-solid ~6h ahead of the stamped value. Suppression was never affected (the org-wide `opt_outs` row is still written); only stage-level attribution counters under-counted.
- Response adds `attributed` (STOPs credited to a stage — now 0 or 1 per STOP) and `unattributed` (suppressed STOPs that matched no send).
- Best-effort Telegram alert on failures.

### `/api/cron/send-scheduled` (scheduled sends)
- Calls `runScheduledSends()` ([`lib/sends/scheduled.ts`](../../lib/sends/scheduled.ts)) for stages with a due `scheduled_at` on a tracked campaign.
- Respects: `SEND_ENABLED` kill-switch, per-stage `send_approved`, the provider's **ET send window** (`decideScheduledSend`), resolvable credentials, and circuit breakers.
- Atomic claim via `sent_at`; a missed window sets `schedule_missed_at` (not locked, reschedulable). Cross-stage per-run budget accumulator caps total sends across N stages. See [sms-send-pipeline.md](sms-send-pipeline.md).
- Runs **every 5 min** (was `*/15`) — paired with the drain's concurrent sends (~20/sec), this lets a large scheduled audience drain materially faster across ticks. The drain is resumable, so leftover `pending` rows roll to the next tick.
- **`SEND_ENABLED` is OFF** in production — the live send path has not fired.

### `/api/keitaro/poll` (Keitaro results poll)
- Calls `pollKeitaro()` ([`lib/keitaro/poll.ts`](../../lib/keitaro/poll.ts)): `POST /admin_api/v1/report/build` over a rolling **3-day** ET window (`?windowDays=N` overrides, ≤30), grouped by `day` + `sub_id_3` + `campaign_id`.
- Maps each row's `sub_id_3` (= stage tracking id) → `campaign_stages.tracking_id` → stage/campaign/org, **classifies** each row's Keitaro campaign by **name** (`gk-lp-visits` = visits/Clickers, else offer redirect + sales — resolved to `campaign_id`(s) once; the visit campaign's alias is a random code, so match on name not alias), **folds** the per-campaign rows into one per-(stage, date) aggregate, then idempotently UPSERTs into `keitaro_stage_results`. Re-polling recomputes full-window totals and overwrites in place (last-write-wins) so late conversions attach to earlier clicks without double-counting.
- Fail-safe: a failed fetch returns `200 { degraded:true, error }` (logs + retries next cycle, never crashes); a single bad aggregate is counted (`errored`) and skipped, never aborting the batch. If the campaigns list (visit-name classifier) fails, rows fall back to redirect and `classification_degraded:true` is set. Unmatched `sub_id_3` values are sampled in the response for debugging.
- Returns `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, classification_degraded, visit_campaigns_matched, unmatched_samples, error }`. See [keitaro-poll.md](keitaro-poll.md). Read stored results via `GET /api/keitaro/results?campaign_id=<id>` or the cross-campaign `GET /api/keitaro/reports` (the `/reports` page).

### `/api/cron/telegram-report` (performance report)
- **One external trigger fires it every hour on the hour (UTC)**; the handler decides internally what to do based on the **current Warsaw time**, computed with `Intl`-backed `formatInTimeZone` (never offset arithmetic — the Warsaw/ET offsets shift on DST weeks).
  - Warsaw hour **11** → **daily** report for the **previous ET day** (final).
  - Warsaw hour **16–23** (not Sunday) → **hourly** update (today-so-far, ET).
  - Warsaw hour **0–1** (not Monday) → **hourly** update (belongs to the previous day's window; Mon 00/01 is Sunday's window, excluded).
  - otherwise → `200 { skipped: true }`.
- `?test=1` (still secret-protected) forces an immediate send regardless of time: hourly format if the current Warsaw hour is inside an hourly window shape, else daily. Response says which format was sent.
- **Five metrics**, aggregated across **all orgs** (this tool is single-org in practice; the cron has no session to scope by), for one ET calendar day — the same day-attribution basis the `/reports` page uses so the numbers reconcile:
  - **Sales / Revenue** → `salesRevenueTotals()` ([`lib/reporting/attribution.ts`](../../lib/reporting/attribution.ts)), conversion-dated (Keitaro `stat_date` ∨ manual-tally entry date, max-deduped per stage).
  - **Spend** → Σ `campaign_stages.total_cost` attributed to the stage's send moment (`sent_at`).
  - **Opt-outs** → count of `opt_outs` (`reason='opt_out'`) by `created_at`.
  - **Delivered** → `stage_sends` accepted by the provider (`status='sent'`) by `sent_at`. CamMan does **not** poll DLR (CLAUDE.md §12), so "delivered" here means "provider-accepted" — the closest real signal for the opt-out ratio.
  - **ROI %** = `(revenue − spend) / spend × 100`; `n/a` when spend = 0. Opt-out ratio = opt-outs ÷ delivered; `n/a` when delivered = 0.
  - **Net Profit** = `revenue − spend` (line after ROI). Renders sign-aware (`-$150.00` for a loss).
- Metric computation lives in [`lib/reporting/report-snapshot.ts`](../../lib/reporting/report-snapshot.ts) (`computeReportMetrics`). The message is sent via `sendTelegramHtml(text, timeoutMs)` ([`lib/alerts/telegram.ts`](../../lib/alerts/telegram.ts)) with `parse_mode: "HTML"` — a **non-swallowing** counterpart to `notifyTelegram()`: on any failure (missing config, network, non-200) it throws.
- **Resilient send:** the report fires once per hour with no natural recovery until the next tick, so the handler wraps the send in `sendHtmlWithRetry` — **2 attempts**, an **8 s** timeout each (up from the 4 s best-effort default), 1 s backoff.
- **Build + send are wrapped in ONE try/catch under a 50 s overall timeout** (`withTimeout`, below `maxDuration=60`). Any failure — send error, **or a hung/slow metrics build** — returns **500** (scheduler failure-monitoring still catches it) **and** fires a best-effort plain-text `notifyTelegram` alert (`⚠️ CamMan <format> report failed…`) so a dropped report is visible instead of silent. Earlier the build ran *outside* the catch, so a hung build produced no report and no alert — just a silent `maxDuration` kill.
- **Cold-start DB fan-out (why hourly silently died while daily worked, fixed 2026-07-07).** `buildHourly` used to run `2× computeReportMetrics` (today + yesterday) via `Promise.all` = **8 concurrent queries**; on a cold serverless start during busy ET hours that burst stalled the connection pooler past `maxDuration`. The queries themselves are ~16 ms — the cost was concurrent *connection acquisition*, not execution. Fix: hourly now fetches today's full metrics (4 queries) + yesterday's **spend only** (`spendInRange`, 1 query) **sequentially** — peak concurrency 4, matching the daily path that never failed. Daily (`buildDaily`, 4 queries at the quiet 05:00 ET hour) was always fine.
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (fail-fast 500 if missing when a send is due), `CRON_SECRET`.

### `/api/cron/refresh-offer-group-report` (offer group report refresh)
- Calls `refreshOfferGroupReport()` ([lib/reporting/offer-group-report.ts](../../lib/reporting/offer-group-report.ts)): `REFRESH MATERIALIZED VIEW CONCURRENTLY` on `offer_report_org_summary_mv` then `offer_group_report_mv` (two separate statements — `CONCURRENTLY` cannot run inside an explicit transaction), then stamps both `report_refresh_log` rows with `now()`.
- `maxDuration = 300` (not the default 60) — measured worst-case ~50s cold / ~37s warm for both refreshes against production data; this is a background job with nothing waiting on it, so the larger budget is free.
- **DST drift:** `0 5,20 * * *` is fixed-UTC → 00:00 & 15:00 ET in winter (EST), 01:00 & 16:00 ET in summer (EDT). ~1h drift across the transition, irrelevant for a twice-daily historical report — same tradeoff already accepted for `telegram-report`'s Warsaw-time schedule.
- No request body/params; returns `{ ok: true }`. See [offer-group-report.md](offer-group-report.md).

### `/api/cron/lookup-worker` (Telnyx number-lookup drain)
- Calls `runLookupWorker()` ([`lib/telnyx/worker.ts`](../../lib/telnyx/worker.ts)) every 2 min. See [phone-lookup-carrier.md](phone-lookup-carrier.md).
- **Single-runner lease** (not a `pg_try_advisory_lock` — advisory locks are unsafe through the transaction pooler): a `lookup_settings.worker_lease_until` row claimed via a conditional UPDATE (only if NULL/expired), leased 4 min, heartbeat-renewed (CAS on the token) each ~60 s, cleared on clean exit. An overlapping invocation exits as a no-op; a crashed drain's lease simply expires and the next tick proceeds — so a slow run can't multiply the effective Telnyx rate.
- **Guards in order:** `lookup_paused` → daily cap (SUM of `lookup_queue.attempts` since Warsaw midnight, so failed calls + retries consume cap) → Telnyx balance (`available_credit`; if it can't cover the next chunk → Telegram alert + skip, auto-resumes when topped up; a 402/feature-gate mid-run halts the run).
- **Claim:** `FOR UPDATE SKIP LOCKED`, incrementing `attempts` + stamping `updated_at` at claim (each claim = one Telnyx call). A 429'd row is left `pending` and skipped by a 60 s cooldown until it ages out (backoff); terminal failures (bad number / 3 attempts) mark the queue row `failed` and write **no** `phone_lookups` row (the contact stays `Unidentified`). Paced to `lookup_concurrency_rps`/sec.
- On each completed lookup, contact sync copies line_type/carrier down and, for landlines, cancels **pending** `stage_sends` + removes the contact from `campaign_audience_pool`. A drained batch is finalized (actual cost from the line-type mix) with a Telegram summary.

## 4. Data
- Reads/writes `clicks`, `geoip_cache`; `opt_outs`, `texthub_inbound_events`; `stage_sends`, `links`, `campaign_stages`, `send_circuit_events`; `keitaro_stage_results` (reads `campaign_stages`/`campaigns` for sub_id_3 mapping).
- `telegram-report` reads only: `organizations`, `keitaro_stage_results`, `stage_manual_sales`, `campaign_stages`, `opt_outs`, `stage_sends` (all via indexed date/status filters).
- `refresh-offer-group-report` rebuilds `offer_group_report_mv` / `offer_report_org_summary_mv` from `offer_report_campaign_econ` (a view over `campaigns`, `campaign_stages`, `stage_sends`, `stage_manual_sales`, `keitaro_stage_results`, `opt_out_attributions`) plus `contact_contact_groups`/`contact_groups`, and updates `report_refresh_log`.

## 5–7. Notes
- Vercel injects the `CRON_SECRET` Bearer header automatically when it calls the GET path; the dual POST paths exist so an operator can trigger the same work manually for their own org from the UI.
- All are idempotent / safe to run on a tick that has no work (`telegram-report` returns `{ skipped: true }` outside its send windows).
- Local testing: hit the endpoints with the Bearer header (see [08-local-setup.md](../08-local-setup.md)) and the various `scripts/test-*` scripts.
