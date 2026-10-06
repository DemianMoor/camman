# Campaign Activity Log

_Last updated: 2026-10-06_

The **Activity** section at the bottom of a campaign's detail page
([app/(protected)/campaigns/[id]/page.tsx](../../app/(protected)/campaigns/[id]/page.tsx))
surfaces everything that has happened to a campaign — lifecycle changes, stage
authoring, the API send pipeline, and result imports — plus a per-recipient
drill-down of the actual messages.

It is **read-only** (any org member with `campaigns.view`). Nothing here
triggers sends or mutations.

## Data sources

| Surface | Source | Notes |
| --- | --- | --- |
| **Timeline** (audit events) | `campaign_events` table | Append-only log written by `logCampaignEvent()` at each mutation point. Coarse — one row per action, **not** per recipient. |
| **Messages** (drill-down) | `stage_sends` (live) + `texthub_inbound_events` | Per-recipient send rows, filterable by stage / status / phone. Each row is joined to its latest matching TextHub reply. Never duplicated into `campaign_events`. |
| **Summary cards** | `stage_sends` status aggregate + linked STOP replies | See [Summary cards](#summary-cards). |
| **Delivery cards** + **By stage & number** tab | `stage_delivery_rollup` + the live delivery query ([lib/reporting/campaign-activity.ts](../../lib/reporting/campaign-activity.ts)) | See [Delivery cards](#delivery-cards). |

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

## Summary cards

All lifetime, every stage of the campaign. Rebuilt 2026-10-06 (ClickUp 869fchavb).

| Card | Counts | Notes |
| --- | --- | --- |
| Messages sent | `stage_sends.status = 'sent'` | **Is the delivery base** (rollup + live, below) so the delivery cards can never use a different number of sends. `scripts/verify-delivery-grains.ts` asserts it equals the direct count. |
| Failed at send | `status = 'failed'` | The send itself errored; no message went out. Renamed from "Failed" so it can't be confused with **Failed delivery** (a provider receipt). Not "Rejected": `status = 'rejected'` means canceled/recalled audit rows. |
| Filtered | `status = 'filtered'` | TextHub-side suppression; other providers never write it. |
| Skipped | `skipped_duplicate` + `skipped_opted_out` + `skipped_ineligible` | Was `skipped_duplicate` only, labelled "Skipped (1h)". The tooltip breaks out the three reasons. |
| In flight | `pending` + `sending` | |
| Opt-outs | distinct sends with a STOP-class inbound event **linked** to them (`matched_stage_send_id`, result `suppressed` / `duplicate` / `already_opted_out`) across `texthub_inbound_events`, `textrequest_inbound_events`, `tells_webhook_events` (`kind = 'inbound'`), `ahoi_inbound_events` — `countCampaignOptOuts` | Replaced "Replies", which read `texthub_inbound_events` only and was 0 on every txr / tls / ahi campaign. Exact linkage only — non-STOP replies are stamped `ignored` before matching and are never linked, so they are not counted. It can differ from the stage table's opt-out total, which uses the 72 h-window `opt_out_attributions`. |
| Last send | `max(sent_at)` | |

## Delivery cards

Delivered · Failed delivery · No status · Pending — each a count and a %. Built
from the shared delivery definitions in
[lib/reporting/delivery.ts](../../lib/reporting/delivery.ts) (`terminalCte`,
`DELIVERY_COUNTS`, `DLR_SOURCES`); no new delivery query. Mapping: Delivered =
`delivered`, Failed delivery = `undelivered`, No status = `no_receipt`.

- **Composition** (`getCampaignDeliveryRows`): ET days up to two days before the
  maturity cutoff's day come from `stage_delivery_rollup` via
  `getDeliveryByStage(orgId, range, stageIds)`; the last two ET days come from the live
  `queryDeliveryByStage` with `maturedBefore`. Yesterday is read live because
  the rollup's 10-minute tier refreshes today only — yesterday's last sends
  reach the rollup at the next 3-hourly settle.
- **Maturity = 60 minutes**, every provider (`ACTIVITY_DLR_MATURITY_MINUTES`).
  Share of first final receipts that land within 1 h (measured 2026-10-06):
  tls 98.7%, txr 97.1%, ahi 99.2%. The tripwire's 10 min would leave ~8% of
  tls receipts showing as No status first. txr has a reconcile-poll tail
  (p99 ≈ 29 h) that no threshold catches, so No status shrinks over a day or more.
- **Pending** = every DLR-capable send younger than the cutoff, receipt or not.
  **% base = matured DLR-capable sends**; Delivered + Failed delivery + No
  status foot to it, and matured + pending = capable sent. Pending's % is of
  capable sent.
- **N/A, never 0**: a campaign with no sends on a DLR-capable provider
  (txh / txh2) shows N/A on all four cards; the fields are `null` in the API.
- **Mixed campaigns**: counts and % cover the DLR-capable sends only, with
  "Based on X of Y sent" under the cards.
- **No status wording** does not blame the provider: the txr receipt gaps
  (e.g. campaign 1595, 3,199 of 4,491 sends with no receipt row) may be ours —
  per-message webhooks missing during a send burst plus the reconcile poll's
  6-hour lookback.
- **By stage & number** tab: the same cells at (stage, sending number) grain —
  the rows the cards are summed from.
- **Query plan** (`queryLiveCampaignDelivery`): the live read runs in its own
  transaction with `SET LOCAL enable_nestloop = off`. For a single-stage
  campaign the planner estimates ~7 sends (4,491 actual) and nested-loops them
  over every receipt group in the window — 8–12 s. Off: ~0.35 s, identical rows
  (re-proved by the verify script on every run). The shared
  `queryDeliveryByStage` and the undelivered tripwire are not changed.
- **Cost** (prod, 2026-10-06): 0.2–0.4 s for the whole delivery read on the
  largest campaigns (38.6K-send txh, 19.8K-send txr) and on campaigns that sent
  yesterday; first read after a cold start up to ~1.2 s.
- **Known gap, not fixed here**: ahi reports failures as `error` / `failed`,
  never `undelivered`, so the shared definition counts every ahi failure as No
  status (affects /reports/delivery too). Separate card.

## API

- `GET /api/campaigns/[campaignId]/activity?page&pageSize`
  → `{ summary: { sent, failed, rejected, filtered, skipped_duplicate,
  skipped_opted_out, skipped_ineligible, pending, sending, total, opt_outs,
  last_sent_at, by_stage[], delivery }, events: { data[], totalCount, page,
  pageSize } }`. `delivery` is `CampaignDeliverySummary`
  ([lib/reporting/campaign-activity.ts](../../lib/reporting/campaign-activity.ts)):
  the card cells plus `maturity_minutes` and `by_stage_phone[]`. `replies` was
  removed (2026-10-06) in favour of `opt_outs`.
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
summary cards, then the delivery cards, then a **Timeline ⇄ Messages ⇄ By
stage & number** tab toggle. Times render via
`formatCampaignDateTime` (ET). The send pipeline writes the underlying data — see
[sms-send-pipeline.md](sms-send-pipeline.md).
