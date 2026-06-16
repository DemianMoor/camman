# CamMan — Bug-Fix Rules from Live SMS Test (Handoff for Claude Code)

> Three confirmed bugs surfaced during the first real end-to-end SMS test on 2026-06-16.
> The send pipeline itself is **proven working** (materialize → mint unique links → inline drain → TextHub accepted → handset delivery, with opt-out correctly suppressing one recipient). These three issues are the fixes that must land before WS4.
>
> **Priority order:** Bug 1 (integrity) → Bug 3 (tracking) → Bug 2 (visibility) → then WS4.
> Rationale: Bug 1 corrupts "did it send" truth; Bug 3 breaks all Keitaro attribution; WS4's dashboard will surface data that 1 and 3 currently poison. Fix the data/integrity layer before building views on top of it.
>
> _Brief date: 2026-06-16_

---

## Bug 1 — Scheduler stamps `sent_at` without actually sending (INTEGRITY — highest priority)

### Symptom (observed in test)
A stage was armed via Approve & arm (materialized at click-time) and scheduled for 12:25 PM ET. The global `sends_enabled` toggle was **off**. At the 12:30 cron tick the stage's `sent_at` was stamped (`Sent Jun 16 12:30 PM ET`), and the stage-level Status moved off "ready" — **but zero messages drained**: both `stage_sends` rows stayed `pending`, TRIES `0`, no MESSAGE ID, nothing reached TextHub.

### Impact
A stage shows "Sent" while no messages were sent. This is a **false-positive send signal** — the exact integrity failure the WS3 work exists to prevent. At volume this would silently mark whole campaigns as sent that never fired.

### Root-cause hypothesis
`sent_at` is being stamped on stage **selection/processing** in the scheduler, decoupled from whether the drain actually sent anything. The WS2a "click-materialize" path is the likely seam: because the stage was materialized externally (at Approve & arm), the cron tick found an already-materialized due stage and stamped `sent_at` without Phase B completing a successful drain — and the gate refusal (`sends_enabled` off) did not prevent the stamp.

### Verify first
1. In `lib/sends/scheduled.ts`, find **every** place `sent_at` is written. The design doc lists two intended stampers: Phase A (after a successful materialize) and the manual drain backfill (`COALESCE`, only when `processed > 0`). Identify which one fired for an **externally-materialized (click-armed)** stage — Phase A should have skipped it (nothing to materialize), so determine what actually stamped it.
2. Confirm whether the drain **gate refusal** path (env off / `sends_enabled` off / `send_paused` / window closed) has any route that still reaches the `sent_at` stamp.
3. Check the `approve-send` route — confirm it does **not** stamp `sent_at` at arm-time for a future schedule.

### The rule (fix)
**`sent_at` is stamped if and only if a drain pass actually sent ≥ 1 message (`processed > 0` with at least one row transitioned to `sent`/`sending`). Any gate refusal — env `SEND_ENABLED` off, DB `sends_enabled` off, `send_paused`, or outside the send window — must leave `sent_at` NULL and the stage fully re-tryable on a later tick.**

- Apply this uniformly across **all** stamp points (scheduler Phase A, scheduled-path drain, manual drain backfill, and the approve-send route).
- The click-armed seam specifically: an externally-materialized stage that the cron picks up must follow the same rule — stamp `sent_at` only after its Phase B drain successfully processes rows, never on mere selection.
- A stage whose drain was gate-refused must look identical to "armed, not yet fired" — re-selectable next tick, no stale `sent_at`.

### Acceptance + regression test
- New test: arm a stage with `sends_enabled = false`, run a cron tick → assert `sent_at` stays NULL, rows stay `pending`, stage is re-selected on the next tick once the gate opens. (Extends `test-scheduled-decouple`.)
- New test: click-materialize a stage, run a tick with the gate **open** → assert it drains AND `sent_at` is stamped only after `processed > 0`.
- Manual check: repeat the original scenario; confirm a gate-off tick no longer shows "Sent."

---

## Bug 3 — Internal shortener emits malformed tracking params (BREAKS KEITARO ATTRIBUTION)

### Symptom (observed in test)
The minted redirect target opens as:

```
https://www.guidekn.com/lp/knd?knd=8_62_061626_1_s1_c124&subid3=sub_id3
```

Three things are wrong versus the required format.

### Required format (confirmed by owner)
```
https://www.guidekn.com/lp/knd?sub_id3=8_62_061626_1_s1_c124
```
- `/lp/knd` is the page-slug path — correct, leave as-is.
- The query string must be exactly `?sub_id3=<stage_tracking_id>`.

### The three defects to fix
1. **Wrong param key:** emits `subid3` (no underscore). Must be `sub_id3` (with underscore) — this is the param the owner has configured Keitaro to ingest. A mismatched key makes Keitaro silently return nothing.
2. **Placeholder leaked as value (most damaging):** the value is the literal string `sub_id3` instead of the actual stage tracking ID. A template token (e.g. `{sub_id3}`) is not being substituted — the raw token reached the output. Must emit the real `campaign_stages.tracking_id` (`8_62_061626_1_s1_c124` in the test). A literal placeholder collapses all clicks into one Keitaro bucket.
3. **Stray `knd=` query param:** `?knd=8_62_061626_1_s1_c124` should not exist at all. The stage ID is being injected into a `knd` query param in addition to (wrongly) the `subid3` slot. Remove the `knd=` query param entirely. (Do not confuse with the `/lp/knd` path slug, which stays.)

### Verify first
1. Locate the **destination-URL / redirect-target builder** in `lib/links/` (the link-mint path), not `lib/keitaro/client.ts` — the shortener builds the redirect target with tracking params appended; the Keitaro client only reads reports.
2. Find where the `knd=` query param is appended and why the stage ID lands there — likely a crossed mapping between the page-slug field and the tracking-param field.
3. Find the substitution that should replace `{sub_id3}` (or equivalent token) with `campaign_stages.tracking_id`; confirm why it isn't running.
4. **Check the sibling slots too:** if the builder also emits `sub_id4` (page slug) and `sub_id5` (customer/click id), confirm they don't have the same key-typo / unsubstituted-placeholder defect. Fix them to the same standard (correct underscored key, real value). Do not assume only `sub_id3` is affected.

### The rule (fix)
**The shortener's redirect-target query string must be built by substituting the stage's actual `tracking_id` into a correctly-named `sub_id3` parameter, producing exactly `?sub_id3=<tracking_id>`. No literal placeholder tokens may ever reach the emitted URL, no `knd=` query param may be appended, and any sibling `sub_id4`/`sub_id5` slots must follow the same correct key+value pattern.**

### Acceptance + regression test
- Unit test on the URL builder: given a stage with `tracking_id = "8_62_061626_1_s1_c124"` and page slug `knd`, assert the output is exactly `https://www.guidekn.com/lp/knd?sub_id3=8_62_061626_1_s1_c124` — assert the key is `sub_id3` (underscore), the value equals the tracking_id, and `knd=` is absent from the query string.
- Mint a fresh link in the UI and confirm the opened URL matches.
- Confirm a Keitaro poll attributes the click to the correct `sub_id_3` after the alias mapping (owner has Keitaro configured for the `sub_id3` emission key).

---

## Bug 2 — "Active" overload: global send-state invisible from the operating surface (WS4 #3)

### Symptom (observed in test)
The provider page (`/providers/2`) shows multiple green states — provider **Active**, API sending **Enabled**, Sending circuit **Active**, phone numbers **Active** — **none of which is the global `sends_enabled` kill-switch.** That switch lives off-screen at Settings → Sending. The operator read the provider "Active" badges as "sending is on," armed a stage, and it silently didn't fire because the global toggle was off. The stage panel did say "Live sending: off," but its relationship to all the "Active" badges was not legible. This cost the entire test session.

### Impact
The one switch that actually gates sending is the least visible state in the system, and it's surrounded by unrelated badges that all say "Active." Guaranteed operator error at daily volume or with a second operator.

### The rule (fix)
**Global live-sending state must be unambiguous and visible from every surface where an operator commits or reviews a send — not buried on a separate Settings page.**

1. **Single global status indicator**, prominent on: the stage send panel, the provider page, and ideally a persistent app-level strip/header. Plain copy: **"Live sending: ON"** or **"Live sending: OFF — enable in Settings → Sending"** with a direct link to the toggle.
2. **Disambiguate the badges.** The provider-level states (provider Active, API sending Enabled, circuit Active/`send_paused`, phone Active) are *capabilities and breakers* — distinct from the *global on/off*. Label or group them so none reads as "sending is live." Surface the global `sends_enabled` state on the provider page alongside them, clearly marked as the master switch.
3. Fold this into **WS4 #3** (global breaker/pause strip): the strip shows both `send_paused` (per-provider breaker) **and** `sends_enabled` (global switch) as two clearly-named, distinct states.
4. **Consistency check:** the stage panel's "Live sending: off" and the Settings → Sending toggle must read from the **same source of truth** and never disagree. (During the test, Settings appeared on while the panel read off — verify they bind to the same flag value, no caching/scope mismatch.)

### Acceptance
- From the stage send panel, an operator can tell at a glance whether live sending is globally on or off, without visiting Settings.
- Provider-page badges no longer imply sending is live; the global master state is shown and labeled.
- Settings toggle and panel indicator always agree.

---

## Data cleanup note
The test stage that received the false 12:30 `sent_at` has since been drained via Send-now (both rows now `submitted`), so it self-resolved. No orphaned stage needs repair from this test. After Bug 1 ships, no future stage should be able to enter the "stamped sent, nothing drained" state — confirm with the regression test rather than manual cleanup.

## Sequencing relative to WS4
Fix Bug 1, Bug 3, Bug 2 in that order, then proceed to WS4 (fleet dashboard, readiness surface, breaker/volume/window/stuck indicators, per-recipient drill-down). Bug 2's fix is effectively the front half of WS4 #3, so building it now is not wasted work — it slots directly into the dashboard layer.

## Guardrails (unchanged from build brief)
- Never persist or emit the `api_key`.
- Preserve at-most-once: only `pending` rows are claimed; `sending` rows are never auto-retried.
- UI copy stays "Submitted"/"Accepted by TextHub", never "Delivered" (TextHub showing UNKNOWN/`Delivered At: --` is *their* delivery layer, correctly outside CamMan's claim).
- Every schema/behavior change updates the `docs/` folder per the standing CLAUDE.md rule.
