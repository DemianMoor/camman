# Feature — UI System

_Last updated: 2026-08-13_

## 1. Purpose
A consistent, server-component-first UI built on Next.js 16 + Tailwind v4 + shadcn/ui. Reusable wrappers enforce the project's interaction conventions (dialog dismissal, required-field markers, file uploads, multi-select) so individual screens stay thin.

## 2. Conventions (CLAUDE.md §9)
- Pages are **server components** by default; `"use client"` only for forms/interactivity.
- **Tailwind only** (no CSS modules, no inline styles except dynamic). shadcn/ui primitives in `components/ui/`, custom components in `components/`.
- Tables via the `DataTable` wrapper (TanStack Table). Forms via react-hook-form + Zod. Toasts via sonner. Icons from lucide-react.
- List filters persisted to localStorage via `usePersistedFilters`, keyed by route.

## 3. Shared components
| Component | File | Role |
|-----------|------|------|
| `DataTable` | `components/data-table.tsx` | TanStack wrapper: manual pagination/sort/selection, loading skeletons, empty state, row-click |
| `MultiSelectPicker` | `components/multi-select-picker.tsx` | popover searchable checkbox list for >10 options (UTM tags, groups); scales to hundreds. Pill-toggles reserved for ≤5 fixed enums. `layout` picks where the selected-item chips go: `"stacked"` (default) puts them on their own row beneath the trigger — right for a full-width form field; `"inline"` puts them beside it (`flex-nowrap`) so the control grows **wider, not taller**, with `triggerClassName` setting the trigger's width and `maxChipsShown` capping the run |
| `SearchableSelect` | `components/searchable-select.tsx` | **single**-select sibling of `MultiSelectPicker`: popover + filter input + ↑/↓/Enter nav; commits one value and closes on pick. Trigger mirrors `<SelectTrigger>` styling so it drops into a row without shifting layout. Used by the segment Rules tab (rule type + brand/offer/segment/contact-group value pickers). `fallbackLabel`/`fallbackColor` render a persisted value whose options haven't loaded (or that is archived) |
| `SegmentPicker` / `OfferPicker` | `components/segments/segment-picker.tsx`, `components/offers/offer-picker.tsx` | popover searchable pickers with **pin (star) + recently-used** ordering (Pinned → Recent → All). SegmentPicker is multi-select; OfferPicker is single-select. Both back their prefs with `usePickerPrefs(namespace)` (`lib/hooks/use-picker-prefs.ts`), a per-browser localStorage store keyed `segments.*` / `offers.*`. `useSegmentPrefs` is a thin wrapper over it |
| `FileDropZone` | `components/file-drop-zone.tsx` | click + drag-drop file input (CSV imports). The only file-picker shape — extend it, don't roll a new `<input type=file>` |
| `FormDialog` | `components/ui/form-dialog.tsx` | dialog that **blocks** backdrop-click + Escape dismissal (protects in-progress form data); X / Cancel still close |
| `CopyableId` | `components/ui/copyable-id.tsx` | read-only input + copy button + toast for system-generated ids (tracking IDs) |
| Sidebar + nav | `components/protected/sidebar*.tsx`, `nav-config.ts` | grouped nav; items disabled via `isEntityAvailable()` |
| `SpamCheckStrip` | `components/spam/spam-check-strip.tsx` | inline spam-score button under creative textareas |

### Dialog dismissal rules
| Wrapper | Backdrop / Escape | Use for |
|---------|-------------------|---------|
| `<FormDialog>` | **blocked** | any create/edit/upload dialog or anything taking input beyond a single button press |
| `<AlertDialog>` | default (dismissible) | confirmations |
| bare `<Dialog>`+`<DialogContent>` | default | read-only modals |

### Required-field indicator
Required fields get a trailing red asterisk via `<FormLabel required>` (or inline `<span aria-hidden className="text-destructive ml-0.5">*</span>` for non-FormField `<Label>`s). Optional fields get **nothing** (no "(optional)" text). Required-ness mirrors the Zod schema and is enforced server-side.

## 4. Editor surfaces (campaigns)
| File | Role |
|------|------|
| `app/(protected)/campaigns/[id]/page.tsx` | campaign detail + **inline stage table** (status dropdowns, bulk actions, import/manual/history dialogs, archive/restore) |
| `app/(protected)/campaigns/[id]/edit/page.tsx` + `components/campaigns/campaign-editor-page.tsx` | setup / audience / notes editor with live audience preview; `Esc` to cancel (confirm), `Cmd/Ctrl+Enter` for the primary action |
| `components/campaigns/campaign-form-fields.tsx` | individual campaign fields |
| `components/campaigns/stage-inline-creator.tsx` + `stage-form.tsx` | inline stage create/edit (FormDialog) with **live SMS preview** + char/segment counter |
| `components/campaigns/status-change-dialog.tsx` | campaign status-transition confirmation |
| `components/campaigns/stage-send-panel.tsx` | approve + trigger send |
| `components/campaigns/results-import-form.tsx`, `manual-results-form.tsx`, `import-history-dialog.tsx` | CSV import / manual counters / revert |
| `components/campaigns/click-report-section.tsx` | click attribution report |

**Audience preview** (right-rail card): total contacts, will-send-vs-above-cap progress bar, pool breakdown (segments / groups / overlap / excluded opt-outs), filter chips, exclude-in-use switch. Backed by `POST /api/campaigns/audience-preview`.

**SMS preview composition** (`lib/sends/stage-sms.ts`): `<Brand>: <creative>` + (optional) `short_url` line + `stop_text`.

## 5. Data it reads/writes
- UI components are presentational; data flows through the per-entity API routes (CLAUDE.md §8).

## 6. Rules & edge cases
- `MultiSelectPicker` is mandatory for many-option selection; FK pickers gate their fetches on `isEntityAvailable()` (no speculative 404-catching).
- **A control inside a horizontal row must never gain a second row.** The row centres its items, so anything that grows taller shifts every sibling off the shared baseline — the selection you just made appears to knock the other dropdowns out of alignment. Use `MultiSelectPicker`'s `layout="inline"` there (the segment Rules row does); reserve the default `"stacked"` chips for full-width form fields, where growing downward costs nothing.
- **Which picker for a single-select?** `SearchableSelect` is the generic default (any entity, any string-keyed option list). `OfferPicker`/`SegmentPicker` are the *specialized* ones — reach for them only when the **pin + recently-used** ordering is wanted, since they hardcode their entity's copy and `usePickerPrefs` namespace. Three popover-search components now coexist (`MultiSelectPicker`, `SearchableSelect`, `Offer`/`SegmentPicker`); that overlap is known and deliberate — they differ in cardinality (multi vs single) and in whether prefs-ordering applies. Don't add a fourth: extend one of these.
- **≤10 options stay a plain `<Select>`.** In the segment Rules row the operator (`is`/`is not`), the AND/OR combinator, and the lookback period are deliberately *not* searchable — a filter box over 2–8 items is friction, not help.
- Tall dialogs scroll rather than overflow off-screen (recent fix, commit `19d85e4`).

## 7. Extension points / limitations
- **No command palette / cmdk** exists in the codebase (despite being on the original wishlist) — `> [VERIFY]` resolved: confirmed absent as of 2026-06-05. If added later, document it here.
- Dashboard widgets use Recharts (`app/(protected)/dashboard/`, `lib/dashboard-*.ts`); the "Active stages" block replaced "Recent stages" recently (commit `bf7010a`).
