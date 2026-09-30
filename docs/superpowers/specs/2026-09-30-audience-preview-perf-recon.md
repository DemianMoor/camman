# Recon — Campaign audience preview performance

_2026-09-30 · decision brief · no code changes proposed until you pick_

## The question

The audience preview on the campaign create form takes **18–35 seconds** for a
campaign built over the large contact groups. Today's fix stopped it *failing*.
It did not make it *fast*. This brief lays out what the time is actually spent
on, what it would cost to fix properly, and what I recommend.

**You are deciding:** do we invest in making the preview fast, make it cheaper
to run, or accept it as-is.

---

## 1. What shipped today (PR #248, live)

The reported symptom was `Vercel Runtime Timeout Error: Task timed out after 60
seconds` plus "Could not preview audience".

That was **not one slow query**. It was previews piling up. `pg_stat_activity`
on production showed four running at once, the oldest 49 s. The form waited
400 ms before asking, but once a request was sent it only *ignored* the answer
when you changed something — the request and its database query ran to the end.
An abandoned request does not cancel the query behind it.

| | before | after |
| --- | --- | --- |
| Previews running at once | up to 4, oldest 49 s | 1 |
| 60 s timeout + error | yes | should be gone |
| Message when one is genuinely too broad | "fix any issues above" | "narrow the selection and try again" |
| **One preview, biggest groups** | **18–35 s** | **18–35 s** |

⚠️ **Not yet confirmed under real use.** I verified no previews were queued
after deploy, but nobody was building a campaign at that moment. The first real
test is you using the form.

---

## 2. Where the time actually goes

Measured server-side (`EXPLAIN ANALYZE`) on one preview: four biggest contact
groups, Hot+Warm, offer 62. **36.8 s total, ~24 GB of buffer traffic.**

| step | cost | what it is |
| --- | ---: | --- |
| Build the candidate list | **16.8 s** | 646,339 contacts: group membership joined to contacts |
| `offer_limit` | **10.4 s** | scans 575,178 rows to find people who got this offer 5+ times — **found 0** |
| 7 chained joins | ~9.6 s | attaching opt-outs, clickers, in-use, statuses… to all 646,339 |
| `offer_cooldown` | 4.1 s | who got this offer in the last 7 days |
| `freeze_not_due` | 2.1 s | who is resting |

### The core problem, in one line

**The preview drags 646,339 contacts through eight joins to produce an answer of
25,267.**

It carries all 646,339 only because three numbers in the breakdown — *opted
out*, *suppressed*, *status not selected* — are counted across the whole group,
before your status filter narrows anything. Everything else in the query only
ever needed the ~87,000 contacts that match your selected statuses.

### Scale context (this org, measured)

| | |
| --- | ---: |
| Contacts | 973,731 (883,047 messageable) |
| Biggest groups | Manifestation 229,867 · Memory 187,361 · AstroEnergy 149,722 · Weight Loss 141,485 |
| Opt-outs | 183,167 |
| Clickers | 87,626 |
| Contacts locked in active campaigns | 72,937 |

The preview rebuilds sets of this size **on every form change**.

---

## 3. What I tried and reverted — don't ask for it again

I applied the temp-table technique that took campaign activation from 39 s to
4 s last week. Interleaved A/B on a quiet database:

| | run 1 | run 2 |
| --- | ---: | ---: |
| current | 33.6 s | 18.5 s |
| materialised | 35.1 s | 27.8 s |

Identical results out, and **slower**. Reverted. My first reading of this said
"36.8 s → 25.5 s" — that compared runs taken under different load and was
wrong. The numbers are recorded in a code comment so nobody re-derives it.

**Lesson worth keeping:** on this database, a before/after pair taken minutes
apart is not a measurement. Only interleaved runs are.

---

## 4. Options

Confidence is stated honestly: *measured* means I ran it; *estimated* means it
comes from the query plan and has not been proven.

### Option A — Split the query so the joins only touch the selected statuses

Compute the three whole-group numbers with one cheap count, and run the eight
expensive joins over only the contacts matching your chips (~87,000 instead of
646,339).

- **Gain:** 20–35 s → **5–10 s** _(estimated, ~7× less join work)_
- **Risk:** Medium-high. This is the query that produced the 77-vs-1,907 bug two
  days ago. Two existing bars must stay green: the preview↔activation
  cross-path bar and the "audience + every bucket = the whole group" identity.
- **Effort:** ~half a day, including an interleaved before/after measurement.
- **Side benefit:** cuts the ~24 GB per preview by roughly the same factor,
  which also relieves other screens.

### Option B — Make the preview on-demand (a "Calculate audience" button)

Stop firing automatically on every form change.

- **Gain:** No speedup — you still wait when you press it. But the database
  stops doing 24 GB of work each time you adjust a field.
- **Risk:** Very low. UI only.
- **Effort:** Small.
- **Cost to you:** Less immediate feedback while composing a campaign.

### Option C — Covering index on `contact_offer_campaigns`

Add `(org_id, offer_id, contact_id) INCLUDE (campaign_id, last_sent_at)` so both
offer rules can be answered from the index without touching the table.

- **Gain:** **3–8 s** _(estimated; the same trick applied by hand to one of the
  two rules today measured 3,602 ms → 1,909 ms)_
- **Risk:** Low-medium. Additive migration, built with `CONCURRENTLY`. Slightly
  slows the engagement job's writes.
- **Effort:** Small, but it is a **migration** — needs your approval and the
  outside-send-window rule.
- **Also helps:** the send path and campaign activation, not just the preview.

### Option D — Cache the candidate list per group selection

The 16.8 s step is "who is in these groups and messageable". Group membership
changes rarely. Cache it with a short TTL.

- **Gain:** removes the single biggest step on repeat previews _(estimated)_
- **Risk:** Medium — **staleness**. A contact uploaded minutes ago would not
  appear until the cache refreshed. Given you upload lists regularly, I do not
  love this one.
- **Effort:** Medium.

### Option E — Accept it

The error is fixed. 20–35 s is a wait, not a failure.

- **Gain:** none
- **Risk:** the preview keeps doing ~24 GB per run, which is a meaningful share
  of total database load and shows up as slowness on other screens.

---

## 5. Recommendation

**Do B now, then A. Hold C until A is measured.**

1. **B first** — it is small, safe, and stops the repeated cost immediately.
   It is also the honest fix for "the database was full of previews": a
   calculation this expensive should be something you ask for, not something
   that fires while you type.
2. **A next** — it is the only option that actually makes the number small, and
   it is the one that scales as the groups keep growing. Gate it on the two
   existing bars plus an interleaved before/after.
3. **C afterwards, if A leaves it above ~10 s.** It is a migration, so it
   should be justified by a measurement rather than bought speculatively.
4. **Skip D** unless A and C both disappoint — staleness is a bad trade for a
   number the operator uses to size a real send.

Expected end state: **5–10 s, on demand** instead of 18–35 s, repeatedly,
automatically.

---

## 6. Open items found along the way (not in scope above)

- ⚠️ **`check:guards` is RED on `main`** — verified pre-existing, not from my
  branches. Both failures name `scripts/verify-offer-brands.ts` (from #247,
  09-29): it hardcodes **both** database identifiers — including production —
  and is write-capable without importing the preview-DB guard. That is exactly
  what that guard exists to catch. I left another session's work alone; say the
  word and I'll fix it.
- ⚠️ **The "4a byte-identical" gate is stale** (`test-eligibility-layers-identical`).
  It reports `0 of 5548 before-shapes still present` and then passes vacuously
  on `0 differences`. It has been quoted in past PRs as evidence the send path
  was untouched; that evidence is no longer being earned. Needs its corpus
  regenerated and a non-vacuity bar.
- `test-segment-intersect-and-optout` cannot run against the preview database —
  it requires two production-only named segments. Cosmetic, but it means that
  suite is never run in CI-like conditions.

---

## 7. What I measured this with

- `EXPLAIN (ANALYZE, BUFFERS)` per statement, server-side — the reliable
  numbers. Wall-clock from a laptop includes internet round trip and is noise.
- `pg_stat_activity` before *and* after every run, to detect contention. Two
  readings I initially took were pure contention — an index-only scan measured
  at 1.9 s reported 43.8 s minutes later, partly because **my own repeated
  measurement runs** were adding load to the database you were using.
- All production reads only; nothing written.
