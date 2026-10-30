# Partner passthrough fields + sales postbacks — design

Status: approved by the owner 2026-10-30 (decisions below). Recon read origin/main `c5df462d`.

## Goal

A partner sends extra per-lead fields (e.g. `list_id`, `relay_lead_id`) and receives a
postback to their URL when that lead produces a sale, echoing those fields. Generic and
configured per partner key — no code per partner.

## Recon facts that shape the design

- **R1** Intake never rejects unknown fields; the whole payload is kept in `lead_inbox.raw`.
  pml already sends undeclared `reference_id` + `timestamp` on ~150K leads/week ⇒ unknown
  extras stay **ignored**.
- **R2** Sale → lead chain: `conversion_events (campaign_id, contact_id, occurred_at)` →
  `drip_journeys` by the anchor in `reclassifyCompletedJourneysOnPurchase`
  (`occurred_at >= routed_at` and before the contact's next journey on that campaign) →
  `lead_events.partner_key_id`. Prod 30 d: 1,212 drip sales, 0 match >1 journey.
- **R3** Journey state is not a usable trigger: the lifecycle sweep skips posture-off orgs and
  never reclassifies `opted_out` (8 of 1,212 sales). Postbacks queue from the **ledger**.
- **R4** 288 of 901 converted journeys (32%) carry ≥2 purchases.
- **R5** One sale = one `conversion_events` row (stable `keitaro_event_id` across in-place
  updates). Prod 30 d: 1,585 purchases, all `approved`.
- **R6** Only `event_types.is_purchase` fires. Upsell is `counts_revenue` but not
  `is_purchase`; a registration re-posted as a sale on the same tid stays a locked
  registration (conflict marker) — not a purchase anywhere, including our Sales.
- **R7** `/docs/partner-api` must carry no per-partner values (`lib/intake/api-contract.ts`).
- **R8** `lib/brand-landing-probe.ts` already blocks private/reserved addresses at DNS-connect time.

## Owner decisions (2026-10-30)

1. **Counting unit is a per-key setting:** "every purchase" (default) or "first purchase per
   journey only" — `partner_keys.postback_first_purchase_only boolean DEFAULT false`.
2. **Approved only**, no reversal postbacks in v1. A later rejection is visible in the
   ledger, nothing is sent.
3. **Docs split:** the public page documents the generic mechanism; each key's accepted
   fields live on the key card + a copyable instructions block.
4. **Fires whatever the journey ended as**, including `opted_out`. **Never backfill:** only
   ledger rows created at/after `postback_active_since`.
5. Delivery is **at-least-once**; `{conversion_id}` is documented as the partner's dedupe key.
6. Regular-campaign / partner-group attribution overlap: **follow-up**, tied to the
   partner-group-attribution workstream. Not built.

## Design summary

- `partner_keys` gains `passthrough_fields`, `postback_enabled`, `postback_url_template`,
  `postback_include_payout`, `postback_first_purchase_only`, `postback_event_keys`
  (`{purchase}` only in v1), `postback_active_since`.
- `lead_inbox.partner_data` (whitelist applied at intake) is copied by enrichment to
  `lead_events.partner_data`. Bad value ⇒ value dropped, lead kept, per-lead `warnings` in the 202.
- `partner_postbacks` is queue + log. **Idempotency: `UNIQUE (partner_key_id,
  conversion_event_id) WHERE NOT is_test`**, enqueue is `INSERT … ON CONFLICT DO NOTHING`.
  First-only mode adds "no non-test row for this journey yet".
- Enqueue runs inside the drip-monitors cron after the lifecycle sweep, reads no journey
  state, never from the send path. Delivery is its own cron, GET, https:443 only, private
  addresses refused, no redirects, 5 s timeout, retries 1m/5m/30m/2h/6h/24h, then `failed` +
  one latched Telegram alert per key. Global kill switch env `PARTNER_POSTBACKS_DELIVERY_ENABLED`.
- Placeholders: whitelisted field names + `{status}` `{event}` `{conversion_id}`
  `{occurred_at}` `{currency}` `{payout}` (payout only when its toggle is on).
