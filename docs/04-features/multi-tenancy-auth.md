# Feature — Multi-tenancy, Auth & Permissions

_Last updated: 2026-09-15_

## 1. Purpose
Isolate every org's data behind an `org_id`, authenticate users via Supabase Auth, and enforce a five-role permission model on both server and client. A missing `org_id` filter is a data-leak bug — this is the most safety-critical convention in the codebase.

## 2. Key concepts / entities
- `organizations` (tenant root), `org_members` (user↔org + role + **`is_active`**), `invites`.
- `audit_log` — account/authz/compliance events (migration 0175). Distinct from `campaign_events`, which owns campaign-scoped history.
- External `auth.users` (Supabase-managed).
- Roles: `viewer < operator < manager < admin < owner` (ascending, inherited).
- `Permission` union + `can()` helper in [`lib/permissions.ts`](../../lib/permissions.ts).

## 3. How it works

### Org resolution (the single helper)
- **Server pages:** `requireOrgMembership()` → `getOrgMembership(userId)` in [`lib/auth/helpers.ts`](../../lib/auth/helpers.ts). Queries `org_members` by the verified user id via the **privileged Drizzle connection** (RLS-bypassing) and returns `{ org_id, role }`, or redirects to `/auth/complete` if none. Used in [`app/(protected)/layout.tsx`](../../app/(protected)/layout.tsx).
- **API routes:** `requireApiMembership()` in `lib/api/helpers.ts` — gets the authenticated Supabase user (anon-key SSR client), resolves `{ user, orgId, role }`, or returns an error response. **Every route calls this first.**

> There is exactly **one** such helper per surface. Do not invent alternates (CLAUDE.md §3). Future background/webhook contexts use a separate trusted helper that takes `org_id` as an explicit argument.

> **Per-request memoization (perf, no behavior change).** `getUser()` / `getOrgMembership()` ([`lib/auth/helpers.ts`](../../lib/auth/helpers.ts)) and the API-side user/membership primitives ([`lib/api/helpers.ts`](../../lib/api/helpers.ts)) are wrapped in `React.cache()`, so the Supabase Auth round-trip (`supabase.auth.getUser()` — a network call, not a cookie read) and the `org_members` lookup each run **at most once per server request**, no matter how many components/helpers resolve auth during one render. Cache scope is a single request; it never bleeds across requests/users. Return values are unchanged.

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
  DB->>DB: handle_new_user() → create org + owner member<br/>(skipped when an open invite matches the address)
  SB-->>U: verification email
  U->>App: click link → /auth/callback?code=...
  App->>SB: exchangeCodeForSession(code)
  App-->>U: redirect /dashboard
  Note over App: layout.tsx requireOrgMembership();<br/>if missing → /auth/complete
```
- Owner break-glass is email + password (NOT magic link); **email verification required**. Everyone else signs in with Google (below).
- Org auto-creation is a **DB trigger** (`handle_new_user()` in `0001`, amended in `0177`), not app code: new org named `"<name>'s Organization"`, user inserted as `owner`. **It returns early for an invited address** (open, unexpired `invites` row) so the invitee joins the *inviting* org via the callback instead of getting an empty one of their own.
- `/auth/complete` is the fallback if membership is somehow missing post-verification; it rechecks and forwards to `/dashboard`.

### Google Workspace sign-in (migration 0175, ClickUp 869et3vm1 Phase 1)

**Supabase does not enforce `hd`.** Enabling the Google provider accepts *any*
Google account, personal gmail.com included. The hosted-domain restriction is
ours, and it lives in [`lib/auth/workspace-gate.ts`](../../lib/auth/workspace-gate.ts),
enforced in [`app/auth/callback/route.ts`](../../app/auth/callback/route.ts).

**The callback returns to the origin the sign-in started from.**
`signInWithGoogleAction` and `linkGoogleIdentityAction` build `redirectTo` via
`authCallbackOrigin()` ([`lib/app-origin.ts`](../../lib/app-origin.ts)), which
matches the request host against the env-declared origins and falls back to the
primary. This is required, not cosmetic: the PKCE code verifier is a cookie on
the starting origin, so a callback that lands on a different hostname fails the
exchange **locally, without contacting Supabase** — no `/token` in the auth log,
no error surfaced, just a bounce to `/login`. See docs/07-conventions.md.

Three independent checks, all required — "domain alone is not enough":

1. **Verified Google identity in our domain.** The address domain is the
   load-bearing test: a consumer Google account cannot hold an `@exuma.io`
   address, because only the Workspace issues those. The `hd` claim is checked
   as a *confirmation* and **only when present** — Google omits it in some
   flows, and treating absence as failure would lock out legitimate users over
   a claim we do not control. Present-and-wrong fails closed.
2. **Allow-listed.** An existing `org_members` row, or an open `invites` row
   (unexpired, unaccepted) that an Owner created.
3. **`is_active`** — re-checked on *every* request, not just at sign-in.

A session that fails the gate is **signed out inside the callback**, before the
redirect. Leaving it alive would let the user navigate straight to `/dashboard`
and be admitted by a later request that never re-runs the gate.

`?hd=` is also passed to Google's authorize URL, but that is a **convenience
only** — it pre-filters the account chooser. It is a URL parameter, so it is
not a control.

**Password sign-in is owner-only.** `signInAction` resolves the role after
authenticating and signs a non-owner back out. Operator accounts have no
password path at all.

**Self-signup is closed.** `signUpAction` refuses without calling
`supabase.auth.signUp`. The enforcement is in the **server action**, not the
page: a Server Action is an RPC endpoint with a stable id and stays callable
with no UI pointing at it, so deleting the page would have closed nothing.

### The `is_active` per-request gate

`is_active` rides along in the query that **already** resolves `org_id` + role
(`getApiMembershipRow` in `lib/api/helpers.ts`, `getOrgMembership` in
`lib/auth/helpers.ts`), so the check costs **zero extra round-trips**.

It must be in **both** helpers. It cannot live in `proxy.ts` alone: all of
`api/` is excluded from the middleware matcher, and `PROTECTED_PREFIXES` covers
only three page prefixes.

Why it matters: revoking refresh tokens does **not** invalidate an
already-issued access token — Supabase JWTs stay valid until they expire. Only
re-reading `is_active` makes a deactivation take effect on the next request
rather than at token expiry.

⚠️ A deactivated member is redirected to **`/auth/deactivated`, never
`/login`**. Their session is still valid at that point, and `proxy.ts` bounces
authenticated requests for `/login` back to `/dashboard` — which redirects here
again. Sending them to `/login` is an infinite loop, not a login page.

### The deactivation kill switch

[`lib/auth/deactivate.ts`](../../lib/auth/deactivate.ts). Three steps, and the
**order is the point**:

1. `is_active = false` — takes effect on the next request.
2. Revoke refresh tokens (Supabase Admin `signOut(userId, "global")`).
   **Best-effort**: if it fails the switch continues, because step 1 has already
   cut access and step 3 still must run. The UI reports a revocation failure
   explicitly.
3. Auto-pause every stage the user created that is `send_approved = true AND
   sent_at IS NULL` — the "time bomb" defence against sends scheduled before
   departure.

Step 1 is first so there is no instant at which the account is un-revoked *and*
active.

⚠️ **Step 3 does not touch the send path.** It clears the **existing**
`send_approved` gate the drain already reads — no new condition in materialize
or fire. And it **never writes `sent_at`**: that is the scheduler's atomic
fire-lock, and a second writer stamping it silently cancels a scheduled send (a
real past incident). Un-approving is reversible; re-approval is a deliberate
per-stage act by an Owner, which is why reactivation deliberately does **not**
re-approve them.

Authorship comes from `created_by_user_id`. `campaigns` already had it (394 of
397 rows populated); `campaign_stages` gained it in 0175, and **all five
stage-insert sites** stamp it (create, stage duplicate, split, campaign
duplicate, behavioural split).

### User management
- **`/settings/users`** ([page](../../app/(protected)/settings/users/page.tsx) +
  [`components/settings/users-panel.tsx`](../../components/settings/users-panel.tsx)) —
  member roster, roles, last login + IP, pending invites, activate/deactivate.
  Gated on `users.manage`; the page re-checks server-side and `notFound()`s.
- `app/api/users/*` — `list`, `invite`, `[memberId]` (PATCH role **or**
  `is_active`, never both), `invites/[inviteId]` (DELETE = revoke).
- `app/api/members/` is a **different, lower-privilege endpoint** — the campaign
  assignee picker, readable with `campaigns.view`. It was deliberately not
  extended, because the roster exposes email, last login and IP.
- **An invite is an allow-list entry, not an emailed link.** Under Google
  sign-in there is no password to set and no token for the invitee to carry:
  the row itself is the authorization. `invites.token` is still populated
  (NOT NULL UNIQUE) so an emailed-link flow stays possible without a migration.
- Re-inviting **replaces** the open invite rather than stacking a second one, so
  `resolveAllowlist` can never find two rows to choose between.
- **Lockout guards:** the last active owner cannot be demoted or deactivated,
  and nobody can change their own role or access.
- ⚠️ **`operator` is refused by the invite route in Phase 1**
  (`OPERATOR_LOCKED_UNTIL_PHASE_2`). The role name already exists and currently
  grants the whole audience block — the inverse of the Operator access matrix.
  Phase 2 redefines `operatorPerms`; **removing that lock is an explicit Phase 2
  step.**

## 4. Data it reads/writes
- Reads/writes `org_members`, `invites`, `organizations`.
- Reads `auth.users` (via Supabase Auth APIs / FK only).

## 5. UI surface
- `app/(auth)/` — sign-in, sign-up, reset pages.
- `app/(protected)/layout.tsx` — the server-side gate + sidebar shell. It **server-hydrates** the client auth context (`<AuthProvider initial={…}>`, [`components/protected/auth-context.tsx`](../../components/protected/auth-context.tsx)) and the send-state strip (`<SendStateStripLoader>` in a `<Suspense>`, [`components/sends/send-state-strip-loader.tsx`](../../components/sends/send-state-strip-loader.tsx)) from data already resolved on the server, so neither re-fetches `/api/me` or `/api/sends/state` (each a full auth round-trip) on mount. Both client components keep their fetch path for callers that mount them without `initial`.
- Settings / member management pages under `app/(protected)/` (members).
- `proxy.ts` — edge session refresh + coarse route guard. **Excludes all of `api/`** (and `r/`): every API route self-authenticates in its own handler (audited 2026-06-19, 172/172 routes), and route handlers refresh their own auth cookies, so the middleware `getUser()` round-trip is redundant there. The middleware still runs for page navigations (session refresh + the protected-prefix redirect).

## 6. Rules & edge cases
- Role values are constrained by both the `Permission` model and the `org_members_role_check` DB CHECK — keep them in sync (CLAUDE.md / `lib/permissions.ts` header).
- `can(null, …) === false` (no role ⇒ no access).
- `assertPermission()` throws `PermissionError { code: "forbidden" }` for server enforcement.
- The `proxy.ts` protected-prefix list (`/dashboard`, `/brands`, `/settings`) is **not** the full protected set — the real gate is `requireOrgMembership()` in the protected layout. `> [VERIFY]` whether any protected page is reachable without server-side membership check.

## 7. Extension points / limitations
- Adding a permission: extend the `Permission` union + add to the relevant role Set (higher roles inherit via spread). Adding a role: extend the union, add a Set, **and** update the `org_members_role_check` CHECK constraint via migration.
- No per-resource ACLs — permissions are role-global within an org.
- Google Workspace SSO is live (Phase 1). No other OAuth providers.
- **Session TTL is a Supabase dashboard setting, not code.** There is nowhere in
  this repo to set it; ClickUp 869et3vm1 asks for ≤ 12 h and that is an ops
  change, not a code change.
- **RLS still enforces nothing against the app itself** — `DATABASE_URL`
  connects as `postgres` with `rolbypassrls = true` and tenant tables do not use
  `FORCE ROW LEVEL SECURITY`, so every policy here defends only against a leaked
  anon key. `can()` in application code is the real control. Role-aware RLS is
  deferred to its own card.

---

## Operator authorization & redaction (Phase 2, ClickUp 869et3vm1)

### Default-deny is structural, not a lookup

`requireApiMembership()` refuses an **operator** unless the handler passes an
explicit `{ route, method }`. A route added tomorrow that never opts in denies
the operator **without anyone editing the map**. That is what makes default-deny
true rather than aspirational: a scheme that depends on remembering to add a
deny entry fails the first time somebody forgets.

[`lib/authz/route-map.ts`](../../lib/authz/route-map.ts) is the *second*,
reviewable statement of intent — **85 allowed / 174 denied of 259 routes**. Both
must agree before an operator gets through.

- **A typed route key, not the request.** Passing `req` would have meant changing
  the handler signature of 54 route files that declare `GET()` with no
  parameters. The key is `keyof typeof OPERATOR_ROUTE_MAP`, so a typo is a
  compile error rather than a silent 403.
- **The method is required.** Registry route files export GET, POST and PATCH
  from one module, so a route-level allow would have handed the operator write
  access to Brands and Offers. Method granularity is what makes "view-only"
  expressible.

Other roles are untouched by this parameter — they are gated by `can()` exactly
as before.

### The permission set

`operator` is **38 permissions** (36 at Phase 2; `provider_phones.view` since, and `creatives.archive` on 2026-09-15), defined standalone and deliberately **not**
spread from `viewerPerms`, which carries `contacts.view`, `opt_outs.view`,
`clickers.view` and `segment_contacts.view` — the whole audience block.

⚠️ **`managerPerms` used to spread `operatorPerms`.** Narrowing operator would
have silently stripped `contacts.upload`, `opt_outs.upload`, `lookup.run` and
~20 more from manager, admin **and** owner. The shared base is now
`staffBaselinePerms`, and
[`scripts/test-operator-permission-matrix.ts`](../../scripts/test-operator-permission-matrix.ts)
asserts the other four roles against sets frozen from `origin/main`.

**`contacts.stats`** was split out of `contacts.view`: audience SIZE and audience
IDENTITY were the same grant, which made the aggregate counters unreachable for
a role that may never see a row.

### Provider names are shown to EVERY role (removed 2026-09-11)

There is no redaction layer any more. `lib/authz/redact.ts`, the `jsonForRole()`
response helper and the per-role value sweep are **deleted**: the owner decided
that the registry name IS the display name, and renames providers to whatever
should be visible. Every role sees real provider names, codes and ids.

What this replaced: a value sweep that turned any string exactly matching a
provider name or code into a `Route A` / `Route B` alias, anywhere in a payload.
It is worth remembering **why it was a value sweep and not a field list** if
anything like it is ever needed again — a field list ("null out `provider_name`")
breaks silently the moment someone adds a join or returns a nested provider
object, whereas the value sweep made the end-to-end assertion true by
construction.

`provider_route_aliases` (migration 0175) is **retained but unused** — nothing
reads or writes it. It was left in place rather than dropped so the decision
stays reversible; drop it if that changes.

⚠️ **Confidentiality of CONTACT data is unaffected.** The audience block is
still denied to the operator by `OPERATOR_ROUTE_MAP` and the permission matrix,
and `scripts/verify-operator-access.ts` still sweeps every response, rendered
page and token body for recipient phone numbers and contact ids. Only the
provider-identity half is gone.

⚠️ **A response-boundary layer only covers what crosses that boundary** — the
lesson outlives the redactor. `SendStateStripLoader` is a **server component**
rendered by the protected layout on *every* page; it surfaced
`sms_providers.name` without ever touching an API route, so every JSON assertion
passed while the name went straight into the HTML. Any future per-role filtering
must be applied in server components by hand, which is why
`scripts/verify-operator-access.ts` checks rendered pages and not just JSON.

### Field-level compliance gates

`stop_text` (stage PATCH) and `allow_multi_segment` (creative PATCH) are refused
unless the caller holds `compliance.manage`, shaped like the existing
`tracking_id_immutable` refusal. Field-level, not permission-level: the operator
legitimately needs to edit stages and creatives — just not those fields.

### Page guards live in LAYOUTS

Nine of the ten gated pages are client components and cannot run a server check.
A **layout is a server component regardless of what it wraps**, so one small
file gates a whole subtree without converting any page:
`contacts`, `contact-groups`, `clickers`, `opt-outs`, `opt-ins`, `drip`.
`notFound()`, not 403 — the operator has no business knowing the route exists.

The API routes behind those pages deny independently; the layout is defence in
depth, not the control.

### Contact group NAMES are open to the operator — the screen is not (2026-09-14)

Contact groups became a required campaign field (`31db02f`) after Phase 2 had
already denied `contact-groups/list` to the operator, so the operator could not
create a campaign at all. The fix opens exactly one route, for pickers:

| Surface | Operator |
|---|---|
| `GET /api/contact-groups/list` — campaign audience picker, segment rule picker | **allowed**: id, name, color, count |
| `/contact-groups` page + nav item | denied (layout guard on `contact_groups.view`) |
| `contact-groups/[id]`, `[id]/contacts`, add/remove/archive/restore | denied (route map) |

The list route no longer requires `contact_groups.view`; it accepts that **or**
`campaigns.create` — anyone who can build a campaign can choose its groups. The
permission itself was deliberately **not** granted to the operator: it is also
the key for the page guard, the nav item and `[id]/contacts` (phone numbers).

⚠️ **Descriptions are blanked for picker-only callers, and excluded from their
search.** A description is a free-text note and can name where a list came from
(one in production reads "Test group from Big Data group"). Blanking it without
also dropping it from the `search` filter would let a caller recover the text by
probing substrings. The picker renders only id, name and color, so nothing
visible changes.

### Provider phone numbers are open to the operator for stage forms (2026-09-14)

The stage form loads its **Phone number** dropdown from
`GET /api/providers/[providerId]/phones`, which the route map denied to the
operator — so the dropdown was always empty and disabled ("No active phones for
this provider"), and an operator's stage could never be assigned a number.

The route map now opens **GET only**; `POST` (create a number) stays denied.
`provider_phones.view`, which the operator already holds, still gates the route.

Callers without `providers.view` get the numbers with the provider's **account
wiring and sending limits blanked**: `credential_id`, `dashboard_id`,
`max_sends_per_second`, `short_domain_id` and `allow_unknown_carrier` are `null`,
`carrier_limits` is `[]`. Those belong to the Owner-only provider settings screen.

Kept, because the stage form uses them: the number, `cost_per_sms` (shown next to
each number in the dropdown) and the two message-preview candidates
`short_domain` and `opt_out_footer`. Dropping those would make an operator's
preview resolve a different link host and footer than the send path uses.

Switching the form to the already-open `provider-phones/list` was rejected for
that reason: it returns none of the three.

### Identity linking

The domain gate reads the **Google identity's** email
(`identities[].identity_data.email`), **not `auth.users.email`**. Linking a
Google identity to an existing password account leaves the primary address
unchanged, so reading `user.email` would refuse the owner's own sign-in — the
exact scenario linking exists to enable. Covered by
[`scripts/test-workspace-gate.ts`](../../scripts/test-workspace-gate.ts) case 5.

`linkGoogleIdentityAction` in [`app/(protected)/actions.ts`](../../app/(protected)/actions.ts)
is Owner-only and **self-only** — `linkIdentity()` acts on whoever is signed in,
so nobody can link an identity onto someone else's account.

**Where the button lives:** `/settings/users`, on the signed-in Owner's own row
("Link Google account"). It is hidden once `has_google` is true, and the row
shows a "Google linked" badge instead.

A link and an ordinary sign-in are indistinguishable at the callback — same code
exchange, same user, same Google identity by then — so the action puts
`?linked=google` on its `redirectTo` and the callback writes an
**`auth.google_linked`** audit row when it sees it. The link runs through the
SAME workspace gate as a login, so linking a personal Google account is refused
for exactly the reason signing in with one is.

⚠️ **Requires a Supabase dashboard toggle:** Authentication → Sign In / Providers
→ **"Allow manual linking"**, which is OFF by default. Automatic linking does not
cover this case — it only fires when the identities share an email address.

### Verification

| Script | What it proves |
|---|---|
| `verify-operator-access.ts` | Signs in as a **real operator** and hits every route: no denied route reachable, every allowed route reachable, no provider name/code in any body, every phone-shaped value a known **sending** number. **Preview only** — it creates a user, and refuses to run against production. |
| `test-route-map-coverage.ts` | Every `route.ts` on disk is classified; no stale keys; every allowed route actually passes its own key (an allow that isn't wired is a lie). |
| `test-operator-permission-matrix.ts` | `operator` == the matrix in both directions; other roles unchanged vs `origin/main`. |
| `test-workspace-gate.ts` | The domain gate, including the linked-identity case. Run with `--conditions=react-server`. |

**Not covered:** the Google OAuth sign-in path (no scriptable consent screen)
and allowed write methods (probing them would mutate data). Both are stated in
the script's own output rather than left implied.
