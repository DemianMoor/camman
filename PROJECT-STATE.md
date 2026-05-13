# Campaign Manager — Project State

A snapshot of what this repository is, what it does, and how to continue building it. Read this first if you're a Claude instance joining the project, then read `CLAUDE.md` for the project conventions in detail. This document is kept short on purpose — it's an orientation, not a manual.

## 1. Project Overview

Campaign Manager is an internal CRM-style tool for managing SMS affiliate marketing campaigns. It is built as a single-developer project by a non-developer working with Claude Code; the user gives detailed step-prompts that Claude executes.

The scope decision for v1 is important to internalize: **this tool is a system of record, not a sending tool.** It does not send SMS, does not receive SMS, and does not integrate with any provider's API. The actual sending happens manually in external tools (SendNexus, TextHub, others). Campaigns are composed and "sent" by exporting the audience as CSV. Results come back as CSV imports after the send completes.

Target scale at maturity is millions of contacts and 100+ campaigns per day. Schema and index decisions should account for that from day one, but don't over-engineer for it.

## 2. Tech Stack

Next.js **16.2.6** with the App Router, on Turbopack (the default in 16). TypeScript everywhere. Tailwind v4 (CSS-first config, no `tailwind.config.ts`). UI primitives from **shadcn/ui v4.7** (the modern Radix-Nova style; `baseColor: "neutral"`). Forms use **react-hook-form ^7.75** + **@hookform/resolvers** with **Zod ^4.4** schemas. Toasts via **sonner ^2**. Icons from **lucide-react ^1.14**. Tables built on **@tanstack/react-table ^8.21** via a single `DataTable` wrapper. Phone parsing via **libphonenumber-js ^1.x** (single source of truth — don't write custom phone validation).

Database is Supabase (Postgres + Auth) accessed two ways: **@supabase/supabase-js + @supabase/ssr ^0.10** for auth and any RLS-respecting calls, and **drizzle-orm ^0.45 + postgres ^3.4** for all server-side queries inside route handlers (which bypass RLS because the DB connection isn't user-scoped — we enforce `org_id` at the application layer).

Version-specific gotchas in Next.js 16: `params` in dynamic routes is async (must be awaited); `cookies()` and `headers()` from `next/headers` are async; the legacy `middleware.ts` file convention has been deprecated in favor of `proxy.ts` (the exported function is `proxy`, not `middleware`). Default to Next.js 16 patterns; check `node_modules/next/dist/docs/` if uncertain rather than assuming pre-16 behavior.

## 3. Repository Layout

```
app/
  (auth)/            Login, signup, forgot-password (route group)
  (protected)/       Layout + protected pages (dashboard, brands, offers,
                     affiliate-networks, providers, providers/[id], …)
  auth/              callback, reset-password, complete
  api/               JSON route handlers (brands/, offers/, networks/,
                     providers/[providerId]/phones/[phoneId]/..., me/)
components/
  ui/                shadcn primitives — don't edit unless re-adding via CLI
  protected/         Sidebar, nav, AuthContext (for protected layout)
  brands/            BrandForm
  offers/            OfferForm (sections, useFieldArray for sales_pages,
                     conditional payout fields)
  networks/          NetworkForm
  providers/         ProviderForm, PhoneForm
  data-table.tsx     Generic TanStack Table wrapper
  color-picker.tsx   Reused across entity forms
  status-dropdown.tsx  Reusable for status state machines
db/
  schema.ts          All 8 tables
  client.ts          Drizzle + postgres-js (globalThis-cached pool, max: 5)
  migrations/        Auto-generated SQL + hand-authored RLS migrations
lib/
  api/               helpers, error-codes, toast-error
  auth/              Server-side getUser/requireUser/requireOrgMembership
  hooks/             useApiCall, usePersistedFilters
  supabase/          client/server/admin Supabase factories
  validators/        Zod schemas per entity (+ shared _helpers.ts: nullIfEmpty)
  permissions.ts     Role/Permission types, can(), assertPermission()
  phone-validation.ts  validatePhone() + formatPhoneInternational()
  feature-flags.ts   ENTITY_AVAILABILITY + isEntityAvailable() — single source
                     of truth for "is this entity built yet?"
scripts/             Diagnostic + E2E test scripts (per-entity API tests,
                     schema verifiers, RLS isolation E2E, migration integrity)
proxy.ts             Route protection + Supabase session refresh (Next.js 16)
drizzle.config.ts    Drizzle Kit config (schemaFilter: ["public"])
```

## 4. Database Schema (current state)

Eight tables in `public`, all with `org_id UUID` and all with RLS enabled. Every query filters by `org_id` explicitly (RLS is defense in depth, not the primary defense).

**Infrastructure / tenancy:**
- **`organizations`** — One row per tenant.
- **`org_members`** — Links `auth.users.id` → org with a role (`owner|admin|manager|operator|viewer`).
- **`invites`** — Pending invitations (not yet wired to UI).

**Registry entities (complete vertical slices):**
- **`brands`** — Campaign group identifier with name, color, optional short-link base.
- **`affiliate_networks`** — Platforms where you source offers. List view shows `offer_count` (active offers per network).
- **`offers`** — Affiliate products. Has FK `network_id → affiliate_networks` (ON DELETE SET NULL), conditional payout fields (`payout_model: 'cpa' | 'revshare'` with one of `payout_cpa NUMERIC(12,4)` or `payout_revshare NUMERIC(5,2)`), and `sales_pages JSONB` (array of `{ label, url }`, up to 10).
- **`sms_providers`** — SMS sending platforms. Includes `short_link_supported: boolean` and `short_link_example: text`.
- **`provider_phones`** — Child of providers. FK `provider_id → sms_providers` (CASCADE), FK `brand_id → brands` (SET NULL). Phone columns: `phone_number` (E.164), `country_code` (ISO alpha-2), `dial_code`, `local_number`. UNIQUE(org_id, phone_number). Status state machine with **4** states: `active | suspended | blocked | archived`.

A `current_org_id()` SECURITY DEFINER SQL function returns the calling user's org via a SECURITY DEFINER lookup on `org_members`. RLS policies on all 8 tables use it for tenant isolation. The `handle_new_user()` trigger on `auth.users INSERT` auto-creates an organization and inserts the new user as `owner`.

Soft-delete on every domain table: `status` column + `archived_at TIMESTAMPTZ`. No DELETE policies in RLS — archive only. Hard-deletes are explicit and rare (mainly in test cleanup).

## 5. Authentication & Authorization

Auth is Supabase Auth, **email + password only**. Email verification required. Password reset via Supabase's built-in flow. No OAuth, no magic links — explicitly out of scope for v1.

Five roles in ascending privilege: **viewer < operator < manager < admin < owner**. Permissions are a string union in `lib/permissions.ts`, assigned cumulatively (manager inherits operator, etc.). Currently defined: `brands.*`, `offers.*`, `networks.*`, `providers.*`, `provider_phones.*` (each with view/create/update/archive/restore), plus `registry.*`, `users.manage`, `org.delete`. New permissions go in the union and the relevant role's Set.

The `can(role, permission)` helper is the single source of truth. Called server-side after `requireApiMembership()` and client-side via `useAuth()` (which fetches `/api/me` on mount and exposes `can()` to the protected tree). Both checks must pass — server-side is authoritative; client-side just hides controls.

## 6. Established Conventions

These are sticky. Don't deviate without asking.

**Multi-tenancy.** Every domain table has `org_id UUID`. Every query filters by it explicitly. RLS catches mistakes but isn't the primary defense.

**API error contract.** Every non-2xx returns `{ error: string, code?: string, details?: unknown }`. Codes from `lib/api/error-codes.ts` (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `DUPLICATE`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`). Prefer entity-agnostic codes with `details` carrying specifics (`duplicate` + `details: { field: 'brand_id' }`), never `duplicate_brand_id`.

**API list shape.** `GET /api/{entity}/list` accepts `page`, `pageSize`, `search`, `showArchived`, `sortBy`, `sortDir` via `parseListParams` and returns `{ data: T[], totalCount, page, pageSize }`.

**Auth in route handlers.** `requireApiMembership()` returns a discriminated union. Callers do `if ('error' in auth) return auth.error;` then destructure `{ user, orgId, role }`. No try/catch wrappers.

**DB access in route handlers.** Drizzle (`db` from `db/client.ts`), not Supabase JS. The Drizzle connection uses the privileged DB role and bypasses RLS — explicit `org_id` filtering is therefore non-negotiable.

**Client-side API calls.** `useApiCall<T>()` from `lib/hooks/use-api-call.ts` returns `{ isLoading, execute }`. **Depend on `.execute` in effect deps, never the wrapping object** (see Gotchas). On failures, call `toastApiError(result, fallback?)` from `lib/api/toast-error.ts` for consistent user-facing copy mapped from the error code.

**Forms.** shadcn `<Form>` + react-hook-form + `zodResolver`. Inputs wrapped in `<FormField>`/`<FormItem>`/`<FormControl>`/`<FormMessage>`. Entity forms are pure components — they accept `onSubmit` from the parent and don't make API calls themselves.

**Soft-delete.** `status` column + `archived_at TIMESTAMPTZ`. Archive via dedicated endpoint, not PATCH.

**Tables.** `DataTable` in `components/data-table.tsx` is canonical. Manual pagination + manual sorting; the parent owns the state. `usePersistedFilters('{route}.filters', defaults)` for localStorage-backed filter state.

**UI for CRUD — when to use a dialog vs a detail page.**
- **Dialog**: simple flat entities (Brands, Offers, Networks). Create/edit happens in a shadcn `<Dialog>`. Archive/restore via `<AlertDialog>`. Most entities use this.
- **Detail page**: entities that own children (Providers → Phones). The list row click navigates to `/{entity}/[id]`. The detail page shows top-level entity fields in a Card plus a nested management section for the children. Established in `/providers/[id]`. Use this pattern for any entity with a 1:N relationship to manage in-place.

**StatusDropdown** (`components/status-dropdown.tsx`) — reusable component for status state machines beyond the simple active/archived binary. Used by `provider_phones` for the 4-state machine (active/suspended/blocked dropdown + separate archive action). Pass `options: { value, label, color }[]` and an `onChange` handler. Future use: Campaigns will need it.

**Feature flags** (`lib/feature-flags.ts`) — `ENTITY_AVAILABILITY` const + `isEntityAvailable(key)` helper. Single source of truth for "is this entity built yet?". Drives both the sidebar nav (disabled state) and any FK pickers/filters in other entities. **When building a new entity, flipping its flag to `true` is the LAST step**, after schema + API + UI all work. When an entity's form references another entity that may not exist yet, gate the fetch on `isEntityAvailable(...)` — do not make speculative requests and silently catch 404s.

**Route naming for parent/child entities.** Next.js prohibits sibling dynamic route segments with different names. For nested API trees, use `[parentEntityId]` for the parent's dynamic segment so children can nest under it: `/api/providers/[providerId]/phones/[phoneId]/...`. Page routes use `[id]` (e.g. `/providers/[id]`) — they live in a different subtree so naming doesn't conflict.

**Cross-entity FK pickers.** When a form has a Select that loads options from another entity's `/api/{other}/list` endpoint, the pattern is: check `isEntityAvailable('other')` first; if false, render the Select disabled with an explanatory placeholder; if true, fetch and populate. This way flipping the flag activates the picker without any other code change.

## 7. What's Built

- **Auth flow**: signup, login, password reset, email verification handler, `/auth/complete` defensive page. `proxy.ts` for route protection.
- **Protected layout**: sidebar with all planned entities (only the implemented ones enabled — see feature-flags), mobile drawer, user block.
- **Dashboard placeholder** showing org name + role + a "Coming up" card.
- **AuthContext**: `/api/me` + `useAuth()` exposing `auth`, `isLoading`, `error`, `refetch`, `can(permission)`.
- **Database foundation**: 8 tables, all with RLS. 6 migrations: 0000 schema, 0001 security layer (functions + policies + trigger), 0002 offers/networks tables, 0003 offers/networks RLS, 0004 providers/phones tables, 0005 providers/phones RLS.
- **Shared API/UI infrastructure**: error contract, `apiError` helper, `useApiCall`, `toastApiError`, `DataTable`, `ColorPicker`, `StatusDropdown`, `usePersistedFilters`. Reused by every entity.
- **Entities — complete CRUD vertical slices** (schema + RLS + API + UI + tests + feature flag enabled):
  - **Brands** — flat entity, dialog-based create/edit.
  - **Offers** — conditional payout fields (CPA $ or RevShare %), dynamic `sales_pages` array via `useFieldArray`, FK to networks via Select.
  - **Affiliate Networks** — flat entity. List shows `offer_count` aggregate (left-joined count of active offers).
  - **SMS Providers + Provider Phones** — parent/child. Providers list → detail page (`/providers/[id]`). Detail page manages child phones in-place with multi-status filter, StatusDropdown per row, separate Add/Edit dialogs, Archive/Restore via AlertDialog. Server-side phone validation via libphonenumber-js (raw input → E.164 + country_code + dial_code + local_number). 4-state status machine with `/status` endpoint enforcing the no-status-change-while-archived rule.
- **Diagnostic/test scripts** in `scripts/`: connection test, foundation schema verify, security-layer verify, offers+networks schema verify, providers+phones schema verify, **migration integrity** verify (compares DB hashes against file content + snapshot chain), signup-trigger E2E, RLS-isolation E2E, per-entity API E2E tests.
- **Step 8a — Spam scoring foundation** (this step): append-only `spam_scores` cache table, pluggable provider abstraction (`lib/spam/`), `SelfHostedClassifierProvider` calling Cloud Run, `POST /api/spam/score` + `GET /api/spam/health`, `/spam-debug` page. No Creatives/Campaigns wiring yet (8b/8c). Normalization in `lib/spam/normalize.ts` must stay in sync with the classifier's Python `src/data/normalize.py`.

## 8. What's Next

Roadmap of remaining entity builds (in order):

- **5.4** Routing Types + Traffic Types (likely bundled — both are small lookup-style entities)
- **5.5** UTM Tags
- **5.6** Segment Groups
- **6** Audience layer: Contacts, Segments, Opt-Outs, Opt-Ins, Clickers — with CSV upload/import (the first feature beyond basic CRUD)
- **7** Creatives and Campaigns — the hardest part; CSV export of audience for sending, CSV import of results back

Deferred indefinitely (explicitly out of scope for v1): real SMS sending, provider API integrations, inbound webhooks, two-way conversations, per-recipient delivery status, phone-number-to-campaign assignment, short-link generation, click tracking infrastructure, analytics integrations.

## 9. Known Limitations / Deferred Decisions

No background job system yet (will be needed if/when real sending is added). No `messages` table (single-message log; not needed until two-way conversations). Filter persistence is per-browser via localStorage and doesn't sync across devices — acceptable for an internal tool. The `invites` table exists but is not yet wired to UI (user management is a later step). Build emits LF→CRLF warnings on Windows; cosmetic, ignored.

## 10. Pattern for Building a New Entity

This recipe is now battle-tested across four entities (Brands, Offers, Networks, Providers). A simple entity takes 1–3 hours of Claude Code work plus user testing.

1. Add the table to `db/schema.ts`. Follow conventions: `id`, `org_id` UUID FK CASCADE, `status` text + CHECK, `archived_at` timestamptz, `created_at` timestamptz default now(). Export `$inferSelect`/`$inferInsert` types.
2. Run `npm run db:generate` to produce a Drizzle migration. Review the SQL.
3. Author a separate RLS migration via `drizzle-kit generate --custom --name=<name>_rls`. Add `ENABLE ROW LEVEL SECURITY` + SELECT/INSERT/UPDATE policies. No DELETE policy — archive via status.
4. Run `npm run db:migrate`. Verify via a small scripts/ verifier sibling to the existing ones.
5. Add permissions to `lib/permissions.ts`. Add a Zod validator file under `lib/validators/`. Optional empty-string strings should use `z.union([z.string()..., z.literal("")]).optional()` (not `z.preprocess`) and normalize via `nullIfEmpty` in the API.
6. Build API routes under `app/api/{entity}/`. For flat entities use `[id]`; for entities with child resources, use `[parentEntityId]` so nesting works. Mirror Brands' shape: list, create, get+patch, archive, restore. Each route uses `requireApiMembership`, `can`, Zod, Drizzle, `org_id` filter, standard codes from `lib/api/error-codes.ts`.
7. Write an E2E test script in `scripts/test-{entity}-api.ts` (clone an existing one and adapt assertions). Run against `localhost:3001` with `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` temporarily in `.env.local`.
8. Build the page under `app/(protected)/{entity}/page.tsx`. Reuse `DataTable`, `useApiCall`, `toastApiError`, `usePersistedFilters`. Decide dialog vs detail page based on whether the entity has children. Create an `{Entity}Form` as a pure component.
9. If other entities reference this one via FK picker, those forms should already have an `isEntityAvailable('thisEntity')` gate from the start. Sanity-check before flipping the flag that no other code is preemptively fetching this entity's endpoint.
10. **Flip the flag** in `lib/feature-flags.ts` last. That single change activates the nav item AND any cross-entity pickers.
11. Test in the browser with DevTools Network tab open. Watch for absence of loops.

## 11. Gotchas & Lessons Learned

Real bugs hit. Read them.

**Supabase direct DB doesn't resolve from non-IPv6 networks** on the free tier (`db.<ref>.supabase.co` is IPv6-only without the IPv4 add-on). Use the Supavisor **session pooler** (`aws-X-region.pooler.supabase.com:5432`). Username must include the project ref: `postgres.<project-ref>`. `prepare: false` is required and already set in `db/client.ts`.

**`DATABASE_URL` password must be URL-safe.** A `#` in the password gets parsed as a URL fragment by `postgres-js`, truncating the connection string. URL-encode special chars (`#` → `%23`, `,` → `%2C`) or pick an alphanumeric password. The `@` between password and host must NOT be encoded — that's a structural delimiter.

**`db/client.ts` uses a `globalThis`-cached pool with `max: 5`.** Next.js HMR re-evaluates this module on every code change in dev. Without the cache, each reload opens a fresh pool and the session pooler's ~15-client cap is exhausted, surfacing as `EMAXCONNSESSION`. Don't strip the caching.

**Next.js 16 renamed `middleware.ts` to `proxy.ts`.** Exported function is `proxy`, not `middleware`. Legacy name issues a deprecation warning.

**Next.js prohibits sibling dynamic route segments with different names.** Can't have `/api/providers/[id]` AND `/api/providers/[providerId]/...` at the same path level. Convention adopted: use `[parentEntityId]` for the entire nested API tree (`[providerId]` etc.), and `[id]` for page routes (which live in a different subtree).

**`useApiCall` consumers must depend on `.execute`, not the wrapping object.** The hook returns `{ isLoading, execute }`; `execute` has stable identity (it's `useCallback([])`), but the wrapping object literal is fresh each render. Including the whole object in a `useEffect` dep array creates an infinite fetch loop: effect runs → `execute` flips `isLoading` → re-render → new wrapping object → deps change → effect re-runs. Hit during Step 4.8 (88+ requests in 20s).

**Zod `z.preprocess` breaks react-hook-form type inference.** `z.preprocess(transform, schema)` widens the input type to `unknown`, which incompatibly narrows in zodResolver. For optional form fields, use `z.union([z.string()..., z.literal("")]).optional()` instead, and normalize empty strings to `null` at the API boundary via `nullIfEmpty()` from `lib/validators/_helpers.ts`. For schemas with `.default([])` or `.transform()` (e.g. Offers' `sales_pages`), export both `z.infer<>` (output, used by API) and `z.input<>` (form type, used by RHF) — they differ.

**libphonenumber-js is the standard for all phone parsing.** Don't write custom phone validation regex/parsing. The wrapper lives in `lib/phone-validation.ts` (`validatePhone()`, `formatPhoneInternational()`). Server-side: parse raw input on create, store E.164 + country_code + dial_code + local_number. Client-side: format E.164 → international for display. Future bulk-upload flows (contacts, opt-outs) will reuse the same module.

**Drizzle migration journal can get out of sync if a Write is blocked mid-migration.** Specific scenario hit in 5.3: I scaffolded a custom RLS migration via `drizzle-kit generate --custom`, the Write tool's safety check ("Read first") blocked my SQL write, but I didn't notice before running `db:migrate` — which then dutifully applied the empty placeholder file and recorded it. Recovery: delete the bad row from `drizzle.__drizzle_migrations`, write the correct SQL into the migration file (now its hash differs from the deleted record), and re-run `db:migrate`. Use `scripts/verify-migration-integrity.ts` to diagnose — it hashes each SQL file with SHA-256 and compares against the recorded hashes, plus verifies the snapshot `prevId` chain. Safe to run anytime.

**Always test in the browser with DevTools Network tab open after any UI refactor.** Infinite loops can hide behind 200 OK responses — every request succeeds, but you never see the load complete. The build won't catch this; only watching the network will.

**Server actions can't bypass the redirect-throws-in-try-catch rule.** `redirect()` from `next/navigation` throws a special error that Next.js catches. Wrapping in try/catch silently swallows the redirect. For login/signup the server action returns `{ ok: true, redirectTo }` and the client does `router.push()`.

**Tests can't easily auth to Next.js API routes through cookies** because `@supabase/ssr` uses chunked, structured cookies. The pattern in every `scripts/test-*-api.ts` works: create a `@supabase/ssr` server client with an in-memory `Map` as the cookie jar, sign in (cookies get written to the jar), then serialize the jar into a `Cookie:` header for `fetch` against `localhost:3001`. Clone this for every new entity test.
