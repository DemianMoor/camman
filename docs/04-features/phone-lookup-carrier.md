# Phone Lookup & Carrier Enrichment (Telnyx)

_Last updated: 2026-07-10_

> **Status: in build** (`feat/telnyx-number-lookup`). Phase 1 (schema) is authored; the worker, upload flows, segment/campaign wiring, and admin UI land in later phases. This doc is updated as each phase ships.

Phone line-type + carrier enrichment via the [Telnyx Number Lookup API](https://developers.telnyx.com/docs/identity/number-lookup/quickstart). Three goals:

1. **Landline suppression** — landlines can't receive SMS; they must be a hard, DB-enforced no-send and absent from every audience, segment, count, and send queue (except the Contacts admin screen).
2. **Carrier segmentation** — segment contacts by `phone_type` and `carrier`.
3. **Campaign carrier exclusion** — an optional carrier filter on a campaign's audience.

## Core model

- **`phone_lookups` is a GLOBAL cache** (no `org_id`) — carrier/line-type is a fact about a phone number, not a tenant. One lookup per number ever (re-verify is future scope). Keyed on `phone` in E.164 `+1XXXXXXXXXX`, the exact format `contacts.phone_number` uses (verified: all 752,707 contacts conform), so the enrichment join always hits and a number looked up for one org is free for every other.
- **Denormalized onto `contacts`**: `line_type`, `carrier_norm`, and `messaging_status`. Queries filter the denormalized columns (indexed), never join the cache on the hot path.
- **The landline hard stop is `messaging_status`** (`eligible` | `not_applicable`), derived by a DB trigger: `line_type='landline' ⇒ 'not_applicable'`, everything else (incl. `voip`, `toll_free`, `unknown`) ⇒ `'eligible'`. A trigger (not a generated column) so adding the column is metadata-only — no full-table rewrite at millions of rows. No code path can create an eligible landline; a direct write to `messaging_status` is overridden from `line_type`.
- **Every audience/segment/send query adds `AND messaging_status = 'eligible'`**, matching the four eligible-partial indexes on `contacts`. Landlines are physically absent from those index structures and from all counts, previews, snapshots, send queues, and link minting.

## Carrier buckets

`carrier_norm` resolves a raw Telnyx carrier string to one of six buckets via `carrier_mappings`:

`AT&T` · `T-Mobile` · `Verizon` · `Other Mobile` · `VoIP` · `Unknown`

Plus two non-bucket states (migration 0099):
- **`Unidentified`** — CONTACTS ONLY: **no `phone_lookups` row exists** for the phone (never looked up, no user-provided data). The default for `contacts.carrier_norm`. Invariant: `carrier_norm='Unidentified'` ⇔ no lookup row exists. `phone_lookups.carrier_norm` may **never** hold `Unidentified` (0095 CHECK). Any lookup write (contact sync) replaces `Unidentified` with a real value — `Unknown` at worst.
- **`Unknown`** — a lookup occurred (any source) but the carrier is undetermined (Telnyx returned unknown/absent carrier). Groups with `Unmapped`.
- **`Unmapped`** — looked up, raw string awaiting an admin bucket mapping. Groups with `Unknown` in filters; tracked separately only so the admin queue works. Assigning a mapping inserts into `carrier_mappings` and retroactively updates `phone_lookups` + `contacts`.

**Filter/rule treatment:** the campaign carrier filter offers the six buckets (`Unidentified` **not** selectable) and, when any filter is set, always excludes `Unidentified` on its own reported line; `Unknown` there matches `('Unknown','Unmapped')`. Segment rules offer both `Unknown` and `Unidentified`. Reporting counts `Unidentified` and `Unknown` separately everywhere.

## Line-type mapping (Telnyx → us)

Telnyx `carrier.type` has **no `landline` value**. The mapper (built phase 2) prefers `portability.line_type` (port-corrected) then falls back to `carrier.type`:

| Telnyx value | our `line_type` |
|---|---|
| `mobile` | `mobile` |
| `fixed line` | `landline` |
| `voip` | `voip` |
| toll-free ranges | `toll_free` |
| `fixed line or mobile`, `premium rate`, `pager`, … everything else | `unknown` |

Unknown stays **eligible** — conservative, never silently suppresses. The full raw payload is stored in `phone_lookups.raw_response` regardless.

## Precedence

`telnyx` overwrites anything; `csv_import` never overwrites an existing `telnyx` row. (`manual_edit` sticky precedence and `dlr_inferred` are reserved source values, not yet implemented.)

## Schema (phase 1 — migrations 0095–0098)

| Table | Scope | RLS |
|---|---|---|
| `phone_lookups` | global cache | policy-less (server-only) |
| `carrier_mappings` | global, seeded | policy-less |
| `lookup_settings` | global, single row | policy-less |
| `lookup_batches` | org-scoped (reporting) | org-scoped SELECT, no writes |
| `lookup_queue` | worker state, no org | policy-less |
| `contacts` (+cols) | tenant | (existing) |
| `stage_sends.carrier_norm` | tenant | (existing) |

See [03-data-model.md](../03-data-model.md) for columns. `lookup_settings` is a single global row (boolean PK fixed `true`): `lookup_paused`, `lookup_daily_cap` (Warsaw-tz), `lookup_rate_base` / `lookup_rate_mobile` (admin-editable — Telnyx exposes no pricing API), `lookup_concurrency_rps`.

## Worker (built — phase 3)

`lib/telnyx/` + the `*/2` cron `/api/cron/lookup-worker` ([crons.md](crons.md)). `enqueueLookups(orgId, phones, trigger)` creates a `lookup_batch` and enqueues numbers not already cache-complete or pending. `runLookupWorker()`:
- **Single-runner lease** — `lookup_settings.worker_lease_until` (a lease row, NOT a `pg_try_advisory_lock`, which is unsafe through the transaction pooler): conditional-UPDATE claim (NULL/expired only), 4-min lease, CAS heartbeat-renew ~60s, clear on clean exit. Overlapping invocation → no-op; crashed drain's lease expires and the next tick proceeds.
- **Guards in order:** paused → daily cap (SUM `lookup_queue.attempts` since Warsaw midnight — retries/failures consume cap) → balance (`available_credit`; can't cover next chunk → alert + skip, auto-resumes; 402/feature-gate mid-run halts).
- **Claim** `FOR UPDATE SKIP LOCKED`, `attempts++`+`updated_at` at claim; 429 → left pending, 60s cooldown (backoff); terminal fail → queue `failed`, no `phone_lookups` row (contact stays `Unidentified`). Paced to `lookup_concurrency_rps`/sec.
- **Contact sync** per completed lookup (`syncContactsForPhones`): copies line_type/carrier down (replacing `Unidentified`), and for landlines cancels **pending** `stage_sends` only (never `sending` — mid-flight; deleting can't unsend and breaks the DLR match) + removes from `campaign_audience_pool`. Drained batch → finalized (actual cost from line-type mix) + Telegram summary.

Live-fire drain needs `TELNYX_API_KEY` set; the first run is the 500-number calibration batch. Verified without HTTP (lease overlap/CAS/crash-recovery, attempt-summed cap, enqueue dedup — `scripts/test-lookup-worker.ts`).

## Later phases (planned)

- **Upload flows**: new-contact CSV (lookup toggle default ON → `Unidentified` when OFF + review panel with cost/balance), predefined `line_type`/`carrier` columns (→ a `phone_lookups` row, source `csv_import`), bulk-update existing contacts, backfill (scoped to `is_archived=false`).
- **Segment rules** `phone_type` / `carrier`; **campaign carrier filter** on `audience_filters`; **admin UI** (batches, unmapped queue, settings, Contacts columns + base-mix stats).

## Integration facts

See [06-integrations.md](../06-integrations.md). Endpoint `GET /v2/number_lookup/{+E164}?type=carrier`; balance `GET /v2/balance` (string fields). 403 code 10038 = account feature gate → alert, no retry. Negative balance disables lookup → pause + alert, never retry-loop. Env: `TELNYX_API_KEY`.
