# 07 — Conventions, Business Rules & Gotchas

_Last updated: 2026-06-15_

The authoritative source for project conventions is [`CLAUDE.md`](../CLAUDE.md) at the repo root. This page summarizes the rules a developer most needs and flags every doc↔code discrepancy found while writing these docs.

## Multi-tenancy (non-negotiable)
- Every domain table has `org_id`; **every query filters by it** in app code. A missing filter is a data-leak bug.
- One org-resolution helper per surface (`requireOrgMembership` for pages, `requireApiMembership` for API). Don't invent alternates.
- RLS is defense-in-depth; app-level filtering is primary.

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
  - **Keitaro visit/redirect classification:** clicks are classified by the Keitaro campaign **name** `gk-lp-visits` (landing-page **visits** = "Clickers") vs **any other** campaign (**offer redirects**, whose conversions are sales). Match on **name, not alias** — in the live panel `gk-lp-visits` is the campaign's *name*; its *alias* is a random code (e.g. `ZttBSV`). Resolve the name → `campaign_id`(s) once, then classify rows by `campaign_id`; never hardcode the id (rebuild-safe). Funnel: Clickers → Offer Redirect → Sales, where visits ⊇ redirects (every redirect is also a visit) and the two are **never summed** — total arrivals = visit count. Headline numbers are the **clean** (bot/prefetch-filtered) counts.
- API route naming: `[parentEntityId]` for nested API segments, `[id]` for page routes (avoids Next's sibling-dynamic-segment prohibition).

## Timezone (ET everywhere)
- Single project timezone `CAMPAIGN_TIMEZONE = "America/New_York"`, label `"ET"` ([`lib/campaign-timezone.ts`](../lib/campaign-timezone.ts)). No per-user/per-org timezones yet (would mean editing one file).
- Storage UTC `TIMESTAMPTZ`; API fields are ISO 8601 with offset (`z.string().datetime({ offset: true })`).
- Display via `formatCampaignDateTime(utc)` — **never** bare date-fns `format()` on a campaign timestamp (renders in browser zone).
- Forms: `<input type="datetime-local">` ↔ `campaignLocalInputToUtcIso()` / `utcToCampaignLocalInput()`.
- Send windows evaluated in ET via `lib/quiet-hours.ts` — sender-zone, not recipient-zone (known TCPA limitation).

## Money
- `NUMERIC(12,4)`, displayed `$`. `sales_payout_each` snapshots the offer CPA at the moment sales were entered so ROI doesn't drift if the offer is later edited.

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
- Drain requires all of: `send_approved` (per stage) + `SEND_ENABLED="true"` (env) + `CRON_SECRET`/`campaigns.drain` + provider not `send_paused`.
- `send_paused` is a latching kill-switch — requires a conscious human resume; trips/resumes audited in `send_circuit_events`.
- `SEND_ENABLED` is OFF in production; live sending has not fired.
- **`campaign_stages.sent_at` is the scheduler fire-lock** — the `send-scheduled` cron only considers stages with `sent_at IS NULL`. Only the pipeline (scheduler / manual drain backfill) may write it on a tracked campaign. Marking a **tracked** stage `'sent'` via the manual status action is blocked (409) so bookkeeping can't silently cancel a scheduled send. The scheduler stamps `sent_at` **after** materializing (not before), so a timed-out tick can't strand a stage.
- **Scheduled sends are batched + resumable.** Kickoff mints links in bulk (never per-recipient — that blew the 300s cron limit at ~178s/1000), and the drain resumes across `*/15` ticks (phase B drains `pending` rows in budget-bounded batches). Large audiences send over multiple ticks, paced by the provider's `max_sends_per_run` / `max_sends_per_minute`.

## UI
- `<FormDialog>` for input dialogs (blocks accidental dismissal); `<AlertDialog>` for confirmations; bare `<Dialog>` read-only.
- Required fields → red asterisk via `<FormLabel required>`; no "(optional)" text.
- `<FileDropZone>` for all file pickers; `<MultiSelectPicker>` for >10-option selection; `<CopyableId>` for system ids.

---

## ⚠️ Doc ↔ code discrepancies (resolve these)

| # | Claim | Reality (code) | Where |
|---|-------|----------------|-------|
| 1 | CLAUDE.md §10b: `draft → active` gates on "name + brand + offer + **≥1 segment**" | Code gates on name + brand + offer + **≥1 contact group**; **segments are optional** | `app/api/campaigns/[campaignId]/status/route.ts` ~L118–135 |
| 2 | `db/schema.ts` `segment_rules_rule_type_check` CHECK list omits `is_in_contact_group` | The eval and migration `0031` support `is_in_contact_group`; the DB constraint (post-0031) is authoritative | `lib/segment-rules-eval.ts`, `db/migrations/0031`, `db/schema.ts` L905–917 |
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
