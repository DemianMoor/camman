# Task 2 — Audience preview speed-up: implementation plan

_2026-09-30 · for approval · no build until approved **and** Task 0 items 2–3
(campaigns-suite hang, 4a gate) are green_

Recon ran against `origin/main` @ `a986ca7a`. Builds on the recon brief
[2026-09-30-audience-preview-perf-recon.md](../specs/2026-09-30-audience-preview-perf-recon.md).

---

## 0. What you are approving, in one screen

The preview drags every contact in the selected groups through eight joins and
only then applies your status chips. The plan applies the chips **first**,
splits the preview into a **light group-level part** (reruns only when groups or
segments change) and a **narrowed audience part**, skips layers that provably
cannot match, and cancels superseded previews **on the database**, not just in
the browser.

Measured prototype on the heaviest real recipe (Hot/Warm × the four biggest
groups × offer 62):

| | today | prototype |
| --- | ---: | ---: |
| heavy query, idle database | 18–35 s (36.8 s server, one run) | **2.9 s** |
| heavy query, cold + 4 other queries active | — | **23.1 s** |
| Freeze-cohort recipe (campaign 1501 shape) | 9–12 s | **4.5–4.7 s** |
| light group-level query | (inside the above) | **0.7–1.2 s** |
| buffer traffic | 2.93 M hits + 99.7 K reads (~24 GB) | ~0.65 M hits (~4.5× less) |

**Warm, the < 5 s target is met. Cold under contention, it is not.** §5
explains why and what would close it; that is decision **D3**.

Five decisions are needed — listed in §9.

---

## 1. What the recon found

**F1 — The lifecycle breakdown is computed on every preview and rendered
nowhere.** `previewAudience` has one caller (the create/edit form route), and
the form reads 11 fields — none of them `lifecycle.by_status` or
`lifecycle.excluded.*`. The only `by_status` consumer in the app is the Group ×
Lifecycle report, which is a different dataset. → **D4**.

**F2 — Only four output fields are genuinely group-level.** Everything else is
filtered by `is_eligible`, which includes the chip predicate — including
`from_segments`, `from_groups` and `overlap`, whose names suggest otherwise.

| part | fields |
| --- | --- |
| **group-level** (independent of chips) | `excluded_for_optout` *(rendered)*; `lifecycle.excluded.opted_out`, `.suppressed`, `.status_not_selected` *(not rendered)* |
| **chip-dependent** | `count`, `total_matching`, `from_segments`, `from_groups`, `overlap`, `excluded_by_segments`, `in_use_in_other_campaigns`, `got_offer_in_prior_campaign`, `carrier_removed`, `lifecycle.by_status`, the other five `lifecycle.excluded` buckets |

`status_not_selected` depends on the chips, but only as *"the group's histogram
minus the selected statuses"* — so the light part returns a per-status
histogram and it is derived without a rerun.

**F3 — Narrowing is cheap.** Group ∩ chips built as its own statement:
**72,755 candidates in 440–1,026 ms** (Hot/Warm × 4 biggest groups);
**76,663** for the Freeze recipe.

**F4 — "Drive every join from the candidates" is right for some layers and
measurably wrong for others.** Each layer probed per candidate, 72,755
candidates:

| layer | per-candidate probe | hits | verdict |
| --- | ---: | ---: | --- |
| opt-out | 457 ms | 17,044 | ✅ probe |
| in-use elsewhere | **7,576 ms** | 38,647 | ❌ walks each contact's whole pool history in a 2.8 M-row table |
| freeze-not-due | **25,251 ms** | **0** | ❌ random reads into a 542 MB table — and see F5 |
| offer limit | **13,966 ms** | 0 | ❌ random heap reads |
| offer cooldown | 3,110 ms | 15 | ❌ slower than the set |

Built instead as **bounded sets** (active pools only; the offer's own rows ∩
candidates), the same layers fit inside the 2.9 s above. This is where the rule
*"cost must scale with matching contacts, never with pool size or send history"*
has to bend in Task 2 — §4, decision **D1**.

**F5 — Two layers are provably empty for most recipes.**
`freeze_not_due` requires `status = 'freeze'`, and `contacts.lifecycle_status` is
the projection of that same status — so a Hot/Warm/Cold/New candidate **cannot**
match. Skip it unless the Freeze chip is selected (7 of 165 recent recipes).
`suppressed` is never a chip, so it is always empty over chip-matched
candidates; its count comes from the light histogram.
`has_clicker` / `has_opt_in` feed only the **legacy** predicate — not needed on
the lifecycle path.

**F6 — `offer_exposures` cannot serve the offer rules.** It is unique per
`(org, contact, offer)` and holds only `first_sent_at`: no campaign count for the
limit, no last-send time for the cooldown. The rules stay on
`contact_offer_campaigns`. Skip-when-cannot-apply still helps: rules off, the
prior-offer toggle off, or an offer with no history (**3 of 26** active offers).
But the toggle is **on for 124 of 165** recent campaigns, so this layer matters
for three-quarters of real previews.

**F7 — Every table the preview touches already has a `contact_id`-leading
index.** `opt_outs (org_id, contact_id)`, `campaign_audience_pool (contact_id)`,
`contact_engagement UNIQUE (contact_id)`, `contact_offer_campaigns` PK
`(contact_id, offer_id, campaign_id)`, `contact_contact_groups UNIQUE
(contact_id, contact_group_id)` and `(contact_group_id, contact_id)`,
`contacts (org_id, lifecycle_status, created_at)`. **The base plan needs no
migration.**

**F8 — 65 % of real recipes use segments** (108 of 165 in the last 14 days; 0
use exclude-segments; 2 use a carrier filter). My prototype covered group-only
recipes. Segment-rule evaluation is its own cost (§10e) and is **not** addressed
by narrowing — see §5.

**F9 — Latent, affects nobody today.** The route decides `lifecycleRules` from
the engine's posture, not the campaign row, so **edit-mode** preview of a legacy
draft would use lifecycle semantics. There are **0 drafts** right now. → **D5**.

Environment: Postgres 17.6 · Next.js 16.2.6 · postgres-js 3.4.9.

---

## 2. Design

### 2a. Two parts, one route

`POST /api/campaigns/audience-preview` gains a `part` field: `"base"` or
`"audience"`. **Same route, so no new route-map entry** — the operator
route-map trap from earlier this month does not apply. `check:authz` confirms.

| part | contains | reruns when | measured |
| --- | --- | --- | ---: |
| `base` | group-level fields + a per-status histogram of the membership set | segments, groups or exclude-segments change | 0.7–1.2 s |
| `audience` | every chip-dependent field | anything changes | 2.9 s idle |

A pure, exported `combinePreviewParts(base, audience, chips)` produces the
**exact response shape the form reads today**. The client and the parity
verifier both call it, so the form cannot drift from what was verified.

### 2b. The narrowed audience query (lifecycle path)

1. `pv_cand` temp table = membership ∩ `messaging_status = 'eligible'` ∩
   `lifecycle_status = ANY(chips)`, then `ANALYZE` — real row counts for the
   planner, the lesson from §10b.
2. Each layer attached to `pv_cand` by the cheapest measured shape:

| layer | shape | why |
| --- | --- | --- |
| opt-out | semi-join from candidates | 457 ms |
| in-use elsewhere | set: active campaigns → their pools | bounded by *active* pools, not history (7.6 s the other way) |
| freeze-not-due | **skipped** unless Freeze chip; else set restricted to candidates | F5 |
| suppressed | **skipped** (from `base`) | F5 |
| bought offer | set restricted to candidates | 51 ms today |
| offer limit + cooldown | **one grouped scan** of the offer's rows ∩ candidates → `count(*)` and `max(last_sent_at)` together | two reads collapse into one |
| clicker / opt-in | **not computed** on the lifecycle path | F5 |

3. One aggregate over the ~70 K candidates (hash joins, no `WHERE … IS NULL`
   chains — so none of the estimate cascade that timed activation out in #250).

**Segments.** Membership still comes from the existing segment clauses. Where a
segment is combined with groups, the chip-narrowed set is passed as
`restrictUniverse` (the mechanism already used for groups), shrinking
`is_not`-rule evaluation. Beyond that, segment-rule cost is unchanged — §5.

**Legacy path** (`lifecycle_rules = false`, engine off) keeps today's
single-statement query byte-for-byte. The engine is `write` in production.

### 2c. Trigger, cancellation, timeout

- **Debounce 500 ms** after the last change (today 400 ms). No manual trigger.
- **Browser:** superseded requests already aborted (#248); only the latest
  response renders.
- **Database — "latest wins" per user.** Each preview transaction runs
  `SET LOCAL application_name = 'preview:<user_id>:<seq>'`. A new preview first
  runs `pg_cancel_backend()` on that user's older `preview:` backends via
  `pg_stat_activity`. State lives in Postgres, so it works across serverless
  instances and even when the browser never reports a disconnect (closed tab,
  dropped network).
- **Database — disconnect.** If `request.signal` reliably fires on Vercel,
  cancel our own backend on abort as well. Guarded by an in-flight flag cleared
  *before* COMMIT, so a pid can never be reused by another client's query while
  we still hold it (the pooler cannot reassign the backend before our COMMIT).
- **Statement timeout: propose 10 s** (today 30 s). Rationale: 2× the target.
  With at most one preview per user in flight, 10 s is the most any operator can
  cost the database in a send window. At the boundary the operator sees *"Audience
  preview timed out — narrow the selection and try again"* (already mapped, #248);
  a retry usually lands warm. **The cap protects the database; §5 is what
  protects the operator.**

Three things must be **spiked before T6**, each with a pass/fail check:
(a) `pg_cancel_backend` is permitted for the app's role through the pooler;
(b) `SET LOCAL application_name` is visible in `pg_stat_activity` through
Supavisor transaction mode; (c) `request.signal` aborts on client disconnect on
Vercel. If (a) or (b) fails, fall back to timeout + browser abort and say so.

---

## 3. What does not change

- **Activation / `snapshotAudience`** — untouched. `test-preview-matches-snapshot`
  keeps preview and freeze honest (PARTs F and G).
- **Stage-level previews** (`computeStageAudienceCountForDraft`, the Prepare
  dialog) — out of scope.
- **The send path** — untouched; the 4a gate (made real in Task 0) proves it.
- **The response the form reads** — identical fields and values; §7 verifies
  every one.

---

## 4. Where the rule bends in Task 2 — stated plainly

*"Preview cost must scale with the contacts matching the selected filters, never
with pool size or send history."*

| part | scales with | why not proportional |
| --- | --- | --- |
| candidates | group ∩ chips (index scans) | ✅ |
| opt-out, bought offer | candidates | ✅ |
| **in-use** | **active pool size** | per-candidate probing scales with *history* and was 7.6 s |
| **offer limit/cooldown** | **the offer's history** ∩ candidates | per-candidate probing was 14 s |
| **freeze-not-due** (Freeze chip only) | freeze contacts ∩ candidates | its predicate is not sargable — needs another column |
| **light part** | group size | accepted by you as written |
| **segments** | the segment's rules | §10e territory |

Truly proportional cost for the in-use, offer and freeze layers needs values
**maintained at write time** — per-contact "in an active pool", per
contact×offer "campaign count / last sent", per contact "freeze next-due-at".
That is Task 3. Task 2 takes the fastest bounded option and names it here rather
than claiming the rule is met.

---

## 5. Risks and open questions

**R1 — Cold cache (the one that decides the target).** The same recipe ran
2.9 s idle and **23.1 s** with four other queries active and 28,774 blocks read
from disk. The likely source is random heap reads for `last_sent_at` in the
offer layer and `last_sent_at`/`freeze_cadence_days` in the freeze layer. Two
covering indexes would make both index-only:
- `contact_offer_campaigns (org_id, offer_id, contact_id) INCLUDE (last_sent_at)`
  — this is **Option C**, currently on hold;
- `contact_engagement (org_id, status) INCLUDE (last_sent_at, freeze_cadence_days)`.
Both are migrations. I would not add them speculatively — T7 measures per-node
cold reads first. → **D3**.

**R2 — Segment recipes are unmeasured.** 65 % of real recipes use segments. The
verification set is weighted toward them (§7). If they miss the target, the cause
will be segment evaluation, and I will report that rather than widen Task 2.

**R3 — Cancellation spikes may fail.** Then latest-wins degrades to "timeout +
browser abort" — still bounded by the 10 s cap.

**R4 — "Cold" is approximate on managed Postgres.** Supabase does not let us
flush `shared_buffers` or the OS cache. "Cold" = first run of a recipe after an
idle period in the quiet window, and every timing reports `shared read` blocks
from `EXPLAIN (BUFFERS)` as the evidence.

---

## 6. Scope

**In:** campaign-level preview (create + edit form), lifecycle path; the
light/heavy split; the skips; 500 ms debounce; DB-side latest-wins; the 10 s
timeout; parity verification and timings.

**Out:** stage-level previews; activation/snapshot; the legacy path's
performance; segment-rule evaluation cost; any migration (unless **D3**);
write-time facts (Task 3); a manual trigger (rejected).

---

## 7. Verification — your criteria, mapped

| criterion | how |
| --- | --- |
| **every preview number identical, ≥ 10 real configurations, scope printed** | `scripts/verify-preview-parity.ts` picks recent real recipes to cover: Hot/Warm, Cold, Freeze, New, multi-chip; small and large groups; **≥ 5 with segments**; prior-offer on/off; offer with and without history; cap; carrier filter; exclude-in-use on/off. Prints each recipe, then runs the **reference** (today's code, frozen) and the **new** code **inside one `REPEATABLE READ` transaction** so both read the same snapshot, and diffs **every field** of the response. Any difference fails the run. |
| **send path unchanged** | the 4a gate, made non-vacuous in Task 0 |
| **interleaved before/after, cold and warm, 646 K group** | reference/new interleaved, quiet window 05:00–06:00 UTC; per run: wall time, server `Execution Time`, `shared hit` / `shared read` |
| **target < 5 s** | reported per recipe, warm and cold, pass/fail |

Existing bars that must stay green: `test-preview-matches-snapshot`,
`test-lifecycle-preview-breakdown` (the partition identity *audience + every
bucket = the whole base* now holds **across the two parts** — the strongest
check on `combinePreviewParts`), `test-offer-limit-cooldown`,
`test-lifecycle-chips`, `test-patch-never-writes-unsent`.

New bars:
1. `combinePreviewParts(base, audience) === ` the reference single-query response
   on the preview fixtures.
2. **Freeze skip, structural and behavioural:** without the Freeze chip the
   emitted SQL never references `contact_engagement`; with it, a resting contact
   is still excluded. (Structural because a results-only bar cannot see a skipped
   join — lesson from #250.)
3. **Latest wins:** two overlapping previews for one user → the first is
   cancelled on the database (57014), the second returns.
4. **Timeout:** a forced slow preview returns the 400 message, not a 500.

⚠️ **Guard constraint.** The parity verifier reads production, so all SQL stays
in `lib/`; the script only calls functions. A script carrying write-shaped SQL
text would need a preview-DB-guard exclusion, which is off the table.

The reference copy (`scripts/_preview-reference/`, today's module frozen with
its helpers) is deleted once Task 2 is accepted.

---

## 8. Tasks, in order

Each ends with its own check; one PR per task; done = production on the merged
commit.

- **T1 — Parity harness first.** Frozen reference, verifier, an optional
  executor on `previewAudience` so both implementations share one transaction.
  *Check:* reference vs **unchanged** new code = zero differences on ≥ 10
  recipes. A harness that has never been red against itself proves nothing, so
  it is also red-proved with a deliberate one-row change.
- **T2 — `base` part** + `combinePreviewParts` + bar 1.
- **T3 — Narrowed `audience` part** (lifecycle path) + the skips + bar 2.
- **T4 — Offer layers** (skips + one grouped scan).
- **T5 — Client:** two effects (base keyed on segments/groups/exclude-segments;
  audience keyed on everything), 500 ms debounce, merge via
  `combinePreviewParts`, render latest only.
- **T6 — Spikes (a)–(c), then DB latest-wins + 10 s timeout** + bars 3–4.
- **T7 — Verification run** in the quiet window; docs (`04-features/audience-snapshot.md`,
  `07-conventions.md`, CHANGELOG); final report against §7.

---

## 9. Decisions needed

**D1 — Rule interpretation for Task 2.** Accept bounded sets for in-use, offer
rules and freeze (§4), with truly proportional cost deferred to Task 3?
*Recommend yes* — per-candidate probing measured 3–14× slower for those layers.

**D2 — Statement timeout 10 s** (from 30 s)? *Recommend yes*, with the cold
caveat in R1.

**D3 — Cold target.** If cold p95 stays above 5 s after T7, do you want the two
covering-index migrations (§5 R1) proposed with their SQL, or accept a
warm-only target until Task 3? *Recommend: decide after T7's per-node
measurement* — asking now only whether Option C is back on the table as a
contingency.

**D4 — The unrendered lifecycle breakdown (F1).** Keep computing it
(*recommended* — keeps the response identical so parity is total, and it is cheap
after narrowing), or drop it? Separately: do you want it **shown** on the form?

**D5 — Edit-mode legacy-draft preview (F9).** Fix inside Task 2, or its own
card? *Recommend its own card* — 0 drafts are affected and it is a correctness
change, not a speed one.
