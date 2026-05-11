# Campaign Manager — Project State

A snapshot of what this repository is, what it does, and how to continue building it. Read this first if you're a Claude instance joining the project, then read `CLAUDE.md` for the project conventions in detail. This document is kept short on purpose — it's an orientation, not a manual.

## 1. Project Overview

Campaign Manager is an internal CRM-style tool for managing SMS affiliate marketing campaigns. It is built as a single-developer project by a non-developer working with Claude Code; the user gives detailed step-prompts that Claude executes.

The scope decision for v1 is important to internalize: **this tool is a system of record, not a sending tool.** It does not send SMS, does not receive SMS, and does not integrate with any provider's API. The actual sending happens manually in external tools (SendNexus, TextHub, others). Campaigns are composed and "sent" by exporting the audience as CSV. Results come back as CSV imports after the send completes.

Target scale at maturity is millions of contacts and 100+ campaigns per day. Schema and index decisions should account for that from day one, but don't over-engineer for it.

## 2. Tech Stack

Next.js **16.2.6** with the App Router, on Turbopack (the default in 16). TypeScript everywhere. Tailwind v4 (CSS-first config, no `tailwind.config.ts`). UI primitives from **shadcn/ui v4.7** (the modern Radix-Nova style; `baseColor: "neutral"`). Forms use **react-hook-form ^7.75** + **@hookform/resolvers** with **Zod ^4.4** schemas. Toasts via **sonner ^2**. Icons from **lucide-react ^1.14**. Tables built on **@tanstack/react-table ^8.21** via a single `DataTable` wrapper.

Database is Supabase (Postgres + Auth) accessed two ways: **@supabase/supabase-js + @supabase/ssr ^0.10** for auth and any RLS-respecting calls, and **drizzle-orm ^0.45 + postgres ^3.4** for all server-side queries inside route handlers (which bypass RLS because the DB connection isn't user-scoped — we enforce `org_id` at the application layer).

Version-specific gotchas in Next.js 16: `params` in dynamic routes is async (must be awaited); `cookies()` and `headers()` from `next/headers` are async; the legacy `middleware.ts` file convention has been deprecated in favor of `proxy.ts` (the exported function is `proxy`, not `middleware`). Default to Next.js 16 patterns; check `node_modules/next/dist/docs/` if uncertain rather than assuming pre-16 behavior.

## 3. Repository Layout

```
app/
  (auth)/            Login, signup, forgot-password (route group, no URL segment)
  (protected)/       Layout + protected pages (dashboard, brands, …)
  auth/              callback, reset-password, complete (route handlers + pages)
  api/               JSON route handlers (brands/, me/)
components/
  ui/                shadcn primitives — don't edit unless re-adding via CLI
  protected/         Sidebar, nav, AuthContext (for protected layout)
  brands/            BrandForm — the only entity-specific component so far
  data-table.tsx     Generic TanStack Table wrapper
  color-picker.tsx   Reused by BrandForm; can be reused by future entities
db/
  schema.ts          Drizzle schema (organizations, org_members, invites, brands)
  client.ts          Drizzle + postgres-js client (globalThis-cached)
  migrations/        Generated SQL + Drizzle metadata (0000 schema, 0001 security)
lib/
  api/               helpers, error-codes, toast-error
  auth/              Server-side getUser/requireUser/requireOrgMembership
  hooks/             useApiCall, usePersistedFilters
  supabase/          client/server/admin Supabase factories
  validators/        Zod schemas (auth.ts, brands.ts)
  permissions.ts     Role/Permission types, can(), assertPermission()
scripts/             Standalone tsx scripts (connection test, schema verify, signup-trigger
                     E2E, RLS isolation E2E, brands API E2E)
proxy.ts             Route protection + Supabase session refresh (Next.js 16 proxy)
drizzle.config.ts    Drizzle Kit config (schemaFilter: ["public"])
```

## 4. Database Schema (current state)

Four tables, all in `public` schema. Every domain table carries `org_id UUID` and every query filters by it explicitly.

- **`organizations`** — One row per tenant. Holds `id` (uuid, default gen_random_uuid), `name`, `created_at`. Soft-delete not implemented; orgs aren't deleted in v1.
- **`org_members`** — Links a Supabase `auth.users.id` to an organization with a role (`owner|admin|manager|operator|viewer`). `UNIQUE(user_id, org_id)`. Index on `org_id`. For v1, a user belongs to exactly one org.
- **`invites`** — Pending invitations (email, role, token, expires_at, accepted_at). Role check excludes `'owner'`. Not yet wired to UI; the table exists for the future user-management feature.
- **`brands`** — First domain entity. `serial id` PK plus a separate human-friendly `brand_id TEXT UNIQUE` external identifier. Status is `'active' | 'archived'` with `archived_at` timestamp (soft-delete).

A `current_org_id()` SQL function (SECURITY DEFINER, STABLE) returns the calling user's org via a SECURITY DEFINER lookup on `org_members`. RLS policies on all four tables use it for tenant isolation. There's also a `handle_new_user()` trigger on `auth.users INSERT` that auto-creates an organization and inserts the new user as its `owner` — so signup-via-Supabase Auth produces a usable account with no extra setup.

RLS is **defense in depth**, not the primary defense. Application-level `org_id` filtering in every query is the primary defense. Both must be in place.

## 5. Authentication & Authorization

Auth is Supabase Auth, **email + password only**. Email verification is required before login. Password reset via Supabase's built-in `resetPasswordForEmail` flow. No OAuth, no magic links, no social — and explicitly out of scope for v1.

Five roles in ascending privilege: **viewer < operator < manager < admin < owner**. Permissions are defined as a string union in `lib/permissions.ts` and assigned cumulatively (manager inherits operator, etc.). Currently defined permissions: `brands.view`, `brands.create`, `brands.update`, `brands.archive`, `brands.restore`, `registry.view`, `registry.create`, `registry.update`, `registry.archive`, `users.manage`, `org.delete`. New permissions are added to the union and to the relevant role's Set; the file has a top comment with instructions.

The `can(role, permission)` helper is the single source of truth. It's called server-side in API routes (after `requireApiMembership()`) and client-side via the `useAuth()` hook (which fetches `/api/me` on mount and exposes `can()` to the protected tree). Both must pass — server-side is the authoritative check; client-side is for hiding controls.

## 6. Established Conventions

These are sticky decisions. Don't deviate without asking.

**Multi-tenancy.** Every domain table has `org_id UUID`. Every query that reads or writes domain data MUST filter by `org_id` explicitly. RLS catches mistakes but is not the primary defense.

**API error shape.** Every non-2xx response returns `{ error: string, code?: string, details?: unknown }`. Codes come from `lib/api/error-codes.ts` (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `DUPLICATE`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`). Prefer entity-agnostic codes with `details` carrying specifics (e.g. `duplicate` + `details: { field: 'brand_id' }`), never `duplicate_brand_id`.

**API list shape.** `GET /api/{entity}/list` accepts `page`, `pageSize`, `search`, `showArchived`, `sortBy`, `sortDir` (parsed via `parseListParams`) and returns `{ data: T[], totalCount, page, pageSize }`.

**Auth in route handlers.** Use `requireApiMembership()` from `lib/api/helpers.ts`. It returns a discriminated union; callers do `if ('error' in auth) return auth.error;` then destructure `{ user, orgId, role }`. No try/catch wrappers.

**DB access in route handlers.** Drizzle (`db` from `db/client.ts`), not the Supabase JS client. The Drizzle connection uses the privileged DB role and is not subject to RLS; that's why explicit `org_id` filtering is non-negotiable.

**Client-side API calls.** Use `useApiCall<T>()` from `lib/hooks/use-api-call.ts`. It returns `{ isLoading, execute }`. **Depend on `.execute`, never the wrapping object** (see Gotchas). On failures, call `toastApiError(result)` for consistent user messaging.

**Forms.** shadcn `<Form>` + react-hook-form + `zodResolver`. Every input is wrapped in `<FormField>` / `<FormItem>` / `<FormControl>` / `<FormMessage>` so inline validation works. Entity forms are pure components — they accept `onSubmit` from the parent and don't make API calls themselves.

**UI for CRUD.** Dialogs (shadcn `<Dialog>`) for simple create/edit. AlertDialog for archive/restore confirmations. Full pages are reserved for complex entities (Campaigns, eventually).

**Tables.** The `DataTable` wrapper in `components/data-table.tsx` is canonical. Manual pagination + manual sorting; the parent owns the state.

**List filter state.** Use `usePersistedFilters('{route}.filters', defaults)` so filters survive navigation. The hook is SSR-safe and uses localStorage.

**Soft-delete.** Status column is `'active' | 'archived'` with `archived_at TIMESTAMPTZ`. No hard deletes via UI; rare hard-deletes are explicit.

## 7. What's Built

- Email/password authentication: signup, login, password reset, email verification handler, defensive `/auth/complete` page. Middleware-equivalent route protection via `proxy.ts`.
- Protected layout with sidebar nav (all planned entities visible; only Dashboard and Brands are enabled). Mobile drawer via shadcn Sheet. User block with avatar + email + sign-out.
- Dashboard placeholder showing org name and role.
- `AuthContext` (`/api/me` + `useAuth()`) exposing `auth`, `isLoading`, `error`, `refetch`, and `can(permission)` to the protected tree.
- Database foundation: 4 tables, RLS policies, `current_org_id()` helper, new-user trigger. Two migrations tracked by Drizzle Kit (`0000_wealthy_power_pack.sql`, `0001_security_layer.sql`).
- Brands: full vertical slice. Schema, RLS, all 5 API routes (list / create / get / update / archive / restore), client-side list page with create/edit dialogs, archive/restore AlertDialog, search with 300ms debounce, persistent filters, ColorPicker, BrandForm, status badges, action dropdown.
- Shared API infrastructure: error contract, error codes, `useApiCall`, `toastApiError`. Used by Brands; reused by every future entity.
- Integration test scripts in `scripts/`: connection test, schema verify, security-layer verify, signup-trigger E2E, RLS-isolation E2E, brands-API E2E.

## 8. What's Next

Roadmap of remaining entity builds (in order):

- **5.1** Offers
- **5.2** Affiliate Networks
- **5.3** SMS Providers + Provider Phones
- **5.4** Routing Types and Traffic Types
- **5.5** UTM Tags
- **5.6** Segment Groups
- **6** Audience layer: Contacts, Segments, Opt-Outs, Opt-Ins, Clickers — with CSV upload/import
- **7** Creatives and Campaigns — the hardest part; CSV export of audience for sending, CSV import of results back

Deferred indefinitely (explicitly out of scope for v1): real SMS sending, provider API integrations, inbound webhooks, two-way conversations, per-recipient delivery status, phone-number-to-campaign assignment, short-link generation, click tracking infrastructure, analytics integrations.

## 9. Known Limitations / Deferred Decisions

No background job system yet (will be needed if/when real sending is added). No `messages` table (single-message log; not needed until two-way conversations). Filter persistence is per-browser via localStorage and doesn't sync across devices — acceptable for an internal tool. The `invites` table exists but is not yet wired to UI (user management is a later step). Build emits LF→CRLF warnings on Windows; cosmetic, ignored.

## 10. Pattern for Building a New Entity

This is the recipe; it's how Brands was built and how the next 6–10 entities should be built. A simple entity takes 1–3 hours of Claude Code work plus user testing.

1. Add the table to `db/schema.ts`. Follow the conventions: `id`, `org_id` UUID with FK to organizations CASCADE, `status` text default `'active'` with CHECK, `archived_at` timestamptz, `created_at` timestamptz default now(). Export `$inferSelect` / `$inferInsert` types.
2. Run `npm run db:generate` to produce a Drizzle migration. Review the SQL.
3. Write a `0XXX_<name>_rls.sql` custom migration via `drizzle-kit generate --custom --name=<name>_rls` for `ENABLE ROW LEVEL SECURITY` plus SELECT/INSERT/UPDATE policies on the new table. Use the same patterns as `0001_security_layer.sql` (no DELETE policy; archive via status).
4. Run `npm run db:migrate`. Verify in Supabase or via a small scripts/ verifier.
5. Add permissions to `lib/permissions.ts` (e.g. `offers.view`, `offers.create`, etc.) and assign them to roles. Add a Zod validator file under `lib/validators/`.
6. Build API routes under `app/api/{entity}/`. Mirror the Brands shape: `list/route.ts` (GET), `route.ts` (POST), `[id]/route.ts` (GET + PATCH), `[id]/archive/route.ts` (POST), `[id]/restore/route.ts` (POST). Each must `requireApiMembership()`, call `can()`, validate with Zod, filter by `org_id`, use Drizzle, and return the standard shapes.
7. Write an E2E test script in `scripts/test-{entity}-api.ts` (clone the Brands one and adapt assertions). Run it against `localhost:3001` with `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` in `.env.local`.
8. Build the page under `app/(protected)/{entity}/page.tsx`. Reuse `DataTable`, `usePersistedFilters`, `useApiCall`, `toastApiError`. Create an `{Entity}Form` component as a pure component.
9. Enable the nav entry in `components/protected/nav-config.ts` (flip `disabled` to `undefined` or remove the field).
10. Test in the browser with DevTools open. Watch Network tab for the absence of loops.

## 11. Gotchas & Lessons Learned

These are real bugs hit during Step 4. Read them.

**Supabase direct DB connection doesn't resolve from non-IPv6 networks** on the free tier (the `db.<ref>.supabase.co` hostname is IPv6-only without the IPv4 add-on). Use the Supavisor **session pooler** (`aws-X-region.pooler.supabase.com:5432`) for connections from the app. Username must include the project ref: `postgres.<project-ref>`. `prepare: false` is required and is already set in `db/client.ts`.

**`DATABASE_URL` password must be URL-safe.** A `#` in the password gets parsed as a URL fragment by `postgres-js`, truncating the connection string. Either URL-encode special chars (`#` → `%23`, `,` → `%2C`) or pick an alphanumeric password when rotating. The `@` between password and host must NOT be encoded — that's a structural delimiter.

**`db/client.ts` uses a `globalThis`-cached pool with `max: 5`.** Next.js HMR re-evaluates this module on every code change in dev. Without the cache, each reload opens a fresh pool and the session pooler's ~15-client cap is exhausted within minutes, surfacing as `EMAXCONNSESSION`. Don't strip the caching.

**Next.js 16 renamed `middleware.ts` to `proxy.ts`.** The exported function is now `proxy`, not `middleware`. The matcher syntax is unchanged. This is enforced (the legacy name issues a deprecation warning).

**`useApiCall` consumers must depend on `.execute`, not the wrapping object.** The hook returns `{ isLoading, execute }`; `execute` has stable identity (it's `useCallback([])`), but the wrapping object literal is fresh each render. Including the whole object in a `useEffect` dep array creates an infinite fetch loop: effect runs → `execute` flips `isLoading` → re-render → new wrapping object → deps change → effect re-runs. Discovered on the Brands page (88+ requests in 20s). The hook has a prominent doc block warning about this.

**Zod `z.preprocess` breaks react-hook-form type inference.** `z.preprocess(transform, schema)` widens the input type to `unknown`, which incompatibly narrows in zodResolver. For optional form fields, use `z.union([z.string()..., z.literal("")]).optional()` instead, and normalize empty strings to `null` at the API boundary via a `nullIfEmpty()` helper.

**Always test in the browser with DevTools Network tab open after any UI refactor.** Infinite loops can hide behind 200 OK responses — every request succeeds, but you never see the load complete. The build won't catch this; only watching the network will.

**Server actions can't bypass the redirect-throws-in-try-catch rule.** `redirect()` from `next/navigation` throws a special error that Next.js catches. Wrapping it in a try/catch silently swallows the redirect. For login/signup, the page returns `{ ok: true, redirectTo }` from the server action and the client does `router.push()`.

**Tests can't easily auth to Next.js API routes through cookies** because `@supabase/ssr` uses chunked, structured cookies. The pattern in `scripts/test-brands-api.ts` works: create a `@supabase/ssr` server client with an in-memory `Map` as the cookie jar, sign in (the cookies get written to the jar), then serialize the jar into a `Cookie:` header for `fetch` against `localhost:3001`. Reuse this pattern for every entity API test.
