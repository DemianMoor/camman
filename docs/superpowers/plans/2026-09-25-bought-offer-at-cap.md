# Plan — exclude buyers at activation when an audience cap is set

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a lifecycle campaign has an `audience_cap`, stop the cap's random sample from spending slots on people who already bought the offer.

**Architecture:** One extra DELETE against `audience_qualified`, between the existing prior-offer DELETE and the `ORDER BY RANDOM() LIMIT cap` sample. Nothing else moves.

---

## Status (owner, 2026-09-25)

**Approved in principle. Build on preview AFTER #229 (PR 4d) merges** — this sits directly on 4d's DELETE ordering inside `snapshotAudience`, so building it first would mean writing against a shape that is still under review. PR stopped before merge, as usual.

**Report the slots-reclaimed number on the first THREE real capped campaigns.**

⚠️ **That number cannot be produced yet, and the plan should not pretend otherwise.** Measured 2026-09-25: **0 lifecycle campaigns have a cap** (campaign 1460 has none). So the three have to be created first — the measurement is gated on real operator use, not on code being ready.

⭐ **It will not be a long wait, and that is also the argument for building it.** **566 of 673 campaigns (84%) carry a cap**, 297 of them created in the last 30 days. Capping is the norm here, not an edge case, so this change will apply to most lifecycle campaigns rather than a rare few.

## Global Constraints

- ⛔ **No merge and no production migration until campaign 1460's post-run comparison is accepted.** This changes what activation freezes.
- ⛔ **Do not start until #229 merges.**
- **No migration needed** — `audience_cap`, `lifecycle_rules` and the `bought_offer` definition all exist.
- The 4a byte-identical gate must stay green: an **uncapped** campaign's SQL must not move at all.
- Docs are part of done.

---

## Why this is a change at all, and why only for capped campaigns

PR 4b decided deliberately that `bought_offer` is a **send-time overlay**: buyers stay in the pool and the drain skips them. The reasoning was that purchases keep arriving after activation, so freezing the decision would freeze a stale one.

⭐ **A cap changes the economics, not the reasoning.** Without a cap, a buyer in the pool costs nothing — the send skips them and everyone else still gets their message. With a cap, the pool is *sampled*, so every buyer that survives the sample **occupies a slot that a sendable contact would have had**. The message is not merely skipped; it is never sent to anyone. That is the whole argument, and it applies only where a cap exists.

⚠️ **Accept the asymmetry explicitly.** After this, two campaigns with identical recipes can freeze different pools depending only on whether a cap is set. That is intended, but it is surprising, so it belongs in the docs and in the UI's cap helper text — not just in the code.

⚠️ **The staleness objection does not bite here, and the plan should say why.** Being a buyer is monotonic: nobody un-buys. So excluding buyers at activation can only ever be *correct-and-early*, never wrong-later. The reverse case — someone who buys **after** activation — is untouched by this change and is still caught by the send-time layer. That asymmetry is what makes this safe where baking in `freeze_not_due` would not be.

---

### Task 1: The DELETE

**Files:** `lib/audience-snapshot.ts` (`snapshotAudience`, between the prior-offer DELETE ~`:1870` and `limitClause` ~`:1913`)

- [ ] **Step 1: Write the failing test first** — extend `scripts/test-lifecycle-preview-breakdown.ts` or a new `scripts/test-bought-offer-cap.ts`, PART N:

```ts
// N1  ⭐ CAPPED + lifecycle: buyers are absent from the frozen pool
// N2  ⭐ UNCAPPED + lifecycle: buyers are STILL IN the pool (unchanged —
//     this is the bar that stops the change leaking past its scope)
// N3  LEGACY campaign with a cap: buyers still in the pool (lifecycle only)
// N4  ⭐ the cap is honoured AFTER the removal: with 10 qualified, 3 of them
//     buyers, and cap 5 ⇒ pool is exactly 5, none of them buyers. Without the
//     ordering this yields 5 drawn from 10, i.e. ~1.5 wasted slots.
// N5  no offer on the campaign ⇒ no-op (the layer cannot be built)
// N6  cap LARGER than the qualified set ⇒ every non-buyer, no error
```

- [ ] **Step 2: Run it, confirm N1 and N4 fail.**
- [ ] **Step 3: Implement.** Gate on `cap !== null && input.lifecycleRules === true && input.offerId != null`. Reuse `purchasedOfferContacts()` — the one definition, shared with the segment rule and the send-time layer. ⚠️ **Separate statement after `ANALYZE`**, like its neighbour, for the planner reason in CLAUDE.md §10b.
- [ ] **Step 4: Re-run — expect 6/6.**
- [ ] **Step 5: Commit.**

### Task 2: Say so in the preview and the UI

- [ ] **Step 1:** For a capped lifecycle campaign, `bought_offer` moves from `send_time` to `excluded` in `AudiencePreviewResult.lifecycle` — because for that campaign it now genuinely keeps a lead out of the pool. For an uncapped one it stays in `send_time`. The shape is the same; which group it lands in follows the behaviour.
- [ ] **Step 2:** One line under the Audience cap field when a cap is set on a lifecycle campaign: _"Buyers of this offer are excluded before the cap samples."_
- [ ] **Step 3: Commit.**

### Task 3: Measure, docs, PR

- [ ] **Step 1: Measure on preview** — activation wall time with and without the extra DELETE.
- [ ] **Step 1b: The slots-reclaimed number, on the FIRST THREE real capped lifecycle campaigns** (owner, 2026-09-25). Read-only, per campaign: how many pooled contacts had already bought the offer at snapshot time, i.e. how many cap slots the change would have reclaimed. That number is the entire justification; if it is ~0 across all three, say so plainly and let the owner decide whether to ship it at all. ⚠️ Blocked until three such campaigns exist — none did on 2026-09-25.
- [ ] **Step 2:** `contact-lifecycle.md` (the asymmetry and the monotonicity argument), `07-conventions.md`, `CHANGELOG.md`, last-updated dates.
- [ ] **Step 3:** Full check, 4a gate re-captured, rebase, **open the PR and STOP**.

## Merge gate

Ask before merge, after 1460. Bring: the slots-reclaimed number, the activation timing delta, and the 4a gate result.
