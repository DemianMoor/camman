# Task 3 — "Texted in the last…" segment rule: build plan

> Status: **APPROVED 2026-10-02** (owner), nothing built yet. Rulings: D1 edit in place, **segment 223 first**; D2 yes as proposed; D3 try camman-v2 first, if a branch is needed report the monthly cost and wait. **Build gate:** §5 must carry the window's measured numbers and segment evaluation must be confirmed **under 1 s**; otherwise stop and report. **Required before the first segment switch:** manual sends visible to the rule (§4b, task T2b).
>
> Numbering: 0195 went to the campaign offer-cooldown default (card 869fb5j0e), so this rule's CHECK migration is **0196** and the manual-recipients table is **0197**.
> Spec: [2026-10-02-task3-audience-facts-recon.md](../specs/2026-10-02-task3-audience-facts-recon.md) §11 (E0) and §12.
> **Waits on:** migration 0196 SQL approval; the 2026-10-03 window numbers for §5 (build gate).

## 0. The decision and the order

- **E0 = (b).** "Not texted within N days" is built as a **new** rule type
  reading `contact_engagement.last_sent_at`.
  - The existing rule (`in_use_in_campaign_last_period`) and every existing
    segment keep their meaning.
  - Nothing switches automatically.
- **Task 3 order:**
  1. the E4 offer covering index (SQL proposed after run 2);
  2. **this rule**;
  3. the freeze fact.
- **Shelved:** the liveness-journal/trigger design for meaning (a)
  (spec §4, §12.4). It stays in the spec, marked shelved.

## 1. A related rule already exists, and why it is not reused

`last_message_in_last_n_days` ("Last message within the last N days",
[lib/validators/segment-rule-types.ts](../../../lib/validators/segment-rule-types.ts)) already reads
`last_sent_at >= now() − N days`. **No segment uses it today**
(production read, 2026-10-02). It is not reused because:

- It accepts operator `is` only, as do all time-based types (CLAUDE.md §10e). "**Not** texted within N days" needs `is_not`.
  - The opposite type, `last_message_more_than_n_days_ago`, cannot stand in. A never-texted contact has `last_sent_at IS NULL`, which matches neither direction, so it would drop every never-texted contact. Today's "Not Used" segments include them.
- Its value is a free day count. The segments being switched use the period codes `3d` / `1w` / `2w`.
- It has no lag tail (§4). Adding one would change an existing rule's evaluation, which the owner ruled out.

**New type:**

| | |
|---|---|
| key | `texted_in_last_period` |
| label | "Texted in the last…" |
| operators | `is`, `is_not` |
| value shape | `campaign_use_period` (the same codes and the same picker as the in-use rule, so the switch is like for like) |

The value is a scalar string. All four registration places already handle
this shape for the in-use rule:
- `RULE_TYPES`
- `validateValueByShape`
- `isRuleComplete`
- `verifyValueOwnership`

Each one is still edited and covered by a test (CLAUDE.md §10e).

## 2. Evaluation

The new branch in `ruleInnerQuery`, [lib/segment-rules-eval.ts](../../../lib/segment-rules-eval.ts):

```sql
-- the fact: written by the engagement job, read through contact_engagement (org_id, last_sent_at)
SELECT contact_id FROM contact_engagement
 WHERE org_id = $org AND last_sent_at >= now() - <period>
UNION
-- the lag tail (§4): sends the job has not counted yet, via stage_sends_org_sent_at_idx
SELECT contact_id FROM stage_sends
 WHERE org_id = $org AND status = 'sent'
   AND sent_at >= (SELECT watermark FROM cron_locks WHERE job_name = 'contact-engagement')
                  - interval '30 minutes'           -- the job's own INCREMENTAL_OVERLAP_MINUTES
   AND sent_at >= now() - <period>
```

With `is_not`, the builder's existing path gives "eligible contacts EXCEPT this set".
A never-texted contact has no matching row, so it **is** in "not texted". This
matches today's "Not Used" segments.

**Migration 0196 (needs approval).** It extends the `segment_rules_rule_type_check`
CHECK constraint with `'texted_in_last_period'`. The pattern copies 0189:
- `DROP CONSTRAINT IF EXISTS` plus `ADD CONSTRAINT` with the full list;
- hand-authored SQL, snapshot and journal entry.

It is additive, so it is applied before the code ships.
I will show the SQL before applying it.

## 3. Moving the segments: an explicit switch per segment, by the owner

Segments using today's rule (production, 2026-10-02):

| Segment | Rule today | Campaigns that used it, last 30 days |
|---|---|---:|
| 195 "Not Used Last 1 Week" | in-use `is_not 1w` | 113 |
| 223 "Not Used 3 Days" | in-use `is_not 3d` | 63 |
| 196 "Not Used Last 2 Weeks" | in-use `is_not 2w` (+ an inactive `is 3m` rule) | 62 |
| 162, 163, 180, 181, 183, 194 | various | 0 (not touched unless the owner asks) |

**D1: how the owner switches (recommended: option 1).**

1. **Edit in place.** On the segment's Rules tab, add "Texted in the last… is not \<same period\>" and set the old rule inactive. The old rule stays in the segment, so switching back is one toggle.
   - Before the switch, the Rules tab preview shows the new count, and the nightly report (§6) lists old vs new counts per segment.
   - After the switch, every **future** campaign that picks the segment uses the new rule, including drafts activated later.
   - Already-activated pools are frozen and unaffected (CLAUDE.md §10b).
2. **New segments** ("Not Texted 3 Days", …) beside the old ones. Operators then choose per campaign. This is safer per campaign, but there are two near-identical segments to pick between.

No code, migration or script changes any segment's rules. Tests assert that the build leaves `segment_rules` for 195, 223 and 196 unchanged.

**Behaviour change the owner accepts with (b)** (the E0 "only (a)" side, 0.2–1.3K contacts):
- A contact snapshotted into a just-activated campaign but **not yet texted** counts as *not texted*.
- What keeps two campaigns from taking the same contacts is **exclude-in-use** (campaign default on), not this rule.
- Recommendation: keep exclude-in-use on for campaigns built from these segments.

## 4. The 15-minute lag

The engagement job runs at :10, :25, :40 and :55 past each hour. Its watermark is stamped when a run **finishes**. Its incremental recount reads sends from 30 minutes before the previous watermark.

**Does exclude-in-use cover contacts texted since the last run? Partly, not fully.**

- **It covers:** a contact texted by a campaign that is **still `active`** when the preview or activation runs, provided the new campaign has exclude-in-use on (default true; the segment-level flag does the same).
- **It does not cover:**
  1. A campaign **paused or completed** within the lag after its sends. Exclude-in-use counts `status = 'active'` only, and completion is a manual action (`status` and `bulk-status` routes).
  2. A campaign built with exclude-in-use **off**.
  3. Activation (the snapshot) has the same gaps.

**What covers them: the lag tail in the rule itself (§2).**
- Every `'sent'` row since the watermark minus 30 minutes is read straight from `stage_sends`. The rule is then exact at the moment it is evaluated, whatever exclude-in-use is set to.
- If the engagement job stalls, the tail grows. It stays correct, only slower. The existing stale-heartbeat alert (45 minutes) fires.
- The tail matches the job's own window, so a send whose row turned `'sent'` after the job's snapshot is still caught.

**Residual gaps:**
- A row in `'sending'` right now (seconds). Exclude-in-use covers it when on.
- A stage marked as sent **outside the drain** (manual export to an external provider). It writes no `stage_sends` rows, so neither the fact nor the tail sees it.
  - Production had **0** such stages in the last 30 days (read 2026-10-02).
  - The nightly check (§6) alerts if one appears.

**Writer census for (b)** (owner requirement §12.4):
- `stage_sends.status = 'sent'` has exactly **one** writer: [lib/sends/drain.ts:889](../../../lib/sends/drain.ts#L889), `SET status = 'sent', sent_at = now()`. Drip feeds the same drain (`stampDripStageDrainable` only makes a stage drainable). No `INSERT` writes a row as `'sent'`.
- `contact_engagement.last_sent_at` has exactly **one** writer: [lib/engagement/refresh.ts](../../../lib/engagement/refresh.ts) (its header: "the ONLY writer"). Its value is `max(sent_at)` over `status = 'sent'` rows.
- Both are checked by a guard: a `check:guards` needle fails if a second file writes `status = 'sent'` on `stage_sends`. A new writer is then a red build, not a silent gap.

## 4b. Manual sends visible to the rule (owner requirement; task T2b, before the first switch)

**Today:**
- A manual stage (`link_mode = 'manual'`) is exported as a CSV (`GET …/export-phones`), texted in an external provider, then set to `'sent'` through the stage `status` route or `bulk-status`.
- The export **stores nothing**; its own comment calls this "the known manual-CSV blind spot". So at "mark as sent" there is no record of who received the message.
- Recomputing the recipients at mark time is not reliable. Opt-outs, the split, `limit` and the exclusions can all change between export and mark, and an operator can export several times.

**Proposal (recommended): record at export, stamp at mark.**
1. **Migration 0197:** a table `stage_manual_recipients`:
   - columns: `org_id`, `stage_id`, `contact_id`, `exported_at`, `sent_at` (nullable), `created_at`;
   - PK `(stage_id, contact_id)`, FKs explicit;
   - index `(org_id, sent_at) WHERE sent_at IS NOT NULL`.
2. **Export.** `export-phones` inserts each streamed chunk's contact ids (`ON CONFLICT DO NOTHING`; several exports union). This needs the recipient query to return `contact_id` next to `phone_number`; the CSV is unchanged.
3. **Mark as sent** (both `status` and `bulk-status`, manual stages only): in the same transaction as the status change, set `sent_at = now()` on that stage's rows where `sent_at IS NULL`. Moving a stage **out** of `'sent'` clears them, so a mistaken mark is undone.
4. **The new rule and the nightly ground truth** both union `stage_manual_recipients` rows with `sent_at` in the window. A manual send therefore counts as texted.

**Why not write `stage_sends` rows (the example in your request).** `status = 'sent'` on `stage_sends` is the single shared definition of "was messaged" (CLAUDE.md §10e), and several things read it:
- the send circuit breakers' rolling counts: marking a 10K-recipient manual stage would land 10K `'sent'` rows in one instant;
- the reports, Overview and Delivered %;
- the engagement job;
- `sent_from_provider_phone`.

Synthetic rows would change all of these at once, and the drain is the census's single writer of `'sent'`. A separate table changes only what this rule reads. If you want manual sends counted in the reports and the lifecycle engine as well, that is a larger, separate decision.

**Known limits:**
- `sent_at` is the moment of marking, not the external send time, which is unknown. Rows exported before T2b ships have no record and stay invisible; there were 0 manual sends in the last 30 days.

**Test (bar `scripts/test-manual-send-visibility.ts`, preview DB, synthetic campaign):**
1. Manual stage with contacts A, B, C. Export with a limit of 2 → rows for A and B, `sent_at` null; the rule `is_not 3d` still includes A and B (not marked sent).
2. Mark as sent → `sent_at` stamped; `is_not 3d` excludes A and B and keeps C.
3. Bulk-status path → same result.
4. A second export adds C, and the stamp after re-marking covers it.
5. Revert from `'sent'` → stamps cleared, A and B included again.
6. A tracked stage is unaffected; the route still refuses `'sent'` for it.
7. Ground truth (§6) includes the manual rows.
8. Nothing written to `stage_sends`.

## 5. Expected preview time

Run 1 (Small, 2026-10-02):
- The base part took **5–6 s** on segment recipes.
- Segment evaluation (today's in-use rule) was **3–5 s** of that.

**What changes.** The new rule replaces a join of `campaign_audience_pool` × `campaigns` × `campaign_stages` with:
- one index range scan on `contact_engagement (org_id, last_sent_at)`: about 112K (3d), 191K (1w) or 358K (2w) entries, each with a heap fetch for `contact_id`;
- a small tail from `stage_sends_org_sent_at_idx`.

The EXCEPT against the eligible universe stays the same for both rules.

**Estimate, not a measurement:** segment evaluation under 1 s, which would bring the base part to about **1.5–3 s** on today's data.

**Measured in the 2026-10-03 window** (`--s9`, item 2, merged in #279). Today's rule and the new one are timed in the exact segment shape the builder emits (eligible EXCEPT rule), with buffers and the costliest nodes, plus the tail size. The plan is updated with those numbers before build approval.
- If heap fetches dominate, the remedy is a covering index `(org_id, last_sent_at) INCLUDE (contact_id)`. That is a separate migration, proposed only if measured.

**Risk for the speed gate (2 s at 5× data).** At 5× contacts the EXCEPT over the whole eligible universe grows linearly, whichever rule is used. Recipes without a contact group may miss 2 s at 5× even with this rule. The gate (§6) will say so; it is not assumed away.

## 6. Trial, kill switch, alert, speed gate (spec §12, adapted to (b))

**Trial.**
- **What it compares.** Every night, for each real recipe whose segments use either rule, the new rule (fact + tail) is compared with **the same meaning computed straight from `stage_sends`**: contacts with a `'sent'` row in the window. That source does not move, so the comparison is not checking a value against itself.
- **Reporting.** Any difference is drift. The old-vs-new counts per segment are reported alongside (information for D1, not drift).
- **Where it runs.**
  - Comparison core: in lib.
  - Entry points: a cron route (`/api/cron/audience-rule-parity`, 05:10 UTC, quiet window, REPEATABLE READ read-only, `maxDuration` 300) and `verify-preview-parity.ts --texted`.
- **Streak.** The zero-drift streak is kept in `cron_locks`-style state.
- **Manual sends.** The same run alerts on any stage sent outside the drain (§4).

**D2: E2 adapted (needs the owner's ruling).** E2 said "enable for the preview only; activation switches after 14 days of zero drift". For a **segment rule** that split would make the preview count differ from the audience actually snapshotted.
- **Proposal:** the 14 consecutive zero-drift nights run **before** the owner's first switch.
- Once a segment is switched, preview and activation both use the new rule.

**Kill switch.** `AUDIENCE_RULE_TEXTED=direct` makes the new rule read `stage_sends` directly, the trial's ground-truth path. That removes the dependency on the engagement fact without changing the rule's meaning.
- Like `AUDIENCE_PREVIEW_IMPL`: read per request, named in a response header, changed on Vercel with a redeploy (steps as on the Task 2 card).
- Switching a segment back to the old meaning is the per-segment toggle (§3), not the env var. An env var that silently changed what a segment means would break the owner's "nothing automatic" rule.

**Drift alert.** A Telegram post on any difference, naming:
- recipe, segment, period;
- the count delta and three example contact ids;
- the current streak (which resets to 0).

**Speed gate.** A bar that fails if a preview takes more than 2 s at 5× today's data.
- **Where:** the preview project camman-v2, never production.
- **Data:** a generator script scales contacts, `contact_engagement` and `stage_sends` 5× with synthetic phones.
- **D3:** whether camman-v2's compute is enough for 4.8M contacts, or a Supabase branch is needed. The owner decides, because of the cost.

## 7. Tasks (each its own PR; nothing merges without its bars green)

| # | Task | Gate |
|---|---|---|
| T0 | E4 offer covering index | SQL proposed after run 2; owner approval |
| T1 | Migration 0196: CHECK constraint | Owner approves the SQL; applied before T2 ships |
| T2b | Manual sends visible (§4b): migration 0197 + export records + mark/unmark stamps + rule/ground-truth union | Bar `test-manual-send-visibility`; **before the first segment switch** |
| T2 | Rule type: four registration places + eval branch + tail; bar file `scripts/test-segment-rule-texted.ts` (preview DB, synthetic contacts: texted 2 days ago in the engagement table; texted 10 minutes ago in `stage_sends` only with a stale engagement table; never texted; texted 20 days ago. `is` / `is_not` × 3d/1w/2w; never-texted is in "not texted"; tail dedupe; segments 195/223/196 unchanged) | Bars + guards + tsc |
| T3 | Rules panel: the new type appears from `RULE_TYPES`; the period picker is reused; operator select shown (both operators) | Browser check on production |
| T4 | Kill switch `AUDIENCE_RULE_TEXTED=direct` + header; bar: direct = fact on the fixtures | Bars; one timed flip in the quiet window |
| T5 | Nightly trial cron + Telegram + streak + manual-send check; `check:guards` needle for a second `'sent'` writer | Red proof: a seeded drift fixture alerts |
| T6 | Speed-gate dataset + bar | Depends on D3 |
| T7 | Docs: 03-data-model (0196, 0197), 04-features/segments, 05-flows (nightly trial), 07-conventions (lag tail, single writer), CHANGELOG | Part of each PR |

Build starts only when §5 has the window's numbers and segment evaluation is under 1 s. Then 14 zero-drift nights and T2b live, then the owner switches **223 first**, then 195 and 196, one at a time (D1).

## 8. Decisions for the owner

- **D1:** switch in place (recommended) or new segments.
- **D2:** run the 14-night trial before the first switch; switched segments use the rule in preview and activation alike.
- **D3:** where the 5× speed-gate dataset lives.
- **Migration 0196:** approve the SQL when shown.
