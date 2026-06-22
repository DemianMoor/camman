# 07 — Conventions, Business Rules & Gotchas

_Last updated: 2026-06-22_

The authoritative source for project conventions is [`CLAUDE.md`](../CLAUDE.md) at the repo root. This page summarizes the rules a developer most needs and flags every doc↔code discrepancy found while writing these docs.

## Multi-tenancy (non-negotiable)
- Every domain table has `org_id`; **every query filters by it** in app code. A missing filter is a data-leak bug.
- One org-resolution helper per surface (`requireOrgMembership` for pages, `requireApiMembership` for API). Don't invent alternates.
- RLS is defense-in-depth; app-level filtering is primary.
- **Every `public` table must have RLS enabled** (Supabase advisor `rls_disabled_in_public`) — without it the anon key (shipped in the frontend bundle) can read/write it directly via PostgREST. Server-only infra tables with no client caller (e.g. `geoip_cache`, migration `0066`) enable RLS **with no policies**: the direct postgres-js connection (`DATABASE_URL`) and `service_role` bypass RLS, so server code keeps working while anon/authenticated access is default-denied. Tenant tables read by the browser need an `org_id`-scoped policy instead.

## IDs & naming
- **DB id vs business id vs human_id vs tracking_id** are four distinct things:
  - `id` — internal PK (serial / uuid / bigserial).
  - business id (`brand_id`, `offer_id`, `segment_id`, …) — unique user-facing text code on registry tables.
  - `human_id` — user-editable label on campaigns.
  - `tracking_id` — auto-generated, **immutable** analytics id (see below).
- **Tracking ID formats:**
  - Campaign: `<brand_id>_<offer_id>_<MMDDYY>_<seq>` (e.g. `5_14296_051526_1`).
  - Stage: `<campaign_tracking_id>_s<stage_number>_c<creative_id>`.
  - Date is campaign `created_at` in **ET**. **Not lexically sortable across year boundaries — always `ORDER BY created_at`.**
  - Immutable: PATCH rejects changes (`tracking_id_immutable`); changing brand/offer/creative later does not regenerate.
  - **Keitaro `sub_id_3` = the STAGE tracking id** (the offer postfix param carries it into the tracked URL), not a bare campaign id. The Keitaro poll groups by `sub_id_3` + `campaign_id` and maps back via `campaign_stages.tracking_id`; campaign totals are the SUM across stages. See [04-features/keitaro-poll.md](04-features/keitaro-poll.md).
  - **Keitaro `sub_id_1` = the per-recipient id** (= `stage_sends.id`), appended to the tracked link at redirect time for per-sale → phone attribution (conversions poll).
  - **`sub_idN` URL-param vs `sub_id_N` Keitaro-token spelling split (don't mix them up):** the inbound URL param has **no** underscore before the digit (`sub_id1`, `sub_id3`); the Keitaro token / report column / `conversions/log` column has the underscore (`sub_id_1`, `sub_id_3`). The campaign *Parameters* tab maps one onto the other. A mismatch silently breaks attribution (real past bug). Constants: `STAGE_TRACKING_PARAM = "sub_id3"` ([lib/stage-url.ts](../lib/stage-url.ts)), `RECIPIENT_SUB_ID_PARAM = "sub_id1"` ([lib/links/resolve-click.ts](../lib/links/resolve-click.ts)).
  - **Keitaro visit/redirect classification:** clicks are classified by the Keitaro campaign **name** `gk-lp-visits` (landing-page **visits** = "Clickers") vs **any other** campaign (**offer redirects**, whose conversions are sales). Match on **name, not alias** — in the live panel `gk-lp-visits` is the campaign's *name*; its *alias* is a random code (e.g. `ZttBSV`). Resolve the name → `campaign_id`(s) once, then classify rows by `campaign_id`; never hardcode the id (rebuild-safe). Funnel: Clickers → Offer Redirect → Sales, where visits ⊇ redirects (every redirect is also a visit) and the two are **never summed** — total arrivals = visit count. Headline numbers are the **clean** (bot/prefetch-filtered) counts.
- API route naming: `[parentEntityId]` for nested API segments, `[id]` for page routes (avoids Next's sibling-dynamic-segment prohibition).

## Timezone (ET everywhere)
- Single project timezone `CAMPAIGN_TIMEZONE = "America/New_York"`, label `"ET"` ([`lib/campaign-timezone.ts`](../lib/campaign-timezone.ts)). No per-user/per-org timezones yet (would mean editing one file).
- Storage UTC `TIMESTAMPTZ`; API fields are ISO 8601 with offset (`z.string().datetime({ offset: true })`).
- Display via `formatCampaignDateTime(utc)` — **never** bare date-fns `format()` on a campaign timestamp (renders in browser zone).
- Forms: `<input type="datetime-local">` ↔ `campaignLocalInputToUtcIso()` / `utcToCampaignLocalInput()`.
- Send windows evaluated in ET via `lib/quiet-hours.ts` — sender-zone, not recipient-zone (known TCPA limitation).
- **postgres-js timestamptz-inference gotcha:** binding a bare ET wall-clock string and casting `${s}::timestamp` (or `::timestamptz`) lets postgres-js infer a `timestamptz` parameter and **pre-shifts the instant** (a silent multi-hour error). To convert an external ET wall-clock (e.g. Keitaro's `datetime`) to the correct UTC instant, build a zoned literal instead: `(${s} || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz` — concatenation forces text binding; NULL concat → NULL. (Seen in `lib/keitaro/poll-conversions.ts`.)
- **TextHub inbox `received_at` is US Mountain Time, not UTC.** TextHub stamps inbound STOP messages "YYYY-MM-DD HH:MM:SS" with no zone in Mountain wall-clock (operator-confirmed). `parseProviderReceivedAt` ([`lib/sends/poll-opt-outs.ts`](../lib/sends/poll-opt-outs.ts)) interprets it in `America/Denver` (`TEXTHUB_RECEIVED_AT_TIMEZONE`, via `date-fns-tz` `fromZonedTime`) → true UTC; DST-aware (MDT/−6 summer, MST/−7 winter). ISO strings that carry their own offset are honored as-is. Parsing it as UTC (the original bug, fixed 2026-06-19) put the attribution anchor up to 7h early, so a campaign's own STOP replies failed the `sent_at <= anchor + 5min` upper bound and the stage's opt-out counter read 0 despite ~100 real replies. Empirically: our ingest clock ran a constant ~6h ahead of the stamped value (132 msgs, June/MDT).

## Money
- `NUMERIC(12,4)`, displayed `$`. `sales_payout_each` snapshots the offer CPA at the moment sales were entered so ROI doesn't drift if the offer is later edited.
- **Stage `total_cost`** (migration `0081`, [`lib/stages/total-cost.ts`](../lib/stages/total-cost.ts)) auto-derives as `cost_per_sms × (sms_count + opt_out_count)` from the stage's assigned provider phone — opt-out replies count toward the multiplier because STOPs are billed like sends. Recomputed wherever those inputs change (manual-results save, opt-out poller, provider-phone PATCH). `total_cost_manual=true` (operator override via the manual-results **Auto-calculate** switch, or a cost-bearing CSV import) freezes the value — the auto formula then leaves it alone.

## Database & migrations
- Drizzle schema in `db/schema.ts`; migrations **hand-authored** SQL in `db/migrations/` (db:generate blocks on a TTY rename prompt — see memory). Hand-write SQL + clone the snapshot forward + add the journal entry, then `db:migrate` + `verify-migration-integrity`.
- Migrations are **not** auto-applied on deploy — run them locally against the target `DATABASE_URL` before pushing dependent code.
- Soft-delete via `status='archived'` + `archived_at`; hard delete is rare and explicit (confirm before any DROP/DELETE/force-push).
- Connection: Supabase **transaction pooler (port 6543)** + `?prepare=false`; `db/client.ts` caches the pool on `globalThis` (don't strip).

## Feature flags
- `lib/feature-flags.ts` `ENTITY_AVAILABILITY` is the single source for "is this entity built?". Flip a new entity's flag to `true` **last**, after schema+API+UI work. Gate cross-entity fetches on `isEntityAvailable()` (no speculative 404s).

## Audience semantics
- Segment audience = manual membership **∪** rule matches (Model C); zero active rules ⇒ manual only (preserve this short-circuit).
- Campaign audience is **frozen at activation**; locked afterward (`audience_locked_after_draft`). Both `exclude_in_use_contacts` flags (segment + campaign) only consider `status='active'` campaigns.

## Sending safety
- Drain requires all of: `send_approved` (per stage) + the **two-switch send gate** + `CRON_SECRET`/`campaigns.drain` + provider not `send_paused`.
- **Two-switch send gate (migration 0063):** the drain needs BOTH `SEND_ENABLED="true"` (env — the deploy-level **backstop**, left permanently on in Vercel; refuses `send_disabled`) AND `org_settings.sends_enabled=true` (DB — the **daily on/off** in Settings → Sending, manager+, audited in `org_setting_events`; refuses `send_disabled_org`). Don't collapse them: the env var is the basement breaker (there only if a UI bug or compromised session flips the DB flag), the DB flag is the operational switch, `send_paused` is the per-provider "something broke" breaker. The DB flag is re-read each batch ⇒ a true mid-run kill; the env var is immutable per invocation.
- `send_paused` is a latching kill-switch — requires a conscious human resume; trips/resumes audited in `send_circuit_events`.
- **Submission evidence + classification (migration 0064):** every send attempt writes an append-only `send_attempts` row (verbatim TextHub body + redacted request — api_key NEVER persisted). Classification rules (`lib/sends/classify-attempt.ts`): an outcome not confidently a success ⇒ `indeterminate`, **never** counted as sent; `indeterminate`/`sending` rows are **never auto-retried** (preserves at-most-once). Buckets map to owners: `mine_transport`=us, `theirs_rejected`=escalate, `indeterminate`=reconcile.
- **`filtered` send status (migration 0065) is LABEL-ONLY.** A TextHub rejection carrying the structured `{"status":"Suppressed"}` envelope is recorded as `stage_sends.status='filtered'` (not `'failed'`), gated strictly on the `status` token via `isSuppressedStatus()` — never the HTTP code or the free-text `response`. It does **not** add the number to `opt_outs` and does **not** exclude it from future campaigns; it is purely a visible classification (violet "Filtered" tile + Messages filter/badge, separate `filtered` count in the drain result + `send_drain` event). Because it leaves the `failed` bucket, suppressions no longer paint a stage red/"needs attention". Auto opt-out capture / pre-send skipping is deliberately deferred.
- **Reconciliation:** `pool = attempted + excluded(opt_out|filter|split) + gap`; a non-zero `gap` is OUR bug (a materialized recipient went missing) and is surfaced, never hidden in count math.
- **Copy rule:** the system says **"Submitted" / "Accepted by TextHub", never "Delivered."** There is no DLR — the strongest claim is that TextHub accepted the message.
- `SEND_ENABLED` stays ON in production as the backstop; `org_settings.sends_enabled` defaults OFF and gates day-to-day. Live sending has not fired.
- **`campaign_stages.sent_at` is the scheduler fire-lock** — the `send-scheduled` cron only considers stages with `sent_at IS NULL`. Only the pipeline (scheduler / manual drain backfill) may write it on a tracked campaign. Marking a **tracked** stage `'sent'` via the manual status action is blocked (409) so bookkeeping can't silently cancel a scheduled send.
- **`sent_at` is stamped IF AND ONLY IF a drain actually attempted ≥1 send (`processed > 0`)** (Bug 1). Neither scheduler Phase A (materialize) nor any gate-refused drain (env `SEND_ENABLED` off, DB `sends_enabled` off, `send_paused`, window closed) may stamp it — a refused stage stays armed and re-selectable, never a false "Sent". Re-materialization is prevented by the rows existing, not by `sent_at`.
- **Stage tracking-link param is the fixed `sub_id3`** (`STAGE_TRACKING_PARAM`, [lib/stage-url.ts](../lib/stage-url.ts)) — the key Keitaro ingests for attribution, the same for every offer; NOT the per-offer `postfix` (operators set those to page slugs). The send mint uses the stage's stored **`full_url`** (operator's source of truth), not a server-side rebuild (Bug 3).
- **Scheduled sends are batched + resumable.** Kickoff mints links in bulk (never per-recipient — that blew the 300s cron limit at ~178s/1000), and the drain resumes across `*/15` ticks (phase B drains `pending` rows in budget-bounded batches). Large audiences send over multiple ticks, paced by the provider's `max_sends_per_run` / `max_sends_per_minute`.
- **A stage can't be scheduled in the past.** Stage create (`POST`) and edit (`PATCH`) reject a `scheduled_at` earlier than now (60s grace for minute-granularity input) with a `validation` error on `scheduled_at`; PATCH only enforces it when the value actually changes, so an unrelated edit to a stage with a historical schedule still saves. The shared guard is [`lib/sends/schedule-guard.ts`](../lib/sends/schedule-guard.ts) (`isScheduledAtInPast`), mirrored client-side in the stage form (inline error + blocked save).
- **Emergency hard-stop on Today's sends.** `org_settings.sends_paused` (migration 0080) is a one-click org-wide pause flipped from the Today's sends screen, independent of the daily `sends_enabled` switch. The drain re-reads it every batch, so engaging it halts any in-flight send at the next batch boundary and refuses new ones — no further message is submitted via the provider API until "Proceed" clears it. See [04-features/sms-send-pipeline.md](04-features/sms-send-pipeline.md).
- **WS4 terminology is locked:** the action is **"Prepare"** (approve + materialize + mint links → `stage_sends` rows), the resulting state is **"Prepared"**. Never "Arm"/"Armed". The Prepare confirm popup is ONE shared component ([stage-prepare-dialog.tsx](../components/campaigns/stage-prepare-dialog.tsx)) used by every entry point (list row + editor) — never duplicate it.
- **Operational status is derived, not the `status` column.** [lib/stages/stage-status.ts](../lib/stages/stage-status.ts) is the single source for the five-state "will it send?" model (draft / scheduled_unprepared / prepared / sending_sent / missed_failed). The **Orange↔Blue split is materialization** (`stage_sends` rows exist), NOT whether `scheduled_at` is set — a scheduled stage with no rows is Orange ("won't send until you Prepare it"). It applies to `link_mode='tracked'` only (returns `null` otherwise → manual-status color). Don't hardcode these colors/labels elsewhere; the row renderer, legend, and fleet dashboard all import the map. See [04-features/daily-volume-ui.md](04-features/daily-volume-ui.md).

## UI
- `<FormDialog>` for input dialogs (blocks accidental dismissal); `<AlertDialog>` for confirmations; bare `<Dialog>` read-only.
- Required fields → red asterisk via `<FormLabel required>`; no "(optional)" text.
- `<FileDropZone>` for all file pickers; `<MultiSelectPicker>` for >10-option selection; `<CopyableId>` for system ids.

---

## ⚠️ Doc ↔ code discrepancies (resolve these)

| # | Claim | Reality (code) | Where |
|---|-------|----------------|-------|
| 1 | CLAUDE.md §10b: `draft → active` gates on "name + brand + offer + **≥1 segment**" | Code gates on name + brand + offer + **≥1 contact group**; **segments are optional** | `app/api/campaigns/[campaignId]/status/route.ts` ~L118–135 |
| 2 | ~~`db/schema.ts` `segment_rules_rule_type_check` CHECK list omits `is_in_contact_group`~~ **RESOLVED (migration `0069`)** | `0069` restated the full IN-list (adding the `made_purchase_*` types) and updated `db/schema.ts` + the snapshot to match the live constraint, including `is_in_contact_group` | `lib/segment-rules-eval.ts`, `db/migrations/0069`, `db/schema.ts` |
| 3 | `.env.example` shows `DATABASE_URL` port `5432` / "Session Pooler" | CLAUDE.md §6 mandates **transaction pooler 6543** for serverless; `.env.example` comment is stale on this point | `.env.example`, CLAUDE.md §6 |
| 4 | Original wishlist mentions a command palette | **No command palette / cmdk exists** in the codebase (confirmed absent 2026-06-05) | grep across `components/`, `app/` |
| 5 | `proxy.ts` protected-prefix list (`/dashboard`,`/brands`,`/settings`) | Narrower than the full protected route set; the real gate is `requireOrgMembership()` in the protected layout | `proxy.ts`, `app/(protected)/layout.tsx` |

## Campaign activity log (`campaign_events`)
- Append-only audit of campaign/stage actions, written by `logCampaignEvent()` ([lib/campaign-events.ts](../lib/campaign-events.ts)) at each mutation point and shown in the campaign **Activity** tab. See [04-features/campaign-activity-log.md](04-features/campaign-activity-log.md).
- `event_type` is **free-text, not CHECK-constrained** — the allowed set is the `CampaignEventType` union in code, so new kinds need no migration. Don't add a CHECK.
- Logging is **best-effort** (the helper swallows its own errors) so an audit write can't break the user action. Inside a transaction it must be the **last** statement and is trusted — a thrown error there aborts the whole tx regardless of the catch (Postgres aborts on any error). Outside a tx, the swallow makes it truly non-fatal.
- `actor_user_id` NULL ⇒ system/cron (e.g. the scheduled drain); the UI renders "System / automatic".
- The Activity **Messages** drill-down reads `stage_sends` live — individual recipient sends are **never** copied into `campaign_events`.

## Open `[VERIFY]` items (could not confirm from source in this pass)
- Exact production `DATABASE_URL` pooler port (6543 expected) — discrepancy #3.
- The live DB's `segment_rules` CHECK contents — discrepancy #2.
- Per-route `runtime` / `dynamic` exports for cron + redirect handlers (Node runtime / force-dynamic expected).
- How `campaign_stages.status` / `sent_at` are reconciled after a TextHub drain (kickoff/drain operate only on `stage_sends`).
- Whether any protected page is reachable without a server-side membership check — discrepancy #5.
