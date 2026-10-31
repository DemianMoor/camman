# Drip lead enrichment (Phase 3)

_Last updated: 2026-10-30 (partner_data passthrough copy, 0228); 2026-10-23 (0222 toll-free gate link); 2026-10-22 (zip attribute, 0219); 2026-10-21 (the contact gets its lookup line_type at creation; 0218 gate); 2026-10-12 (poke chain, 0206); 2026-10-11 (batches until the 45 s deadline; no head-of-line block on the lookup cap); 2026-10-09 (digest lookup cost uses the bulk-batch-only calibrated rate); 2026-10-07_

The consumer of `lead_inbox`. Normalizes a captured lead, resolves its line type through the
**existing** Telnyx lookup queue, discards landlines, and turns everything else into a contact with
attributes, an arrival event, and drip-group membership. **Zero sends** — the send path is Phase 5.

Card `869endkqt` · migrations **0155–0158** · recon:
[2026-08-23-drip-phase-3-enrichment-recon.md](../superpowers/specs/2026-08-23-drip-phase-3-enrichment-recon.md)

## Shape

`/api/cron/lead-enrichment` (every minute) under `withCronLease('lead-enrichment')` →
[lib/drip/enrichment.ts](../../lib/drip/enrichment.ts).

**Two passes, and the design is forced.** The Telnyx lookup worker is a synchronous **poll** — it
claims from `lookup_queue` and calls Telnyx inline ([lib/telnyx/worker.ts](../../lib/telnyx/worker.ts))
— so there is no callback to receive and no way to block on a result inside one tick.

| Pass | Claims | Does |
|---|---|---|
| 1 | `status='received'` | normalize → cache hit? finalize now : enqueue + park as `awaiting_lookup` |
| 2 | `status='awaiting_lookup'` **whose lookup is complete** | finalize |

Latency: **same pass on a cache hit**, ~2–5 min on a miss, degraded while a bulk upload is in the
queue (mitigated below). Only ~1 % of pml leads are cache hits (2026-10-06..12). With the **poke
chain** on (0206, [drip-poke-chain.md](drip-poke-chain.md)), intake pokes this sweeper, the sweeper
pokes the lookup worker when it queues lookups, and the worker pokes the sweeper back when lookups
finish. A miss then resolves in seconds instead of on the next `*/2` + `* * * * *` ticks.
Lookups stay queue-based.

## Line-type policy — only landline is discarded

**⚠️ voip and unknown are saved and processed exactly like mobile.** This matches the existing
documented policy in [lib/telnyx/map-line-type.ts](../../lib/telnyx/map-line-type.ts) — *"we never
silently suppress a number we're unsure about"* — and `sync-contacts` likewise suppresses landline
only.

The asymmetry decides it: discarding is **irreversible and already paid for** (the row is deleted
and the lookup is spent), while keeping costs one row. `line_type` is stamped on the lead event and
counted in its own column, so Phase 4 can filter a population it can actually see.

Intake still keeps voip/unknown; **filtering them is a per-group choice** made at selection time —
the contact group's **Allow VoIP / Allow unknown** boxes (migration 0218,
[contacts-and-groups.md](contacts-and-groups.md#allowed-number-types-migrations-0218-0222)).

**⚠️ The contact gets the lookup's `line_type` / `carrier_norm` when enrichment creates it**
(2026-10-20). The worker's `syncContactsForPhones` copy runs when the lookup completes — before the
contact exists — so until this fix every drip contact kept `unknown` / `Unidentified` (421K of them,
repaired by `scripts/backfill-contact-line-type.ts`). Segment rules on phone type / carrier and the
0218 gate read the contact's copy, so it has to be right at creation.

**⚠️ "unknown" means two different things** — Telnyx looked and could not classify (8,526 numbers),
*or* the number was never looked up at all (8,413 contacts). A rule that discarded "unknown" would
discard both.

## What happens to a landline

Counted in `lead_intake_daily`, then the `lead_inbox` row is **deleted** — in the **same
transaction**, so there is no window where the lead is neither a row nor a count.

`lead_events.inbox_id` is `ON DELETE SET NULL`, **not** cascade. A cascade would take the lead event
with the deleted inbox row, destroying the evidence the ledger exists to preserve.

## Contact groups

Every processed lead joins **"Drip intake"** (sandbox: **"Drip sandbox"**). Since 2026-10-07 a
**real** lead also joins its **partner × tag group**, named `<partner_slug>-<interest_tag>` in
lowercase (e.g. `pml-aca`; no tag ⇒ `pml-untagged`). Created on first use by
`ensurePartnerTagGroup` in [lib/drip/groups.ts](../../lib/drip/groups.ts); membership is
`ON CONFLICT DO NOTHING`, so a repeat lead is a no-op.

- **Sandbox leads never join one** — the sandbox group stays the only place they live.
- **⚠️ The group's `contact_group_id` is `drip:<org_id>:<name>`.** `contact_group_id` is unique across
  ALL orgs and the upsert returns whichever row owns the key, so a key without the org id would write
  one org's contacts into another org's group the day two orgs share a partner slug.
- Leads that arrived before the change: `scripts/backfill-partner-tag-groups.ts`
  (dry run by default; `--apply` writes; `--partner=<slug>` scopes it). Idempotent.

## Sandbox

Runs the **whole** pipeline except two things: no Telnyx call (marked lookup-skipped), and
membership of the **"Drip sandbox"** group rather than "Drip intake".

**⚠️ The separate group is the safety boundary, not a label.** A drip campaign's audience is built
from the real group, so sandbox leads are unsendable structurally. A shared group with a boolean flag
would put the entire guarantee on every future query remembering to filter.

Counted **exclusively** as `sandbox` — never in `received`/`mobile`/`landline` — so Phase 7 reads
real partner volume without filtering.

## Guards

| Guard | Behaviour |
|---|---|
| Drip daily sub-cap | `lookup_settings.drip_daily_cap` (default 50,000), counted per **ET** day against `lookups_spent` (Telnyx **calls**, not leads — a cache hit costs nothing) |
| Account-global cap | `lookup_settings.lookup_daily_cap`, **Warsaw** midnight, untouched |
| Top-up alert | `balance < GREATEST(7 × avg_daily_spend_7d, balance_floor_usd)`, default floor $50 |

**⚠️ Two different day boundaries now live in one flow.** Warsaw midnight is **18:00 ET** —
measured — i.e. *inside* the 8 AM–9 PM ET drip window. One ET drip day straddles two global cap days,
and the global cap can exhaust mid-afternoon ET and refill at 6 PM, which looks exactly like an
outage. Anything surfacing either number must say which day it means.

**⚠️ The balance floor is not belt-and-braces — it is the only working half at launch.** Seven-day
lookup spend was **$0.00** when this shipped (no batches since 2026-08-10), so `7 × avg` evaluates to
$0 and a purely historical threshold would never fire, precisely when drip first needs it.

**⚠️ Cap exhaustion leaves the row as `received`, not `awaiting_lookup`.** The claim only re-picks an
awaiting row whose lookup is **complete**, so parking a never-enqueued lead there would strand it
silently forever. Leaving it `received` keeps it claimable next tick.

## Throughput: batches until the deadline (2026-10-11)

One tick now claims and processes batches of 200, **each in its own transaction**, until nothing is
claimable, 45 s have passed (`ENRICHMENT_DEADLINE_MS`; the route allows 60 s), or 1,500 claims
(`ENRICHMENT_MAX_CLAIMS_PER_TICK`). Pass-2 rows (lookup complete, finishing a lead) are claimed
before pass-1 rows. Each batch belongs to ONE org (the one owning the oldest claimable row); the
batch used to take `rows[0].org_id` for rows that could span orgs.

**Why:** one batch of 200 per tick, with every cache miss claimed twice, capped processing at
~100 leads/min. On 2026-10-10 ProMarketing's 50,000 took **8 h 16 min**: arrival → lookup reached a
median of 251 min while the Telnyx worker (30 rps ≈ 1,800/min) was mostly idle, and lookup →
processed took ~12 s.

**Cost:** ~14 database round trips and ~5–8 ms of DB time per lead (pg_stat_statements on prod).
Production runs in Vercel `fra1` next to Supabase `eu-central-1`, so a batch of 200 is ~5 s and a
45 s tick is ~1,500 claims ≈ 650–750 leads/min. The cron logs one `[lead-enrichment] {…}` line per
tick (`claimed`, `processed`, `batches`, `elapsedMs`, `hitDeadline`); read that for the real figure.

**No head-of-line block on the lookup cap.** When the drip lookup sub-cap is spent, a `received` row
that needs Telnyx is no longer claimed at all. Before, up to 200 such rows headed every batch (each
left `received` as `capDeferred`), so leads whose lookup had completed behind them waited for the ET
day to roll over. Proof: `scripts/test-drip-enrichment-throughput.ts`. With the cap spent and 50
ready leads behind 300 blocked ones, **50 were processed** (old code: **0**, with 200 claimed and
deferred).

## Queue priority (head-of-line blocking)

`lookup_queue` has no `org_id` — it is **account-global** — and was claimed strict FIFO. A bulk
upload put every later drip lead behind the whole batch: measured **p50 42 min, p95 111 min** across
259,863 lookups from batches of 19,713–229,867 numbers. Same failure class as the scheduled-drain
head-of-line incident.

Claim order is now `priority DESC, created_at, id`. Everything except drip stays at the default `0`,
so with one distinct value in the table the ordering is **byte-identical** to before — asserted by
the mixed-queue case in [scripts/test-drip-enrichment-schema.ts](../../scripts/test-drip-enrichment-schema.ts),
which compares the bulk subsequence against the old ordering rather than just checking drip goes
first.

## Monitors

`/api/cron/drip-monitors` — a **different job** from the sweeper it watches. A job that reports on
its own liveness is silent in exactly the case that matters. Same mutual dead-man arrangement as
`tells-sweep`/`tells-monitors`.

**⚠️ `awaiting_lookup` is counted separately from `received`.** They fail for different reasons and
need different responses: a pile of `received` means the sweeper is behind or dead; a pile of
`awaiting_lookup` means the Telnyx side is stuck. Summing them lets a stalled lookup hide inside a
healthy-looking inbox.

The backlog alert ships **here, with its consumer** — in Phase 2 nothing drained the inbox by design,
so it would have fired on the first lead and stayed firing forever.

## Hourly partner-intake digest

_Added 2026-10-07 (migration 0199)._ Drip-intake lookup batches **no longer post per-batch
Telegram messages**. `finalizeCompletedBatches` ([lib/telnyx/worker.ts](../../lib/telnyx/worker.ts))
skips the "📇 Lookup batch complete" summary when `trigger = 'drip_intake'`; `upload`, `backfill` and
`csv_update` batches keep theirs, and the balance-floor / cap / backlog alerts are unchanged.

Instead, every tick of `/api/cron/telegram-report` (`0 * * * *`, after the performance report)
sends one **digest of the hour that just ended**, built by `buildIntakeDigest`
([lib/drip/intake-digest.ts](../../lib/drip/intake-digest.ts)) and rendered by the pure
`formatIntakeDigest` ([lib/drip/intake-digest-format.ts](../../lib/drip/intake-digest-format.ts)):

- **Source:** `lead_intake_hourly` — written by `bumpIntakeCounters` in the same statement as
  `lead_intake_daily`. The hour is the **processing** hour (when enrichment counted the lead), the
  same clock as the daily row, not the partner's `received_at`.
- **Per partner key (`partner_slug`) × resolved tag:** leads (`received`), mobile, voip / unknown /
  landline, lookups (`lookups_spent`), cost. Sandbox-only rows are not shown.
- **Cost** = lookups × the partner report's calibrated rate (`getCalibratedLookupRate`, 90-day ledger
  of **upload/backfill batches only** since 2026-10-09, flat-rate fallback) — **never** the per-batch
  balance delta, which reads $0.00 on 1–2-lookup drip batches; those batches are excluded from the
  calibration altogether ([drip-partner-reporting.md](drip-partner-reporting.md) §3). The footer no longer spells out the rate derivation (dropped by the owner, 2026-10-07). Sub-dollar costs print 4 decimals.
- **Format:** one partner × tag → compact lines; several → a `<pre>` table
  `Partner | Tag | Leads | Mobile | Lookups | Cost` with a TOTAL row, plus one compact
  voip/unknown/landline line per row. Over 3,500 chars it splits **by partner** across numbered
  messages (a partner is split only if it alone doesn't fit); totals and footer go on the last part.
- **Footer:** the Telnyx balance (once), and on the first-ever digest a note that
  hourly tracking began mid-hour — that partial hour is never digested on schedule.
- **No message for an hour with no intake.** It is a digest, not an alert: no `alert_state`, no
  transition gating.
- **Self-check:** each digest re-verifies `SUM(hourly) = daily` for the digested hour's ET day,
  every counter column, per partner × tag (`checkDaySumInvariant`), and appends a
  `⚠️ Day-sum check FAILED` line naming the breaks instead of failing silently. A day that began
  before tracking did (the deploy day) is skipped. On demand, read-only:
  `npx tsx --conditions=react-server scripts/check-intake-hourly-invariant.ts [fromDay] [toDay]`.
- **Isolation:** the digest build is time-boxed (10 s) and wrapped in its own try/catch; a failure
  logs and posts one plain-text line, and never breaks the report or the watches.
- **Manual re-run:** `GET /api/cron/telegram-report?digestHour=<ISO instant>` (CRON_SECRET) re-sends
  the digest for that hour, marked "(manual re-run)", without touching the performance report.
- **Known edge:** a batch that started before :00 and commits a few seconds after is counted in the
  earlier hour, after that hour's digest may already have been built — it stays in the table and the
  daily report, it is just not in that digest.

Tests: [scripts/test-intake-digest-format.ts](../../scripts/test-intake-digest-format.ts) (pure) and
[scripts/test-intake-hourly-db.ts](../../scripts/test-intake-hourly-db.ts) (preview DB, rolled back:
dual write, one-statement atomicity, invariant, digest).

## Idempotency

The sweeper is crash-safe by construction: the batch is claimed `FOR UPDATE SKIP LOCKED` in one
transaction and the status write is the commit point. A re-run after a crash between "write event"
and "mark processed" is a no-op, because `lead_events` carries a partial `UNIQUE (inbox_id)` and the
insert is `ON CONFLICT DO NOTHING`. Contact and attribute writes are upserts;
`COALESCE(EXCLUDED.x, existing)` means a later, sparser lead can never blank a value already known.

## Partner passthrough data (0228, 2026-10-30)

`insertLeadEvent` in [lib/drip/enrichment.ts](../../lib/drip/enrichment.ts) copies
`lead_inbox.partner_data` onto the new `lead_events.partner_data` (NULL stays NULL). It is a plain
copy of what intake already validated; enrichment neither re-validates nor reads the key's
whitelist. See [partner-lead-intake.md](partner-lead-intake.md#passthrough-fields-0228-2026-10-30).

## ZIP code (0219, 2026-10-20)

`zip` is a canonical lead field (`lib/intake/fields.ts`; aliases `zip_code`, `zipcode`, `postal_code`, `postal`, `postcode`; a partner key's `field_mapping` wins). `normalizeLead` stores it **trimmed, as received** — except a zip that lost its leading zero: a JSON number or a digits-only value of 3–4 characters is left-padded to 5 (`2134` → `02134`; `normalizeZipInput`, shared with the CSV import and the backfill); the `{zip}` personalization tag normalizes at render (5 digits, ZIP+4 cut — `lib/messages/tags.ts`). The attribute upsert is `upsertLeadAttributes` (same COALESCE rule: a lead without a zip never blanks a known one).

Before 0219 enrichment dropped zip although partner `pml` sends it on ~96% of leads. `scripts/backfill-contact-zip.ts` recovers it from `lead_inbox.raw` for contacts whose zip is still NULL, using the same extraction (`lib/drip/zip-backfill.ts`; newest lead carrying a zip wins). Dry run by default (READ ONLY); `--apply` writes per batch, idempotent, never overwrites a known zip. Owner-gated on prod, off-hours (~300 MB read).
