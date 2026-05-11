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

## 9. UI Conventions

- Pages are server components by default; client components only when needed (forms, interactivity).
- Tailwind only. No CSS modules. No inline styles except dynamic ones.
- shadcn/ui components live in `/components/ui/`. Custom components in `/components/`.
- Tables use TanStack Table via a `DataTable` wrapper.
- Forms use react-hook-form + Zod resolvers.
- Toasts via sonner.
- Icons from lucide-react.
- Filters in list views persisted to localStorage via a `usePersistedFilters` hook, keyed by route.

## 10. File Organization

- `/app/` — Next.js App Router pages and API routes
- `/components/` — React components
- `/components/ui/` — shadcn/ui primitives
- `/db/` — Drizzle schema, migrations, query helpers
- `/lib/` — utility code, auth helpers, Supabase clients
- `/lib/permissions.ts` — `can()` helper and role definitions
- `/lib/supabase/` — Supabase client helpers (browser and server)
- `/types/` — shared TypeScript types

## 11. Working Style with Claude Code

- Make small, reviewable changes. Prefer many small commits over one large one.
- When asked to build a new entity (e.g., "build Offers"), look at the existing Brands implementation and follow its patterns exactly. Do not invent new patterns without asking.
- When a request is ambiguous, ASK rather than guess.
- Never modify files outside `/c/AFF/camman` (i.e., `C:\AFF\camman`).
- Never commit `.env.local` or any file containing secrets.
- Never log secrets. Never include secrets in error messages.
- Before any destructive operation (DROP TABLE, hard DELETE, force-push), ask for explicit confirmation.

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
