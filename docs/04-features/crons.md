# Feature — Cron Jobs

_Last updated: 2026-06-05_

## 1. Purpose
All scheduled/deferred work runs via **Vercel Cron** (no job queue — CLAUDE.md §12). Three endpoints, each fired every 15 minutes, authenticated with `Authorization: Bearer <CRON_SECRET>`.

## 2. The jobs (`vercel.json`)
| Path | Schedule | Job | Auth |
|------|----------|-----|------|
| `/api/clicks/score-pending` | `*/15 * * * *` | enrich + score click rows | CRON_SECRET only (503 if unset) |
| `/api/opt-outs/poll` | `*/15 * * * *` | poll TextHub inbox for STOP intake | CRON_SECRET (GET, all orgs) **or** session operator+ (POST, own org) |
| `/api/cron/send-scheduled` | `*/15 * * * *` | fire scheduled tracked sends | CRON_SECRET (GET, all orgs) **or** session `campaigns.drain` (POST, own org) |

## 3. How each works

### `/api/clicks/score-pending` (click scoring)
- CRON_SECRET Bearer only; returns 401 on bad/missing secret, **503 if `CRON_SECRET` is unconfigured**.
- Params: `?mode=pending|rescore` (default pending), `?maxRows=N` (default 2000, ≤20000).
- Calls `scoreClicks()` ([`lib/links/score-clicks.ts`](../../lib/links/score-clicks.ts)); Node runtime (filesystem for the MaxMind `.mmdb`).
- Returns `{ mode, scored, byClassification, capped, degraded, enrichment }`. `degraded:true` ⇒ no rows scored (enrichment failed) — rows stay pending. See [tracking-attribution.md](tracking-attribution.md).

### `/api/opt-outs/poll` (STOP intake)
- Polls each provider credential's TextHub `?inbox=true` endpoint and inserts new opt-outs (`opt_outs`, source `sms_inbound`, org-wide). The TextHub *push* callback is broken on their side, so intake pivoted to **polling**; the Stage-A inbound webhook is a dormant fallback. Manual "Poll now" button uses the POST path (operator+).
- Best-effort Telegram alert on failures.

### `/api/cron/send-scheduled` (scheduled sends)
- Calls `runScheduledSends()` ([`lib/sends/scheduled.ts`](../../lib/sends/scheduled.ts)) for stages with a due `scheduled_at` on a tracked campaign.
- Respects: `SEND_ENABLED` kill-switch, per-stage `send_approved`, the provider's **ET send window** (`decideScheduledSend`), resolvable credentials, and circuit breakers.
- Atomic claim via `sent_at`; a missed window sets `schedule_missed_at` (not locked, reschedulable). Cross-stage per-run budget accumulator caps total sends across N stages. See [sms-send-pipeline.md](sms-send-pipeline.md).
- **`SEND_ENABLED` is OFF** in production — the live send path has not fired.

## 4. Data
- Reads/writes `clicks`, `geoip_cache`; `opt_outs`, `texthub_inbound_events`; `stage_sends`, `links`, `campaign_stages`, `send_circuit_events`.

## 5–7. Notes
- Vercel injects the `CRON_SECRET` Bearer header automatically when it calls the GET path; the dual POST paths exist so an operator can trigger the same work manually for their own org from the UI.
- All three are idempotent / safe to run on a tick that has no work.
- Local testing: hit the endpoints with the Bearer header (see [08-local-setup.md](../08-local-setup.md)) and the various `scripts/test-*` scripts.
