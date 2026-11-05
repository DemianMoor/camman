# Partner postback events: sold / opt_out / invalid — design

Status: owner decisions 2026-11-05 (below). Recon read origin/main `d6369eb8`. Extends
[2026-10-30-partner-postbacks-design.md](2026-10-30-partner-postbacks-design.md); everything there still holds
unless this document changes it.

## Goal

A partner gets feedback on the outcome of each lead it sent, via one postback mechanism with three events:

| Event key | Default status word | Source | Fires once per | Recorded time (`{occurred_at}`) |
|---|---|---|---|---|
| `purchase` | `sold` | sales ledger (today's behaviour) | sale (`conversion_events.id`) | sale `occurred_at` |
| `opt_out` | `opt_out` | drip journey closed `opted_out` | journey (`drip_journeys.id`) | journey `closed_at` (processing time) |
| `invalid` | `invalid` | enrichment's landline branch | lead (`lead_inbox.id`) | enrichment time |

## Recon facts

- **R1** A journey becomes `opted_out` only via `closeJourneyOnOptOut` (`lib/drip/lifecycle.ts`), called from the
  four opt-out intake paths in the same transaction as the `opt_outs` write. `close()` guards
  `state IN ('routed','active')`, so a journey is opted out at most once and never reverts; `closed_at = now()`.
  A STOP for a contact with no live journey closes nothing. Prod: 5,337 opted-out journeys in total; pml 1,453 in
  7 days. The existing `drip_journeys_org_state_routed_idx (org_id, state, routed_at DESC)` serves the scan.
- **R2** Landline leads are counted then **deleted** inside the enrichment transaction
  (`lib/drip/enrichment.ts`, `if (lineType === "landline")`). No `lead_events` row, no contact, no journey; the
  inbox row (with `partner_key_id`, `partner_data`) exists only until that DELETE. `lead_inbox.id` is `uuid`.
  pml: 4,196 landlines in 7 days.
- **R3** Sandbox rows skip the lookup (`line_type` forced null), so they never reach the landline branch.
- **R4** `partner_postbacks.conversion_event_id` is nullable; today's only idempotency key is
  `UNIQUE (partner_key_id, conversion_event_id) WHERE NOT is_test`.
- **R5** `postback_event_keys text[]` has `CHECK (postback_event_keys <@ ARRAY['purchase'] AND cardinality >= 1)`;
  enqueue reads `'purchase' = ANY(k.postback_event_keys)`; `postback_active_since` is stamped when the key's
  postbacks are enabled.
- **R6** Delivery's `no_longer_approved` re-check applies only to rows with a `conversion_event_id`, so it already
  ignores rows without one.

## Owner decisions (2026-11-05)

1. `invalid` = **landline only**. G19 stands: unknown line type stays sendable and is never reported invalid.
2. `opt_out` = **journey-only**: the journey closed `opted_out`. A STOP after the journey ended belongs to our
   campaigns, not the partner's lead, and sends nothing.
3. `{status}` renders the **per-event word**, editable per key (defaults `sold` / `opt_out` / `invalid`). Today it
   renders the ledger status `approved`; no live template uses `{status}`. pml's literal `status=sold` becomes
   `status={status}` when this ships.
4. **`{event_id}`** on every postback, documented as the partner's dedupe key.
5. `{occurred_at}` for `opt_out` = processing time (`closed_at`).
6. Events are independent: a lead that opts out and later buys gets both.
7. **All three events skip sandbox keys.** Sandbox never sends anything outbound.
8. Two PRs, preview-first, owner gates before the prod migration and each merge:
   **PR1** migration + per-event mechanics + `opt_out`; **PR2** `invalid`.

## Design

**Schema (one additive migration, `0234_partner_postback_events`):**
- `partner_postbacks.event text NOT NULL DEFAULT 'purchase'`, CHECK `IN ('purchase','opt_out','invalid')`.
- `partner_postbacks.lead_inbox_id uuid` — **no FK**: the inbox row is deleted in the same transaction.
- Partial unique indexes, all `WHERE NOT is_test`: `(partner_key_id, drip_journey_id) WHERE event = 'opt_out'`;
  `(partner_key_id, lead_inbox_id) WHERE event = 'invalid'`. The existing per-conversion index stays (NULL
  conversion ids do not collide).
- `partner_keys.postback_event_keys` CHECK widened to `<@ ARRAY['purchase','opt_out','invalid']`.
- `partner_keys.postback_status_words jsonb NOT NULL DEFAULT '{}'` — event key → word; a missing key means the
  default word. Word: 1–32 chars of `[A-Za-z0-9_.-]`.
- `partner_keys.postback_event_since jsonb NOT NULL DEFAULT '{}'` — event key → ISO timestamp when that event
  became live on the key. Backfill: `{"purchase": postback_active_since}` where that is set.

**Per-event "since" (no backfill, decision 4 of the original design, per event):** an event's since is stamped
when it becomes live — the key is enabled while the event is in `postback_event_keys`, or the event is added while
the key is enabled — and removed when it stops being live. Turning `opt_out` on later never sends opt-outs from
before. `postback_active_since` stays as the key-level stamp (not read by enqueue any more).

**Payload:** `PostbackPayload.event` widens to `"purchase" | "opt_out" | "invalid"`; new `event_id: string`.
`status` = the key's word for the event, **snapshotted at enqueue** like the rest of the payload.
`event_id` = `purchase-<conversion_id>` / `opt_out-<journey uuid>` / `invalid-<lead_inbox uuid>` — deterministic,
stable across retries. `conversion_id`, `currency`, `payout` are empty for non-sale events. `{event_id}` joins
`SYSTEM_PLACEHOLDERS` (so it can no longer be a passthrough field name — none uses it today).

**Shared rules for every event:** key `postback_enabled`, event in `postback_event_keys`, `NOT k.sandbox`
(new for `purchase` too), source time ≥ the event's since, and the **required-fields rule** (#422: every
passthrough field the template references is non-empty in the lead's partner data). One SQL fragment builds it.

**opt_out enqueue:** a second idempotent `INSERT … SELECT … ON CONFLICT DO NOTHING` in `enqueuePartnerPostbacks`
under the same advisory lock: `drip_journeys` `state='opted_out'`, `closed_at` within 30 days and ≥ since, joined
org-matched to its `lead_events` row and key. Never from the send path.

**invalid enqueue:** inside the enrichment landline branch, before the DELETE, one
`INSERT … SELECT FROM partner_keys … ON CONFLICT DO NOTHING` built from the inbox row's key, partner data and id.
Run in a **savepoint**: a failure is logged and latches one Telegram alert (gated on `postbacksLive()`), and the
enrichment of that lead continues. Postbacks must never block intake.

**Delivery:** unchanged. `no_longer_approved` keeps applying only to rows with a conversion (R6).

**UI (key card):** "Fires on" becomes three checkboxes (Purchase (approved) / Opt-out / Invalid number), each with
its status word input; `{event_id}` chip; the log gains an Event column; Send test sends a `purchase` sample.
In PR1 the Invalid checkbox is not shown (the server refuses `invalid` until PR2).

**Docs:** public partner page — events, status words, `{event_id}` as the dedupe key, empty values per event,
API changelog entry; internal feature doc, data model + ERD, conventions, flows, CHANGELOG.
