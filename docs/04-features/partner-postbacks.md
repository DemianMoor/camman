# Partner sales postbacks

_Last updated: 2026-11-05_

When a lead a partner sent us produces a sale, we `GET` a URL the partner configured on their
intake key, echoing the extra fields they sent with the lead. Generic and per key — no code per
partner. Spec: [2026-10-30-partner-postbacks-design.md](../superpowers/specs/2026-10-30-partner-postbacks-design.md)
(owner decisions 2026-10-30). Schema (migration 0228, PR1) is in [03-data-model.md](../03-data-model.md);
the passthrough-fields half is in [partner-lead-intake.md](partner-lead-intake.md).

## What fires

- A `conversion_events` row (the ledger) whose event type has `event_types.is_purchase`, with
  `status = 'approved'`, attributed to a **drip journey** whose lead arrived on a non-sandbox key with postbacks
  enabled and `purchase` in its events. Upsell and registration events never fire. A later rejection is visible in
  the ledger and **nothing is sent** (no reversal postbacks in v1). `event = 'purchase'`,
  `event_id = purchase-<conversion_events.id>`.
- **`opt_out`** (when the key has `opt_out` in its events): a drip journey closed `opted_out` (STOP while the
  journey was live) within the last 30 days, at/after the key's opt_out since, same non-sandbox and required-fields
  rules. One row per key and journey (`partner_postbacks_key_journey_optout_uniq`). `event_id =
  opt_out-<drip_journeys.id>`, `{occurred_at}` = the journey's `closed_at` (processing time, UTC `Z`),
  `{conversion_id}` empty, `{currency}` / `{payout}` empty. First-purchase-only does **not** apply to opt_out, and
  a queued opt_out does not count as the journey's "first" postback (test E13).
- **`{status}` is the key's per-event word** (`postback_status_words`; defaults `sold` / `opt_out`). The sale
  payload is snapshotted at enqueue, so delivery re-reads the ledger row
  (org-matched) when it claims a live row: if its status is no longer `'approved'` (rejected while the postback was
  pending), the row is `cancelled` with `last_error = 'no_longer_approved'` and nothing is sent. A sale re-approved
  afterwards is not re-queued (the per-key/conversion unique index already holds the cancelled row).
- **Regardless of journey state**, including `opted_out`. The trigger is the ledger, never the journey (the
  lifecycle sweep skips posture-off orgs and never reclassifies `opted_out`).
- **Never backfilled, per event.** Only sources at/after the event's own since in
  `partner_keys.postback_event_since` (stamped when that event becomes live): ledger rows by `created_at`, opted-out
  journeys by `closed_at`. Turning `opt_out` on later never sends the opt-outs before it. A sale recorded `pending`
  before enabling and approved after does **not** fire.
- **Required fields (derived from the template).** Every passthrough field the key's template references (e.g.
  `{relay_lead_id}`) must have a non-empty value in the lead's stored `partner_data`, or the sale is **never
  queued** — silently, no row. A partner that sends the field in only some feeds gets no empty-value postbacks
  from the others. Nothing is configured: the rule reads the template, so a template that uses only system
  placeholders requires nothing. `partner_data` is fixed at intake, so a skip is final. SQL in
  [lib/partners/postbacks/enqueue.ts](../../lib/partners/postbacks/enqueue.ts); test E9 in
  `scripts/test-postback-enqueue-db.ts`.
- Regular (non-drip) campaigns do not fire. Attributing regular campaigns to partner groups is a **follow-up**, tied
  to the partner-group-attribution workstream; not built.

## Counting modes (per key, `partner_keys.postback_first_purchase_only`)

| Mode | Fires for |
|---|---|
| Every purchase (default) | each approved purchase |
| First purchase per journey only | the journey's **earliest approved purchase** by `(occurred_at, id)`. If that earliest purchase predates enabling, the journey never fires |

## Template and placeholders

`partner_keys.postback_url_template` is an `https://` URL (port 443, no credentials). Placeholders may appear only in
the **path or query**, never the host (a render that would change the host is refused). Allowed: `{status}` `{event}`
`{conversion_id}` `{occurred_at}` `{currency}` `{payout}` plus this key's own passthrough field names (for example
`{relay_lead_id}`). Values are URL-encoded. A referenced passthrough field is required (see "What fires"); any other missing value
renders empty. Validated server-side by
`postbackConfigError` in [lib/partners/postbacks/template.ts](../../lib/partners/postbacks/template.ts); the same
function drives the inline error in the UI.

**Payout gating.** `{payout}` is accepted only while "Include payout" is on. It is our revenue for the sale, the same
sensitivity as the report revenue toggle. Off means the placeholder is refused and renders empty.

## Delivery

- Enqueue: `enqueuePartnerPostbacks` ([lib/partners/postbacks/enqueue.ts](../../lib/partners/postbacks/enqueue.ts)), one
  idempotent `INSERT … SELECT` per event (purchase, opt_out) run by `/api/cron/drip-monitors` after the lifecycle sweep, under a transaction
  advisory lock (serialises first-only picks). Never from the send path.
- Delivery: `/api/cron/partner-postbacks` (`*/5 * * * *`, [deliver.ts](../../lib/partners/postbacks/deliver.ts)).
  `GET`, https:443 only, private/reserved addresses refused at connect time, redirects never followed, 5 s timeout.
  2xx is delivered; 408, 429, 5xx and network errors retry; anything else fails.
- Retries after 1 m, 5 m, 30 m, 2 h, 6 h, 24 h; **7 attempts**, then `failed`. A key disabled while rows are pending
  cancels them unsent; an edited template applies to retries.
- **At-least-once.** A runner that dies after the partner answered re-sends once its 2-minute lease lapses. The partner
  must dedupe on **`{conversion_id}`**. (One real postback per key and conversion is also enforced on our side by a
  partial unique index.)
- **Kill switch:** env `PARTNER_POSTBACKS_DELIVERY_ENABLED` must be `true`. Otherwise the cron only records its
  heartbeat and answers `skipped_kill_switch: true`, and Send test answers 409. Enqueue does **not** check the
  switch: an enabled key keeps queueing rows, which go out in a burst once delivery is switched on. The key JSON
  carries `postback_delivery_enabled` (the switch, evaluated server-side in `normalizeKeyRows`), and the "Sales
  postback" section shows *"Delivery is switched off for this environment — postbacks are queued but not sent"* when
  the key is enabled and delivery is off.

## Operating it (Settings → Partners → key card → "Sales postback")

UI: [components/settings/partner-key-postback.tsx](../../components/settings/partner-key-postback.tsx).

1. Set the template, Count and Include payout, then **Save postback** (needs `partner_keys.manage`).
2. **Send test** posts a sample payload (`test_<field>` values, a `test-<uuid>` conversion id) to the *saved* template
   and shows the HTTP code and masked URL inline. A second test within a few seconds is refused (429). Test rows are
   `is_test` and never count toward idempotency or first-only.
3. Enable, then watch the **Postback log**: a fixed-height box (about 9 rows) inside the key card, newest first,
   25 rows per page with **Load older** (keyset on id, `GET /api/partner-keys/[keyId]/postbacks?before=<next_before>`),
   a search box (`?q=`, 300 ms debounce; matches the masked URL, the conversion id and the lead's passthrough values —
   e.g. the partner's lead id — case-insensitive, `%`/`_` literal) and "Failed only" (`?failed=1`). Columns: time
   (ET), test/live, conversion id, code, attempts, status, masked URL (truncated, full value on hover). Server side:
   `listKeyPostbacks` in [lib/partners/postbacks/config.ts](../../lib/partners/postbacks/config.ts); test A5 in
   `scripts/test-partner-postbacks-api.ts`. The log is shown only to users who can manage keys.

**Who sees the template.** `postback_url_template` can carry a secret query value, so it is returned raw only to callers with `partner_keys.manage`; view-only callers (`partner_keys.view`) get `maskUrl(template)` from every key read (`normalizeKeyRows(rows, canManage)` in [lib/partners/queries.ts](../../lib/partners/queries.ts); test `scripts/test-partner-key-template-masking.ts`).

URLs are stored and shown **masked**: query values whose name contains `token`, `key`, `secret`, `sig`, `auth` or
`pass`, or is exactly `k` (any case), become `***`. The raw URL is never logged or returned. The UI applies `maskUrl`
again at render — the Send-test banner and every log cell — so a row stored before a masking rule existed still
renders masked. The saved template on the key card is shown masked and read-only until **Edit** reveals the raw
value for editing (manage users only; Save or Reset masks it again).

## Alerts

- `partner-postback-failed:<keyId>`: one latched Telegram message per key when a delivery fails permanently or exhausts
  its retries; clears on the key's next delivery.
- `partner-postbacks-stale`: raised by `/api/cron/drip-monitors` when the delivery cron's heartbeat is stale, **only once
  postbacks are live** (kill switch on, or any key enabled), so a deliberately-off feature does not page. The check is
  wrapped in try/catch: a throw there cannot 500 drip-monitors after its work is done.
- `partner-postbacks-enqueue-failed`: raised by `runDripMonitors` ([lib/drip/monitors.ts](../../lib/drip/monitors.ts))
  when `enqueuePartnerPostbacks` throws, gated on the same go-live predicate (`postbacksLive` in
  [heartbeat-gate.ts](../../lib/partners/postbacks/heartbeat-gate.ts)); cleared by the next successful enqueue.
  Enqueue stays best-effort (the monitors continue), but it is no longer silent: both heartbeats stay fresh while it
  fails, and a sale older than enqueue's 30-day window is never queued. The text carries the error class and a
  capped first-line message only (never SQL or URLs).

## Go-live (owner steps)

PR2 ships inert (the cron answers `skipped_kill_switch: true`, `partner_postbacks` is empty). To go live: set the env
var in Vercel and redeploy, configure the partner's key, Send test to their URL, enable, and watch the log through the
first real sale.

## Per-event config (0234)

- `postback_event_keys` lists the events a key sends (`purchase`, `opt_out`; `invalid` arrives later). `postback_status_words` maps event -> the word sent as `{status}` (`^[A-Za-z0-9_.-]{1,32}$`); a PATCH **merges** into the stored map.
- `postback_event_since` (event -> ISO time it went live) is server-written only, by `nextEventSince` in `lib/partners/postbacks/config.ts`. An event is live when the key is enabled AND the event is in its list: becoming live stamps now, staying live keeps the old stamp, ceasing to be live drops it. Disable then enable re-stamps every live event.
