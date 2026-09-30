# Task 2 — Audience preview speed-up: implementation plan

_2026-09-30 · **APPROVED WITH CHANGES** (owner, 2026-09-30) · build starts only
once Task 0 items 2–3 (campaigns-suite hang, 4a gate) are green_

> **Owner rulings.** D1 yes · D2 keep 30 s during the build, final value from
> T7 · D3 decide after T7, Option C allowed as contingency · D4 keep computing,
> do not render · D5 own card. Five changes are folded in below and marked
> **[change N]**: cancellation safety (§2c, T6), timeout + client retry (§2c),
> segment-share gate (T1), env kill switch (§2d), and the T7 memory/replica
> report (§7).
>
> ⚠️ **All production parity and timing runs — T1 included — happen in the
> quiet window (05:00–06:00 UTC) only.** Code and preview-database runs may
> happen any time.

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

The five decisions are **resolved** — §9.

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
  cancel our own backend on abort as well.

**[change 1] Cancellation safety — no latest-wins ships without it.**
`pg_cancel_backend(pid)` targets a *backend*, and through a shared pooler a
backend is reassigned between transactions. Reading `application_name` and then
cancelling is two steps: between them the preview can finish, the pooler can
hand that backend to a **send-path** transaction, and the cancel lands on it.

*Preferred — structural:* previews connect as a **dedicated database role**
(e.g. `camman_preview`, its own `PREVIEW_DATABASE_URL`, its own Supavisor pool).
A non-superuser role can only signal backends of its **own** role, and a pool's
backends are only ever handed to clients of that role — so a preview cancel is
unable to reach a send-path backend by construction, race or no race. What the
spike must establish:
- the role can be created and given read access plus `TEMPORARY` (the design
  uses temp tables), **and** reads the org's rows — the app role bypasses RLS
  today; a new role would see nothing under the existing policies unless it is
  granted `BYPASSRLS` (Postgres 17 allows a `CREATEROLE` holder to grant
  attributes it holds) or explicit grants;
- Supavisor accepts `camman_preview.<ref>` and pools it separately;
- **proof, not assumption:** from a `camman_preview` session,
  `pg_cancel_backend()` on a `postgres`-role backend is **refused**.
Creating a role is a database change: its SQL is shown for approval before it
touches production, and it runs outside the send window.

*If not feasible:* the plan documents the residual race — its window, measured —
and exactly what each send-path statement does on receiving 57014 (drain claim,
materialization, kickoff, the cron jobs), before any latest-wins code merges.
Timeout + browser abort remain the fallback either way.

**[change 2] Timeout: stays 30 s during the build.**
- Confirmed from code: it is `SET LOCAL statement_timeout` **inside the preview's
  own transaction** (`previewAudience`, #248). It resets at COMMIT/ROLLBACK and
  cannot leak to a pooled backend's next client. T6 adds a bar that asserts it
  (a fresh transaction on the same connection reads the server default).
- **One automatic client retry on timeout** before any error is shown — a timed-out
  first run has usually warmed the cache. The retry is visible (*"still
  calculating…"*), counted, and never loops.
- The **final value is proposed from T7's cold measurements**, not chosen now.

Three things must be **spiked before T6**, each with a pass/fail check:
(a) the dedicated role, as above; (b) `SET LOCAL application_name` is visible in
`pg_stat_activity` through Supavisor transaction mode; (c) `request.signal`
aborts on client disconnect on Vercel. If (a) fails, the residual-race analysis
above is mandatory; if (b) fails, latest-wins is dropped and timeout + browser
abort + retry is what ships.

### 2d. **[change 4]** Kill switch

An environment variable, `AUDIENCE_PREVIEW_IMPL=reference`, routes the preview
to the **reference implementation** (today's code, frozen). Unset — the new
path. It exists so a production problem is one Vercel env change and a redeploy
away, with no revert.

Consequence: the reference copy lives under `lib/audience-preview-reference/`,
not `scripts/`, because the route must be able to import it. **The switch and the
reference copy are removed together**, in one PR, once Task 2 is accepted.

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
browser abort + one retry" — still bounded by the statement timeout (30 s during the build, final value from T7).

**R4 — "Cold" is approximate on managed Postgres.** Supabase does not let us
flush `shared_buffers` or the OS cache. "Cold" = first run of a recipe after an
idle period in the quiet window, and every timing reports `shared read` blocks
from `EXPLAIN (BUFFERS)` as the evidence.

---

## 6. Scope

**In:** campaign-level preview (create + edit form), lifecycle path; the
light/heavy split; the skips; 500 ms debounce; DB-side latest-wins (only if the cancellation-safety proof passes); the statement
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
| **[change 5] memory fit** | size of every table **and index** the preview touches (`pg_relation_size` per relation and per index) against the instance's memory (`shared_buffers`, `effective_cache_size`, instance RAM). Says whether the working set can stay resident — which is what "cold" really measures |
| **[change 5] read-replica viability** (for Task 3) | whether the temp-table design runs on a read-only replica. Expected answer, to be confirmed: **it does not** — a Postgres hot standby rejects `CREATE TEMP TABLE` and `ANALYZE`. The report names the replica-compatible variant (e.g. `MATERIALIZED` CTEs, which lose `ANALYZE` stats) and measures what it costs |

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

The reference copy (`lib/audience-preview-reference/`, today's module frozen
with its helpers — see §2d) is deleted together with the kill switch once Task 2
is accepted.

---

## 8. Tasks, in order

Each ends with its own check; one PR per task; done = production on the merged
commit.

- **T1 — Parity harness first.** Frozen reference, verifier, an optional
  executor on `previewAudience` so both implementations share one transaction.
  *Check:* reference vs **unchanged** new code = zero differences on ≥ 10
  recipes. A harness that has never been red against itself proves nothing, so
  it is also red-proved with a deliberate one-row change.
  **[change 3] Segment gate.** T1 also times **≥ 5 real segment recipes on
  today's code**, and for each the share spent evaluating segment membership
  (the membership source alone vs the whole preview, interleaved). **If segment
  evaluation is more than half the wall time on the median segment recipe, stop
  and report before T2** — narrowing by chips would not be the right fix for
  most real recipes. Quiet window only.
- **T1b — Kill switch** ([change 4]): `AUDIENCE_PREVIEW_IMPL=reference`, with a
  bar that the route actually serves the reference when set.
- **T2 — `base` part** + `combinePreviewParts` + bar 1.
- **T3 — Narrowed `audience` part** (lifecycle path) + the skips + bar 2.
- **T4 — Offer layers** (skips + one grouped scan).
- **T5 — Client:** two effects (base keyed on segments/groups/exclude-segments;
  audience keyed on everything), 500 ms debounce, merge via
  `combinePreviewParts`, render latest only.
- **T6 — Spikes (a)–(c) first, including the cancellation-safety proof
  ([change 1]); then client retry on timeout ([change 2]) and — only if the
  proof passes — DB latest-wins** + bars 3–4 + the `SET LOCAL` bar. The timeout
  stays 30 s.
- **T7 — Verification run** in the quiet window, including the memory-fit and
  read-replica sections ([change 5]) and the proposed final timeout;
  docs (`04-features/audience-snapshot.md`, `07-conventions.md`, CHANGELOG);
  final report against §7. **D3 is decided from this report.**

---

## 9. Decisions — resolved 2026-09-30

| | ruling |
| --- | --- |
| D1 | **Yes** — bounded sets for in-use, offer rules and freeze in Task 2 |
| D2 | **Keep 30 s during the build**; one automatic client retry; final value proposed from T7 |
| D3 | **Decide after T7**; Option C allowed as contingency |
| D4 | **Keep computing, do not render** |
| D5 | **Own card** |

The original questions follow, unchanged, for the record.

## 9a. Decisions as originally asked

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
