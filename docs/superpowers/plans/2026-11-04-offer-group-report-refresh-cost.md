# Plan — make the `offer_group_report_mv` refresh cheaper

_Last updated: 2026-11-04 · Status: proposal for dev-lead review_

## 1. Why this exists

`offer_group_report_mv` holds the offer × contact-group rows behind **Audience
Stats** and **Offers x Group** (295 rows, 176 kB). It is rebuilt from all-time
history twice a day (05:00 / 20:00 UTC) and has been the slowest view of the
report refresh for months:

| Date | Group-view refresh | Limit in force |
|---|---|---|
| 2026-09-21 | 107.5 s | 120 s → raised to 180 s |
| 2026-10-27 | 175.9 s (peak) | 180 s |
| 2026-11-02 20:00 UTC | ~165 s (last success) | 180 s |
| 2026-11-03 05:00, 20:00 · 11-04 05:00 | **cancelled at 180.0 s** | 180 s |

The three failures left both reports showing 2026-11-02 data with the red
"two refreshes missed" banner.

**Stopgap shipped 2026-11-04:** the timeout is now 230 s, and the summary and
offer-totals views moved to the 05:30 / 20:30 run so the main run still fits
Vercel's 300 s invocation limit. Details are in
[docs/04-features/offer-group-report.md](../../04-features/offer-group-report.md),
section "2026-11-04 — refresh headroom".

**Runway.** At the observed growth (~1.4 s/day, 107.5 s → ~165 s in six weeks)
the view reaches 230 s around mid-December, and sooner on a busy-cluster day
(the same SELECT has measured 163 s under load when it took ~100 s quiet).
**Treat 2026-12-01 as the deadline.** The 230 s cannot be raised much more:
the main run is ~280 s worst case against a hard 300 s.

## 2. Where the time goes (hypotheses, to confirm in Phase 0)

The definition (`pg_get_viewdef`, current on prod) has five CTEs. Input sizes
(catalog estimates, 2026-11-04):

| Table | Rows | Size |
|---|---|---|
| `stage_sends` | 7.6 M | 6.5 GB (~850 B/row) |
| `offer_exposures` | 3.2 M | 856 MB |
| `contact_contact_groups` | 2.5 M | 485 MB |
| `contacts` | 1.75 M | 804 MB |
| `counted_clickers` | 275 K | 156 MB |
| `opt_out_attributions` | 179 K | 30 MB |
| `conversion_events` | 3.4 K | 3 MB |

- **H1 — `stage_sends` is read in full twice.** `rate` counts sent rows per
  stage (cost per send), and `attr` scans every sent row again. Each pass reads a
  6.5 GB heap to use four narrow columns (`id`, `stage_id`, `contact_id`,
  `sent_at`).
- **H2 — the group fan-out and aggregate in `attr`.** Every sent row is joined to
  `contact_contact_groups` on `contact_id` with `group_id = ANY(camp.gids)`, then
  grouped by (org, offer, group). This was the 170 MB disk sort before
  `work_mem` was raised to 384 MB (2026-09-21).
- **H3 — `fresh` doesn't depend on sends at all.** It reads `contacts` ×
  `contact_contact_groups` and anti-joins `offer_exposures`. It only borrows the
  offer list from `attr`, but it runs inside the same statement and adds to the
  same timeout.
- `cell_clicks` / `cell_optouts` work on far smaller inputs and are expected to
  be minor.

Nothing here has been measured per node on the current data. That is Phase 0.

## 3. Phase 0 — measure (½ day)

1. Run `EXPLAIN (ANALYZE, BUFFERS)` once on prod for the view's defining SELECT
   at 384 MB `work_mem`, in an owner-approved quiet window. It is one ~3-minute
   heavy read, with the same cost as a refresh.
2. Record per-CTE time and buffers. Confirm or reject H1–H3.
3. Check the `stage_sends` visibility map (`pg_class.relallvisible` vs
   `relpages`). That decides whether an index-only scan (option A2) would really
   avoid the heap.
4. Find a per-stage sent count already stored that equals
   `count(*) WHERE status = 'sent'`. `campaign_stages.sms_count` is a candidate
   but is known **not** to equal it (Creative CTR fix, 09-14), so it must be
   checked, not assumed.

**Exit:** a table of where the ~180 s goes, and a pick from section 4.

## 4. Options

### A. Make the existing query cheaper — no change to any number (recommended first)

One migration that recreates the view with the same output, plus at most one
index.

- **A1 — one pass over `stage_sends` instead of two.** Derive the per-stage send
  count for `rate` from the same scan `attr` already does (aggregate to stage
  grain first, then roll up to the cell), or from a verified stored count
  (Phase 0 step 4).
- **A2 — covering partial index** on `stage_sends (stage_id, contact_id, id,
  sent_at) WHERE status = 'sent'`. This turns the 6.5 GB heap scan into an
  index-only scan of an estimated 300–400 MB. It costs write amplification on
  the busiest table in the system (every send inserts and updates it), and it
  needs `CREATE INDEX CONCURRENTLY` outside a transaction. **This is a lead
  call.**
- **A3 — move `fresh` into its own matview**, refreshed as a separate
  statement, and join it in. This takes H3's cost out of the critical statement
  without changing the number.

Expected: if H1 + H2 dominate, A1 + A2 should cut the refresh by more than half.
Phase 0 has to confirm this. Effort: 2–3 days including the preview test and
the paired before/after comparison of all 295 rows.

### B. Split the view into parts — same total work, but no single statement near the limit

Materialize `attr`, `cell_clicks`, `cell_optouts` and `fresh` as their own
matviews, refreshed one statement at a time. `offer_group_report_mv` stays as a
cheap final join under the same name, so no reader changes. Each statement gets
its own timeout. Total database time is unchanged, and the parts get refreshed
seconds apart (already true across views today).

Use this if A doesn't get enough, or as a quick fallback if the deadline gets
close. Effort: 2 days.

### C. Incremental rollup — the long-term fix, but it changes what the report means

Today **group membership is evaluated at refresh time.** A send counts toward a
group if the contact is in that group *now* (`contact_contact_groups` joined
live). So adding a contact to a group moves their whole send history into it.
That is why the view cannot simply add up new days: any upload changes the past.

An incremental design (a per-day or per-stage rollup that only adds new sends,
seconds per run regardless of history) needs **send-time attribution**: record
the contact's groups at send time, or freeze rows per finished stage. That
changes numbers on screen and is a **product decision for the owner** before
any engineering. Effort: 1–2 weeks, including the migration, backfill and
reconciliation.

### D. Move the refresh off Vercel (pg_cron) — not recommended on its own

This removes the 300 s ceiling, but the database cost and its growth stay the
same. `pg_cron` was not installed as of 2026-09-21, and alerting would have to
be rebuilt around stamp age. It doesn't fix the cause.

## 5. Recommendation and sequence

1. **Phase 0** this week (needs a quiet window and the owner's go).
2. **Option A** (A1 + A3, and A2 if the lead accepts the index), as one PR plus
   a migration. Preview test on camman-v2, then a paired before/after on prod
   that must match all 295 rows exactly. **Target: under 90 s.**
3. If A lands above ~120 s, add **B** on top.
4. Raise **C** with the owner separately. It is the only option that stops the
   growth, and it is a reporting-semantics change, not a perf fix.

## 6. Decisions needed from the dev lead

1. **Index on `stage_sends` (A2):** acceptable write cost on the hottest table,
   or rule it out?
2. **Phase 0 on prod:** OK to run one ~3-minute `EXPLAIN ANALYZE` in a quiet
   window, or measure only on a restored copy?
3. **Target and alarm:** is under 90 s the right bar? Do we also want a warning
   (e.g. Telegram) when `groupMs` passes ~150 s, instead of learning from a
   failure?
4. **Option C:** worth putting to the owner now, or park it until A has been
   measured?

## 7. Done means

- The group refresh runs under the agreed target on two consecutive prod runs,
  read back from the route's `groupMs` log line and the gaps between
  `report_refresh_log` stamps.
- All 295 rows match the pre-change view exactly (paired comparison script,
  committed under `scripts/`).
- `scripts/test-refresh-session.ts` stays green on preview.
- Docs updated: `docs/04-features/offer-group-report.md`,
  `docs/04-features/crons.md`, `docs/03-data-model.md` (if a migration or index
  is added) and `docs/CHANGELOG.md`.

## 8. Out of scope

The lifecycle and exposure views (their own run, ~60 s), the 300 s Vercel limit
itself, and any change to what the report shows (except through an explicit
decision on C).
