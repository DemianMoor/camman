# Campaign Activity Log

_Last updated: 2026-07-07_

The **Activity** section at the bottom of a campaign's detail page
([app/(protected)/campaigns/[id]/page.tsx](../../app/(protected)/campaigns/[id]/page.tsx))
surfaces everything that has happened to a campaign — lifecycle changes, stage
authoring, the API send pipeline, and result imports — plus a per-recipient
drill-down of the actual messages.

It is **read-only** (any org member with `campaigns.view`). Nothing here
triggers sends or mutations.

## Two data sources

| Surface | Source | Notes |
| --- | --- | --- |
| **Timeline** (audit events) | `campaign_events` table | Append-only log written by `logCampaignEvent()` at each mutation point. Coarse — one row per action, **not** per recipient. |
| **Messages** (drill-down) | `stage_sends` (live) + `texthub_inbound_events` | Per-recipient send rows, filterable by stage / status / phone. Each row is joined to its latest matching TextHub reply. Never duplicated into `campaign_events`. |
| **Summary cards** | `stage_sends` aggregate + reply count | Sent / Failed / In-flight / Replies / Last send time. |

## `campaign_events` ([db/schema.ts](../../db/schema.ts))

Append-only. Columns: `id bigserial`, `org_id`, `campaign_id`, `stage_id?`
(SET NULL on stage delete), `event_type` (free-text), `actor_user_id?`
(NULL ⇒ system/cron), `summary` (human one-liner), `metadata jsonb?`,
`created_at`. Migration `0060_campaign_events`. RLS: org-scoped SELECT only —
writes go through the app's privileged connection (mirrors `send_circuit_events`).

- **`event_type` is intentionally NOT CHECK-constrained.** The allowed set is
  the `CampaignEventType` union in [lib/campaign-events.ts](../../lib/campaign-events.ts);
  adding a new kind is a one-line code change, no migration.

### Logged event types (v1)

`campaign_created` · `campaign_status_changed` (activate / pause / complete /
archive / restore) · `stage_created` (create + duplicate) ·
`stage_status_changed` · `stage_scheduled` (set / moved / cleared — logged only
when the value actually changes) · `stage_deleted` (hard delete of a
never-sent, no-results stage — `stage_id` is NULL on the row itself since the
stage is gone; see [campaigns-stages-creatives.md](campaigns-stages-creatives.md#deleting-stages))
· `send_approved` · `send_kickoff` (materialized recipient count) · `send_drain`
(sent / failed / stop reason; written even for cron-driven runs, actor NULL) ·
`results_imported` · `results_reverted`.

Generic field edits (renames, notes) are deliberately **not** logged — they'd
bury the send-relevant signal. Add more types as needed.

## `logCampaignEvent(dbc, {...})` ([lib/campaign-events.ts](../../lib/campaign-events.ts))

The single write helper. **Best-effort**: it swallows (logs) its own errors so an
audit-write failure can never break the user action. Pass the surrounding
transaction (`tx`) where one exists so the event commits atomically with its
action; otherwise pass `db`. When inside a transaction it must be the **last**
statement and is trusted not to fail — a thrown error there would abort the whole
transaction regardless of the catch (Postgres aborts the tx on any error).

## API

- `GET /api/campaigns/[campaignId]/activity?page&pageSize`
  → `{ summary: { sent, failed, rejected, pending, sending, total, replies,
  last_sent_at, by_stage[] }, events: { data[], totalCount, page, pageSize } }`.
  Timeline events join `auth.users` to resolve the actor's display name (NULL ⇒
  the UI shows "System / automatic").
- `GET /api/campaigns/[campaignId]/activity/messages?page&pageSize&stageId&status&search`
  → paginated `stage_sends` rows, each `LEFT JOIN LATERAL` to its latest
  `texthub_inbound_events` reply (matched `texthub_message_id =
  provider_message_id`). `search` is a phone `ILIKE`.

Indexed for scale by `stage_sends_campaign_created_idx (campaign_id,
created_at)`, added in the same migration.

## UI

[components/campaigns/campaign-activity-section.tsx](../../components/campaigns/campaign-activity-section.tsx):
summary cards on top, then a **Timeline ⇄ Messages** tab toggle. Times render via
`formatCampaignDateTime` (ET). The send pipeline writes the underlying data — see
[sms-send-pipeline.md](sms-send-pipeline.md).
