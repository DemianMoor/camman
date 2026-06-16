# CamMan — Workstream 4: Daily-Volume UI (Build Brief for Claude Code)

> The final workstream. WS1–WS3 (UI send toggle, collapsed Approve/Prepare flow, submission integrity) are live and proven on real traffic. WS4 is the operating layer that makes running many campaigns a day fast and legible.
>
> **Prerequisite:** the three bugs in `CAMMAN-SMS-TEST-BUGFIX-RULES.md` should land first. Two of them are load-bearing for WS4 (see Dependencies).
>
> **Nature of this work:** purely additive UI + read endpoints. No changes to the send path, no migrations expected (confirm per item).
>
> **Terminology (LOCKED — use exactly, everywhere):**
> - The **action** is **"Prepare"** = approve + materialize + mint links (creates `stage_sends` rows).
> - The **resulting state** is **"Prepared"** = rows exist, waiting for the scheduled window to drain.
> - Button label: **"Prepare"**. State label: **"Prepared"**. Never "Arm"/"Armed".
>
> _Brief date: 2026-06-16_

---

## 0. Foundation — the single status model (build this first)

Everything in Group A keys off **one shared definition**. Do not hardcode colors or labels in multiple components.

Create **one source of truth**: a `status → { color, label, meaning, willSend }` map (one module/constant). The stage-row renderer, the legend, and any dashboard tile all import from it. Change a state once → every surface updates. This is what keeps the legend honest by construction instead of by discipline.

### The stage status lifecycle

| Color | State key | Label | Meaning (operator-facing) | Will it send? |
|---|---|---|---|---|
| ⚪ Grey | `draft` | Draft | Not scheduled or not configured yet. | No |
| 🟠 Orange | `scheduled_unprepared` | Scheduled, not prepared | Time is set but messages aren't prepared — **will NOT send until you Prepare it.** | **No** |
| 🔵 Blue | `prepared` | Prepared | Approved and prepared — **will send automatically at the scheduled time.** | Yes |
| 🟢 Green | `sending_sent` | Sending / Sent | Messages submitted to the provider. | Sent |
| 🔴 Red | `missed_failed` | Missed / Failed | Scheduled time passed without sending, or sends failed — **needs attention.** | No / partial |

### The non-negotiable rule (the entire point of the color system)
**Orange vs Blue is determined by materialization state — whether `stage_sends` rows exist — NOT by whether `scheduled_at` is set.**

- `scheduled_at` set **AND** no materialized rows → **Orange** ("scheduled, not prepared — won't fire as-is").
- `scheduled_at` set **AND** approved + materialized (`pending` rows exist) → **Blue** ("Prepared — will fire at scheduled time").

A scheduled time with no rows must read Orange. This is the exact trap the live test exposed: a time was set, nothing was prepared, and there was no way to see it. Orange makes "this won't send" visible at a glance.

### Red state detail
`missed_failed` covers two distinct conditions, both "needs attention":
- Scheduled window passed and the stage never drained (gate was off, or — pre-Bug-1-fix — a false `sent_at` masked it).
- Sends ran but produced failures / stuck `sending` rows.

This state must be visually loud — a missed send must never masquerade as Draft (implies "not yet") or Sent (implies "done").

---

## Group A — Stage operation & status (new this session)

### A1 — Status model
Build the shared map from §0 first; all of A2–A5 depend on it. Verify whether deriving the five states needs any new query fields on the stages-list endpoint (it already returns `send_approved` + `schedule_missed_at`; confirm it can also signal "has `stage_sends` rows" cheaply — a boolean/count is enough, don't N+1).

### A2 — "Prepare" (SEND API) from two surfaces, one shared popup
The Prepare action lives in **two places**: on the **stages-list row** and inside the **stage editor** (both currently labeled "SEND API" — rename to reflect Prepare; keep "SEND API" wording only if it denotes the API-send *type*, but the action/button opens Prepare).

- Both entry points trigger the **identical confirm popup** via **one shared handler** — never two behaviors that can drift.
- Popup is the existing Approve/Prepare confirm: "Prepare N messages?" + the **readiness checklist** (creative attached, recipients > 0, tracking IDs, provider set, supports API send, credential resolvable, active short domain) + the frozen SMS preview + segment count.
- **Critical:** the readiness checklist must appear in the popup **regardless of entry point**. The list-row path is the one most likely clicked on a half-configured stage, so it must NOT skip pre-flight.
- On confirm: materialize + (future schedule → Prepared/Blue) or (no schedule → inline Send-now drain). Same as the WS2 flow already built.

### A3 — Stage color lifecycle on list rows
Color each stages-list row per the §0 map. Orange/Blue split driven by materialization state per the non-negotiable rule. The color is the at-a-glance "will this send" signal across a list of many stages.

### A4 — One-click "Prepare" on Orange rows
An Orange row (scheduled, not prepared) carries a **one-click Prepare action directly on the row**. Click → the A2 shared popup (with full readiness checklist) opens in place → confirm → row materializes and flips Orange → Blue, **without opening the editor**. This is the high-leverage daily-volume move: fix an un-prepared scheduled stage from the list.

### A5 — Campaign-level status legend
A compact legend at the campaign level (near the stages-list header), **collapsed by default** behind a small "Status guide" / "?" affordance — expandable, not always-on (avoids clutter for operators who know it; teaches new ones once).

- Each entry: color swatch + state label + the one-line meaning from the §0 map.
- **Consumes the same §0 source** as the row renderer — never a separate hardcoded copy.
- Phrase every line around "will it send" (already encoded in the map's `meaning`/`willSend`). Orange and Red lines carry the bolded "won't send" / "needs attention" emphasis.

### A6 — Bulk Prepare (DEFERRED — flagged, not built now)
"Select N Orange stages → Prepare all" is the natural next step once A4 exists. **Do not build it in this pass.** It multiplies the blast radius of any half-configured stage and needs its own confirm design. Ship single-row Prepare (A4) first, prove it, then add bulk as a deliberate follow-up. Listed here so it's a conscious "later," not forgotten.

---

## Group B — Monitoring & dashboards (the original seven, ranked by leverage)

### B1 — Fleet / "Today" dashboard (highest leverage)
One cross-campaign view of every stage scheduled for today and its state (using the §0 colors): Draft / Scheduled-unprepared / Prepared / Sending-Sent / Missed-Failed. Triage from one screen instead of opening many panels. Orange and Red stages should sort/surface to the top — those are the ones needing action. Links into each stage. This is the single biggest scale lever; pairs with B3 and the WS3 failure banners.

### B2 — Pre-flight readiness checklist surface
The `checks` data already exists (WS2 `preflightStageSend`). Surface it as a live green/red checklist on the stage **before** Prepare, not only inside the confirm popup — so readiness is visible at a glance while configuring. **Spam score is shown but is NOT a gate** (locked decision: creative selected = approved).

### B3 — Global send-state + breaker strip (folds in Bug 2 fix)
A persistent status strip showing **two clearly-distinct states**:
- **`sends_enabled`** (global live-sending master switch, WS1) — "Live sending: ON / OFF — Settings → Sending".
- **`send_paused`** (per-provider breaker) — paused + reason if latched.

This is the front half of the Bug 2 fix. The strip must be visible from the operating surfaces (stage panel, provider page, ideally app-level). It resolves the "too many Active badges, real switch off-screen" problem that cost the live test. Provider-level capability badges (API sending Enabled, circuit Active, phone Active) must be visually distinct from these two operational states.

### B4 — Volume-vs-caps meter
Today's sent count vs `max_sends_per_24h`; this run vs `max_sends_per_run`. See "9,200 / 10,000 today" before committing a big batch and hitting a soft ceiling. Counts are org-wide (matches current breaker accounting).

### B5 — Send-window indicator
On scheduled/Prepared stages: "Window opens 08:00 ET" / "open, closes in 3h 12m". Prevents the "why didn't it fire overnight" confusion, given the sender-ET-zone limitation (window is sender's fixed ET, not recipient-local — a known v1 simplification).

### B6 — Stuck-row callout
Rows stuck in `sending` (process died mid-send) are never auto-retried by design (at-most-once). Surface "N messages stuck — review" prominently rather than leaving them invisible in the count tiles. Feeds the WS3 indeterminate bucket. These should push a stage toward Red in the §0 model.

### B7 — Per-recipient drill-down + targeted retry
The Activity/Messages view already lists per-recipient rows (status / TRIES / MESSAGE ID / error). Add: filter to failed/stuck rows, read the **grouped** error (WS3 classification: mine / theirs / indeterminate), and **retry just those** (existing "Retry failed" mints fresh rows per the terminal-row rule). Include the one-click escalation export (WS3) for theirs/indeterminate rows.

---

## Dependencies on the bug fixes (do not ignore)

- **Bug 1 (false `sent_at`) must land before A3/B1 are trustworthy.** The Red "Missed/Failed" state depends on a missed send actually being detectable — if the scheduler still stamps `sent_at` without sending, a missed stage falsely reads Green/Sent and the color system lies. Fix Bug 1 first, then the color lifecycle reflects truth.
- **Bug 2 (visibility) IS B3.** Build B3 as the Bug 2 fix — they're the same work; don't do it twice.
- **Bug 3 (shortener params) is adjacent to this UI.** The `ATTACH TO URL` chips in the stage editor (`subid3`/`subid2` — no underscores) are the likely source of the malformed `subid3` key. Whoever fixes Bug 3 should look there first; whoever builds A2/A4 will be in the same editor and should not replicate the bad key.

---

## Recommended build order
1. **§0 status model** (foundation — A1).
2. **A2 Prepare-from-two-surfaces** (shared popup) → **A3 row colors** → **A4 one-click Prepare on Orange** → **A5 legend.** (Group A is one coherent thread; build it together.)
3. **B3 global send-state strip** (= Bug 2 fix) → **B1 fleet dashboard** → **B2 readiness surface.**
4. **B4 / B5 / B6 / B7** (meters, indicators, drill-down) — layer on once the dashboard frame exists.
5. **A6 bulk Prepare** — deliberate later, after A4 is proven.

## Acceptance (cross-cutting)
- One shared status definition; legend and rows never disagree.
- An Orange row means "scheduled but no `stage_sends` rows" and can be Prepared in one click from the list, with the full readiness checklist in the popup.
- Prepare from list row and from editor produce identical behavior.
- A missed scheduled send reads Red, not Green/Sent (requires Bug 1 fixed).
- Global "Live sending: ON/OFF" is legible from the stage panel without visiting Settings.

## Guardrails (unchanged)
- Never persist or emit the `api_key`.
- At-most-once preserved: only `pending` rows claimed; `sending` rows never auto-retried.
- UI copy: "Submitted"/"Accepted by TextHub", never "Delivered".
- Every UI/behavior change updates the `docs/` folder per the standing CLAUDE.md rule.
