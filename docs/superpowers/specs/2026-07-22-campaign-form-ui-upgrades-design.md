# Campaign creation form — UI upgrades

Date: 2026-07-22
Status: approved, ready to implement

## Goal

Four independent UI improvements to the campaign creation screen
(`/campaigns/new`, rendered by
[campaign-editor-page.tsx](../../../components/campaigns/campaign-editor-page.tsx)
with state from
[campaign-form-state.ts](../../../components/campaigns/campaign-form-state.ts)).
All four apply to **create mode only** — editing an existing campaign keeps
its saved values.

## Change 1 — Offer picker with pin + recently-used

Replace the plain shadcn `Select` for Offer
([campaign-editor-page.tsx:573-608](../../../components/campaigns/campaign-editor-page.tsx))
with a new **single-select** `OfferPicker`, modeled on `SegmentPicker`
([segment-picker.tsx](../../../components/segments/segment-picker.tsx)).

- Searchable popover; per-row pin star; ordering **Pinned → Recent → All**;
  tabs `All / Recent / Pinned` (drop the segment-only `Has rules / Static`
  tabs). Keeps the color dot each offer shows today.
- Single-select: choosing an offer sets the value, records it as recent, and
  closes the popover. Trigger shows the selected offer's dot + name (or
  "Select" placeholder). No chips (single value).
- **Prefs storage:** extract the localStorage logic in
  [use-segment-prefs.ts](../../../lib/hooks/use-segment-prefs.ts) into a generic
  `usePickerPrefs(namespace)` hook (`lib/hooks/use-picker-prefs.ts`). Refactor
  `useSegmentPrefs` to delegate to it (keys `segments.pinned`/`segments.recent`,
  no behavior change). `OfferPicker` calls `usePickerPrefs("offers")` (keys
  `offers.pinned`/`offers.recent`). Per-browser, matching segments' existing
  tech-debt note.

## Change 2 — Auto-select "API Send" after a qualifying brand

In [campaign-form-state.ts](../../../components/campaigns/campaign-form-state.ts):
add a "user touched send method" flag (ref) set inside `setLinkMode`. New
create-mode effect: when the selected brand **has** an active short domain and
the user has not manually touched the field, set `link_mode = 'tracked'`
(`shouldDirty: false`). The existing force-to-Manual effect (lines 485-489)
still handles brands with no short domain.

Behavior: pick a qualifying brand → flips to API Send; manually switching to
Manual sticks and won't flip back on later brand changes; a brand with no short
domain falls back to Manual.

## Change 3 — Routing defaults to "Preland"

New create-mode effect in `campaign-form-state.ts`: after routing types load,
if `routing_type_id` is still null, select the type named `Preland`
(case-insensitive, trimmed). Falls back to `None` if not found. `shouldDirty:
false`, guarded on null so it composes with the existing single-option
auto-select.

## Change 4 — Clickers filter pre-selected

Flip `DEFAULT_FILTERS.include_clickers` `false → true`
([campaign-form-state.ts:88](../../../components/campaigns/campaign-form-state.ts)).
New campaigns start with No-status + Clickers + Not-clicked on. Edit mode loads
saved filters, unaffected.

## Verification

- `npm run build` / typecheck passes.
- Localhost `/campaigns/new` manual check (shown in browser before any push):
  1. Offer picker pins & recents behave like Segments.
  2. Selecting a brand with a short domain flips to API Send; manual override
     sticks; brand without domain falls back to Manual.
  3. Routing shows Preland by default.
  4. Clickers pill starts filled.
- Docs updated: `docs/04-features/` (campaigns) + `docs/07-conventions.md` as
  applicable, and a `docs/CHANGELOG.md` entry.

## Out of scope

- Server-side / per-user persistence of pins & recents (stays per-browser).
- Any change to the offer/routing data model or API.
