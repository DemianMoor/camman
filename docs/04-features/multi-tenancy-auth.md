# Feature — Multi-tenancy, Auth & Permissions

_Last updated: 2026-06-05_

## 1. Purpose
Isolate every org's data behind an `org_id`, authenticate users via Supabase Auth, and enforce a five-role permission model on both server and client. A missing `org_id` filter is a data-leak bug — this is the most safety-critical convention in the codebase.

## 2. Key concepts / entities
- `organizations` (tenant root), `org_members` (user↔org + role), `invites`.
- External `auth.users` (Supabase-managed).
- Roles: `viewer < operator < manager < admin < owner` (ascending, inherited).
- `Permission` union + `can()` helper in [`lib/permissions.ts`](../../lib/permissions.ts).

## 3. How it works

### Org resolution (the single helper)
- **Server pages:** `requireOrgMembership()` → `getOrgMembership(userId)` in [`lib/auth/helpers.ts`](../../lib/auth/helpers.ts). Queries `org_members` by the verified user id via the **privileged Drizzle connection** (RLS-bypassing) and returns `{ org_id, role }`, or redirects to `/auth/complete` if none. Used in [`app/(protected)/layout.tsx`](../../app/(protected)/layout.tsx).
- **API routes:** `requireApiMembership()` in `lib/api/helpers.ts` — gets the authenticated Supabase user (anon-key SSR client), resolves `{ user, orgId, role }`, or returns an error response. **Every route calls this first.**

> There is exactly **one** such helper per surface. Do not invent alternates (CLAUDE.md §3). Future background/webhook contexts use a separate trusted helper that takes `org_id` as an explicit argument.

### Canonical API-route shape
```ts
const auth = await requireApiMembership();
if ("error" in auth) return auth.error;
const { orgId, role } = auth;
if (!can(role, "stages.view")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
// ...every query filtered by org_id:
.where(and(eq(campaign_stages.id, id), eq(campaign_stages.org_id, orgId)))
```
The UI hides actions a user can't perform; the server **re-checks independently** (`can()` is used on both sides).

### Two-layer enforcement
1. **App layer (primary):** explicit `eq(table.org_id, orgId)` on every query, run through the RLS-bypassing Drizzle connection.
2. **RLS (defense-in-depth):** `0001_security_layer.sql` enables RLS and defines `public.current_org_id()` (SECURITY DEFINER, reads `org_members` via `auth.uid()`); policies gate org tables for **anon-key** access. The service-role client and Drizzle bypass RLS.

### Supabase client factories ([`lib/supabase/`](../../lib/supabase/))
| File | Client | Key | Used by |
|------|--------|-----|---------|
| `client.ts` | `createBrowserClient` | anon | client components |
| `server.ts` | `createServerClient` | anon + cookies | server components, route handlers |
| `admin.ts` | `createClient` | **service-role** | server-only trusted ops (bypasses RLS) |

### Auth flow
```mermaid
sequenceDiagram
  participant U as User
  participant App as Next.js
  participant SB as Supabase Auth
  participant DB as Postgres (trigger)
  U->>App: Sign up (email, password, display_name)
  App->>SB: auth.signUp(emailRedirectTo=/auth/callback)
  SB->>DB: INSERT auth.users
  DB->>DB: handle_new_user() → create org + owner member
  SB-->>U: verification email
  U->>App: click link → /auth/callback?code=...
  App->>SB: exchangeCodeForSession(code)
  App-->>U: redirect /dashboard
  Note over App: layout.tsx requireOrgMembership();<br/>if missing → /auth/complete
```
- Email + password (NOT magic link); **email verification required** before login.
- Org auto-creation is a **DB trigger** (`handle_new_user()` in `0001`), not app code: new org named `"<name>'s Organization"`, user inserted as `owner`.
- `/auth/complete` is the fallback if membership is somehow missing post-verification; it rechecks and forwards to `/dashboard`.

### User management
- `app/api/members/` — invite/remove/role-assign, gated by `users.manage` (admin+). Invites use `invites.token` + `expires_at`.

## 4. Data it reads/writes
- Reads/writes `org_members`, `invites`, `organizations`.
- Reads `auth.users` (via Supabase Auth APIs / FK only).

## 5. UI surface
- `app/(auth)/` — sign-in, sign-up, reset pages.
- `app/(protected)/layout.tsx` — the server-side gate + sidebar shell.
- Settings / member management pages under `app/(protected)/` (members).
- `proxy.ts` — edge session refresh + coarse route guard.

## 6. Rules & edge cases
- Role values are constrained by both the `Permission` model and the `org_members_role_check` DB CHECK — keep them in sync (CLAUDE.md / `lib/permissions.ts` header).
- `can(null, …) === false` (no role ⇒ no access).
- `assertPermission()` throws `PermissionError { code: "forbidden" }` for server enforcement.
- The `proxy.ts` protected-prefix list (`/dashboard`, `/brands`, `/settings`) is **not** the full protected set — the real gate is `requireOrgMembership()` in the protected layout. `> [VERIFY]` whether any protected page is reachable without server-side membership check.

## 7. Extension points / limitations
- Adding a permission: extend the `Permission` union + add to the relevant role Set (higher roles inherit via spread). Adding a role: extend the union, add a Set, **and** update the `org_members_role_check` CHECK constraint via migration.
- No per-resource ACLs — permissions are role-global within an org.
- No SSO / OAuth providers (email+password only).
