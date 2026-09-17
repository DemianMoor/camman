# Edit landing pages after creation — design

_Date: 2026-09-17 · Status: approved in chat, pending spec review_

## Problem

On the offer edit dialog, a landing page can be created, made default, and
disabled/enabled — but its **title, slug, URL and kind cannot be changed**.

- The UI (`components/offers/landing-pages-panel.tsx`) has no edit affordance.
- The API (`PATCH /api/offers/[offerId]/landing-pages/[pageId]`) already accepts
  `title`, `slug`, `external_url`, but refuses any kind change
  (`kind_immutable`), and the update schema has no `kind` field.

Operators want all four fields editable.

## Why this needs care

A stage stores **which page** (`campaign_stages.landing_page_id`), not a URL.
The destination is built from the page's *current* `kind` / `slug` /
`external_url`:

- **Regular stages** — in `kickoffStageSend` (`lib/sends/kickoff.ts`) while the
  stage is being **materialized**; the URL is frozen into each recipient's
  minted link. Once `campaign_stages.materialized_at` is set, the stage no longer
  reads the page. A stage mid-materialization (`materialized_at IS NULL`, some
  windows committed) would pick up an edit for its remaining windows.
- **Drip stages** (`drip_active IS TRUE`) — per contact, every time
  (`lib/drip/scheduler.ts`, `lib/drip/followups.ts`). They never freeze.

So editing a page's destination changes where every not-yet-materialized stage
and every dripping stage sends — including approved and scheduled ones. Links
already minted keep their old destination. That is why `kind` was made
immutable; the user has ruled that editing is allowed **with an explicit
confirmation** showing the blast radius.

## Decisions

1. **Title** — always editable, no confirmation.
2. **Destination** = `kind`, `slug`, `external_url`. Editable, but a change to a
   page that affected stages still use requires confirmation (below).
3. **Kind becomes editable.** Switching kind requires the new kind's value and
   clears the other column, satisfying `offer_landing_pages_shape_check`.
4. **Confirmation is enforced by the server**, not only the UI (approach A).
   The same query produces the warning and gates the write, so they cannot
   disagree — the pattern `lib/api/campaign-brand-change.ts` already uses.
5. **Switching to `kind='slug'` is refused** if any affected stage's campaign
   brand has no `landing_host`. Such stages would otherwise hard-fail at mint
   (`brand_missing_landing_host`). This is the same rule
   `checkStageLandingPage` enforces at stage save; confirmation does not
   override it.
6. **Renaming a slug frees the old slug** for reuse on that offer. Nothing in
   the app resolves a page by slug; links in the wild carry full URLs. No extra
   guard. The existing unique index still returns `409 duplicate` on a clash.
7. **No migration.** The table's CHECKs already permit either kind; nothing in
   the schema changes.
8. **Permissions unchanged.** `offers.update` (manager+). The route map keeps
   `offers/[offerId]/landing-pages/[pageId]` denied to operators.

## Affected stages — the one definition

A stage is **affected** by a destination edit when all hold:

- `campaign_stages.landing_page_id = <page>` and same `org_id`
- `campaign_stages.archived_at IS NULL`
- its campaign's `status IN ('draft', 'active', 'paused')`
- `materialized_at IS NULL` **or** `drip_active IS TRUE`

Of those, **committed** = `send_approved IS TRUE OR scheduled_at IS NOT NULL OR
drip_active IS TRUE` — shown separately because those are the ones an operator
has already signed off.

Stages whose campaign is `completed` / `archived`, and stages already fully
materialized, are not counted: their messages will not change.

## Server

### Validator — `lib/validators/offer-landing-pages.ts`

`offerLandingPageUpdateSchema` gains:

- `kind: z.enum(["slug", "external_url"]).optional()`
- `confirm: z.boolean().optional()`

All other fields keep their current schemas.

### Destination resolver — `lib/landing-page-edit.ts` (pure)

```ts
resolveLandingPageEdit(
  existing: { kind; slug; external_url },
  input: { kind?; slug?; external_url? },
): { ok: true; kind; slug: string | null; external_url: string | null; destinationChanged: boolean }
 | { ok: false; field: "slug" | "external_url"; message: string }
```

1. **Target kind** = `input.kind ?? existing.kind`.
   - Target `slug` with `input.external_url` present → refuse, field
     `external_url` ("A slug page has no URL").
   - Target `external_url` with `input.slug` present → refuse, field `slug`.
   - Kind **changes** and the new kind's value is missing → refuse, field
     `slug` / `external_url` ("Switching to … needs a …").
2. **New destination** = target kind + supplied value, falling back to the
   existing value when not supplied; the other column is `null`.
3. `destinationChanged` = kind differs, or the active value differs.

Pure (no DB, no Next imports) so it can be tested with a plain `tsx` script —
the same split `lib/entity-name.ts` uses for testability.

### PATCH — `app/api/offers/[offerId]/landing-pages/[pageId]/route.ts`

Inside the existing transaction, after loading `existing`:

1. `resolveLandingPageEdit(existing, input)`; a refusal → 400 `validation`
   with its field. This replaces the `kind_immutable` branch.
2. If `destinationChanged`, run the affected-stages query
   (`lib/api/landing-page-impact.ts`, below) **in the same `tx`**.
   - Target kind `slug` and any affected stage's brand has no `landing_host`
     → 400 `landing_page_invalid`, field `kind`, message naming the brand(s).
     Checked before confirmation.
   - `affected > 0` and `input.confirm !== true` → 409, code
     `landing_page_in_use`, details `{ affected, committed }`, nothing written.
3. Write: `title` if supplied; `kind`, `slug`, `external_url` from the
   resolver; `is_default` / `status` as today; `updated_at = now()`.

`API_ERROR_CODES` gains `LANDING_PAGE_IN_USE = "landing_page_in_use"` (reuse
`LANDING_PAGE_INVALID_CODE` from `lib/api/landing-page-guard.ts` for the brand
refusal).

### Impact helper — `lib/api/landing-page-impact.ts`

```ts
computeLandingPageImpact(dbc, { orgId, pageId }): Promise<{
  affected: number;
  committed: number;
  brandsWithoutLandingHost: string[]; // distinct names among affected stages
}>
```

One read-only SQL statement implementing the definition above. Used only by
the PATCH.

## UI — `components/offers/landing-pages-panel.tsx`

- Each row, when `canEdit`, gets a **pencil** icon button (lucide `Pencil`,
  `aria-label="Edit"`).
- Clicking it turns that row into an inline editor (one row at a time):
  Title*, Kind select (Brand slug / External URL), Slug* or URL* with the same
  validation hints as the add form, and **Save** / **Cancel** buttons. Inline,
  not a dialog — the panel already lives inside the offer's `FormDialog`.
- Save sends only changed fields (plus `kind` whenever the destination fields
  are shown, so the server can resolve the target unambiguously).
- On `409 landing_page_in_use`, open an `AlertDialog`:
  > **Change where this landing page sends?**
  > {affected} stage(s) still use this page ({committed} approved, scheduled or
  > dripping). Their future messages will link to the new destination.
  > Messages already sent keep their old link.
  > [Cancel] [Change destination]

  Confirm re-sends the same body with `confirm: true`.
- Other errors → `toast.error(message)`, editor stays open. Success →
  `toast.success`, editor closes, list reloads.
- The add-form and edit-row share field markup via a small local component in
  the same file (both need Title/Kind/Slug-or-URL with identical validation).

## Error handling summary

| Situation | Status | Code | Written? |
|---|---|---|---|
| Title only | 200 | — | yes |
| Destination change, 0 affected | 200 | — | yes |
| Destination change, affected, no confirm | 409 | `landing_page_in_use` | no |
| Same, `confirm: true` | 200 | — | yes |
| → slug, affected stage's brand lacks landing_host | 400 | `landing_page_invalid` | no |
| Value doesn't match target kind / missing on switch | 400 | `validation` | no |
| Slug clash on the offer | 409 | `duplicate` | no |
| Page not in org/offer | 404 | `not_found` | no |

## Verification

⚠️ **Nothing runs against production.** `.env.local` points at the PROD
database, so no fixture-writing script runs from it. All data-touching checks
use the preview project `camman-v2` (`fdzxzxayhknywvmrhjcj`).

1. `npx tsc --noEmit`; `npx eslint` on changed files only (repo-wide lint walks
   other worktrees).
2. **Resolver** — `scripts/test-landing-page-edit-resolver.ts`, plain `tsx`, no
   DB: title-only (no change); slug edit; URL edit; slug→URL and URL→slug
   (other column nulled); URL on a slug page refused; switch with missing
   value refused; same value re-sent ⇒ `destinationChanged=false`.
3. **Impact SQL** — on `camman-v2` via the Supabase MCP, inside a `DO $$ … $$`
   block that seeds its own org/offer/brand/page/campaigns/stages and ends in
   `RAISE EXCEPTION 'TESTRESULT …'` (full rollback, zero residue). Asserts:
   unmaterialized stage counted; fully materialized stage not counted;
   `drip_active` stage counted; stage on a `completed` campaign not counted;
   archived stage not counted; `committed` counts approved/scheduled/dripping
   only; brand without `landing_host` is reported.
4. **API handshake** — on the PR's `camman-*` preview (preview DB), a
   throwaway user, fixtures deleted by ID in `finally`: title edit 200; slug
   edit on in-use page → 409 `landing_page_in_use` with counts, row unchanged;
   same with `confirm: true` → 200, row changed; URL→slug with a hostless brand
   → 400 even with confirm; slug clash → 409 `duplicate`.
5. **Browser** — the offer dialog on the preview: edit title; edit slug on an
   in-use page → dialog shows counts → confirm → row shows the new
   `/lp/<slug>`.
6. **Docs** — `docs/07-conventions.md` (replace the "kind is immutable"
   bullet), `docs/03-data-model.md` (table note),
   `docs/04-features/registry.md` (offers: landing page editing),
   `docs/CHANGELOG.md`.

## Out of scope

- Showing a per-row "used by N stages" count in the list.
- Versioning / history of a page's past destinations.
- Letting operators edit pages (route map unchanged).
