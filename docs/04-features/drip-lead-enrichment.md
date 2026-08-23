# Drip lead enrichment (Phase 3)

_Last updated: 2026-08-23_

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
queue (mitigated below).

## Line-type policy — only landline is discarded

**⚠️ voip and unknown are saved and processed exactly like mobile.** This matches the existing
documented policy in [lib/telnyx/map-line-type.ts](../../lib/telnyx/map-line-type.ts) — *"we never
silently suppress a number we're unsure about"* — and `sync-contacts` likewise suppresses landline
only.

The asymmetry decides it: discarding is **irreversible and already paid for** (the row is deleted
and the lookup is spent), while keeping costs one row. `line_type` is stamped on the lead event and
counted in its own column, so Phase 4 can filter a population it can actually see.

**⚠️ "unknown" means two different things** — Telnyx looked and could not classify (8,526 numbers),
*or* the number was never looked up at all (8,413 contacts). A rule that discarded "unknown" would
discard both.

## What happens to a landline

Counted in `lead_intake_daily`, then the `lead_inbox` row is **deleted** — in the **same
transaction**, so there is no window where the lead is neither a row nor a count.

`lead_events.inbox_id` is `ON DELETE SET NULL`, **not** cascade. A cascade would take the lead event
with the deleted inbox row, destroying the evidence the ledger exists to preserve.

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

## Idempotency

The sweeper is crash-safe by construction: the batch is claimed `FOR UPDATE SKIP LOCKED` in one
transaction and the status write is the commit point. A re-run after a crash between "write event"
and "mark processed" is a no-op, because `lead_events` carries a partial `UNIQUE (inbox_id)` and the
insert is `ON CONFLICT DO NOTHING`. Contact and attribute writes are upserts;
`COALESCE(EXCLUDED.x, existing)` means a later, sparser lead can never blank a value already known.
