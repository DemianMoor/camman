# Operator API tokens

_Last updated: 2026-09-04_

ClickUp 869evpmbz. Migration `0176`. Lets a member's own tools (in practice,
Claude) read CamMan through **that member's existing permissions** — no new data
surface, no parallel results API.

The reference handed to the worker is [`docs/operator-api.md`](../operator-api.md).
This file is the internal picture.

---

## 1. The design rule

A token is **its owner's authority, narrowed**. It resolves to the owning
member's `org_id` + `role` and then falls through the *identical* gate a browser
session runs:

```
requireApiMembership(access?)
  ├─ Authorization: Bearer cmt_… present?
  │    ├─ resolveApiToken()        → 401 on revoked / expired / inactive / api_enabled=false
  │    ├─ consumeTokenRequest()    → 429 over 300/hour
  │    ├─ decideTokenAccess()      → 403 unless the route's `token` list names this method
  │    └─┐
  └─ else requireApiUser() (Supabase cookies) ─┐
                                              ├─ is_active → isRole → decideOperatorAccess()
                                              └─ { user, orgId, role, token? }
```

Because the tail is shared, `is_active`, the default-deny route map, `can()` and
`redactForRole()` apply to tokens **by construction**, not by anyone remembering
to re-apply them.

**One plug point.** `requireApiMembership()` in
[`lib/api/helpers.ts`](../../lib/api/helpers.ts) is called by 245 route files and
every route that calls `requireApiUser()` also calls it — there is exactly one
door. It takes **no `req`** (it already reaches the session through `cookies()`),
so the bearer token is read the same way via `headers()` and **not one handler
signature changed**.

`redactForRole()` needed **zero** changes: it keys off the `role` string the
above returns, so a token resolving to `role: "operator"` is aliased exactly like
a session.

---

## 2. The token allowlist — why not `read_only ⇒ GET`

The card originally specified "read-only tokens accept GET only; every mutating
method 405s". **That is the wrong axis in this codebase and it was replaced.**

Every endpoint that can compute an audience number is a **POST**, because its
input is a filter object too large for a query string:

| Endpoint | Method | Writes? |
| --- | --- | --- |
| `campaigns/audience-preview` | POST | no |
| `segments/overlaps` | POST | no |
| `segments/[id]/rules/preview` | POST | yes — best-effort `segment_stats` cache warm |
| `segments/[id]/refresh-stats` | POST | yes |
| `segment-stats/refresh-all` | POST | yes |

A method rule would have 405'd exactly the endpoints the token exists to read,
while still permitting any future GET that turns out to mutate.

So `OPERATOR_ROUTE_MAP` entries carry an optional `token?: HttpMethod[]` naming
the exact (route, method) pairs a token may use. **Absent means denied**, the
same structural default the operator gate uses. It **must be a subset of
`methods`** — a token can never exceed its owning role — and
`scripts/test-route-map-coverage.ts` asserts that, since TypeScript cannot
express "subset of a sibling field".

The allowlist applies to **every role, Owner included**: a long-lived bearer
secret in an agent's config gets a much smaller surface than the human it
belongs to.

`read_only` survives as a column for a future write-capable token. Nothing sets
it false.

**33 (route, method) pairs are token-reachable** out of 268 classified routes.
The first two of `segments/[id]/rules/preview`'s side effects are accepted
deliberately: it is semantically a read (gated on `segment_rules.view`) whose
only write refreshes a cache the segment page already shows, and it is the sole
way to get a *live* segment count.

---

## 3. Fresh-lead counts

`GET /api/audience/fresh-counts`, backed by the `audience_fresh_counts` rollup
and `/api/cron/refresh-fresh-counts` (every 30 min, `11,41 * * * *`).

**Why the endpoint exists at all.** Phase 0 established the operator could not
answer "how many leads can I still assign" from anything that already existed:

- **Groups are invisible to the operator.** `contact_groups.view` is not in
  `operatorPerms` and every contact-groups route is `null` in the route map,
  `contact-groups/list` included — so an operator cannot even enumerate a group.
  And the groups **are** the verticals (Manifestation, Weight Loss, Blood
  Sugar…), which is the dimension the question is asked in.
- **The segment answer is stale by construction.** The "Not Used N Days" segments
  encode this, but `segment_stats.rule_filtered_count` is only ever written by a
  POST and **there is no cron for it** — while the rule's window anchors on
  `now()`. Measured 2026-09-04: *"Not Used Last 1 Week"* held 610,148 stamped
  **2026-07-16**, with 682,558 distinct contacts messaged since.

### What "used" means

⚠️ **`not_used` = not snapshotted into a campaign pool, NOT "not messaged".** A
contact counts as used once it lands in `campaign_audience_pool` for a campaign
that ran (`active`/`paused`/`completed`) inside the window — deliberately the
same definition as the `in_use_in_campaign_last_period` segment rule, for two
reasons:

1. It is the operative constraint. A contact reserved to a campaign cannot be
   assigned to another one whether or not its message has fired.
2. It makes these numbers **reconcile** with the "Not Used N Days" segments the
   Owner already works from. Two different definitions of the same English
   phrase is how two screens disagree forever.

It inherits that rule's one wart: the window anchors on the **campaign's**
`created_at`, not on when the contact was touched.
`campaign_audience_pool` carries no per-row timestamp, so there is nothing better
to anchor on without going back to `stage_sends`.

### Why not `stage_sends`

A literal "not messaged" variant was built and measured **first**, and rejected
on cost:

| Formulation | Source size | Measured (prod, 2026-09-04) |
| --- | --- | --- |
| `stage_sends`, two windows | 3,441 MB / 4.4M rows | **33.7 s** |
| `stage_sends`, single scan + `max(sent_at)` | same | **26.6 – 39.5 s** |
| `campaign_audience_pool` (shipped) | 302 MB / 2.0M rows | **13.5 s** |

The 30-day `stage_sends` window is 1.89M rows and the index scan is heap-bound
(1.28M buffers). Making it fast needs a covering partial index on `stage_sends`,
which is **write amplification on the send path**. The pool formulation touches
nothing the drain writes.

Eligibility excludes archived contacts and anyone with an `opt_outs` row —
non-negotiable for an actionable number, and matching
`excludeOptOutsFromAudience()` on the segment pages.

### Honesty about staleness

`computed_at` and `stale_seconds` are in **every** response, because the failure
mode this endpoint exists to avoid is a confidently stale number. If the cron has
never run the endpoint answers **503**, not `200` with zeros: "the rollup has not
run" is a service state, not an answer of zero, and an agent must not read an
empty result as "you have no leads".

---

## 4. Rate limiting

300 requests/token/hour, a constant in
[`lib/api/token-usage.ts`](../../lib/api/token-usage.ts).

Not `lib/api/rate-limit.ts` — that limiter is an in-memory token bucket and its
own header explains it only enforces per-instance, so on Vercel the effective
rate is `instance_count × limit`. Shared state means the database. This is
`lib/intake/rate-limit.ts` applied to tokens; that one is live and measured.

⚠️ **The guard is on the `DO UPDATE`, not in application code.** An
unconditional increment means rejected requests burn quota, so an agent with a
retry loop locks itself out for the rest of the hour without ever getting an
answer. `WHERE count + 1 <= limit` makes a refusal touch nothing.

**Ordering:** resolve → rate limit → allowlist. The limit is charged *before* the
allowlist so hammering a forbidden route still burns quota; otherwise a prober
would get unlimited attempts at the one thing we most want bounded.

The bearer read and the rate-limit consume are wrapped in `React.cache`, which is
load-bearing rather than a micro-optimisation: a handler resolving auth twice
would charge the caller twice for one request.

---

## 5. Audit trail and alerts

Three actions, added to the `AuditAction` union in
[`lib/audit.ts`](../../lib/audit.ts):

| Action | When | Sampled? |
| --- | --- | --- |
| `api.request` | every allowed token request | no |
| `api.denied` | 401 (attributable) and every 403 | never |
| `api.rate_limited` | every 429 | never |

⚠️ **`api.request` records the AUTH outcome, not the handler's final status.** It
is written by `requireApiMembership()` before the handler body runs, so its
metadata carries `outcome: "allowed"` — deliberately not a `status` field that
would look like an HTTP code and be wrong for anything the handler later 404s.

**No batching.** Production `audit_log` held **13 rows / 80 kB** across its whole
life at the time this shipped; one token at the 300/hour ceiling is ~7,200
rows/day. That is a large multiple of nothing, and the write is one narrow insert
that is already best-effort (`writeAuditLog` never throws), so a slow insert
degrades to a dropped row rather than a failed request. If retention becomes a
problem the lever is a sweep of `api.request` rows, not a more complicated write
path.

An **unknown** token writes nothing at all: it cannot be attributed, and a public
endpoint is scanned constantly, so those rows would be noise rather than signal.
`scripts/verify-operator-access.ts` asserts this.

**Alerts** ([`lib/api/token-alerts.ts`](../../lib/api/token-alerts.ts)) go through
`notifyOnTransition`, not `notifyTelegram` directly — these fire per-request, so a
bare send would page on every denial, and `notifyOnTransition` also retries until
delivery is confirmed. **The current hour is part of the alert key**, which is the
entire "at most one message per token per hour" mechanism: a stable key would
alert once and then go silent for as long as the probing continued.

- **Denial burst** — ≥10 denials in an hour from one token.
- **Rate-limit trip** — the first 429 of the hour.

---

## 6. Owner UI

`/settings/users` (already Owner-only) gains an **API** column. The button opens
a sheet per member ([`components/settings/user-api-panel.tsx`](../../components/settings/user-api-panel.tsx)):

- the `api_enabled` switch,
- their tokens — create (plaintext shown **once**, via `<CopyableId>`), revoke,
  with live/revoked/expired state and last-used,
- last-7-days usage: requests, denials, rate-limit hits, top endpoints, last IP.

The switch lives in the sheet rather than the table because "API on" and "has a
live token" only make sense read together — the sheet warns on either mismatch.

Endpoints (all Owner-only, and absent from every `token` list, so **a token can
never mint, list or revoke a token, including its own**):

- `GET|POST /api/users/[memberId]/tokens`
- `DELETE /api/users/[memberId]/tokens/[tokenId]`
- `GET /api/users/[memberId]/api-usage?days=N`
- `PATCH /api/users/[memberId]` now takes exactly one of `role`, `is_active` or
  `api_enabled`.

`api_enabled` is handled **before** the last-owner and self-modification guards,
because neither applies: toggling API access cannot lock the org out of
anything, and an Owner switching their own API access on is the normal first use
— refusing it as "self modification" would make the switch unreachable in a
single-owner org, which is the org this ships into.

---

## 7. Provider route aliases were empty in production

`provider_route_aliases` had **0 rows** in production since 0175 shipped, because
`loadAliasTable()` seeds **lazily** on the first operator page load and no
operator had ever signed in (`org_members` held one row, the Owner). The redactor
had therefore never executed against production data — "Route A hides TextHub"
was a claim tested only against preview.

[`scripts/seed-provider-route-aliases.ts`](../../scripts/seed-provider-route-aliases.ts)
seeds every org. It **calls `loadAliasTable()` rather than reimplementing the
letter assignment**, which is the whole point of its design: a second
implementation would only have to disagree once — on the day a provider is added
between a seed run and a lazy load — to produce two different "Route B"s.

Run once per environment before anyone relies on the mapping:

```
npx tsx --conditions=react-server scripts/seed-provider-route-aliases.ts
```

Idempotent (`ON CONFLICT DO NOTHING`, never reassigns). Letters are assigned in
provider-id order and **stable forever** — a letter that moves is worse than no
alias at all.

---

## 8. Verification

`scripts/verify-operator-access.ts` section 6 (preview only — it refuses to run
unless `DATABASE_URL` points at the preview project):

| Case | Assertion |
| --- | --- |
| `api_enabled = false` | 401 |
| same token, switch on | 2xx — proves the switch is what gated it |
| revoked | 401 |
| expired | 401 |
| unknown token | 401 **and zero audit rows** |
| non-allowlisted route | 403 + an `api.denied` row |
| …same route with a session | 2xx — proves the 403 is the allowlist, not a broken route |
| POST to a GET-only token route | 403/405 |
| over the limit | 429 + `api.rate_limited` row + an armed `alert_state` row + **counter unmoved** |
| the sweep | every token-allowed GET fetched **with bearer auth**, run through the same forbidden-provider-string and contact-field assertions as sections 2–3 |
| fresh-counts shape | every group field is a number except `group_name` |

The sweep is the point of putting this in that file: sections 2 and 3 proved the
redactor holds for a **session**, and a token takes a different path in, so it is
a fresh claim asserted the same way rather than assumed to carry over.

The rate-limit case pre-loads the counter rather than firing 300 real requests —
the counter row *is* the limiter's only state, so setting it is equivalent to
having spent it, and 300 round-trips would add minutes to every run to exercise
the same branch.

Telegram **delivery** is not asserted (that would assert Telegram is up); the
armed `alert_state` row is asserted instead.
