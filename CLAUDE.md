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

Drafts can be saved with zero required fields and no segments. The audience snapshot (rows in `campaign_audience_pool`) is computed **at activation time**, not at draft save. The `draft → active` status transition gates on name + brand + offer + ≥1 segment and runs the snapshot in the same transaction as the status update — so a stale draft can't slip through, and a snapshot that comes out empty rolls the whole thing back. Once a campaign reaches `active`, the audience is frozen: the `PATCH` endpoint rejects changes to `audience_segment_ids` and `audience_filters` with `details.reason = 'audience_locked_after_draft'`.

## 10c. Creatives

- Many-to-many with offers via the `creative_offers` junction table. A creative can be tied to zero, one, or many offers.
- `applies_to_all_offers=true` makes a creative valid for any offer in the org. Junction rows are still allowed when this flag is on (used as a fallback list); toggling the flag does NOT auto-clear junction rows.
- No provider or brand association on the creative itself — those concepts live at the stage level (provider on the stage, brand on the parent campaign).
- No status state machine. Creatives are `active` or `archived` only.
- `quality` (`high | average | poor | unknown`) and `sequence_placement` (`1st | 2nd | 3rd | any | unknown`) are user-managed metadata used for filtering/organizing. Defaults are `unknown`. Not enforced anywhere else in the system.
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

- Real-time SMS sending via provider APIs
- Inbound SMS webhook handling
- Two-way conversations / message threads
- Background job queues (Inngest, etc.)
- Provider API integrations of any kind
- Per-recipient delivery status tracking from a provider
- Phone-number-to-campaign assignment ("Load Phones" workflow from the original spec)
- Short link generation and click tracking infrastructure (we record clicker data via CSV import only)

When the user wants these, they will be added in a separate phase.

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
