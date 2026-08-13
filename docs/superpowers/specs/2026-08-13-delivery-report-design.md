# Delivery Report — design

**Date:** 2026-08-13
**Branch:** `feat/delivery-report`
**Status:** approved, ready to build

Delivery-rate visibility across the platform. Three deliverables over ONE query
layer, so the human view and the automated alert can never disagree:

1. `/reports/delivery` — a new dimension in the reports section, one row per provider.
2. A `Delivered %` column on the Overview report's campaign and stage rows.
3. An undelivered tripwire monitor (runbook §2b: undelivered > 8% on a matured batch).

---

## 1. Recon findings (verified against prod, read-only, 2026-08-13)

Every claim below was measured, not assumed. The originating brief was right on
the shape and wrong in two places; both are recorded here because the
corrections are the load-bearing part of the design.

### 1.1 Source mapping

| Provider | DLR source | State |
|---|---|---|
| `tls` (855) | `tells_webhook_events`, `kind='dlr'`, key `matched_stage_send_id` | 967 rows → 500 messages, 100% matched |
| `txr` (641) | `textrequest_dlr_events`, key `coalesce(matched_stage_send_id, stage_send_id)` | 158 rows → **50 messages** |
| `ahi` (314) | `ahoi_dlr_events`, key `matched_stage_send_id` | 5 rows; status arrives **mixed-case** (`delivered` AND `DELIVERED`) |
| `txh` (2), `txh2` (499) | **none exists** | see below |
| `snx` (1), `smpl` (96) | none | `snx` archived 2026-08-13; `smpl` `supports_api_send=false` |

**Correction to the brief.** There is no TextHub DLR table at all.
`texthub_inbound_events` (91,325 rows) is reply/STOP intake and has no status
column. A delivery-report endpoint exists on TextHub's side
(`?dlr=true&id=<message_id>`, contract verified in
[scripts/probe-texthub-status.ts](../../../scripts/probe-texthub-status.ts)) but
nothing polls it and nothing stores it. So `—` for `txh`/`txh2` is a **data
fact today**, not only a policy choice. The policy still matters for the future:
the capability declaration (§3) is what decides whether a future poller's output
is trusted, and it is the thing to change deliberately if one is ever built.

### 1.2 Provider attribution is unambiguous

```
sent rows 2,954,934 · provider_phone_id NULL: 0 · stage sms_provider_id NULL: 0
stage_sends.provider_phone_id→provider_id  vs  campaign_stages.sms_provider_id
  DISAGREEMENTS: 0
```

And **no stage is mixed-provider** (0 of 882 stages with sends). A stage
therefore maps losslessly to exactly one provider, which is what makes the
stage-grain primitive in §2 correct AND cheap.

**Campaigns CAN be mixed:** 4 of 212 campaigns with sends span >1 provider. The
mixed-campaign treatment in §5.2 is a real case, not a hypothetical.

### 1.3 The three counting traps

Each of these produced a wrong number during recon before being corrected.

**(a) Row-counting inflates `txr` 3.2×.** Text Request writes one row from the
per-message `status_callback` AND another from the reconcile poll. 158 event
rows cover 50 messages; 155 of those rows are terminal. Counting rows reports
149 delivered against 50 sent = **298% delivered**. The fold to one terminal
status per message MUST happen before the join to sends.

**(b) "No receipt" is not "no event row".** A `tls` message emits `sent` (non-
terminal) and then `delivered`; a failure emits only `undelivered`. A message
with just the non-terminal `sent` row HAS an event row but HAS NO receipt.
Defining no-receipt as "no matching event" reported 0 where the truth was 14.

```
no_receipt := NOT (has_delivered OR has_undelivered)     -- correct
no_receipt := no matching event row                      -- WRONG
```

**(c) Ungated computation reads as a platform-wide outage.** Running the
delivery query across all providers with no capability gate, today:

```
txh2   357,567 sent   0 delivered   0 undelivered   0.0%
txh    211,092 sent   0 delivered   0 undelivered   0.0%
tls        500 sent 457 delivered  29 undelivered  91.4%
txr         50 sent  47 delivered   2 undelivered  94.0%
```

568,659 sends — 99.9% of platform volume — rendering `0.0%`. This is why the
capability gate produces `null`, structurally, rather than the UI hiding a
computed zero.

### 1.4 Verified output (7-day window, 2026-08-13)

With dedup + precedence + the correct no-receipt definition:

```
prov   sent  delivered  undelivered  no_receipt  delivered%  undelivered%
tls     500        457           29          14       91.4%          5.8%
txr      50         47            2           1       94.0%          4.0%
```

Both rows foot exactly (457+29+14 = 500; 47+2+1 = 50). The `tls` 5.8%
undelivered **reproduces the baseline recorded in the runbook** from the
2026-08-13 validation send — an independent cross-check that this query layer
computes what the runbook computed by hand.

> Note on a 6-message difference from the runbook's `451 delivered / 480
> terminal`: those figures were taken from the monitor's 6-hour window with
> 10-minute maturity; six more DLRs landed afterwards. Late arrival is expected
> and is precisely why the tripwire needs a maturity gate (§6).

### 1.5 Cost — measured, and the reason for the 14-day cap

`stage_sends` is 3,067,188 rows / 2601 MB. The dominant cost is the scan; the
DLR side is ~4 ms.

| Window | Sends scanned | Time | Buffers |
|---|---|---|---|
| 7 days | 569,208 | **0.31 – 1.31 s** | 354K |
| 30 days | 2,198,888 | **11.0 s** | 1.45M |

`stage_sends_org_sent_at_idx` is `(org_id, sent_at) WHERE sent_at IS NOT NULL`,
so `status` and `stage_id` are heap fetches. 30 days would exceed the function
limit.

**The obvious escape hatch is dead:** `campaign_stages.sms_count` is `0` on all
882 stages with API sends (it is a manual-mode field), so `Sent` cannot come
from a pre-aggregate. Verified, not assumed.

**Decision: cap the window at 14 days.** No migration in this change. The
covering index and the 30d/92d range go on the follow-up card (§8).

### 1.6 Denominator

The brief specified `send_attempts`. This design uses
**`stage_sends.status = 'sent'`** instead:

- It is the project's single shared definition of "was messaged"
  (CLAUDE.md §10e), used by the reports rollup, the send circuit breakers, and
  the `sent_from_provider_phone` segment rule.
- It is what `getStageMetricsInRange` counts, so the Delivery report reconciles
  with Overview's `Total Sent` rather than diverging from it.
- `send_attempts` is multi-row per message under retry, so it would need its own
  dedup and still would not tie out.

---

## 2. The shared layer

`lib/reporting/delivery.ts`, exporting one query function:

```ts
getDeliveryByStage(orgId, { from, to }): Promise<DeliveryStageRow[]>

interface DeliveryStageRow {
  stage_id: number;
  sent: number;
  delivered: number;
  undelivered: number;
  no_receipt: number;   // sent AND NOT (delivered OR undelivered)
}
```

**Grain is stated in code and enforced by construction.** The function returns
STAGE grain and nothing else. Every surface aggregates these rows at its own
display grain; no surface consumes another surface's aggregated output.

**Why stage-grain rows are safely additive here** (and counted-clickers were
not): a message belongs to exactly one stage, and dedup to one terminal status
per message already happened inside the query. Provider and campaign totals are
therefore sums over disjoint message sets, not sums over overlapping
deduplicated sets. This distinction is the EPC workstream's lesson and must be
restated in the module header, because "counts aren't additive" is exactly the
kind of note that gets misapplied in both directions.

Aggregation helpers live beside it as pure functions over `DeliveryStageRow[]`
so they are unit-testable without a database:

```ts
rollupByProvider(rows, stageProvider): DeliveryProviderRow[]
rollupByCampaign(rows, stageCampaign, stageProvider): Map<number, DeliveryCampaignCell>
```

---

## 3. Capability declaration

Report rows come from the `sms_providers` **registry** — every current and
future provider, never a hardcoded list. Capability comes from a declaration
whose DEFAULT is "no DLR source":

```ts
interface DlrSource {
  table: string;
  key: string;      // SQL expression yielding the stage_send id
  filter?: string;  // extra predicate (tls needs kind='dlr')
}

const DLR_SOURCES: Record<string, DlrSource> = {
  tls: { table: "tells_webhook_events",   key: "matched_stage_send_id",
         filter: "kind = 'dlr'" },
  txr: { table: "textrequest_dlr_events", key: "coalesce(matched_stage_send_id, stage_send_id)" },
  ahi: { table: "ahoi_dlr_events",        key: "matched_stage_send_id" },
  // ABSENT = no DLR intake. txh/txh2 have no DLR table at all (§1.1);
  // snx/smpl do not API-send.
};
```

Keyed on `sms_providers.sms_provider_id` (the short DB code — `ahi` not `ahoi`;
see the provider-key convention).

Consequences, both intended:

- A provider row added to the registry tomorrow appears in the report
  immediately, with `—`, needing no report change.
- When a provider's DLR intake becomes real, registering it here lights its
  cells up — also with no report change.

**Gating is structural.** A provider with no source yields `null` for
Delivered / Undelivered / No-receipt / %, never `0`, and never a value computed
from whatever rows happen to exist. If a future TextHub poller wrote fabricated
100%-delivered receipts, the absent declaration suppresses them.

`lower(status)` is applied on every source — Ahoi emits both cases (§1.1).

---

## 4. The query

One scan of `stage_sends`, one fold of the DLR sources.

```sql
WITH sends AS (                       -- the only expensive step (§1.5)
  SELECT id, stage_id
  FROM stage_sends
  WHERE org_id = $1 AND status = 'sent'
    AND sent_at >= $2 AND sent_at < $3
),
terminal AS (                          -- ONE row per MESSAGE, ~490 rows today
  SELECT <key> AS ss_id,
         bool_or(lower(status) = 'delivered')   AS d,
         bool_or(lower(status) = 'undelivered') AS u
  FROM <capable table>
  WHERE lower(status) IN ('delivered','undelivered') AND <key> IS NOT NULL
    [AND <filter>]
  GROUP BY 1
  -- UNION ALL one such block per registered source
)
SELECT s.stage_id,
       count(*)::int                                              AS sent,
       count(*) FILTER (WHERE t.d)::int                           AS delivered,
       count(*) FILTER (WHERE t.u AND NOT COALESCE(t.d,false))::int AS undelivered,
       count(*) FILTER (WHERE NOT COALESCE(t.d OR t.u, false))::int AS no_receipt
FROM sends s
LEFT JOIN terminal t ON t.ss_id = s.id
GROUP BY 1;
```

Three properties to preserve in any refactor:

1. **`GROUP BY <key>` happens before the join to `sends`.** Folding after the
   join reintroduces the `txr` 3.2× inflation (§1.3a).
2. **`delivered` beats `undelivered`.** Matches the precedence already used in
   `lib/sends/tells-monitors.ts`. No message currently carries both terminal
   statuses (verified 0 for `tls` and `txr`), but nothing structurally prevents
   it, so the rule is explicit rather than incidental.
3. **`no_receipt` is `NOT (d OR u)`**, not "no joined row" (§1.3b).

The terminal CTE only ever contains rows from registered sources, so
non-capable stages naturally aggregate to zeros; the capability declaration then
converts those zeros to `null` in TypeScript. Belt and braces — the SQL stays
simple and the gate does not depend on the SQL being right.

The hash probe against a ~490-row build side is negligible; the measured
per-stage scan is the cost in §1.5. **The final query's measured cost goes in
the PR description**, not extrapolated from these numbers.

---

## 5. Surfaces

### 5.1 `/reports/delivery`

Its own route and component. The existing `app/(protected)/reports/[dimension]`
route renders `PerformanceReport`, whose EPC/revenue/clicker column set does not
fit; a literal `delivery` path segment takes precedence over `[dimension]` in
Next.js, so the two coexist without touching `REPORT_DIMENSIONS`.

- `app/(protected)/reports/delivery/page.tsx`
- `components/reports/delivery-report.tsx`
- `app/api/reports/delivery/route.ts` — `campaigns.view` (matches Overview and
  the other report routes), 14-day cap enforced server-side.

Columns: **Provider · Sent · Delivered · Undelivered · No receipt · Delivered %**

Rows: every non-archived provider in the registry, plus any archived provider
with sends in the window (so `snx` history does not silently vanish). A capable
provider with no sends in the window shows a zero row — "Tells sent nothing this
week" is information.

Non-capable providers render `—` in all four DLR columns with a "no reliable
DLR" note. **Never `0%`.**

Window selector: 1d / 7d / 14d, default 7d. **The window is labelled on the
surface** — figures from different windows are not comparable.

`No receipt` is displayed, never folded into the percentage. The UI notes that
recently-sent messages may not have matured; the report deliberately applies no
maturity gate (unlike the tripwire, §6) because it is showing a count, not
deciding whether to alert.

### 5.2 Overview `Delivered %` column

One column added to `components/reports/keitaro-report.tsx` and its route,
sourced from the same layer at the same grain the row renders.

- **Stage rows** — plain percentage. Stages are single-provider (§1.2), so no
  coverage label is ever needed. `—` when the stage's provider is not capable.
- **Campaign rows** — percentage computed over the campaign's **DLR-capable
  sends only**, with the coverage labelled:

  ```
  91.4% (of 4% of sends)
  ```

  `—` when no send in the campaign is DLR-capable. The label is not optional:
  a 4%-coverage figure and a 100%-coverage figure are otherwise indistinguishable.

---

## 6. Tripwire — check #4 in `runTellsMonitors`

Built on the same layer, so the alert and the page cannot disagree — that is the
entire reason it is not a separate query.

Extends `lib/sends/tells-monitors.ts` and its existing cron
(`/api/cron/tells-monitors`), reusing breach-only Telegram delivery, the
`cron_locks` heartbeat, and the dead-man pairing with the sweeper.

- **Batch = stage.** A stage is one send batch and is single-provider (§1.2).
- **Scope:** `tls` stages with sends in `DLR_COVERAGE_WINDOW_HOURS` (6).
- **Maturity:** matured sends only, reusing `DLR_MATURITY_MINUTES` (10) —
  observed terminal-DLR latency was p50 2 s, p99 9 s, max 401 s.
- **Floor:** reuse `DLR_COVERAGE_MIN_SENDS` (50). Below that the rate is noise,
  and alerting on noise is how a monitor gets muted.
- **Rule:** `undelivered / sent > 0.08` on a matured batch.
- **Action:** breach-only Telegram line appended to the existing message.
  **Detection only.** The operator response (drop MPS to 10/s, hold 48 h) stays
  manual per the runbook — the monitor never touches `max_sends_per_second`.

Threshold exported as a named constant beside the existing ones, with its
calibration basis in the comment.

### 6.1 Runbook SQL correction — ships in this PR

The runbook's §2b tripwire SQL divides by *messages with any DLR event*:

```
29 / 486 = 5.97%     -- the runbook's SQL as written
29 / 500 = 5.8%      -- the runbook's RECORDED baseline figure
```

The recorded 5.8% baseline used the `sent` denominator, so the SQL block and
the figure beside it already disagree. Check #4 uses `undelivered / sent`,
consistent with this design's stated grain rule (`Delivered % = delivered /
sent`, accepted sends as denominator) and with the recorded baseline. **The
runbook's SQL block is corrected in this same PR** so the runbook and the
automated check can never diverge.

### 6.2 Per-provider thresholds — the generalization path (NOT in this change)

The 8% threshold is calibrated to **one** number: the `tls` toll-free number's
5.8% undelivered baseline at 5/s, observed on the 2026-08-13 validation send.
It is not a platform constant and must not be applied to another provider by
inheritance.

`txr` and `ahi` have no baseline yet — 50 and 1 sends respectively. This report
is the instrument that will accumulate those baselines.

**Intended path, on the follow-up card (§8):** once a DLR-capable provider has
enough observed volume to establish a baseline, each provider gets its **own
configured threshold**, and check #4 generalizes to iterate DLR-capable
providers rather than being `tls`-scoped. Until a provider has a baseline, it
gets no threshold rather than 8% — an uncalibrated monitor is a monitor that
gets muted, which is the failure mode the existing Tells monitors were
explicitly designed around.

This is recorded here so the `tls` scoping reads as a deliberate stopping point
rather than an oversight.

---

## 7. Verification

`scripts/verify-delivery-grains.ts`, in the spirit of
`verify-epc-surface-grains.ts`:

1. **Every row foots:** `delivered + undelivered + no_receipt == sent`, per
   stage AND per provider rollup.
2. **Capability gate holds:** non-capable providers emit `null`, never `0`, for
   all four DLR columns.
3. **Dedup holds:** the `txr` source folds 158 event rows to 50 messages; a
   regression to row-counting fails the check.
4. **Rollups agree:** provider totals and campaign totals both reconstruct from
   the same stage rows.
5. **Prints its input scope** — window, org, provider set, row counts — so a
   passing check cannot be read against an unknown universe.

Plus unit tests for the pure aggregators (`rollupByProvider`,
`rollupByCampaign`, the coverage-label rule) and for the check #4 breach
predicate, following the existing `dlrCoverageBreached` / `inboundSilenceBreached`
pattern of testable pure decision helpers.

**The verify script's output goes in the PR description.**

---

## 8. Scope boundaries

**In this change:** the shared layer, `/reports/delivery`, the Overview column,
check #4, the runbook SQL correction, the verify script, docs.

**Explicitly NOT in this change** — one follow-up ClickUp card covering both,
since both are gated:

1. **Covering index + 30d/92d windows.** `(org_id, sent_at) INCLUDE (stage_id)
   WHERE status = 'sent'`, est. 100–150 MB on a 2.6 GB table, taking the 30-day
   window from 11.0 s toward sub-second. **A migration — needs Dmytro.**
2. **Per-provider tripwire thresholds** (§6.2), once `txr`/`ahi` baselines exist.

**Gates.** No migration is expected and none is approved; if recon during build
turns out to require one, stop and ask. The tripwire is monitoring, not
compliance logic and not carrier pacing — it detects and never adjusts MPS — so
self-merge on green verification applies.

---

## 9. Documentation

Per CLAUDE.md's mandatory checklist:

- `docs/04-features/delivery-report.md` — new.
- `docs/07-conventions.md` — the grain rule, the three counting traps (§1.3),
  and the capability-declaration convention.
- `docs/04-features/tells-runbook.md` — §2b SQL correction; tripwire now automated.
- `docs/04-features/reports-rollup.md` — the new tab.
- `docs/CHANGELOG.md` — one-line entry.
- No schema change ⇒ `docs/03-data-model.md` and the ERD are untouched.
