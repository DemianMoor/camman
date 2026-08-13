# Delivery Report

_Last updated: 2026-08-13_

Delivery-rate visibility across every provider. Three surfaces read from **one**
query layer — [lib/reporting/delivery.ts](../../lib/reporting/delivery.ts) — so
the human view and the automated alert can never disagree:

| Surface | Grain | Where |
|---|---|---|
| `/reports/delivery` | provider × window | [components/reports/delivery-report.tsx](../../components/reports/delivery-report.tsx) · [app/api/reports/delivery/route.ts](../../app/api/reports/delivery/route.ts) |
| `Delivered %` column on the Overview tab | campaign **and** stage | [components/reports/keitaro-report.tsx](../../components/reports/keitaro-report.tsx) · [app/api/keitaro/reports/route.ts](../../app/api/keitaro/reports/route.ts) |
| Undelivered tripwire (check #4) | batch (= stage) | [lib/sends/tells-monitors.ts](../../lib/sends/tells-monitors.ts) · [app/api/cron/tells-monitors/route.ts](../../app/api/cron/tells-monitors/route.ts) |

No schema change. No migration.

---

## 1. Definitions (fixed across every surface)

```
sent        = stage_sends.status = 'sent'      the project's shared definition of
                                               "was messaged" — the same one the
                                               reports rollup, the send breakers
                                               and the sent_from_provider_phone
                                               rule use, so Delivery reconciles
                                               with Overview's Total Sent
delivered   = the message has a terminal 'delivered' receipt
undelivered = terminal 'undelivered' AND NOT delivered      (delivered wins)
no_receipt  = sent AND NOT (delivered OR undelivered)

Delivered %   = delivered / sent      accepted sends as the denominator
Undelivered % = undelivered / sent    the tripwire's rate
```

**`no_receipt` is displayed, never folded into the percentage.** A recently-sent
message may simply not have matured yet; hiding that inside the rate would make
a slow DLR feed look like a delivery failure.

---

## 2. Capability declaration — why some cells are blank

Report **rows** come from the `sms_providers` registry (every current and future
provider). **Capability** comes from `DLR_SOURCES` in
[lib/reporting/delivery.ts](../../lib/reporting/delivery.ts), whose default is
"no DLR source".

| Provider | Source | Notes |
|---|---|---|
| `tls` | `tells_webhook_events` `kind='dlr'` | key `matched_stage_send_id` |
| `txr` | `textrequest_dlr_events` | key `coalesce(matched_stage_send_id, stage_send_id)` |
| `ahi` | `ahoi_dlr_events` | status arrives **mixed-case**; every source is `lower()`ed |
| `txh` / `txh2` | **none** | TextHub has no DLR table at all (§4) |
| `snx` / `smpl` | **none** | no API send path |

A provider with no source reports its **Sent** count and `null` — rendered `—` —
for Delivered / Undelivered / No receipt / %. **Never `0`.** The gate is
structural, enforced by the types (`number | null`), not by the UI choosing to
hide a computed zero.

Two consequences, both intended:

- a provider added to the registry tomorrow appears immediately as `—`, needing
  no change to the report;
- when a provider's DLR intake becomes real, registering it in `DLR_SOURCES`
  lights its cells up — also with no change to the report.

---

## 3. Mixed-provider campaigns

A **stage** is always single-provider (verified: 0 of 882 stages with sends span
more than one). A **campaign** can span several.

The campaign-grain percentage is computed over its **DLR-capable sends only**,
and the UI labels the coverage:

```
91.4% (of 4% of sends)
```

`—` when no send in the campaign is DLR-capable. The label is not decoration: a
4%-coverage figure and a 100%-coverage one are otherwise indistinguishable.

> Mixed-**provider** is not the same as mixed-**capability**. All 4 mixed
> campaigns in prod today are `txh` + `txh2` — both non-capable — so they render
> `—`, not a label. No campaign currently mixes a capable provider with a
> non-capable one, so this path is exercised by
> [scripts/test-delivery-rollups.ts](../../scripts/test-delivery-rollups.ts)
> rather than by production data. It starts firing as soon as a `tls`/`txr` stage
> lands in a campaign that also sends via TextHub.

---

## 4. TextHub has no delivery receipts — the important blank

`texthub_inbound_events` (91K rows) is **reply/STOP intake**. It has no status
column and holds no delivery receipts. TextHub's own API does expose a
delivery-report endpoint (`?dlr=true&id=<message_id>`, contract verified in
[scripts/probe-texthub-status.ts](../../scripts/probe-texthub-status.ts)) but
**nothing polls it and nothing stores it**.

`txh` + `txh2` carry ~99.9% of platform volume. Computing delivery for them
without the capability gate produces:

```
txh2   357,567 sent   0 delivered   0 undelivered   0.0%
txh    211,092 sent   0 delivered   0 undelivered   0.0%
```

— which reads as a total platform outage. This is the single reason the gate
emits `null` rather than letting a zero through.

**If a TextHub DLR poller is ever built, registering it in `DLR_SOURCES` is a
deliberate act, not a formality.** Their short-code DLRs are not trusted; do not
register a source whose receipts you have not validated against reality.

---

## 5. Cost — and why the window is capped at 14 days

Measured against prod 2026-08-13 (`stage_sends`: 3.07M rows / 2601 MB):

| Window | Sends scanned | Server-side |
|---|---|---|
| 7 days | 551,753 | **473 ms** |
| 30 days | 2,198,888 | **11.0 s** |

The whole cost is the `stage_sends` scan: `stage_sends_org_sent_at_idx` is
`(org_id, sent_at) WHERE sent_at IS NOT NULL`, so `status` and `stage_id` are
heap fetches. The DLR side is ~3 ms against a ~490-row hash.

Therefore:

- `/api/reports/delivery` caps the range at **14 days** (`MAX_RANGE_DAYS`).
- The Overview route permits **92** days, so its `Delivered %` column is
  **computed only when the range is ≤ 14 days**. Beyond that the column reports
  `null` and the UI says why — otherwise a wide Overview range would inherit the
  11 s cost and time out.

`campaign_stages.sms_count` is **not** a shortcut: it is `0` on all 882 stages
with API sends (a manual-mode field), so `Sent` cannot come from a pre-aggregate.

**Raising either cap requires the covering index first** — ClickUp `869ehwae3`.

---

## 6. Counting traps

Each of these produced a plausible, wrong number during development.

**(a) Row-counting inflates `txr` 3.2×.** Text Request writes a row from the
per-message `status_callback` *and* another from the reconcile poll: 158 event
rows for 50 messages. Counting rows reports 149 delivered against 50 sent —
**298%**. The `GROUP BY` in the terminal CTE must happen **before** the join to
sends.

**(b) "No receipt" ≠ "no event row".** A `tls` message emits a non-terminal
`sent` before `delivered`; a failure emits only `undelivered`. A message with
just the `sent` row *has* an event row and *has no* receipt. Defining no-receipt
as a missing join reported 0 where the truth was 14.

**(c) Ungated computation reads as an outage.** See §4.

---

## 7. Verification

| Script | What it pins |
|---|---|
| [scripts/test-delivery-rollups.ts](../../scripts/test-delivery-rollups.ts) | 45 assertions over the pure aggregators + the tripwire predicate. No DB. Covers the mixed-capability path that prod data does not yet exercise. |
| [scripts/verify-delivery-grains.ts](../../scripts/verify-delivery-grains.ts) | Live: rows foot, the capability gate emits null, the per-message fold dedups, all rollups reconcile. **Prints its input scope**, and warns explicitly when the mixed-capability path was not exercised rather than printing a `0` that reads as a pass. |
| [scripts/test-tells-monitors.ts](../../scripts/test-tells-monitors.ts) | 39 assertions incl. 8 for the tripwire (baseline does not fire, 8.1% does, volume floor holds). |

Live figures, 7-day window 2026-08-13:

```
provider        sent   delivrd   undeliv   no rcpt   deliv %
txh2         345,630         —         —         —         —
txh          205,573         —         —         —         —
tls              500       457        29        14     91.4%
txr               50        47         2         1     94.0%
ahi                0         —         —         —         —
```

Both capable rows foot exactly (457+29+14 = 500; 47+2+1 = 50), and the `tls`
5.8% undelivered reproduces the baseline recorded in
[tells-runbook.md](tells-runbook.md) §2b.

---

## 8. The tripwire (check #4)

Runbook §2b — **undelivered > 8% on a matured batch → drop MPS to 10/s, hold
48h** — automated as a fourth check inside the existing
`/api/cron/tells-monitors`, on the shared layer.

- **Batch = stage.** Matured sends only (`DLR_MATURITY_MINUTES` = 10), window 6h,
  floor 50 sends (`DLR_COVERAGE_MIN_SENDS`) — below that a rate is noise, and
  alerting on noise is how a monitor gets muted.
- **Breach-only Telegram**, one line appended to the existing message; the
  undelivered figure is shown on *every* breach so the rate is always visible
  next to a delivery-related alert.
- **DETECTS ONLY.** The MPS response stays manual per the runbook; nothing in the
  monitor writes `provider_phones.max_sends_per_second`.

> ⚠️ **The 8% threshold is calibrated to ONE number** — the `tls` toll-free
> number's 5.8% baseline at 5/s. It is not a platform constant and must not be
> inherited. `txr` and `ahi` have no baseline yet (50 and 1 sends all-time); this
> report is the instrument that will accumulate them, after which each
> DLR-capable provider gets its **own configured threshold** and the check
> generalizes beyond `tls`. Until a provider has a baseline it gets **no**
> threshold, not a default 8%. Path: ClickUp `869ehwae3`.
