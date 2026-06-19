# Campaign Manager — Project Conventions

This file is the source of truth for how this project is structured. Read it at the start of every session. When in doubt, ask before deviating from these conventions.

## 1. Project Overview

Campaign Manager is an internal CRM-style tool for managing SMS affiliate marketing campaigns. The user is a non-developer building this with Claude Code's help. The project is single-developer (the user) with optional senior-engineer code review at milestones.

**Scope decision for v1 (important):** This tool does NOT send SMS, does NOT receive SMS, and does NOT integrate with SMS providers' APIs. It is a system of record for contacts, segments, campaigns, and campaign results. The actual sending happens manually in external provider tools (SendNexus, TextHub, others later). Campaign results are imported via CSV after sends complete. Real-time SMS provider integration may come in a later phase.

**Target scale at maturity:** millions of contacts, 100+ campaigns per day. Build with this in mind from day one — schema decisions and indexes matter — but don't over-engineer for it.

**Display name:** "Campaign Manager"
**Default currency:** USD (all monetary values stored as numeric, displayed with $ prefix)
**Tech stack:** Next.js 16 (App Router) · TypeScript · Tailwind · Supabase (Postgres + Auth) · Drizzle ORM · Zod · TanStack Table · Recharts · shadcn/ui

## 2. Next.js Version Note

This project uses Next.js 16, which is newer than most training data. Patterns that changed from earlier versions:
- `params` in dynamic routes are async (must be awaited)
- `cookies()` and `headers()` are async
- Server components are the default; client components must opt in with "use client"
- Turbopack is the default bundler

When generating code, default to Next.js 16 patterns. If unsure whether something changed, check official docs rather than memory.

## 3. Multi-Tenancy Rules (CRITICAL)

Every domain table has an `org_id UUID` column. Every query that reads or writes domain data MUST filter by `org_id`. This is non-negotiable — a missing filter is a data-leakage bug.

**Pattern:** All API routes resolve the user's `org_id` via a server-side helper before any query. There is exactly one helper that does this; do not invent alternates. Background jobs and webhooks (future) will use a separate trusted-context helper that takes `org_id` as an explicit argument.

Supabase RLS policies are defense-in-depth, not the primary defense. Application-level filtering is the primary defense. Both must be in place.

## 4. Authentication

- Provider: Supabase Auth, email + password method (NOT magic link)
- Password reset: via email link (Supabase built-in flow)
- Email verification: required before login
- On new user signup, a trigger auto-creates an `organizations` row and inserts the user as `owner` in `org_members`. New users land in `/auth/complete` to set their display name, then `/dashboard`.

## 5. Roles & Permissions

Five roles in ascending privilege:
- `viewer` — read-only
- `operator` — + create/send/archive campaigns, create/archive creatives, upload contacts/opt-outs/clickers
- `manager` — + delete contacts, create/delete segments, delete opt-outs/clickers, create/archive registry entities, edit config
- `admin` — + manage users (invite, remove members)
- `owner` — + delete organization

Permission checks use a `can(permission)` helper on both server and client. UI hides actions the user cannot perform; server endpoints re-check independently.

## 6. Database Conventions

- ORM: Drizzle. Migrations live in `/db/migrations`. Schema in `/db/schema.ts`.
- Every domain table has: `id`, `org_id`, `created_at`, and (where applicable) `status TEXT`, `archived_at TIMESTAMPTZ`.
- Soft-delete via `status = 'archived'`. Hard delete is rare and explicit.
- Foreign keys are always declared. Cascades are explicit, not assumed.
- Timestamps stored as `TIMESTAMPTZ`, never naive timestamps.
- Money stored as `NUMERIC(12, 4)` for precision. Displayed as USD.

### Database connection mode

`DATABASE_URL` uses Supabase's **Transaction pooler** (port `6543`) with `?prepare=false`. This is required for serverless deployment (Vercel) — Session pooler (port `5432`) holds connections per-client and saturates the 15-connection limit under any concurrent serverless load. Transaction pooler releases connections per-transaction and scales to thousands of brief queries. Long-running transactions (e.g., CSV imports of 50K+ rows) still hold one connection for their duration.

### Timezone

Campaign-related times are anchored to a single project-wide timezone: **America/New_York (ET)**. The constant lives in `lib/campaign-timezone.ts` as `CAMPAIGN_TIMEZONE`, with label `CAMPAIGN_TIMEZONE_LABEL = "ET"`. We do not (yet) support per-user or per-org timezones — adding that later would mean editing one file.

- Storage: all timestamps remain `TIMESTAMPTZ` in UTC. No naive timestamps.
- API: datetime fields cross the wire as ISO 8601 strings with offset (validators use `z.string().datetime({ offset: true })`).
- Display: always go through `formatCampaignDateTime(utc)`, which renders in ET and suffixes the label. Never use bare `date-fns` `format()` on a campaign timestamp — it'll render in the browser's local zone.
- Forms: `<input type="datetime-local">` exposes the value as an ET wall-clock string. Convert on submit with `campaignLocalInputToUtcIso(value)`, and on load with `utcToCampaignLocalInput(utc)`.

## 7. Cross-entity dependencies

Entity availability is tracked in `lib/feature-flags.ts` via the `ENTITY_AVAILABILITY` const and the `isEntityAvailable()` helper. This is the single source of truth for "is this entity built yet?". The sidebar nav and any FK pickers / filters in other entities derive their disabled state from it.

When building a new entity, the **last** step is flipping its flag to `true` — only after the schema, API, and UI are all working and tested. Flipping the flag simultaneously enables the nav item and activates any cross-entity references (e.g. the network picker in the Offers form starts fetching `/api/networks/list` the moment `networks: true` is set).

When an entity's form or filter references another entity that may not yet be built, gate the fetch on `isEntityAvailable(...)`. Do **not** make speculative requests and silently catch 404s — that's wasteful, noisy in the console, and easy to forget to remove later. Render the disabled state directly when the dependent entity is unavailable.

Before flipping a flag to `true`, sanity-check that no other entity's form or filter is making a fetch that would now succeed unexpectedly — the new entity's data should appear deliberately in dependent forms, not by accident.

## 8. API Conventions

All API routes live under `/app/api/`. Standard endpoints per entity:

- `GET  /api/[entity]/list` — paginated list with filters
- `POST /api/[entity]` — create
- `GET  /api/[entity]/[id]` — single record
- `PATCH /api/[entity]/[id]` — update
- `POST /api/[entity]/[id]/archive` — archive
- `POST /api/[entity]/[id]/restore` — restore

List endpoint query params: `page`, `pageSize`, `search`, `showArchived`, `sortBy`, `sortDir`.
List response: `{ data: T[], totalCount: number, page: number, pageSize: number }`.

All inputs validated with Zod. All outputs are typed. Errors return `{ error: string, code?: string }` with appropriate HTTP status.

**Parent/child route naming.** API routes for entities with nested children use `[parentEntityId]` for the dynamic segment (e.g. `/api/providers/[providerId]/phones/...`). Page routes use `[id]` (e.g. `/providers/[id]`). This avoids Next.js's prohibition on sibling dynamic segments with different names when nesting children under a dynamic parent.

## 9. UI Conventions

- Pages are server components by default; client components only when needed (forms, interactivity).
- Tailwind only. No CSS modules. No inline styles except dynamic ones.
- shadcn/ui components live in `/components/ui/`. Custom components in `/components/`.
- Tables use TanStack Table via a `DataTable` wrapper.
- Forms use react-hook-form + Zod resolvers.
- Toasts via sonner.
- Icons from lucide-react.
- Filters in list views persisted to localStorage via a `usePersistedFilters` hook, keyed by route.
- Form-containing dialogs prevent accidental dismissal via backdrop click or Escape. Use the shared `<FormDialog>` wrapper (`components/ui/form-dialog.tsx`) for any create/edit dialog, upload dialog, or any other dialog that takes user input beyond a single button press. Confirmation/`<AlertDialog>` dialogs retain default behavior. Read-only modals use the bare `<Dialog>` + `<DialogContent>` primitives.
- For multi-entity selection with potentially many options (>10), use `<MultiSelectPicker>` from `components/multi-select-picker.tsx`. It's a popover-based searchable checkbox list that scales to hundreds of items. Pill-toggle patterns are reserved for small fixed enums (≤5 options) like status filters.
- **Required-field indicator.** Required fields get a trailing red asterisk; optional fields get nothing (no "(optional)" suffix in labels, no "Optional." helper text). `<FormLabel required>...</FormLabel>` from `components/ui/form.tsx` adds the asterisk. For non-`FormField` callers using `<Label>` directly, inline `<span aria-hidden className="text-destructive ml-0.5">*</span>` after the label text. Required-ness mirrors the Zod schema: a field marked required must reject empty values server-side, not just visually.
- **File upload.** Use `<FileDropZone>` from `components/file-drop-zone.tsx` for any file picker (CSV imports, etc.). It wraps a visually-hidden `<input type="file">` in a clickable + drag-and-droppable surface with hover and selected-file states. Do not roll a new `<input type="file">` — extend `FileDropZone` if a new shape is needed.

## 10. File Organization

- `/app/` — Next.js App Router pages and API routes
- `/components/` — React components
- `/components/ui/` — shadcn/ui primitives
- `/db/` — Drizzle schema, migrations, query helpers
- `/lib/` — utility code, auth helpers, Supabase clients
- `/lib/permissions.ts` — `can()` helper and role definitions
- `/lib/supabase/` — Supabase client helpers (browser and server)
- `/types/` — shared TypeScript types

## 10b. Campaign audience snapshots

Drafts can be saved with zero required fields and no segments. The audience snapshot (rows in `campaign_audience_pool`) is computed **at activation time**, not at draft save. The `draft → active` status transition gates on name + brand + offer + ≥1 segment and runs the snapshot in the same transaction as the status update — so a stale draft can't slip through, and a snapshot that comes out empty rolls the whole thing back. Once a campaign reaches `active`, the audience is frozen: the `PATCH` endpoint rejects changes to `audience_segment_ids`, `audience_contact_group_ids`, `audience_filters`, `audience_cap`, and `exclude_in_use_contacts` with `details.reason = 'audience_locked_after_draft'`.

**Audience source composition (segment ∩ group).** Segments OR together (a contact in ANY selected segment), contact groups OR together (ANY selected group), and the two dimensions **INTERSECT** when both are populated — a contact must be in a selected segment **AND** a selected group. When only one dimension is filled, that side is used alone (the empty dimension is ignored, not "match nothing"). The shared `buildAudienceSourceClause` in [lib/audience-snapshot.ts](lib/audience-snapshot.ts) builds this for the snapshot and the draft stage count; `previewAudience` applies the same rule via a `membership_ok` flag so its breakdown can still report each side's pool (`from_segments` / `from_groups`) while `total_matching` / `overlap` are the intersected audience. (Earlier behavior UNION'd both dimensions; changed 2026-06-10.) **Perf:** when both dimensions are present, the group set is passed to `buildSegmentAudienceClause(…, restrictUniverse)` as the `is_not` universe so a near-universal negated rule doesn't scan all contacts before the intersection; status flags are hash-joined (`flagSetCtes`/`flagJoins`) not correlated-`EXISTS`. Don't regress these (it's the difference between ~9s and ~0.4s at scale). A side effect: `from_segments` then reflects the segment evaluated within the group (= the intersection), not the full segment side. **Snapshot path (`snapshotAudience`): the candidate set is materialized into a `ON COMMIT DROP` temp table and `ANALYZE`d before the flag joins.** This is load-bearing, not optional cleanup: the source is built from `UNION`/`INTERSECT`/`EXCEPT` set ops whose cardinality Postgres estimates at ~200 rows, so at scale (150K+ candidates) the planner picks nested-loop anti-joins for the opt-out/in-use exclusions and the activation hits `statement timeout (57014)`. The temp table gives real row stats → hash anti-joins (>180s → ~8.5s). Because temp tables need a transaction, `snapshotAudience` must be called with the activation `tx`, and the two routes that snapshot set `maxDuration = 60`.

**`exclude_in_use_contacts` on the campaign** (`campaigns.exclude_in_use_contacts`, default **true**): the campaign-level counterpart to the per-segment flag (§10e). When on, the snapshot AND the live preview drop any contact already in another `status='active'` campaign's `campaign_audience_pool` — across the WHOLE candidate audience (the segment∩group intersection, or the single populated dimension), which the per-segment flag can't reach for a group-only audience. The `audience_cap` then random-samples from the remaining unused pool; when fewer unused contacts exist than the cap, all of them are sent (`min(cap, unused)`). Both flags compose (idempotent — they EXCEPT the same active-pool set). The logic lives in `buildQualifierFromRelation` (snapshot) / `previewAudience` (and `computeStageAudienceCountForDraft` for draft stage previews) in [lib/audience-snapshot.ts](lib/audience-snapshot.ts); `previewAudience` still reports `in_use_in_other_campaigns` (the pre-exclusion in-use count) so the UI can show "N excluded".

## 10d. Spam scoring

- Scoring lives behind a pluggable provider abstraction in [lib/spam/](lib/spam/). Currently only `classifier` (a self-hosted SMS-classifier service running on Cloud Run, accessed over HTTP with an API key). Future providers (OpenAI, on-device, etc.) implement the same `SpamProvider` interface and register in the factory map.
- Append-only cache table `spam_scores` keyed on `(org_id, text_hash, provider)`. Re-scoring the same text against the same provider is a cache hit; `force=true` re-runs the provider and overwrites… well, doesn't actually overwrite (the cache is append-only — the unique constraint blocks duplicates and `force=true` is currently a no-op against an existing row; this gets revisited if we add scheduled re-scoring).
- Permission model: `spam.view` for any org member (cache reads), `spam.score` for operator+ (the action that potentially costs money). Matches the RLS policy.
- Two derived classifications from the single 0–100 score:
  - **Internal label** (`ham` / `suspicious` / `spam`) — thresholds 0–30 / 31–70 / 71–100. Used for analytics and the future "warn before activate" gating UX.
  - **Binary verdict** (`spam` / `not_spam`) — `score > 50` ⇒ spam. The user-facing yes/no.
- Both fields are returned in every API response. Verdict is derived at the service-layer level, not stored as a column.
- Normalization in `lib/spam/normalize.ts` (NFKC → lowercase → trim → collapse whitespace → SHA-256) MUST stay byte-for-byte identical to the Python classifier's `src/data/normalize.py`. Divergence silently doubles cost by making the cache miss across the boundary.
- **UI integration:** scoring is button-triggered inline via the shared `<SpamCheckStrip>` (`components/spam/spam-check-strip.tsx`). It sits below the textarea in `CreativeForm` and on every row of `BulkCreativeForm`. The stage form's creative picker shows a small color-dot + score number next to each option, populated from the list endpoint's cache join (read-only — listing does NOT trigger scoring). There is no standalone debug page; the inline strip + the `/api/spam/score` endpoint are the only entry points.

## 10e. Segment rules — UNION with manual membership (Model C)

A segment's effective audience is the **UNION** of its manual `segment_contacts` membership and the contacts matching the segment's active rules combined left-to-right via per-rule `combinator`:

```
final audience = (manual membership) ∪ (contacts matching the rule chain)

rule chain = rule[0]  comb[1]  rule[1]  comb[2]  rule[2]  …
             (left-associative; comb[0] is ignored)
```

A segment with **zero active rules** short-circuits to manual membership only. The SQL builder (`lib/segment-rules-eval.ts`) checks for active rules first and emits the bare `SELECT contact_id FROM segment_contacts …` clause when there are none — **preserve this property in any future refactor**. With rules active, the builder emits a `SELECT … FROM (manual UNION rule_matches) AS combined` shape. Manual members are always included regardless of whether they match the rules; rules only ever ADD contacts to the audience.

Each rule carries `combinator` (`and` / `or`, default `and`) that joins it to the running result of the prior rules. The first rule's combinator is read but ignored. **Left-associative**: `A OR B AND C` is `(A OR B) AND C`, not the standard SQL precedence — we wrap each step in parens so the planner doesn't reinterpret it. Reordering rules can change the effective audience because of this.

- **Schema:** [db/schema.ts](db/schema.ts) `segment_rules` table. Rules carry `rule_type`, `operator` (`is` / `is_not`), `value` (JSONB; shape per rule_type), `position` (display order; no UNIQUE constraint — reorder briefly produces duplicates and renumbers in a two-phase update), `is_active` boolean, `combinator` (`and` / `or`, default `and`). CHECK constraints enforce valid types, operators, and combinators at the DB level.
- **Eval uses SQL set arithmetic, not boolean predicates.** [lib/segment-rules-eval.ts](lib/segment-rules-eval.ts) combines rule-matched sets via `UNION` / `INTERSECT` / `EXCEPT` (combinator + operator → set op). This was a perf fix: `c.id IN (sub1) OR c.id IN (sub2)` against a >100K-row contacts table picks a terrible plan (seqscan); the set-arithmetic form lets each branch use its own index plan. Mapping: AND+is → INTERSECT, OR+is → UNION, AND+is_not → EXCEPT, OR+is_not → UNION with `(org_contacts EXCEPT inner)` (slow; rare).
- **`exclude_in_use_contacts` flag on the segment** (`segments.exclude_in_use_contacts`, default false): when on, the eval EXCEPTs `campaign_audience_pool.contact_id` for any campaign with `status='active'` from the final clause. Lets the operator reserve contacts to one in-flight campaign at a time. Paused/completed/archived campaigns DO NOT block — only `active` counts.
- **Validation source of truth:** [lib/validators/segment-rule-types.ts](lib/validators/segment-rule-types.ts) maps each `rule_type` → allowed operators + value shape. Both server (Zod schemas in [lib/validators/segment-rules.ts](lib/validators/segment-rules.ts)) and client (`RulesPanel`) read from this map — don't fork.
- **Operators are constrained per rule type.** Time-based rule types (`*_in_last_n_days`, `*_more_than_n_days_ago`) accept `is` only — the direction is encoded in the type name. The form hides the operator select for these.
- **FK ownership.** Brand/offer/segment/contact_group IDs in rule values are re-verified against the user's org before insert/update (`verifyValueOwnership` in [app/api/segments/[id]/rules/route.ts](app/api/segments/[id]/rules/route.ts)). RLS is defense-in-depth.
- **Counts:**
  - `segment_stats.total_count` (per-row trigger) is the manual-membership count — unaffected by rules.
  - `segment_stats.rule_filtered_count` (computed on demand by `/api/segments/[id]/refresh-stats`) is the FULL UNION'd audience count (manual ∪ rule_matches). Null when no active rules exist or when the eval timed out. The column name is historical — under UNION semantics it represents `audience_count`, not a narrowed subset.
- **Preview endpoint:** `POST /api/segments/[id]/rules/preview` returns `{ count, manual_count, rule_filtered_count, duration_ms, truncated }`. Hard 10s `SET LOCAL statement_timeout` inside a transaction; on timeout (Postgres error code 57014) returns `truncated: true, count: null` rather than 500.
- **Campaign audience snapshots respect UNION.** [lib/audience-snapshot.ts](lib/audience-snapshot.ts) calls `buildSegmentAudienceClause(segmentId, orgId)` per segment and UNIONs across segments. Existing frozen pools (`campaign_audience_pool` rows) are NOT recomputed when rules change after a campaign moves past draft; this is by design.
- **UI conventions:**
  - The Rules tab lives on `/segments/[id]` next to Contacts/Upload/Remove.
  - Auto-save per-rule: rule_type and operator changes commit immediately; numeric/FK values commit on blur. No save button per row.
  - Reorder via up/down arrow buttons (no drag-and-drop dep). If we add `@dnd-kit` later, the up/down arrows can stay as a fallback for keyboard.
  - The 600ms debounced preview fires whenever the in-memory rule list changes. Network-tab discipline: do not re-fire the preview on every keystroke; the rules list only updates after PATCH returns.
  - Segments with `active_rules_count > 0` show a small `Has rules` badge in the campaign-form audience picker. Tooltip explains the audience is the rule-filtered + manual UNION.

## 10f. Contact groups (formerly Segment Groups)

Categorical tags applied directly to contacts via the `contact_contact_groups` junction. A contact may have multiple groups. Used as a filter dimension in segment rules (`is_in_contact_group`) and on the `/contacts` page (groups column + multi-select group filter + bulk "Apply to groups" action).

- Renamed from `segment_groups` in migration 0031. The old "folder for segments" concept is gone — segments don't carry group membership anymore.
- Detail page at `/contact-groups/[id]` with three tabs: Contacts (list/search/sort/bulk-remove), Add contacts (via `PhoneUploadForm`), Remove contacts (via `PhoneUploadForm`).
- All four phone-upload entry points (contacts, opt-outs, opt-ins, clickers) expose a `MultiSelectPicker` for contact groups; selected IDs travel as `assign_to_group_ids` on the POST. The shared [lib/upload/audience-upload.ts](lib/upload/audience-upload.ts) helper applies them after contacts are upserted.
- Bulk-apply endpoint: `POST /api/contacts/bulk-apply-groups` with `{ contact_ids[], group_ids[] }`, idempotent via `ON CONFLICT DO NOTHING`. Returns `{ applied: number }`.

## 10g. Tracking IDs (campaigns + stages)

Auto-generated, **immutable**, structured identifiers separate from the internal `id` (UUID-like primary key) and the user-editable `human_id`. Used as URL parameters in external analytics tracking links.

- **Campaign format:** `<brand_id>_<offer_id>_<MMDDYY>_<seq>` (e.g. `5_14296_051526_1`). Date is the campaign's `created_at` rendered in ET (`CAMPAIGN_TIMEZONE`).
- **Stage format:** `<campaign_tracking_id>_s<stage_number>_c<creative_id>` (e.g. `5_14296_051526_1_s2_c42`).
- **Counter table:** `campaign_tracking_counters (org_id, brand_id, offer_id, date_et)` PK. Allocation is a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING (next_seq - 1)` (see [lib/tracking-id.ts](lib/tracking-id.ts)) — no SELECT-then-INSERT races.
- **When generated:**
  - **Campaign:** in the POST transaction if `brand_id` and `offer_id` are both set. In PATCH if the prior value was NULL and the patch results in both being set. Uses the campaign's ORIGINAL `created_at` for the date segment — drafts that get brand+offer added later still date back to when they were first saved.
  - **Stage:** in the POST (and duplicate) transaction if the parent campaign has a `tracking_id` AND the stage has a `creative_id`. If the parent is NULL but brand+offer exist (e.g. pre-Phase-9 backfill case), the stage POST generates the campaign's `tracking_id` first in the same transaction.
- **Immutability:** PATCH endpoints reject `tracking_id` in the payload with `code: "tracking_id_immutable"` (mapped from a Zod issue with `params.code = "TRACKING_ID_IMMUTABLE"` in the validators). Mutating `brand_id` / `offer_id` / `creative_id` / `stage_number` on an entity with a non-NULL `tracking_id` does NOT regenerate it — historical references are preserved by design.
- **Uniqueness:** partial unique indexes `campaigns_tracking_id_org_uniq` and `campaign_stages_tracking_id_org_uniq` (both `WHERE tracking_id IS NOT NULL`) so multiple NULLs coexist while generated IDs are globally-unique per org.
- **Sortability gotcha:** the MMDDYY date segment is not string-sortable across year boundaries — `010127` < `120126` lexicographically. Always `ORDER BY created_at` for chronology, never by `tracking_id`.
- **UI:** the `<CopyableId>` component ([components/ui/copyable-id.tsx](components/ui/copyable-id.tsx)) is the canonical surface — read-only input + copy button + sonner toast. Reuse it for any system-generated identifier surfaced to the user. The campaigns list table shows the column behind a per-browser `Show tracking ID` toggle to keep the default view narrow.
- **Backfill:** [scripts/backfill-tracking-ids.ts](scripts/backfill-tracking-ids.ts) is idempotent (`tracking_id IS NULL` gate). Processes campaigns first ordered by `(org_id, created_at, id)`, then stages ordered by `(campaign_id, stage_number)`. Run once after migration 0038 applies in any environment with existing data.

## 10c. Creatives

- Many-to-many with offers via the `creative_offers` junction table. A creative can be tied to zero, one, or many offers.
- `applies_to_all_offers=true` makes a creative valid for any offer in the org. Junction rows are still allowed when this flag is on (used as a fallback list); toggling the flag does NOT auto-clear junction rows.
- No provider or brand association on the creative itself — those concepts live at the stage level (provider on the stage, brand on the parent campaign).
- No status state machine. Creatives are `active` or `archived` only.
- `quality` (`high | average | poor | unknown`), `sequence_placement` (`1st | 2nd | 3rd | any | unknown`), and `funnel_stage` (`start | clicked | checkout | ignored | unknown`, migration 0076) are user-managed metadata used for filtering/organizing. Defaults are `unknown`. Not enforced anywhere else in the system.
- The stage form's creative picker queries `/api/creatives/list?offer_id=<X>&status=active` — the list endpoint's `offer_id` filter returns creatives that either have a junction row to X OR have `applies_to_all_offers=true`.
- Bulk-create accepts up to 50 rows per request; shared offer/quality/sequence apply to every row in the batch. The whole batch runs in one transaction.

## 11. Working Style with Claude Code

- Make small, reviewable changes. Prefer many small commits over one large one.
- When asked to build a new entity (e.g., "build Offers"), look at the existing Brands implementation and follow its patterns exactly. Do not invent new patterns without asking.
- When a request is ambiguous, ASK rather than guess.
- Never modify files outside `/c/AFF/camman` (i.e., `C:\AFF\camman`).
- Never commit `.env.local` or any file containing secrets.
- Never log secrets. Never include secrets in error messages.
- Before any destructive operation (DROP TABLE, hard DELETE, force-push), ask for explicit confirmation.
- If migration-related issues arise (journal/file mismatch, suspected drift, after recovering from a partial apply), run `npx tsx scripts/verify-migration-integrity.ts` to compare DB-recorded hashes against actual file content and verify the snapshot chain. Read-only diagnostic, safe to run anytime.

## 12. What This Project Is NOT (yet)

To keep scope tight, the following are explicitly OUT of scope for v1. Do not build them, do not stub them, do not "prepare for" them in ways that complicate v1 code:

- Inbound SMS webhook handling
- Two-way conversations / message threads
- MMS sending
- Per-recipient delivery status tracking / DLR polling from a provider (the send pipeline stores TextHub's message id so DLR is *possible* later, but does not poll it)
- Background job queues (Inngest, etc.) — scheduled/deferred work uses Vercel Cron instead
- Phone-number-to-campaign assignment ("Load Phones" workflow from the original spec)
- Per-contact send history (`send_history` / `has_been_sent_*` rule types). Deferred until campaign-pool snapshotting captures per-recipient deltas. The segment-rules system is structured to absorb a future `has_been_sent_to_by_campaign` rule type without schema churn — add the type to `RULE_TYPES` and emit the corresponding sub-SELECT in [lib/segment-rules-eval.ts](lib/segment-rules-eval.ts).

When the user wants these, they will be added in a separate phase.

**Now IN scope (built in later phases, formerly listed here as out):**
- Short link generation + click tracking + bot/prefetch scoring — the link shortener (`lib/links/`, `app/r/[code]`, migrations 0048–0049).
- **Outbound** SMS sending via the TextHub provider API (`lib/sends/`, migration 0050): single-recipient transactional send that mints a tracked link per recipient. Outbound only — inbound/two-way/DLR/MMS remain out (above).

## 13. What This Project IS (for v1)

- Multi-tenant CRM for contacts, segments, opt-outs, opt-ins, clickers
- Registry of brands, offers, networks, providers, provider phones, creatives, routing types, traffic types, UTM tags
- Campaign composition (form-based, save as draft, save/load templates)
- Audience preview (count + breakdown by status) before "send"
- CSV export of campaign audience for manual upload to external provider
- CSV import of campaign results from provider, with per-provider import mapping templates
- Automatic propagation of imported opt-outs and clickers to suppression/engagement tables
- Dashboard with campaign activity, spend, and engagement analytics
- User management (invite, remove members, role assignment)

## 14. Deployment

- **Hosting:** production runs on Vercel, linked to the GitHub repo. Pushes to `main` auto-deploy.
- **Env vars:** set in the Vercel dashboard (Settings → Environment Variables), NOT via the CLI and NOT committed. `.env.example` at the project root lists every variable the app reads.
- **Database:** the deployed app talks to the SAME Supabase project as local dev. There isn't a separate prod Postgres yet — when one is added, `DATABASE_URL` is the only thing that changes per environment.
- **Migrations are NOT auto-applied on deploy.** After merging a schema change, run `npm run db:migrate` locally against the production `DATABASE_URL` BEFORE pushing the code that depends on the new schema. (Same connection string the deployed app uses — Vercel build doesn't touch the database.) After applying, run `npx tsx scripts/verify-migration-integrity.ts` to confirm the chain is clean.
- **Supabase Auth URLs:** Authentication → URL Configuration in the Supabase dashboard must include the production origin under both Site URL and Redirect URLs (`/auth/callback`, `/auth/complete`, `/auth/reset-password`). Keep the localhost entries for development.
- **NEXT_PUBLIC_SITE_URL** must match the deployed origin in production so absolute auth-callback URLs point at the right host. After the first deploy, update this in Vercel and trigger a redeploy.

## Documentation maintenance (MANDATORY)

The `docs/` folder is the source of truth for how CamMan works and must stay
in sync with the code at all times.

On EVERY change that affects behavior, data, or interfaces, before considering
the task complete you MUST update the relevant documentation in the same change:

1. Schema or migration change  -> update docs/03-data-model.md AND the Mermaid ERD.
2. New/changed feature or module -> update or add the matching file in docs/04-features/.
3. New/changed user journey, send path, or webhook -> update the sequence diagram(s) in docs/05-flows.md.
4. New external dependency, env var, or integration -> update docs/06-integrations.md.
5. New business rule, ID format, convention, or gotcha -> update docs/07-conventions.md.
6. New setup/build/run step -> update docs/08-local-setup.md.
7. ALWAYS append a one-line entry to docs/CHANGELOG.md: `YYYY-MM-DD — <what changed> — <docs updated>`.
8. Update the "last updated" date on every doc you touch.

Rules:
- Documentation is part of "done". A change is incomplete if the docs don't reflect it.
- Keep diagrams accurate — if a code change makes a diagram wrong, fix the diagram, don't leave it.
- Reference real file paths so docs stay verifiable.
- If you are unsure whether a change is doc-affecting, assume it is and check the checklist above.
- Never write a value/secret into docs; document env var names and purpose only.