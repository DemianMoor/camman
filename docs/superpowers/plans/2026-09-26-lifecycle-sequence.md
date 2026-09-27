# Tomorrow's sequence — 2026-09-26

_Written 2026-09-25. The scheduled jobs that drive this are **session-only**: if the Claude session ends, they are gone and each step needs a prompt instead._

## Gate

⛔ **Nothing merges and nothing reaches production until campaign 1460's post-run comparison is accepted.** #229 (PR 4d) and PR 5 both wait on it.

The one exception the owner has already approved: **migration 0191 may be applied to production on their "go now" in the morning window**, because it is additive (three columns, constant defaults, metadata-only) and the code that reads them is not merged. This is the 0187 pattern — additive leads the code.

## Order

| when | what | gate |
|---|---|---|
| ~05:07 UTC | **Two measurements**, read-only: 4d Task 3 activation timing (old vs new predicate, preview DB) and the PR 5 one-day reconstruction cost. Then write the PR 5 plan. | auto |
| morning window | **Apply 0191 to production** — additive only, code NOT merged. Then `verify-migration-integrity.ts`, expect **192/192**. | ⛔ owner's explicit "go now" |
| 13:45 UTC | **Campaign 1460 stage 4791 fires** (15:45 Warsaw). Watch from 13:40. | auto |
| after | **Post-run comparison** → owner accepts or not. | ⛔ owner |
| after acceptance | Merge #229 and PR 5. | ⛔ owner |

## What "0191 to production" means precisely

- Three columns on `campaigns`: `offer_cooldown_days` (7), `offer_limit_times` (5), `offer_rules_enabled` (**false**).
- Two CHECK constraints, `NOT VALID` then `VALIDATE`.
- ⚠️ **`offer_rules_enabled` false on all 673 existing campaigns is the point.** It is what stops them silently switching from "ever got this offer" to the Y/N rule. Nothing sets it true until #229 merges and a NEW campaign is created.
- Apply outside the send window. If the 5s lock timeout trips, retry once at a quieter time rather than raising it.

## The watch, in one line

Before: pool still 2,832 (hot 1,306 / warm 1,526), stage `send_approved`, one lifecycle campaign only, no latched breaker. During: `skipped_ineligible` split by reason, ~10% stop rule per reason, any `lifecycle_recheck_failed` means that batch's numbers are MISSING not zero. After: Prepare-time prediction vs live outcome per reason, and `computeStageReconciliation`'s gap — non-zero is a bug.

Expect `freeze_not_due = 0`: the audience is Hot/Warm only.
