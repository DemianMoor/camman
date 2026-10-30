# Partner sales postbacks

_Last updated: 2026-10-31_

When a lead a partner sent us produces a sale, we `GET` a URL the partner configured on their
intake key, echoing the extra fields they sent with the lead. Generic and per key — no code per
partner. Spec: [2026-10-30-partner-postbacks-design.md](../superpowers/specs/2026-10-30-partner-postbacks-design.md)
(owner decisions 2026-10-30). Schema (migration 0228, PR1) is in [03-data-model.md](../03-data-model.md);
the passthrough-fields half is in [partner-lead-intake.md](partner-lead-intake.md).

## What fires

- A `conversion_events` row (the ledger) whose event type has `event_types.is_purchase`, with
  `status = 'approved'`, attributed to a **drip journey** whose lead arrived on a key with postbacks enabled.
  Upsell and registration events never fire. A later rejection is visible in the ledger and **nothing is sent**
  (no reversal postbacks in v1).
- **Regardless of journey state**, including `opted_out`. The trigger is the ledger, never the journey (the
  lifecycle sweep skips posture-off orgs and never reclassifies `opted_out`).
- **Never backfilled.** Only ledger rows created at/after the key's `postback_active_since` (stamped when postbacks
  are enabled). A sale recorded `pending` before enabling and approved after does **not** fire.
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
`{relay_lead_id}`). Values are URL-encoded; a missing field renders empty. Validated server-side by
`postbackConfigError` in [lib/partners/postbacks/template.ts](../../lib/partners/postbacks/template.ts); the same
function drives the inline error in the UI.

**Payout gating.** `{payout}` is accepted only while "Include payout" is on. It is our revenue for the sale, the same
sensitivity as the report revenue toggle. Off means the placeholder is refused and renders empty.

## Delivery

- Enqueue: `enqueuePartnerPostbacks` ([lib/partners/postbacks/enqueue.ts](../../lib/partners/postbacks/enqueue.ts)), one
  idempotent `INSERT … SELECT` run by `/api/cron/drip-monitors` after the lifecycle sweep, under a transaction
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
  heartbeat and answers `skipped_kill_switch: true`, and Send test answers 409.

## Operating it (Settings → Partners → key card → "Sales postback")

UI: [components/settings/partner-key-postback.tsx](../../components/settings/partner-key-postback.tsx).

1. Set the template, Count and Include payout, then **Save postback** (needs `partner_keys.manage`).
2. **Send test** posts a sample payload (`test_<field>` values, a `test-<uuid>` conversion id) to the *saved* template
   and shows the HTTP code and masked URL inline. A second test within a few seconds is refused (429). Test rows are
   `is_test` and never count toward idempotency or first-only.
3. Enable, then watch the **Postback log** (last 50 rows, optional "Failed only"): time (ET), test/live, conversion id,
   masked URL, code, attempts, status. The log is shown only to users who can manage keys.

**Who sees the template.** `postback_url_template` can carry a secret query value, so it is returned raw only to callers with `partner_keys.manage`; view-only callers (`partner_keys.view`) get `maskUrl(template)` from every key read (`normalizeKeyRows(rows, canManage)` in [lib/partners/queries.ts](../../lib/partners/queries.ts); test `scripts/test-partner-key-template-masking.ts`).

URLs are stored and shown **masked**: query values whose name contains `token`, `key`, `secret`, `sig`, `auth` or
`pass` become `***`. The raw URL is never logged or returned.

## Alerts

- `partner-postback-failed:<keyId>`: one latched Telegram message per key when a delivery fails permanently or exhausts
  its retries; clears on the key's next delivery.
- `partner-postbacks-stale`: raised by `/api/cron/drip-monitors` when the delivery cron's heartbeat is stale, **only once
  postbacks are live** (kill switch on, or any key enabled), so a deliberately-off feature does not page.

## Go-live (owner steps)

PR2 ships inert (the cron answers `skipped_kill_switch: true`, `partner_postbacks` is empty). To go live: set the env
var in Vercel and redeploy, configure the partner's key, Send test to their URL, enable, and watch the log through the
first real sale.
