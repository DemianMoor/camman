# Daily-Volume UI (WS4)

_Last updated: 2026-07-10_

The operating layer that makes running many tracked SMS campaigns a day fast and
legible. Purely additive UI + read endpoints over the existing send pipeline
([sms-send-pipeline.md](sms-send-pipeline.md)); no change to the send path itself.

## Terminology (locked)

- **Prepare** (the action) = approve + materialize + mint links → creates
  `stage_sends` rows. Button label: **Prepare**.
- **Prepared** (the resulting state) = rows exist, waiting for the scheduled
  window to drain. Never "Arm"/"Armed" (the old wording was renamed throughout).

## The operational status model (§0)

One source of truth: [lib/stages/stage-status.ts](../../lib/stages/stage-status.ts).
A `status → { color, label, meaning, willSend, sortWeight, …classes }` map
(`STAGE_STATUS_META`) plus `deriveStageOperationalStatus()`. Every surface — the
stages-list row renderer, the legend, the fleet dashboard — imports from here, so
the legend stays honest by construction.

This is **distinct** from the user-editable `campaign_stages.status` column
(draft/pending/sent/success/cancelled/failed), a manual record. The operational
status is **derived** from the send pipeline and answers "will this stage fire?".

| Color | Key | Label | Will it send? |
|---|---|---|---|
| ⚪ Grey | `draft` | Draft | No — not scheduled/configured |
| 🟠 Orange | `scheduled_unprepared` | Scheduled, not prepared | **No** — time set, no rows |
| 🟣 Indigo | `materializing` | Materializing | In progress — rows landing in the background, not sendable yet |
| 🔵 Blue | `prepared` | Prepared | Yes — fully materialized, waiting |
| 🟢 Green | `sending_sent` | Sending / Sent | Submitted to provider |
| 🔴 Red | `missed_failed` | Missed / Failed | Needs attention |

**The non-negotiable rule:** Orange↔Blue is driven by **materialization**, NOT by
whether `scheduled_at` is set. A scheduled stage with no rows reads Orange ("won't
send until you Prepare it"); once fully materialized it reads Blue. This depends on
Bug 1 (false `sent_at`) being fixed so a missed send reads Red, not Green.

**Indigo `materializing` (WS5):** materialization is windowed + resumable (see
[sms-send-pipeline.md](sms-send-pipeline.md)), so a stage can have SOME
`stage_sends` rows while `campaign_stages.materialized_at` is still NULL. That
in-between state reads Indigo — the audience is incomplete and **cannot send yet**
(the cron finishes it, then it flips to Blue). The deriver keys off `materializedAt`,
not row existence, precisely so a half-built batch never reads "Prepared".

`deriveStageOperationalStatus()` returns `null` for stages off the pipeline
(manual-mode campaigns, archived stages) — callers fall back to the manual-status
color. The model applies only to `link_mode = 'tracked'` campaigns.

## Group A — stage operation & status

- **A2 — shared Prepare popup.** [components/campaigns/stage-prepare-dialog.tsx](../../components/campaigns/stage-prepare-dialog.tsx)
  is the ONE confirm popup, used by both the stages-list row and the stage editor
  ([stage-send-panel.tsx](../../components/campaigns/stage-send-panel.tsx)). Runs
  the WS2 preflight ([lib/sends/preflight.ts](../../lib/sends/preflight.ts), now
  also returning `preview_text`), renders the readiness checklist + message
  preview + segment count regardless of entry point, then calls `approve-send`.
- **A3 — row colors.** The stages list (`app/(protected)/campaigns/[id]/page.tsx`)
  colors each row via `rowClassName` on the shared `DataTable` and shows a "Send"
  column with the operational badge. Counts come from the stages-list endpoint's
  new `send_counts` field (one batched grouped query, no N+1).
- **A4 — one-click Prepare on Orange rows.** Orange rows carry a **Prepare**
  button that opens the A2 popup in place (full checklist), flipping Orange→Blue
  without opening the editor. Mirrored on the fleet dashboard.
- **A5 — legend.** [components/campaigns/stage-status-legend.tsx](../../components/campaigns/stage-status-legend.tsx)
  — collapsed "Status guide" affordance consuming the same §0 map.
- **A6 — bulk Prepare:** deliberately **not** built (deferred).

## Group B — monitoring & dashboards

- **B1 — Fleet "Today" dashboard.** `/sends/today`
  ([page](../../app/(protected)/sends/today/page.tsx)) +
  `GET /api/sends/today`. Every tracked stage scheduled/sent/missed today (ET),
  status-derived server-side, Orange/Red sorted to the top, links into each
  campaign. Hosts the meter, window indicator, and stuck callout.
  - **Emergency hard-stop.** A "Hard stop" button (manager+, `campaigns.drain`)
    flips `org_settings.sends_paused` via `POST /api/sends/pause`. While engaged,
    a red banner with a "Proceed (resume sending)" button replaces it. The pause
    state rides on `GET /api/sends/state` (`sends_paused`); the drain halts any
    in-flight send at its next batch and refuses new ones until cleared. See
    [sms-send-pipeline.md](sms-send-pipeline.md).
- **B2 — readiness checklist surface.** [components/sends/stage-readiness-checklist.tsx](../../components/sends/stage-readiness-checklist.tsx)
  shows the live green/red preflight checklist on the stage before Prepare. Spam
  score is advisory, never a gate (numeric score display deferred).
- **B3 — send-state strip (= Bug 2 fix).** [components/sends/send-state-strip.tsx](../../components/sends/send-state-strip.tsx)
  in the app header (`app/(protected)/layout.tsx`), fed by `GET /api/sends/state`.
  Two distinct operational states: global `sends_enabled` (master switch) and
  per-provider `send_paused` (breaker), kept visually separate from provider
  capability/"Active" badges. The existing
  [live-sending-banner.tsx](../../components/sends/live-sending-banner.tsx) stays
  on the stage panel + provider page.
- **B4 — volume-vs-caps meter.** [components/sends/volume-caps-meter.tsx](../../components/sends/volume-caps-meter.tsx)
  — org-wide count of messages sent on the current **ET calendar day** (label
  "Sent today (ET)") vs the aggregate effective `max_sends_per_24h`. The displayed
  count is calendar-day so it reads as a true "what went out today" total and
  matches the stage list; the breaker itself still accounts in a rolling
  trailing-24h window (`countSentSince` in the drain), so near midnight the
  meter can read lower than the breaker's view. `today.sent_today` on
  `GET /api/sends/state`.
  - **Prepared for today.** A companion line above the meter (same card) shows
    the total messages **prepared** (materialized) across every stage in play
    today = `Σ counts.total` of the `GET /api/sends/today` rows, computed
    client-side (no API change). It accumulates as each stage is prepared, and
    since sent ⊆ prepared it pairs with the "Sent today" figure below it.
- **B5 — send-window indicator.** [components/sends/send-window-indicator.tsx](../../components/sends/send-window-indicator.tsx)
  — "opens 08:00 ET" / "open · closes in 3h 12m" from
  `sendWindowForDay()` ([lib/quiet-hours.ts](../../lib/quiet-hours.ts)). Sender's
  fixed ET zone (v1 limitation).
- **B6 — stuck-row callout.** Rows stuck in `sending` (process died mid-send,
  never auto-retried) surface as a count in the strip + a callout on the fleet
  dashboard.
- **B7 — per-recipient drill-down.** The Activity → Messages view gains a "Needs
  attention" status filter (`failed`/`rejected`/`sending`) backed by the messages
  API. Grouped-error classification, escalation export, and "Retry failed" remain
  on the stage send panel (WS3).

## Endpoints added

- `GET /api/sends/state` — global flags (incl. `sends_paused`) + paused providers
  + today's ET-calendar-day sent count (`today.sent_today`) / 24h cap + stuck
  count. Permission `campaigns.view`. Never emits credentials.
- `POST /api/sends/pause` — `{ paused: boolean }`, the emergency hard-stop toggle.
  Permission `campaigns.drain` (manager+); audited in `org_setting_events`.
- `GET /api/sends/today` — fleet dashboard data (tracked stages in play today).
  Permission `stages.view`.
- `GET /api/campaigns/[campaignId]/stages` — now also returns `link_mode` and
  per-stage `send_counts`.
- `POST /api/campaigns/[campaignId]/stages/[stageId]/send/preflight` — now also
  returns `preview_text`.
- `GET /api/campaigns/[campaignId]/activity/messages` — `status=attention` group.
