# Feature — Cron Jobs

_Last updated: 2026-06-24_

## 1. Purpose
All scheduled/deferred work runs via **Vercel Cron** (no job queue — CLAUDE.md §12). Four endpoints authenticated with `Authorization: Bearer <CRON_SECRET>`.

## 2. The jobs (`vercel.json`)
| Path | Schedule | Job | Auth |
|------|----------|-----|------|
| `/api/clicks/score-pending` | `*/15 * * * *` | enrich + score click rows, then propagate clean clicks → `clickers` | CRON_SECRET only (503 if unset) |
| `/api/opt-outs/poll` | `*/15 * * * *` | poll TextHub inbox for STOP intake | CRON_SECRET (GET, all orgs) **or** session operator+ (POST, own org) |
| `/api/cron/send-scheduled` | `*/5 * * * *` | fire scheduled tracked sends | CRON_SECRET (GET, all orgs) **or** session `campaigns.drain` (POST, own org) |
| `/api/keitaro/poll` | `*/5 * * * *` | pull Keitaro clicks/conversions → `keitaro_stage_results` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
| `/api/keitaro/poll-conversions` | `*/15 * * * *` | per-recipient SALE attribution → `stage_sends.sale_status` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |
| `/api/keitaro/poll-offer-reaches` | `*/15 * * * *` | per-recipient OFFER-PAGE REACH (Level 2) → `stage_sends.offer_reached_at` | CRON_SECRET (all orgs) **or** session `result_imports.create` (operator+, POST/GET) |

## 3. How each works

### `/api/clicks/score-pending` (click scoring)
- CRON_SECRET Bearer only; returns 401 on bad/missing secret, **503 if `CRON_SECRET` is unconfigured**.
- Params: `?mode=pending|rescore` (default pending), `?maxRows=N` (default 2000, ≤20000).
- Calls `scoreClicks()` ([`lib/links/score-clicks.ts`](../../lib/links/score-clicks.ts)); Node runtime (filesystem for the MaxMind `.mmdb`).
- After scoring, calls `propagateTrackedClickers()` ([`lib/links/propagate-clickers.ts`](../../lib/links/propagate-clickers.ts)) to materialize freshly-scored clean (`human`) clicks into the `clickers` engagement table so segment clicker rules see them. Best-effort (a failure here is logged but does not fail the scoring run) and idempotent.
- Returns `{ mode, scored, byClassification, capped, degraded, enrichment, clickersInserted }`. `degraded:true` ⇒ no rows scored (enrichment failed) — rows stay pending. See [tracking-attribution.md](tracking-attribution.md).

### `/api/opt-outs/poll` (STOP intake)
- Polls each provider credential's TextHub `?inbox=true` endpoint and inserts new opt-outs (`opt_outs`, source `sms_inbound`, org-wide). The TextHub *push* callback is broken on their side, so intake pivoted to **polling**; the Stage-A inbound webhook is a dormant fallback. Manual "Poll now" button uses the POST path (operator+).
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

## 4. Data
- Reads/writes `clicks`, `geoip_cache`; `opt_outs`, `texthub_inbound_events`; `stage_sends`, `links`, `campaign_stages`, `send_circuit_events`; `keitaro_stage_results` (reads `campaign_stages`/`campaigns` for sub_id_3 mapping).

## 5–7. Notes
- Vercel injects the `CRON_SECRET` Bearer header automatically when it calls the GET path; the dual POST paths exist so an operator can trigger the same work manually for their own org from the UI.
- All four are idempotent / safe to run on a tick that has no work.
- Local testing: hit the endpoints with the Bearer header (see [08-local-setup.md](../08-local-setup.md)) and the various `scripts/test-*` scripts.
