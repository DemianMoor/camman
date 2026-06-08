# Claude Code Brief — Link Shortener + Click Tracker

**Module:** Link shortener / click tracker (new CamMan module, first piece of the TextHub SMS integration)
**This brief covers:** Phase 0 (reconnaissance) and Phase 1 (schema + mint function).
**Companion files (the proposed implementation — adapt, don't blindly apply):** `link-tracking.schema.ts`, `link-tracking.migration.sql`, `mint-link.ts`

---

## Mission

We're adding a link shortener + click tracker to CamMan. Each outbound SMS gets a **unique short URL per recipient**; a click resolves 1:1 to (contact, campaign, stage, creative, destination) and gets logged for attribution. Bot/prefetch clicks are **classified, never deleted** — filtered at report time.

**The hard rule for this session:** Do not write or modify any code until you have completed Phase 0 and I have approved your findings. Your first job is to understand the *current* state of CamMan and flag anything that conflicts with the proposed design. The companion files reflect my assumptions about the codebase; several of those assumptions may be stale or wrong. Your discovery is the source of truth.

---

## Non-negotiables (carry through both phases)

1. **Recon before code.** Phase 0 ends with a written findings report and a STOP. No schema, no functions, no migrations until I approve.
2. **Touch only what this module needs.** Do not refactor, rename, or "improve" existing tables, the send pipeline, segments, the spam-scoring service, or anything unrelated. If the module *requires* a change to existing code, that's a conflict — flag it, don't make it.
3. **Match existing conventions over the companion files.** Naming, PK types, migration workflow, tenancy/RLS, file structure — whatever CamMan already does wins. The companion files are a starting point in *my* assumed conventions, not gospel.
4. **Idempotency and classify-don't-delete are design invariants.** Don't drop them without explicitly flagging why.

---

## Phase 0 — Reconnaissance (do this first, then STOP)

Produce a findings report (template at the end). Work through these checks. Where something differs from the companion files, note it as a reconciliation item; where it could break the design, note it as a **conflict** with a severity.

### 0.1 — Convention & product state
- Read `CLAUDE.md` and any referenced `AGENTS.md`. Summarize the conventions that apply to a new DB-backed module.
- Identify the current stack versions actually in use (Next.js, Drizzle, Supabase client, the Postgres driver — `postgres-js` vs `node-postgres`). The mint function's `.execute()` row access depends on which driver this is.
- Skim recent migrations / changelog / git log for the data layer so you know what's changed recently and don't collide with in-flight work.

### 0.2 — Data model inventory
- List the existing tables this module references: **brands, offers, campaigns, stages, creatives, contacts.** For each, record the **exact PK type** (the companion schema assumes `bigint` — if any are `uuid`/`serial`/`integer`, every FK column must change to match).
- Confirm the **naming convention** (snake_case columns, plural table names, timestamp column style, `withTimezone`, default-now pattern).
- Confirm the **migration workflow**: drizzle-kit `generate` + `migrate`/`push`? Where do custom raw-SQL migrations (like `CREATE SEQUENCE link_code_seq`) fit? Does the workflow support them, or do they need a different home?

### 0.3 — Tenancy & access
- How is **multi-tenancy** enforced on existing tables — RLS policies, an `account_id`/`org_id`/`tenant_id` column, app-layer scoping? The companion schema adds **none of this** — determine what the new tables need to match the rest of the product, and flag it. (Note for later: the Phase 2 redirect endpoint is public and will need to write `clicks` via a service-role/admin client or a dedicated policy.)
- Confirm how the three Supabase client factories (browser/server/admin) are used, so the module writes through the right one.

### 0.4 — Conflict hunt (the important part)
Search the codebase and DB for each of these and report what you find:
- **Table-name collisions.** `links`, `clicks`, `short_domains`, `link_destinations` — do any already exist or clash with existing names? `links`/`clicks` are generic; if there's any risk, propose a prefix (e.g. `lt_links`) rather than guessing.
- **An existing shortener / tracking implementation.** There was earlier exploration of a self-hosted URL shortener — check for any existing link/url/shortcode/click/tracking tables, routes, or libs that this would duplicate or fight with.
- **Tracking-ID source of truth.** Find where the campaign tracking ID (`<brand_id>_<offer_id>_<MMDDYY>_<seq>`) and stage tracking ID (`<campaign_tracking_id>_s<stage_number>_c<creative_id>`) are generated. Confirm the format is still accurate, and that we can read both at mint time (the schema denormalizes copies onto `links`).
- **`creative_id` always present?** The idempotency key and tracking-ID format assume every tracked send has a creative. Verify stages always carry a creative; if some don't, flag it (the NOT NULL + unique index would break).
- **Idempotency semantics.** The unique index `(stage, creative, contact)` means "one link per recipient per stage/creative, forever" — a resend reuses the same link. **Confirm this is desired.** If the business ever legitimately re-sends the same stage+creative to a contact and wants those clicks tracked *separately*, this key is wrong and we need a send-attempt dimension. This is a decision for me, not for you to resolve — surface it.
- **Route collision (Phase 2 heads-up).** Note where a short-code redirect route would live in the app router and whether the path pattern would collide with existing routes. No action now — just flag.
- **`sqids` dependency.** Confirm it's installable / not already present under a conflicting version.

### 0.5 — Findings report + STOP
Write up the report (template below). End with the conflict list and **wait for my approval.** Do not start Phase 1.

---

## Phase 1 — Build (only after I approve the Phase 0 report)

Implement against the *reconciled* conventions, not the raw companion files:

1. **Schema** — the four tables from `link-tracking.schema.ts`, adjusted for: real PK/FK types, naming convention, tenancy/RLS, and any agreed table-name prefix. Keep the design invariants: skinny `links`, deduped `link_destinations`, idempotency unique index on `(stage, creative, contact)`, `clicks` defined but unwired.
2. **Sequence migration** — `link_code_seq` via the project's migration mechanism (from 0.2), plus FK constraints once PK types are confirmed.
3. **Mint function** — `mint-link.ts` adapted to the real Drizzle client and the actual driver's `.execute()` row shape. Keep it idempotent and transactional. Wire `LINK_SQIDS_ALPHABET` per the project's env convention; generate the alphabet once (one-liner in the file header) and tell me the value to store.
4. **A focused test** — mint twice for the same `(stage, creative, contact)` and assert the second returns `reused: true` with the identical code; mint for two contacts and assert distinct codes. Use the project's existing test setup.

Then summarize what changed, what to run (install, migrate, env), and how you verified it.

---

## Out of scope (do not do)

- The redirect service and click logging (Phase 2 — separate brief).
- Any TextHub API calls or send-worker code.
- Bot-scoring logic (Phase 3).
- Edits to existing modules, the send pipeline, segments, or the spam service.

---

## Findings report template

```
## Phase 0 Findings — Link Shortener Module

### Stack & conventions
- Versions: ...
- Postgres driver: ... (affects mint .execute() row access)
- Migration workflow: ... (can it run a raw CREATE SEQUENCE? where?)
- Naming / timestamp / tenancy conventions: ...

### Referenced tables (PK types)
- brands: <pk type> | campaigns: ... | stages: ... | creatives: ... | contacts: ... | offers: ...

### Tenancy
- How enforced: ... | What new tables need: ...

### Tracking IDs
- Campaign format confirmed: y/n, generated at: <path>
- Stage format confirmed: y/n, readable at mint time: y/n
- creative_id always present: y/n

### CONFLICTS (severity: blocker / needs-decision / minor)
1. [severity] <description> — proposed handling: ...
2. ...

### Reconciliation items (non-blocking adjustments to the companion files)
- ...

### Open questions for you
- Idempotency: resends reuse the same link — confirm desired? ...
- ...

>>> STOPPING for approval before Phase 1.
```
