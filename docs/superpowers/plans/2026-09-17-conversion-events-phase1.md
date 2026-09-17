# Conversion Events — Phase 1 (ledger data model + backfill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `conversion_events` ledger (one row per Keitaro conversion), an org-scoped `event_types` registry and a per-network/offer `conversion_event_mappings` table, then backfill the whole Keitaro history into it and prove the totals against Keitaro. No reader changes.

**Architecture:** One additive migration (0181) creates the three tables plus `offers.keitaro_offer_id`, and seeds event types and the known networks' mappings. A new `lib/conversions/` module does four things:
- fetches every Keitaro conversion (all types, with `tid`/`params`/`conversion_type`/`status_history`)
- parses and resolves it in pure functions
- attributes it recipient → stage → offer
- maps (network/offer, Keitaro conversion type) → (event type, lifecycle status), then upserts keyed on Keitaro `event_id`

A dry-run-by-default backfill script drives it over 7-day windows. A read-only verify script compares the ledger against a fresh Keitaro pull and prints the deltas against today's two sources. Existing pollers and readers are untouched; Phase 2 wires the ledger into the poll.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle ORM 0.45.2 (hand-authored SQL migrations) · Postgres (Supabase, transaction pooler) · tsx verification scripts (no test framework — `check()` PASS/FAIL scripts, exit 1 on failure).

**Spec / recon:** [docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md](../specs/2026-09-17-multi-event-conversions-recon.md) (including the "Decisions" section).

## Global Constraints

- Built from `origin/main` (`39f2b4d` at planning time). Branch `feat/conversion-events-p1` off `origin/main`, never local `main`.
- **Migration is additive only and stays behind the manual prod gate.** Commit the file → push → the preview deploy migrates camman-v2 → the user approves → `npm run db:migrate` on prod → `npx tsx scripts/verify-migration-integrity.ts`. Merge ≠ apply.
- **The backfill writes prod data:** dry-run first, `--apply` only after explicit user approval.
- **DB tests run against camman-v2 (`.env.demo` `DATABASE_URL`), never prod.** Each DB test script refuses the prod project ref `rtdarhkkjwcetlmruftl`.
- Every domain table has `org_id` + RLS enabled + a `SELECT … USING (org_id = public.current_org_id())` policy (pattern: `0178_operator_rollups.sql`).
- Timestamps are `TIMESTAMPTZ`. Keitaro datetimes are ET wall-clock strings, converted in SQL as `(text || ' ' || 'America/New_York')::timestamptz` with the text bound as `::text` (pattern: `lib/keitaro/poll-conversions.ts:235`).
- Money is `NUMERIC(12,4)`.
- Event transport (updated 2026-09-17): PsychoBook sends `status=lead` for registrations and `status=sale` for paid purchases, on two separate postback URLs. Keitaro's built-in `Registration` type stays mapped in case a `registration_status`-style remap becomes available. There is no `event=` param.
- Status mapping is per network/offer, never global:
  - Sweeply `lead` → purchase/approved
  - Everflow (Secco) `sale` → purchase/approved
  - PsychoBook `lead` → registration/approved, `sale` → purchase/approved (user update: two separate postback URLs, sale only after payment)
  - `rejected` → rejected
  - Unknown network/type → `event_type_id` NULL and `status` NULL — never a purchase.
- Revenue and EPC will be approved-only (Phase 3). Pending revenue will be shown separately (Phase 3/5). Nothing in Phase 1 reads the ledger.
- Backfill source is Keitaro history. The three corrections vs today's sources are accepted and are printed, not asserted away:
  - +$715 per recipient
  - −$100 stage-day
  - 26 conversions / $1,463 known at stage level but with no recipient
- Never interpolate a JS array into a Drizzle `sql` template; use the query builder (`inArray`, `.values([...])`).
- In `ON CONFLICT … SET` expressions, write `conversion_events.col` / `excluded.col` literally; don't use `${table.col}`.
- Snapshot convention: clone `0180_snapshot.json` → `0181_snapshot.json`, bumping only `id`/`prevId`. The journal `when` is the previous value + 86400000.
- Lint only changed files (`npx eslint <files>`). `npm run lint` walks other worktrees.
- Docs are part of done (CLAUDE.md "Documentation maintenance").
- Commit trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Design decisions made in this plan (flagged for approval)

1. **The mapping key is Keitaro's conversion _type_ name** (`conversion_type`, lowercased: `lead`, `sale`, `rejected`, `trash`, `registration`, `deposit`), not the raw `status` string. Keitaro resolves many raw statuses into one type (`Sale` = `sale`/`approved`/`confirmed`/…), so the type is canonical. The raw status is stored for audit.
2. **An event type is sticky once set** (amended at approval, 2026-09-17). An in-place update keeps the row's `event_type_id` (`COALESCE(existing, new)`) and takes the new `status`. The new raw `keitaro_status`/`keitaro_type` are always stored.
   - **The change is not silent.** When the mapping for the incoming type names a *different* event type than the locked one (e.g. Registration → Sale on a reused tid), the upsert records it in `conflicting_event_type_id` + `event_type_conflict_at`.
   - The ingest result counts it, the backfill fails on it, and the verify script asserts none exist. Phase 2 alerts on it.
   - A status-only mapping (NULL event type) neither raises nor clears a conflict; an agreeing mapping clears it.
   - Affise `rejected` is seeded with **no event type**, so a declined registration stays a registration and a declined purchase stays a purchase.
   - A conversion first seen as `rejected` on Affise is stored unmapped and alerted (Phase 2).
3. **PsychoBook (`psb`) is NOT the Affise lead=pending pattern** (user update, 2026-09-17). The advertiser can only send `status=lead` or `status=sale`, via two separate postback URLs: **lead = registration ($0), sale = paid purchase** (sent only after payment, no hold). Seeds:
   - `lead` → registration/approved
   - `sale` → purchase/approved
   - `registration` → registration/approved (harmless if never used)
   - `rejected` → status-only

   Both live psb conversions arrive under Keitaro network #5 "Affise.com PsychoBook" (offer #41). The mapping keys on the **CamMan** network `psb`, reached through the stage's campaign offer (134) or `offers.keitaro_offer_id`, so the Keitaro network id never enters the key.
4. **Property Leads (`pl`) is seeded** (amended at approval). Its Keitaro network exists (#4, created 2026-09-08, offer #37 "Ziggy Buys Houses" = CamMan offer 130 `zbh`, zero conversions ever).
   - Its postback template is bare (no status macro, no status mapping), so nothing says what its statuses mean. The seed mirrors today's treatment: `lead` → purchase/approved, `sale` → purchase/approved, `rejected` → purchase/rejected. That's lead-gen CPA, where the lead is the payable event.
   - Adcombo exists in Keitaro but has no CamMan offers, so its conversions are unresolvable and reported, not stored.
5. **`occurred_at` = the earliest `status_history` timestamp** (original conversion time) and never moves; `last_postback_at` tracks re-posts. This is the stable date the bug-2 PR will aggregate by.
6. **Ledger FKs to stage_send/contact/campaign/stage/offer are `ON DELETE SET NULL`**, so deleting a contact or campaign never erases revenue history. `keitaro_stage_results` cascades; this deliberately does not.
7. **Mappings are seeded in the migration** (resolved by `affiliate_networks.network_id` code), so they pass the same prod gate. There is no admin UI in this card; later config changes are SQL (documented in the feature doc).
8. **The tier CHECK widening (decision 5) moves to Phase 4's migration**, where the Registered lane that uses it is built and tested. Phase 1 stays a pure ledger migration.

## File Structure

| File | Responsibility |
|---|---|
| `db/migrations/0181_conversion_events.sql` (create) | tables, indexes, RLS, `offers.keitaro_offer_id`, seeds |
| `db/migrations/meta/0181_snapshot.json` (create), `_journal.json` (modify) | migration bookkeeping |
| `db/schema.ts` (modify) | Drizzle declarations for the three tables + `offers.keitaro_offer_id` |
| `lib/keitaro/client.ts` (modify) | `KEITARO_LEDGER_COLUMNS`, `fetchKeitaroConversionLedger` (all types, truncation guard) |
| `lib/conversions/keitaro-row.ts` (create) | pure: parse a Keitaro row, original-time rule, ET day windows |
| `lib/conversions/build-rows.ts` (create) | pure: mapping resolution, attribution, insert-row building |
| `lib/conversions/ingest.ts` (create) | DB: lookups, upsert, `ingestKeitaroConversions` orchestrator |
| `scripts/test-conversion-ledger-rows.ts` (create) | pure unit checks for the two pure modules |
| `scripts/test-conversion-events-upsert.ts` (create) | rolled-back DB checks of upsert semantics (camman-v2 only) |
| `scripts/backfill-conversion-events.ts` (create) | dry-run / `--apply` backfill over Keitaro history |
| `scripts/verify-conversion-events.ts` (create) | read-only: ledger vs live Keitaro + printed deltas |
| `docs/04-features/conversion-events.md` (create) + `03-data-model.md`, `06-integrations.md`, `07-conventions.md`, `CHANGELOG.md` (modify) | docs |

---

### Task 1: Migration 0181 + Drizzle schema

**Files:**
- Create: `db/migrations/0181_conversion_events.sql`
- Create: `db/migrations/meta/0181_snapshot.json`
- Modify: `db/migrations/meta/_journal.json` (append entry)
- Modify: `db/schema.ts` (offers block ~`:208-252`; append new tables at end of file)

**Interfaces:**
- Produces: tables `event_types`, `conversion_event_mappings`, `conversion_events`; column `offers.keitaro_offer_id`. Drizzle exports `event_types`, `conversion_event_mappings`, `conversion_events`, types `EventType`, `ConversionEventMapping`, `ConversionEvent`.

- [ ] **Step 1: Create the branch in the recon worktree**

```bash
cd C:/AFF/camman/.claude/worktrees/conv-events-recon
git fetch origin
git rev-list --count HEAD..origin/main   # expect 0; if not, re-read the files this plan cites
git checkout -b feat/conversion-events-p1 origin/main
cmd //c "mklink /J node_modules C:\AFF\camman\node_modules"
cmd //c "mklink /H .env.local C:\AFF\camman\.env.local"
```

(Unlink later with `cmd //c "rmdir node_modules"`. Never `rm -rf` a junction.)

- [ ] **Step 2: Write the migration SQL**

`db/migrations/0181_conversion_events.sql`:

```sql
-- 0181 conversion_events — one row per Keitaro conversion, so a click can carry
-- several events (registration $0, purchase, later deposit/upsell) instead of
-- stage_sends' single latest-wins sale. Plus the org's event-type registry and
-- the per-network / per-offer mapping from Keitaro conversion TYPE to
-- (event type, lifecycle status). Additive only; nothing reads these yet.
-- Recon: docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md
-- Plan:  docs/superpowers/plans/2026-09-17-conversion-events-phase1.md

CREATE TABLE IF NOT EXISTS public.event_types (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  -- Counts toward "purchased" (tier, segment purchase rules, drip close).
  is_purchase boolean NOT NULL DEFAULT false,
  -- Its revenue counts toward Revenue / EPC (approved status only, Phase 3).
  counts_revenue boolean NOT NULL DEFAULT false,
  -- Feeds the behavioural "Registered – not purchased" style lane (Phase 4).
  is_retarget_signal boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_types_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT event_types_key_format_check CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT event_types_org_key_uniq UNIQUE (org_id, key)
);
--> statement-breakpoint
ALTER TABLE public.event_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "event_types_select_own_org"
  ON public.event_types FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- Keitaro conversion TYPE (lowercased Keitaro conversion_type name: lead, sale,
-- rejected, trash, registration, deposit) → (event type, lifecycle status),
-- scoped to ONE network or ONE offer. An offer rule beats a network rule. No
-- rule ⇒ the conversion is stored with NULL event type + status (alerted in
-- Phase 2) and is never a purchase. event_type_id NULL on a rule means "status
-- transition only — keep the row's existing event type" (used for Affise
-- rejected, which can decline either a registration or a purchase).
CREATE TABLE IF NOT EXISTS public.conversion_event_mappings (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  affiliate_network_id integer REFERENCES public.affiliate_networks(id) ON DELETE CASCADE,
  offer_id integer REFERENCES public.offers(id) ON DELETE CASCADE,
  keitaro_type text NOT NULL,
  event_type_id integer REFERENCES public.event_types(id) ON DELETE RESTRICT,
  conversion_status text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversion_event_mappings_scope_check
    CHECK (num_nonnulls(affiliate_network_id, offer_id) = 1),
  CONSTRAINT conversion_event_mappings_conversion_status_check
    CHECK (conversion_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT conversion_event_mappings_status_check
    CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS conversion_event_mappings_network_type_uniq
  ON public.conversion_event_mappings (affiliate_network_id, keitaro_type)
  WHERE affiliate_network_id IS NOT NULL AND status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS conversion_event_mappings_offer_type_uniq
  ON public.conversion_event_mappings (offer_id, keitaro_type)
  WHERE offer_id IS NOT NULL AND status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_event_mappings_org_idx
  ON public.conversion_event_mappings (org_id);
--> statement-breakpoint
ALTER TABLE public.conversion_event_mappings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversion_event_mappings_select_own_org"
  ON public.conversion_event_mappings FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- One row per Keitaro conversion. keitaro_event_id is Keitaro's per-conversion
-- id: STABLE across in-place updates (a hold→approved or a re-post bumps
-- Keitaro's `version`, not the id — measured 2026-09-17), and a different tid
-- on the same click is a different conversion with its own id.
CREATE TABLE IF NOT EXISTS public.conversion_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  keitaro_event_id text NOT NULL,
  tid text,
  keitaro_click_subid text,
  -- Raw resolved Keitaro status and its canonical conversion type (mapping key).
  keitaro_status text NOT NULL,
  keitaro_type text NOT NULL,
  keitaro_version integer,
  keitaro_offer_id integer,
  -- Attribution. SET NULL (not cascade): deleting a contact or campaign must
  -- never erase revenue history.
  stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  campaign_id integer REFERENCES public.campaigns(id) ON DELETE SET NULL,
  stage_id integer REFERENCES public.campaign_stages(id) ON DELETE SET NULL,
  offer_id integer REFERENCES public.offers(id) ON DELETE SET NULL,
  -- NULL event_type_id or NULL status = unmapped: stored, alerted, never counted.
  -- event_type_id is LOCKED once set (an update never changes it).
  event_type_id integer REFERENCES public.event_types(id) ON DELETE RESTRICT,
  status text,
  -- Set when a later Keitaro type maps to a DIFFERENT event type than the
  -- locked one (e.g. Registration → Sale on a reused tid): the event type the
  -- latest mapping names, and when the disagreement was first seen. Cleared
  -- when a mapping agrees again. Monitored (Phase 2) — never silently kept.
  conflicting_event_type_id integer REFERENCES public.event_types(id) ON DELETE RESTRICT,
  event_type_conflict_at timestamptz,
  revenue numeric(12, 4) NOT NULL DEFAULT 0,
  currency text,
  -- The ORIGINAL conversion time (earliest status_history entry). Never moved
  -- by an update — Keitaro moves its own `datetime` to the latest re-post.
  occurred_at timestamptz NOT NULL,
  last_postback_at timestamptz,
  status_history text,
  raw_params jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversion_events_status_check
    CHECK (status IS NULL OR status IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS conversion_events_keitaro_event_id_uniq
  ON public.conversion_events (keitaro_event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_org_idx
  ON public.conversion_events (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_campaign_event_idx
  ON public.conversion_events (campaign_id, event_type_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_contact_event_idx
  ON public.conversion_events (contact_id, event_type_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_offer_event_occurred_idx
  ON public.conversion_events (offer_id, event_type_id, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_stage_occurred_idx
  ON public.conversion_events (stage_id, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_stage_send_idx
  ON public.conversion_events (stage_send_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_unmapped_idx
  ON public.conversion_events (org_id, created_at)
  WHERE event_type_id IS NULL OR status IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_type_conflict_idx
  ON public.conversion_events (org_id, event_type_conflict_at)
  WHERE conflicting_event_type_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.conversion_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversion_events_select_own_org"
  ON public.conversion_events FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- Keitaro's offer id (e.g. Psycho Book = 41), so a conversion with no resolvable
-- click can still be attributed to a CamMan offer. offers.offer_id is a short
-- code ('psb'), not Keitaro's id.
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS keitaro_offer_id integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS offers_org_keitaro_offer_id_uniq
  ON public.offers (org_id, keitaro_offer_id)
  WHERE keitaro_offer_id IS NOT NULL;
--> statement-breakpoint
-- Seed: every org gets purchase + registration.
INSERT INTO public.event_types
  (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
SELECT o.id, v.key, v.label, v.display_order, v.is_purchase, v.counts_revenue, v.is_retarget_signal
FROM public.organizations o
CROSS JOIN (VALUES
  ('purchase', 'Purchase', 10, true, true, false),
  ('registration', 'Registration', 20, false, false, true)
) AS v(key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
ON CONFLICT (org_id, key) DO NOTHING;
--> statement-breakpoint
-- Seed: network-level mappings, resolved by network CODE (a missing code — e.g.
-- on the preview DB — inserts nothing). Recorded decisions 2026-09-17:
--   swp Sweeply  — template hardcodes status=lead for PAID conversions
--   scc Secco    — Everflow template status={status}; only `sale` observed
--   psb PsychoBook (Affise, Keitaro network #5) — the advertiser can only send
--                  status=lead or status=sale, via two separate postback URLs:
--                  lead = REGISTRATION ($0), sale = paid purchase (sent only
--                  after payment, no hold). NOT the Affise lead=pending pattern.
--                  registration (Keitaro built-in type) seeded too, harmless if
--                  never used; rejected = status-only (keeps the event type)
--   pl  Property Leads — Keitaro network #4 exists (bare postback template, no
--                  status mapping, zero conversions as of 2026-09-17); seeded
--                  with today's treatment — lead-gen CPA, the lead is payable
INSERT INTO public.conversion_event_mappings
  (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status)
SELECT n.org_id, n.id, v.keitaro_type, et.id, v.conversion_status
FROM (VALUES
  ('pl',  'lead',         'purchase',     'approved'),
  ('pl',  'sale',         'purchase',     'approved'),
  ('pl',  'rejected',     'purchase',     'rejected'),
  ('swp', 'lead',         'purchase',     'approved'),
  ('swp', 'rejected',     'purchase',     'rejected'),
  ('scc', 'sale',         'purchase',     'approved'),
  ('scc', 'rejected',     'purchase',     'rejected'),
  ('psb', 'lead',         'registration', 'approved'),
  ('psb', 'sale',         'purchase',     'approved'),
  ('psb', 'rejected',     NULL,           'rejected'),
  ('psb', 'registration', 'registration', 'approved')
) AS v(network_code, keitaro_type, event_key, conversion_status)
JOIN public.affiliate_networks n ON n.network_id = v.network_code
LEFT JOIN public.event_types et ON et.org_id = n.org_id AND et.key = v.event_key
ON CONFLICT DO NOTHING;
```

- [ ] **Step 3: Snapshot + journal**

```bash
node -e 'const fs=require("fs");const p="db/migrations/meta/";const s=JSON.parse(fs.readFileSync(p+"0180_snapshot.json","utf8"));s.prevId=s.id;s.id="0181a000-0181-4181-8181-000000000181";fs.writeFileSync(p+"0181_snapshot.json",JSON.stringify(s,null,2)+"\n");const j=JSON.parse(fs.readFileSync(p+"_journal.json","utf8"));const last=j.entries[j.entries.length-1];if(last.idx!==180)throw new Error("journal tail is "+last.idx);j.entries.push({idx:181,version:"7",when:last.when+86400000,tag:"0181_conversion_events",breakpoints:true});fs.writeFileSync(p+"_journal.json",JSON.stringify(j,null,2)+"\n");'
git diff --stat db/migrations/meta/_journal.json
node -e 'const a=require("./db/migrations/meta/0180_snapshot.json"),b=require("./db/migrations/meta/0181_snapshot.json");console.log(b.prevId===a.id, b.id)'
```

Expected: `_journal.json | 7 +++++++`, then `true 0181a000-0181-4181-8181-000000000181`. If the journal diff shows whitespace churn beyond the new entry, restore it with `git checkout db/migrations/meta/_journal.json` and add the entry by hand to match the existing formatting.

- [ ] **Step 4: Drizzle schema**

In `db/schema.ts`, in the `offers` column object, add after `payout_revshare`:

```ts
    // Migration 0181: Keitaro's offer id (Psycho Book = 41). offer_id above is
    // CamMan's short code ('psb'), not Keitaro's. Lets a conversion with no
    // resolvable click still land on a CamMan offer.
    keitaro_offer_id: integer("keitaro_offer_id"),
```

and in the `offers` table extras array, after `index("offers_network_id_idx")…`:

```ts
    uniqueIndex("offers_org_keitaro_offer_id_uniq")
      .on(table.org_id, table.keitaro_offer_id)
      .where(sql`keitaro_offer_id IS NOT NULL`),
```

Append at the end of `db/schema.ts`:

```ts
// ============ Conversion events (migration 0181) ============
// docs/04-features/conversion-events.md. One row per Keitaro conversion; the
// event-type registry and the network/offer mapping that classifies it.
export const event_types = pgTable(
  "event_types",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    display_order: integer("display_order").notNull().default(0),
    is_purchase: boolean("is_purchase").notNull().default(false),
    counts_revenue: boolean("counts_revenue").notNull().default(false),
    is_retarget_signal: boolean("is_retarget_signal").notNull().default(false),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("event_types_org_key_uniq").on(table.org_id, table.key),
    check("event_types_status_check", sql`${table.status} IN ('active', 'archived')`),
    check("event_types_key_format_check", sql`${table.key} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

export type EventType = typeof event_types.$inferSelect;

export const conversion_event_mappings = pgTable(
  "conversion_event_mappings",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    affiliate_network_id: integer("affiliate_network_id").references(
      () => affiliate_networks.id,
      { onDelete: "cascade" },
    ),
    offer_id: integer("offer_id").references(() => offers.id, {
      onDelete: "cascade",
    }),
    // Lowercased Keitaro conversion_type name: lead/sale/rejected/trash/registration/deposit.
    keitaro_type: text("keitaro_type").notNull(),
    // NULL = status transition only; the conversion keeps its existing event type.
    event_type_id: integer("event_type_id").references(() => event_types.id, {
      onDelete: "restrict",
    }),
    conversion_status: text("conversion_status").notNull(),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversion_event_mappings_org_idx").on(table.org_id),
    uniqueIndex("conversion_event_mappings_network_type_uniq")
      .on(table.affiliate_network_id, table.keitaro_type)
      .where(sql`affiliate_network_id IS NOT NULL AND status = 'active'`),
    uniqueIndex("conversion_event_mappings_offer_type_uniq")
      .on(table.offer_id, table.keitaro_type)
      .where(sql`offer_id IS NOT NULL AND status = 'active'`),
    check(
      "conversion_event_mappings_scope_check",
      sql`num_nonnulls(${table.affiliate_network_id}, ${table.offer_id}) = 1`,
    ),
    check(
      "conversion_event_mappings_conversion_status_check",
      sql`${table.conversion_status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      "conversion_event_mappings_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type ConversionEventMapping = typeof conversion_event_mappings.$inferSelect;

export const conversion_events = pgTable(
  "conversion_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Stable across Keitaro in-place updates; a new tid is a new id.
    keitaro_event_id: text("keitaro_event_id").notNull(),
    tid: text("tid"),
    keitaro_click_subid: text("keitaro_click_subid"),
    keitaro_status: text("keitaro_status").notNull(),
    keitaro_type: text("keitaro_type").notNull(),
    keitaro_version: integer("keitaro_version"),
    keitaro_offer_id: integer("keitaro_offer_id"),
    // SET NULL, not cascade: deleting a contact/campaign never erases revenue.
    stage_send_id: uuid("stage_send_id").references(() => stage_sends.id, {
      onDelete: "set null",
    }),
    contact_id: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    campaign_id: integer("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    stage_id: integer("stage_id").references(() => campaign_stages.id, {
      onDelete: "set null",
    }),
    offer_id: integer("offer_id").references(() => offers.id, {
      onDelete: "set null",
    }),
    // NULL event_type_id or NULL status = unmapped: stored, alerted, never counted.
    // event_type_id is LOCKED once set; an update never changes it.
    event_type_id: integer("event_type_id").references(() => event_types.id, {
      onDelete: "restrict",
    }),
    status: text("status"),
    // A later Keitaro type mapped to a DIFFERENT event type than the locked one
    // (e.g. Registration → Sale on a reused tid). Cleared when a mapping agrees.
    conflicting_event_type_id: integer("conflicting_event_type_id").references(
      () => event_types.id,
      { onDelete: "restrict" },
    ),
    event_type_conflict_at: timestamp("event_type_conflict_at", { withTimezone: true }),
    revenue: numeric("revenue", { precision: 12, scale: 4 }).notNull().default("0"),
    currency: text("currency"),
    // ORIGINAL conversion time (earliest status_history entry); never moved.
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),
    last_postback_at: timestamp("last_postback_at", { withTimezone: true }),
    status_history: text("status_history"),
    raw_params: jsonb("raw_params").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("conversion_events_keitaro_event_id_uniq").on(table.keitaro_event_id),
    index("conversion_events_org_idx").on(table.org_id),
    index("conversion_events_campaign_event_idx").on(
      table.campaign_id,
      table.event_type_id,
      table.contact_id,
    ),
    index("conversion_events_contact_event_idx").on(table.contact_id, table.event_type_id),
    index("conversion_events_offer_event_occurred_idx").on(
      table.offer_id,
      table.event_type_id,
      table.occurred_at,
    ),
    index("conversion_events_stage_occurred_idx").on(table.stage_id, table.occurred_at),
    index("conversion_events_stage_send_idx").on(table.stage_send_id),
    index("conversion_events_unmapped_idx")
      .on(table.org_id, table.created_at)
      .where(sql`event_type_id IS NULL OR status IS NULL`),
    index("conversion_events_type_conflict_idx")
      .on(table.org_id, table.event_type_conflict_at)
      .where(sql`conflicting_event_type_id IS NOT NULL`),
    check(
      "conversion_events_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
  ],
);

export type ConversionEvent = typeof conversion_events.$inferSelect;
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: exit 0, no output.

- [ ] **Step 6: Commit, push, open a draft PR (the preview deploy migrates camman-v2)**

```bash
git add db/migrations/0181_conversion_events.sql db/migrations/meta/0181_snapshot.json db/migrations/meta/_journal.json db/schema.ts
git commit -m "feat(conversions): migration 0181 — conversion_events ledger, event_types, mappings

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/conversion-events-p1
gh pr create --draft --title "Conversion events ledger — Phase 1 (migration 0181 + backfill)" --body "Phase 1 of multi-event conversions. Plan: docs/superpowers/plans/2026-09-17-conversion-events-phase1.md. Migration is additive and NOT applied to prod (manual gate).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 7: Confirm the preview DB migrated**

After the preview deployment for the branch is READY, run this read-only query on camman-v2 (Supabase MCP `execute_sql`, project `fdzxzxayhknywvmrhjcj`):

```sql
SELECT to_regclass('public.conversion_events') IS NOT NULL AS ce,
       to_regclass('public.event_types') IS NOT NULL AS et,
       to_regclass('public.conversion_event_mappings') IS NOT NULL AS cem,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='offers' AND column_name='keitaro_offer_id') AS offers_col,
       (SELECT count(*) FROM public.event_types) = 2 * (SELECT count(*) FROM public.organizations) AS event_types_seeded,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.conversion_events'::regclass) AS rls;
```

Expected: every column `true` / `1`. If the preview build didn't migrate (`RUN_PREVIEW_MIGRATIONS` unset), stop and tell the user. Don't apply to v2 by hand without asking.

---

### Task 2: Keitaro ledger fetch + pure row parser

**Files:**
- Modify: `lib/keitaro/client.ts` (append after `fetchKeitaroConversions`, ~`:234`)
- Create: `lib/conversions/keitaro-row.ts`
- Test: `scripts/test-conversion-ledger-rows.ts`

**Interfaces:**
- Produces:
  - `KEITARO_LEDGER_COLUMNS`
  - `fetchKeitaroConversionLedger(range: KeitaroReportRange, opts?: { timeoutMs?: number }): Promise<KeitaroLedgerResult>` where `KeitaroLedgerResult = { ok; status; rows: KeitaroReportRow[]; total: number | null; error }`
  - `interface LedgerSourceRow`
  - `parseKeitaroLedgerRow(row: KeitaroReportRow): LedgerSourceRow | null`
  - `originalConversionTimeEt(statusHistory: string | null, datetime: string): string`
  - `etDayWindows(fromDate: string, nowEt: string, days: number): KeitaroReportRange[]`

- [ ] **Step 1: Write the failing test**

`scripts/test-conversion-ledger-rows.ts`:

```ts
// Pure checks for lib/conversions/keitaro-row.ts and lib/conversions/build-rows.ts.
// No DB, no network. Run: npx tsx scripts/test-conversion-ledger-rows.ts
import {
  etDayWindows,
  originalConversionTimeEt,
  parseKeitaroLedgerRow,
} from "../lib/conversions/keitaro-row";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Shape copied from a live conversions/log row (2026-09-17 probe).
const sweeply = {
  event_id: "019f6639-4c78-7104-8129-376c79e45ef7",
  tid: "",
  sub_id: "2odk4rt.3.snk",
  sub_id_1: "E0E19133-D9CD-4B6C-BD77-294F7ADA505F",
  sub_id_3: "8_62_071426_1_s1_c231",
  status: "lead",
  conversion_type: "Lead",
  revenue: 75,
  datetime: "2026-07-15 10:40:59",
  status_history: "1. Lead (2026-07-15 10:40:59)",
  params: { subid: "2odk4rt.3.snk", status: "lead", payout: "75", currency: "usd", from: "Sweeply.pro" },
  offer_id: 1,
  version: 1,
};

console.log("keitaro-row");
const p = parseKeitaroLedgerRow(sweeply);
check("P1 valid row parses", p !== null);
check("P2 type is the lowercased conversion_type", p?.keitaroType === "lead");
check("P3 revenue is a 4dp string", p?.revenue === "75.0000", String(p?.revenue));
check("P4 currency comes from params, uppercased", p?.currency === "USD");
check("P5 sub_id_1 lowercased (stage_sends ids are lowercase)", p?.subId1 === "e0e19133-d9cd-4b6c-bd77-294f7ada505f");
check("P6 empty tid is null", p?.tid === null);
check("P7 unchanged row: occurred = datetime", p?.occurredAtEt === "2026-07-15 10:40:59" && p?.lastPostbackAtEt === "2026-07-15 10:40:59");

const reposted = parseKeitaroLedgerRow({
  ...sweeply,
  datetime: "2026-09-17 07:13:52",
  status_history: "1. Lead (2026-09-14 21:45:32)",
  version: 2,
});
check("P8 re-posted row keeps the ORIGINAL time", reposted?.occurredAtEt === "2026-09-14 21:45:32", String(reposted?.occurredAtEt));
check("P9 re-posted row records the latest postback", reposted?.lastPostbackAtEt === "2026-09-17 07:13:52");

check(
  "P10 multi-entry history in either order → earliest",
  originalConversionTimeEt("2. Sale (2026-09-20 10:00:00) 1. Lead (2026-09-18 09:00:00)", "2026-09-20 10:00:00") === "2026-09-18 09:00:00",
);
check("P11 no history → datetime", originalConversionTimeEt(null, "2026-09-01 00:00:00") === "2026-09-01 00:00:00");
check("P12 missing event_id → null", parseKeitaroLedgerRow({ ...sweeply, event_id: "" }) === null);
check("P13 missing conversion_type → null", parseKeitaroLedgerRow({ ...sweeply, conversion_type: undefined }) === null);
check("P14 malformed datetime → null", parseKeitaroLedgerRow({ ...sweeply, datetime: "2026-09-17T07:13:52Z" }) === null);
check("P15 Keitaro offer 0 (no offer) → null", parseKeitaroLedgerRow({ ...sweeply, offer_id: 0 })?.keitaroOfferId === null);

const w = etDayWindows("2026-06-01", "2026-06-16 12:00:00", 7);
check(
  "W1 contiguous 7-day ET windows ending at now",
  w.length === 3 &&
    w[0].from === "2026-06-01 00:00:00" && w[0].to === "2026-06-07 23:59:59" &&
    w[1].from === "2026-06-08 00:00:00" && w[1].to === "2026-06-14 23:59:59" &&
    w[2].from === "2026-06-15 00:00:00" && w[2].to === "2026-06-16 12:00:00" &&
    w.every((x) => x.timezone === "America/New_York"),
  JSON.stringify(w),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/test-conversion-ledger-rows.ts`
Expected: FAIL — `Cannot find module '../lib/conversions/keitaro-row'`.

- [ ] **Step 3: Add the ledger fetch to `lib/keitaro/client.ts`**

Append after `fetchKeitaroConversions` (before the `// ── Clicks log` banner):

```ts
// ── Conversion ledger (lib/conversions/ingest.ts) ────────────────────────────
// EVERY conversion, ALL conversion types — no status filter. Registration /
// deposit / trash are classified by conversion_event_mappings, not by this
// fetch. Columns verified live 2026-09-17 (a bad column's 400 body lists the
// whole 'events' definition). Note some names are ACCEPTED but silently not
// returned (original_status, previous_status, conversion_id, postback_datetime)
// — a 200 does not prove a column exists.
//   tid             — transaction id; a different tid on one click = separate conversion
//   sub_id          — Keitaro's click id
//   conversion_type — canonical type NAME (Lead/Sale/Rejected/Trash/Registration/
//                     Deposit): the mapping key, since many raw statuses resolve to one type
//   version         — bumps when Keitaro updates a conversion IN PLACE (event_id stays)
//   status_history  — "1. Lead (YYYY-MM-DD HH:MM:SS)" in the report timezone
//   params          — the postback query as JSON (currency lives here)
export const KEITARO_LEDGER_COLUMNS = [
  "event_id",
  "tid",
  "sub_id",
  "sub_id_1",
  "sub_id_3",
  "status",
  "conversion_type",
  "revenue",
  "datetime",
  "status_history",
  "params",
  "offer_id",
  "version",
] as const;

export interface KeitaroLedgerResult {
  ok: boolean;
  status: number;
  rows: KeitaroReportRow[];
  total: number | null;
  error: string | null;
}

// Same never-throw contract as fetchKeitaroConversions. Fails (ok:false) when the
// response carries fewer rows than its own `total` — a truncated page must never
// be ingested as if it were the whole window.
export async function fetchKeitaroConversionLedger(
  range: KeitaroReportRange,
  opts?: { timeoutMs?: number },
): Promise<KeitaroLedgerResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, rows: [], total: null, error: "KEITARO_API_KEY is not set" };
  }

  try {
    const res = await fetch(`${baseUrl()}/admin_api/v1/conversions/log`, {
      method: "POST",
      headers: { "Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ range, columns: KEITARO_LEDGER_COLUMNS, filters: [] }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        rows: [],
        total: null,
        error: `Keitaro conversions/log HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const body = (await res.json().catch(() => null)) as
      | { rows?: unknown; total?: unknown }
      | null;
    const rows = Array.isArray(body?.rows) ? (body.rows as KeitaroReportRow[]) : [];
    const total = typeof body?.total === "number" ? body.total : null;
    if (total !== null && rows.length < total) {
      return {
        ok: false,
        status: res.status,
        rows: [],
        total,
        error: `Keitaro conversions/log truncated: ${rows.length} of ${total} rows`,
      };
    }
    return { ok: true, status: res.status, rows, total, error: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      rows: [],
      total: null,
      error: aborted
        ? "Keitaro conversions/log timed out"
        : `Keitaro conversions/log network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
```

- [ ] **Step 4: Write `lib/conversions/keitaro-row.ts`**

```ts
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import type { KeitaroReportRange, KeitaroReportRow } from "@/lib/keitaro/client";

// One Keitaro conversion normalised for the conversion_events ledger. Pure — no
// DB, no env — so every parsing rule is checked by
// scripts/test-conversion-ledger-rows.ts.
export interface LedgerSourceRow {
  eventId: string;
  tid: string | null;
  clickSubid: string | null;
  subId1: string | null; // lowercased; = stage_sends.id when the click was ours
  subId3: string | null; // = campaign_stages.tracking_id
  keitaroStatus: string; // lowercased raw resolved status
  keitaroType: string; // lowercased conversion_type name — the mapping key
  revenue: string; // NUMERIC string, 4dp
  currency: string | null;
  occurredAtEt: string; // ORIGINAL conversion time, "YYYY-MM-DD HH:MM:SS" ET
  lastPostbackAtEt: string; // Keitaro's current `datetime`
  keitaroOfferId: number | null;
  version: number | null;
  statusHistory: string | null;
  rawParams: Record<string, unknown> | null;
}

const ET_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const HISTORY_TS_RE = /\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)/g;

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function int(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

// Keitaro moves a conversion's `datetime` to the LATEST postback when it updates
// the conversion in place (measured 2026-09-17: a re-post moved one from 09-14 to
// 09-17). status_history keeps each transition as "N. Type (YYYY-MM-DD HH:MM:SS)"
// in the report timezone (equal to `datetime` on all 1,458 never-updated rows),
// so its EARLIEST stamp is the original time. Earliest rather than first-listed:
// the listing order of a multi-entry history is not verified.
export function originalConversionTimeEt(
  statusHistory: string | null,
  datetime: string,
): string {
  if (!statusHistory) return datetime;
  const stamps = [...statusHistory.matchAll(HISTORY_TS_RE)].map((m) => m[1]);
  if (stamps.length === 0) return datetime;
  return stamps.reduce((a, b) => (b < a ? b : a));
}

export function parseKeitaroLedgerRow(row: KeitaroReportRow): LedgerSourceRow | null {
  const eventId = text(row.event_id);
  const datetime = text(row.datetime);
  const keitaroStatus = text(row.status)?.toLowerCase() ?? null;
  const keitaroType = text(row.conversion_type)?.toLowerCase() ?? null;
  if (!eventId || !datetime || !ET_DATETIME_RE.test(datetime) || !keitaroStatus || !keitaroType) {
    return null;
  }
  const revenue = typeof row.revenue === "number" ? row.revenue : Number(row.revenue ?? 0);
  if (!Number.isFinite(revenue)) return null;
  const params =
    row.params !== null && typeof row.params === "object" && !Array.isArray(row.params)
      ? (row.params as Record<string, unknown>)
      : null;
  const statusHistory = text(row.status_history);
  const offerId = int(row.offer_id);
  return {
    eventId,
    tid: text(row.tid),
    clickSubid: text(row.sub_id),
    subId1: text(row.sub_id_1)?.toLowerCase() ?? null,
    subId3: text(row.sub_id_3),
    keitaroStatus,
    keitaroType,
    revenue: revenue.toFixed(4),
    currency: text(params?.currency)?.toUpperCase() ?? null,
    occurredAtEt: originalConversionTimeEt(statusHistory, datetime),
    lastPostbackAtEt: datetime,
    keitaroOfferId: offerId !== null && offerId > 0 ? offerId : null,
    version: int(row.version),
    statusHistory,
    rawParams: params,
  };
}

// Contiguous ET calendar-day windows of `days` days from fromDate 00:00:00 up to
// nowEt. Keitaro filters conversions/log by the conversion's current `datetime`.
export function etDayWindows(
  fromDate: string,
  nowEt: string,
  days: number,
): KeitaroReportRange[] {
  const out: KeitaroReportRange[] = [];
  const endDay = nowEt.slice(0, 10);
  const DAY = 86_400_000;
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); ; t += days * DAY) {
    const start = new Date(t).toISOString().slice(0, 10);
    if (start > endDay) break;
    const last = new Date(t + (days - 1) * DAY).toISOString().slice(0, 10);
    out.push({
      from: `${start} 00:00:00`,
      to: last >= endDay ? nowEt : `${last} 23:59:59`,
      timezone: CAMPAIGN_TIMEZONE,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/test-conversion-ledger-rows.ts`
Expected: `16 passed, 0 failed`, exit 0.

(The live Keitaro fetch + parse is exercised end-to-end by the Task 5 dry run: `invalid 0` there proves every real row parses with these columns.)

- [ ] **Step 6: Lint and commit**

```bash
npx eslint lib/keitaro/client.ts lib/conversions/keitaro-row.ts scripts/test-conversion-ledger-rows.ts
git add lib/keitaro/client.ts lib/conversions/keitaro-row.ts scripts/test-conversion-ledger-rows.ts
git commit -m "feat(conversions): Keitaro ledger fetch + pure row parser

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Mapping resolution + attribution (pure)

**Files:**
- Create: `lib/conversions/build-rows.ts`
- Test: `scripts/test-conversion-ledger-rows.ts` (extend)

**Interfaces:**
- Consumes: `LedgerSourceRow` (Task 2).
- Produces:
  - `type ConversionStatus = "pending" | "approved" | "rejected"`
  - `interface MappingRule { offerId: number | null; affiliateNetworkId: number | null; keitaroType: string; eventTypeId: number | null; conversionStatus: ConversionStatus }`
  - `resolveMapping(rules, key: { offerId; affiliateNetworkId; keitaroType }): { eventTypeId: number | null; status: ConversionStatus } | null`
  - `interface Lookups { stageSends: Map<string, { stageId: number; contactId: string }>; stageIdByTrackingId: Map<string, number>; stages: Map<number, { orgId: string; campaignId: number; offerId: number | null; affiliateNetworkId: number | null }>; offersByKeitaroId: Map<number, { orgId: string; offerId: number; affiliateNetworkId: number }>; rulesByOrg: Map<string, MappingRule[]> }`
  - `interface ConversionEventInsert` (fields listed in the code)
  - `buildConversionEventRows(sources: readonly LedgerSourceRow[], lookups: Lookups): { rows: ConversionEventInsert[]; unresolved: LedgerSourceRow[] }`

- [ ] **Step 1: Extend the test (failing)**

In `scripts/test-conversion-ledger-rows.ts`, add to the imports:

```ts
import {
  buildConversionEventRows,
  resolveMapping,
  type Lookups,
  type MappingRule,
} from "../lib/conversions/build-rows";
import type { LedgerSourceRow } from "../lib/conversions/keitaro-row";
```

and insert before the final `console.log(\`\n${passed} passed…`:

```ts
console.log("\nbuild-rows");
const ORG = "00000000-0000-4000-8000-000000000001";
const SEND = "e0e19133-d9cd-4b6c-bd77-294f7ada505f";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const PURCHASE = 1;
const REGISTRATION = 2;
const rules: MappingRule[] = [
  { offerId: null, affiliateNetworkId: 1, keitaroType: "lead", eventTypeId: PURCHASE, conversionStatus: "approved" }, // swp: lead is paid
  { offerId: null, affiliateNetworkId: 43, keitaroType: "lead", eventTypeId: REGISTRATION, conversionStatus: "approved" }, // psb: lead is a registration
  { offerId: null, affiliateNetworkId: 43, keitaroType: "sale", eventTypeId: PURCHASE, conversionStatus: "approved" },
  { offerId: null, affiliateNetworkId: 43, keitaroType: "registration", eventTypeId: REGISTRATION, conversionStatus: "approved" },
  { offerId: null, affiliateNetworkId: 43, keitaroType: "rejected", eventTypeId: null, conversionStatus: "rejected" },
];

check("M1 network rule applies (psb lead = registration)", JSON.stringify(resolveMapping(rules, { offerId: 134, affiliateNetworkId: 43, keitaroType: "lead" })) === JSON.stringify({ eventTypeId: REGISTRATION, status: "approved" }));
check(
  "M2 offer rule beats network rule",
  resolveMapping(
    [...rules, { offerId: 134, affiliateNetworkId: null, keitaroType: "lead", eventTypeId: PURCHASE, conversionStatus: "pending" }],
    { offerId: 134, affiliateNetworkId: 43, keitaroType: "lead" },
  )?.status === "pending",
);
check("M3 no rule → null", resolveMapping(rules, { offerId: 134, affiliateNetworkId: 43, keitaroType: "trash" }) === null);
check("M4 same type on another network does not leak", resolveMapping(rules, { offerId: 62, affiliateNetworkId: 38, keitaroType: "lead" }) === null);
check("M5 status-only rule keeps a null event type", JSON.stringify(resolveMapping(rules, { offerId: 134, affiliateNetworkId: 43, keitaroType: "rejected" })) === JSON.stringify({ eventTypeId: null, status: "rejected" }));

const lookups: Lookups = {
  stageSends: new Map([[SEND, { stageId: 10, contactId: CONTACT }]]),
  stageIdByTrackingId: new Map([
    ["8_62_071426_1_s1_c231", 10],
    ["143_134_091726_1_s1_c900", 11],
  ]),
  stages: new Map([
    [10, { orgId: ORG, campaignId: 100, offerId: 62, affiliateNetworkId: 1 }],
    [11, { orgId: ORG, campaignId: 101, offerId: 134, affiliateNetworkId: 43 }],
  ]),
  offersByKeitaroId: new Map([[41, { orgId: ORG, offerId: 134, affiliateNetworkId: 43 }]]),
  rulesByOrg: new Map([[ORG, rules]]),
};
const src = (over: Partial<LedgerSourceRow>): LedgerSourceRow => ({
  eventId: "ev-1",
  tid: null,
  clickSubid: "clk",
  subId1: null,
  subId3: null,
  keitaroStatus: "lead",
  keitaroType: "lead",
  revenue: "0.0000",
  currency: "USD",
  occurredAtEt: "2026-09-17 10:00:00",
  lastPostbackAtEt: "2026-09-17 10:00:00",
  keitaroOfferId: null,
  version: 1,
  statusHistory: null,
  rawParams: null,
  ...over,
});

const b1 = buildConversionEventRows([src({ subId1: SEND, subId3: "143_134_091726_1_s1_c900" })], lookups).rows[0];
check(
  "B1 recipient id wins over sub_id_3; stage/campaign/offer from the recipient's stage",
  b1?.stageSendId === SEND && b1.contactId === CONTACT && b1.stageId === 10 && b1.campaignId === 100 && b1.offerId === 62 && b1.orgId === ORG,
  JSON.stringify(b1),
);
check("B2 Sweeply lead → purchase / approved", b1?.eventTypeId === PURCHASE && b1.status === "approved");

const b3 = buildConversionEventRows([src({ subId3: "143_134_091726_1_s1_c900", keitaroType: "registration", keitaroStatus: "registration" })], lookups).rows[0];
check(
  "B3 no recipient, known stage → stage-level row, registration / approved",
  b3?.stageSendId === null && b3.contactId === null && b3.stageId === 11 && b3.offerId === 134 && b3.eventTypeId === REGISTRATION && b3.status === "approved",
  JSON.stringify(b3),
);

const b4 = buildConversionEventRows([src({ subId1: "11111111-1111-4111-8111-111111111111", subId3: "nope", keitaroOfferId: 41, keitaroType: "sale", keitaroStatus: "sale", revenue: "110.0000" })], lookups).rows[0];
check(
  "B4 unknown recipient + unknown stage + mapped Keitaro offer → offer-level row, psb sale → purchase / approved",
  b4?.stageSendId === null && b4.stageId === null && b4.campaignId === null && b4.offerId === 134 && b4.eventTypeId === PURCHASE && b4.status === "approved",
  JSON.stringify(b4),
);

const b5 = buildConversionEventRows([src({ subId3: "nope", keitaroOfferId: 99 })], lookups);
check("B5 nothing resolvable → unresolved, not a row", b5.rows.length === 0 && b5.unresolved.length === 1);

const b6 = buildConversionEventRows([src({ subId1: SEND, keitaroType: "trash", keitaroStatus: "trash" })], lookups).rows[0];
check("B6 unmapped type → NULL event type and NULL status (never a purchase)", b6?.eventTypeId === null && b6.status === null);

const b7 = buildConversionEventRows(
  [src({ subId1: SEND, eventId: "ev-reg", tid: "A", keitaroType: "trash" }), src({ subId1: SEND, eventId: "ev-buy", tid: "B" })],
  lookups,
);
check("B7 two conversions on one click → two rows", b7.rows.length === 2 && b7.rows[0].keitaroEventId !== b7.rows[1].keitaroEventId);
```

Also add `import { fetchKeitaroConversionLedger } from "../lib/keitaro/client";` to the imports.

**Revenue strictness (Task 2 review follow-up):** `parseKeitaroLedgerRow` currently maps a missing `revenue` (`undefined`/`null`) to `0.0000`, so a malformed row is indistinguishable from a real $0 registration. Keitaro always returns a number (`0` for $0 conversions). In `lib/conversions/keitaro-row.ts`, replace

```ts
  const revenue = typeof row.revenue === "number" ? row.revenue : Number(row.revenue ?? 0);
  if (!Number.isFinite(revenue)) return null;
```

with

```ts
  // Missing revenue is a malformed row, not $0 — a real $0 conversion carries 0.
  if (row.revenue === undefined || row.revenue === null || row.revenue === "") return null;
  const revenue = typeof row.revenue === "number" ? row.revenue : Number(row.revenue);
  if (!Number.isFinite(revenue)) return null;
```

and add this check right after P15 in the test file:

```ts
check(
  "P16 missing revenue → null (malformed, not $0); explicit 0 still parses",
  parseKeitaroLedgerRow({ ...sweeply, revenue: undefined }) === null &&
    parseKeitaroLedgerRow({ ...sweeply, revenue: null }) === null &&
    parseKeitaroLedgerRow({ ...sweeply, revenue: 0 })?.revenue === "0.0000",
);
``` Then **replace the file's last two lines** (the `console.log(\`\n${passed} passed…\`)` summary and `process.exit(...)`) with the truncation-guard checks below. This covers the user requirement added at approval (2026-09-17): a truncated window must fail loudly and never be stored as complete, with a unit test. `fetch` is stubbed, so there's no network.

```ts
// Truncation guard (user requirement 2026-09-17): a page carrying fewer rows than
// its own `total` must never be handed back as a complete window. fetch is
// stubbed — no network.
async function fetchGuardChecks() {
  console.log("\nfetch truncation guard");
  const realFetch = globalThis.fetch;
  const realKey = process.env.KEITARO_API_KEY;
  process.env.KEITARO_API_KEY = "test-key";
  const stub = (body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  };
  const range = { from: "2026-09-01 00:00:00", to: "2026-09-07 23:59:59", timezone: "America/New_York" };
  try {
    stub({ rows: [{ event_id: "a" }], total: 2 });
    const truncated = await fetchKeitaroConversionLedger(range);
    check(
      "F1 truncated page (rows < total) → not ok, no rows handed back",
      !truncated.ok && truncated.rows.length === 0 && (truncated.error ?? "").includes("truncated: 1 of 2"),
      JSON.stringify(truncated),
    );
    stub({ rows: [{ event_id: "a" }, { event_id: "b" }], total: 2 });
    const whole = await fetchKeitaroConversionLedger(range);
    check("F2 complete page (rows = total) → ok with every row", whole.ok && whole.rows.length === 2 && whole.total === 2, JSON.stringify(whole));
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.KEITARO_API_KEY;
    else process.env.KEITARO_API_KEY = realKey;
  }
}

fetchGuardChecks().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
```

Run: `npx tsx scripts/test-conversion-ledger-rows.ts`
Expected: FAIL — `Cannot find module '../lib/conversions/build-rows'`.

- [ ] **Step 2: Write `lib/conversions/build-rows.ts`**

```ts
import type { LedgerSourceRow } from "@/lib/conversions/keitaro-row";

export type ConversionStatus = "pending" | "approved" | "rejected";

// One conversion_event_mappings row. Exactly one of offerId / affiliateNetworkId
// is set. eventTypeId null = "status transition only" (the ledger keeps the
// row's existing event type — see upsertConversionEvents).
export interface MappingRule {
  offerId: number | null;
  affiliateNetworkId: number | null;
  keitaroType: string;
  eventTypeId: number | null;
  conversionStatus: ConversionStatus;
}

export interface ResolvedMapping {
  eventTypeId: number | null;
  status: ConversionStatus;
}

// An offer rule beats a network rule. No rule ⇒ null: the conversion is stored
// unmapped (NULL event type + status) and is never counted as a purchase.
export function resolveMapping(
  rules: readonly MappingRule[],
  key: { offerId: number | null; affiliateNetworkId: number | null; keitaroType: string },
): ResolvedMapping | null {
  const byOffer =
    key.offerId === null
      ? undefined
      : rules.find((r) => r.offerId === key.offerId && r.keitaroType === key.keitaroType);
  const rule =
    byOffer ??
    (key.affiliateNetworkId === null
      ? undefined
      : rules.find(
          (r) =>
            r.offerId === null &&
            r.affiliateNetworkId === key.affiliateNetworkId &&
            r.keitaroType === key.keitaroType,
        ));
  return rule ? { eventTypeId: rule.eventTypeId, status: rule.conversionStatus } : null;
}

export interface Lookups {
  stageSends: Map<string, { stageId: number; contactId: string }>;
  stageIdByTrackingId: Map<string, number>; // ambiguous tracking ids omitted
  stages: Map<
    number,
    { orgId: string; campaignId: number; offerId: number | null; affiliateNetworkId: number | null }
  >;
  offersByKeitaroId: Map<number, { orgId: string; offerId: number; affiliateNetworkId: number }>;
  rulesByOrg: Map<string, MappingRule[]>;
}

export interface ConversionEventInsert {
  orgId: string;
  keitaroEventId: string;
  tid: string | null;
  keitaroClickSubid: string | null;
  keitaroStatus: string;
  keitaroType: string;
  keitaroVersion: number | null;
  keitaroOfferId: number | null;
  stageSendId: string | null;
  contactId: string | null;
  campaignId: number | null;
  stageId: number | null;
  offerId: number | null;
  eventTypeId: number | null;
  status: ConversionStatus | null;
  revenue: string;
  currency: string | null;
  occurredAtEt: string;
  lastPostbackAtEt: string;
  statusHistory: string | null;
  rawParams: Record<string, unknown> | null;
}

// Attribution, strongest first:
//   1. sub_id_1 = a stage_sends row  → recipient + that row's stage
//   2. sub_id_3 = a stage tracking id → stage only
//   3. Keitaro offer id = offers.keitaro_offer_id → offer only
//   4. none → unresolved (no org to store it under; reported, not written)
// Org, campaign, offer and network come from the stage when there is one.
export function buildConversionEventRows(
  sources: readonly LedgerSourceRow[],
  lookups: Lookups,
): { rows: ConversionEventInsert[]; unresolved: LedgerSourceRow[] } {
  const rows: ConversionEventInsert[] = [];
  const unresolved: LedgerSourceRow[] = [];

  for (const s of sources) {
    const send = s.subId1 ? lookups.stageSends.get(s.subId1) : undefined;
    const stageId =
      send?.stageId ?? (s.subId3 ? lookups.stageIdByTrackingId.get(s.subId3) : undefined);
    const stage = stageId !== undefined ? lookups.stages.get(stageId) : undefined;

    let orgId: string;
    let campaignId: number | null = null;
    let offerId: number | null;
    let affiliateNetworkId: number | null;
    if (stage) {
      orgId = stage.orgId;
      campaignId = stage.campaignId;
      offerId = stage.offerId;
      affiliateNetworkId = stage.affiliateNetworkId;
    } else {
      const offer =
        s.keitaroOfferId !== null ? lookups.offersByKeitaroId.get(s.keitaroOfferId) : undefined;
      if (!offer) {
        unresolved.push(s);
        continue;
      }
      orgId = offer.orgId;
      offerId = offer.offerId;
      affiliateNetworkId = offer.affiliateNetworkId;
    }

    const mapping = resolveMapping(lookups.rulesByOrg.get(orgId) ?? [], {
      offerId,
      affiliateNetworkId,
      keitaroType: s.keitaroType,
    });

    rows.push({
      orgId,
      keitaroEventId: s.eventId,
      tid: s.tid,
      keitaroClickSubid: s.clickSubid,
      keitaroStatus: s.keitaroStatus,
      keitaroType: s.keitaroType,
      keitaroVersion: s.version,
      keitaroOfferId: s.keitaroOfferId,
      stageSendId: stage && send ? s.subId1 : null,
      contactId: stage && send ? send.contactId : null,
      campaignId,
      stageId: stage ? (stageId ?? null) : null,
      offerId,
      eventTypeId: mapping?.eventTypeId ?? null,
      status: mapping?.status ?? null,
      revenue: s.revenue,
      currency: s.currency,
      occurredAtEt: s.occurredAtEt,
      lastPostbackAtEt: s.lastPostbackAtEt,
      statusHistory: s.statusHistory,
      rawParams: s.rawParams,
    });
  }

  return { rows, unresolved };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx scripts/test-conversion-ledger-rows.ts`
Expected: `31 passed, 0 failed`, exit 0 (17 keitaro-row + 12 build-rows + F1/F2).

- [ ] **Step 4: Lint and commit**

```bash
npx eslint lib/conversions/build-rows.ts scripts/test-conversion-ledger-rows.ts
git add lib/conversions/build-rows.ts scripts/test-conversion-ledger-rows.ts
git commit -m "feat(conversions): pure mapping resolution + recipient/stage/offer attribution

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Lookups, upsert and the ingest orchestrator (DB)

**Files:**
- Create: `lib/conversions/ingest.ts`
- Test: `scripts/test-conversion-events-upsert.ts` (camman-v2 only; rolled back)

**Interfaces:**
- Consumes: `fetchKeitaroConversionLedger`, `parseKeitaroLedgerRow`, `buildConversionEventRows`, `Lookups`, `MappingRule`, `ConversionEventInsert`, schema tables from Task 1.
- Produces:
  - `type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]`
  - `loadLookups(ex: Executor, sources: readonly LedgerSourceRow[]): Promise<Lookups>`
  - `upsertConversionEvents(ex: Executor, rows: readonly ConversionEventInsert[]): Promise<{ inserted: number; updated: number; conflicts: number }>`
  - `interface IngestResult { ok; dryRun; range; fetched; invalid; invalidSamples: string[]; unresolved; unresolvedSamples: string[]; rows; unmappedInBatch; inserted; updated; unchanged; typeConflicts; error }`
  - `ingestKeitaroConversions(database: typeof db, opts: { range: KeitaroReportRange; dryRun?: boolean }): Promise<IngestResult>`

- [ ] **Step 1: Write the failing DB test**

`scripts/test-conversion-events-upsert.ts`:

```ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import type { ConversionEventInsert } from "../lib/conversions/build-rows";
import { upsertConversionEvents } from "../lib/conversions/ingest";

// Upsert semantics of the conversion_events ledger, run through the REAL exported
// write path inside a transaction that always rolls back. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-conversion-events-upsert.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}
const RUN = `test-ce-${Date.now()}`;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface Row {
  event_type_id: number | null;
  status: string | null;
  keitaro_type: string;
  conflicting_event_type_id: number | null;
  has_conflict_at: boolean;
  occurred_et: string;
  last_postback_et: string | null;
}
async function rowOf(tx: Tx, id: string): Promise<Row | undefined> {
  const rows = (await tx.execute(sql`
    SELECT event_type_id, status, keitaro_type, conflicting_event_type_id,
           event_type_conflict_at IS NOT NULL AS has_conflict_at,
           to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS occurred_et,
           to_char(last_postback_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS last_postback_et
    FROM conversion_events WHERE keitaro_event_id = ${id}
  `)) as unknown as Row[];
  return rows[0];
}

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  try {
    await db.transaction(async (tx) => {
      const [org] = (await tx.execute(
        sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`,
      )) as unknown as { id: string }[];
      const types = (await tx.execute(
        sql`SELECT id, key FROM event_types WHERE org_id = ${org.id}::uuid`,
      )) as unknown as { id: number; key: string }[];
      const purchase = types.find((t) => t.key === "purchase")?.id ?? null;
      const registration = types.find((t) => t.key === "registration")?.id ?? null;
      check("U0 seeded event types exist for the org", purchase !== null && registration !== null, JSON.stringify(types));

      const base = (over: Partial<ConversionEventInsert>): ConversionEventInsert => ({
        orgId: org.id,
        keitaroEventId: `${RUN}-x`,
        tid: null,
        keitaroClickSubid: "clk.1",
        keitaroStatus: "lead",
        keitaroType: "lead",
        keitaroVersion: 1,
        keitaroOfferId: null,
        stageSendId: null,
        contactId: null,
        campaignId: null,
        stageId: null,
        offerId: null,
        eventTypeId: purchase,
        status: "pending",
        revenue: "0.0000",
        currency: "USD",
        occurredAtEt: "2026-09-14 21:45:32",
        lastPostbackAtEt: "2026-09-14 21:45:32",
        statusHistory: "1. Lead (2026-09-14 21:45:32)",
        rawParams: { status: "lead" },
        ...over,
      });
      const reg = base({ keitaroEventId: `${RUN}-reg`, tid: "A", keitaroStatus: "registration", keitaroType: "registration", eventTypeId: registration, status: "approved" });
      const buy = base({ keitaroEventId: `${RUN}-buy`, tid: "B", revenue: "110.0000" });

      let r = await upsertConversionEvents(tx, [reg, buy]);
      check("U1 two tids on one click → two rows inserted", r.inserted === 2 && r.updated === 0, JSON.stringify(r));

      r = await upsertConversionEvents(tx, [reg, buy]);
      check("U2 duplicate postbacks → nothing inserted or updated", r.inserted === 0 && r.updated === 0, JSON.stringify(r));

      r = await upsertConversionEvents(tx, [
        { ...buy, keitaroVersion: 2, keitaroStatus: "sale", keitaroType: "sale", status: "approved", occurredAtEt: "2026-09-17 07:13:52", lastPostbackAtEt: "2026-09-17 07:13:52" },
      ]);
      check("U3 in-place status change on the same event_id → one update", r.inserted === 0 && r.updated === 1, JSON.stringify(r));
      const b = await rowOf(tx, buy.keitaroEventId);
      check("U4 status is now approved", b?.status === "approved", JSON.stringify(b));
      check("U5 occurred_at never moves on update", b?.occurred_et === "2026-09-14 21:45:32", JSON.stringify(b));
      check("U6 last_postback_at follows the re-post", b?.last_postback_et === "2026-09-17 07:13:52", JSON.stringify(b));

      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 2, keitaroStatus: "rejected", keitaroType: "rejected", eventTypeId: null, status: "rejected" },
      ]);
      const g = await rowOf(tx, reg.keitaroEventId);
      check("U7 a rejection with no event type keeps the registration's type", r.updated === 1 && g?.event_type_id === registration && g?.status === "rejected", JSON.stringify(g));

      const unk = base({ keitaroEventId: `${RUN}-unk`, keitaroStatus: "trash", keitaroType: "trash", eventTypeId: null, status: null });
      await upsertConversionEvents(tx, [unk]);
      const u = await rowOf(tx, unk.keitaroEventId);
      check("U8 unmapped conversion stored with NULL event type and status", u !== undefined && u.event_type_id === null && u.status === null, JSON.stringify(u));

      r = await upsertConversionEvents(tx, [{ ...unk, eventTypeId: purchase, status: "rejected" }]);
      const h = await rowOf(tx, unk.keitaroEventId);
      check("U9 a mapping added later heals the unmapped row on the next ingest", r.updated === 1 && h?.event_type_id === purchase && h?.status === "rejected", JSON.stringify(h));

      // Reused tid: the registration conversion comes back typed Sale, whose mapping names purchase.
      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 3, keitaroStatus: "sale", keitaroType: "sale", eventTypeId: purchase, status: "approved" },
      ]);
      const c = await rowOf(tx, reg.keitaroEventId);
      check(
        "U11 type changes category → event type stays locked, raw type stored, conflict recorded",
        r.updated === 1 && r.conflicts === 1 && c?.event_type_id === registration && c?.keitaro_type === "sale" && c?.conflicting_event_type_id === purchase && c?.has_conflict_at === true,
        JSON.stringify({ r, c }),
      );

      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 4, keitaroStatus: "rejected", keitaroType: "rejected", eventTypeId: null, status: "rejected" },
      ]);
      const c2 = await rowOf(tx, reg.keitaroEventId);
      check("U12 a later status-only update does NOT clear the conflict", c2?.conflicting_event_type_id === purchase && c2?.has_conflict_at === true, JSON.stringify(c2));

      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 5, keitaroStatus: "registration", keitaroType: "registration", eventTypeId: registration, status: "approved" },
      ]);
      const c3 = await rowOf(tx, reg.keitaroEventId);
      check("U13 an agreeing mapping clears the conflict", r.conflicts === 0 && c3?.conflicting_event_type_id === null && c3?.has_conflict_at === false, JSON.stringify({ r, c3 }));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const [left] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM conversion_events WHERE keitaro_event_id LIKE ${`${RUN}%`}`,
  )) as unknown as { n: number }[];
  check("U10 rolled back — no residue", left.n === 0, `${left.n} rows left`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-events-upsert.ts`
Expected: FAIL — `Cannot find module '../lib/conversions/ingest'`.

- [ ] **Step 2: Write `lib/conversions/ingest.ts`**

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  conversion_event_mappings,
  conversion_events,
  offers,
  stage_sends,
} from "@/db/schema";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import {
  buildConversionEventRows,
  type ConversionEventInsert,
  type ConversionStatus,
  type Lookups,
  type MappingRule,
} from "@/lib/conversions/build-rows";
import { parseKeitaroLedgerRow, type LedgerSourceRow } from "@/lib/conversions/keitaro-row";
import { fetchKeitaroConversionLedger, type KeitaroReportRange } from "@/lib/keitaro/client";

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOKUP_CHUNK = 1000;
// 21 bound columns per row ⇒ 500 rows ≈ 10.5K params, far under Postgres's 65,535.
const UPSERT_CHUNK = 500;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function loadLookups(
  ex: Executor,
  sources: readonly LedgerSourceRow[],
): Promise<Lookups> {
  const sendIds = [...new Set(sources.map((s) => s.subId1).filter((v): v is string => !!v && UUID_RE.test(v)))];
  const trackingIds = [...new Set(sources.map((s) => s.subId3).filter((v): v is string => !!v))];
  const keitaroOfferIds = [...new Set(sources.map((s) => s.keitaroOfferId).filter((v): v is number => v !== null))];

  const stageSends: Lookups["stageSends"] = new Map();
  for (const chunk of chunks(sendIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({ id: stage_sends.id, stageId: stage_sends.stage_id, contactId: stage_sends.contact_id })
      .from(stage_sends)
      .where(inArray(stage_sends.id, chunk));
    for (const r of found) stageSends.set(r.id, { stageId: r.stageId, contactId: r.contactId });
  }

  // tracking_id is unique per org, not globally: an id seen twice is ambiguous
  // and is dropped rather than guessed.
  const stageIdByTrackingId: Lookups["stageIdByTrackingId"] = new Map();
  const ambiguous = new Set<string>();
  for (const chunk of chunks(trackingIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({ id: campaign_stages.id, trackingId: campaign_stages.tracking_id })
      .from(campaign_stages)
      .where(inArray(campaign_stages.tracking_id, chunk));
    for (const r of found) {
      if (!r.trackingId) continue;
      if (stageIdByTrackingId.has(r.trackingId)) ambiguous.add(r.trackingId);
      stageIdByTrackingId.set(r.trackingId, r.id);
    }
  }
  for (const t of ambiguous) stageIdByTrackingId.delete(t);

  const stageIds = [...new Set([...[...stageSends.values()].map((s) => s.stageId), ...stageIdByTrackingId.values()])];
  const stages: Lookups["stages"] = new Map();
  for (const chunk of chunks(stageIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({
        id: campaign_stages.id,
        campaignId: campaigns.id,
        orgId: campaigns.org_id,
        offerId: campaigns.offer_id,
        affiliateNetworkId: offers.network_id,
      })
      .from(campaign_stages)
      .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
      .leftJoin(offers, eq(offers.id, campaigns.offer_id))
      .where(inArray(campaign_stages.id, chunk));
    for (const r of found) {
      stages.set(r.id, {
        orgId: r.orgId,
        campaignId: r.campaignId,
        offerId: r.offerId ?? null,
        affiliateNetworkId: r.affiliateNetworkId ?? null,
      });
    }
  }

  const offersByKeitaroId: Lookups["offersByKeitaroId"] = new Map();
  const ambiguousOffers = new Set<number>();
  for (const chunk of chunks(keitaroOfferIds, LOOKUP_CHUNK)) {
    const found = await ex
      .select({ id: offers.id, orgId: offers.org_id, networkId: offers.network_id, keitaroOfferId: offers.keitaro_offer_id })
      .from(offers)
      .where(inArray(offers.keitaro_offer_id, chunk));
    for (const r of found) {
      if (r.keitaroOfferId === null) continue;
      if (offersByKeitaroId.has(r.keitaroOfferId)) ambiguousOffers.add(r.keitaroOfferId);
      offersByKeitaroId.set(r.keitaroOfferId, { orgId: r.orgId, offerId: r.id, affiliateNetworkId: r.networkId });
    }
  }
  for (const k of ambiguousOffers) offersByKeitaroId.delete(k);

  const orgIds = [...new Set([...[...stages.values()].map((s) => s.orgId), ...[...offersByKeitaroId.values()].map((o) => o.orgId)])];
  const rulesByOrg: Lookups["rulesByOrg"] = new Map();
  if (orgIds.length > 0) {
    const found = await ex
      .select({
        orgId: conversion_event_mappings.org_id,
        offerId: conversion_event_mappings.offer_id,
        affiliateNetworkId: conversion_event_mappings.affiliate_network_id,
        keitaroType: conversion_event_mappings.keitaro_type,
        eventTypeId: conversion_event_mappings.event_type_id,
        conversionStatus: conversion_event_mappings.conversion_status,
      })
      .from(conversion_event_mappings)
      .where(and(inArray(conversion_event_mappings.org_id, orgIds), eq(conversion_event_mappings.status, "active")));
    for (const r of found) {
      const rule: MappingRule = {
        offerId: r.offerId,
        affiliateNetworkId: r.affiliateNetworkId,
        keitaroType: r.keitaroType,
        eventTypeId: r.eventTypeId,
        conversionStatus: r.conversionStatus as ConversionStatus,
      };
      rulesByOrg.set(r.orgId, [...(rulesByOrg.get(r.orgId) ?? []), rule]);
    }
  }

  return { stageSends, stageIdByTrackingId, stages, offersByKeitaroId, rulesByOrg };
}

// ET wall-clock text → timestamptz in SQL, bound as ::text so postgres-js can't
// infer a timestamp and pre-shift it (same trick as poll-conversions.ts).
function etToTimestamptz(et: string) {
  return sql`(${et}::text || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz`;
}

function toInsertValues(r: ConversionEventInsert): PgInsertValue<typeof conversion_events> {
  return {
    org_id: r.orgId,
    keitaro_event_id: r.keitaroEventId,
    tid: r.tid,
    keitaro_click_subid: r.keitaroClickSubid,
    keitaro_status: r.keitaroStatus,
    keitaro_type: r.keitaroType,
    keitaro_version: r.keitaroVersion,
    keitaro_offer_id: r.keitaroOfferId,
    stage_send_id: r.stageSendId,
    contact_id: r.contactId,
    campaign_id: r.campaignId,
    stage_id: r.stageId,
    offer_id: r.offerId,
    event_type_id: r.eventTypeId,
    status: r.status,
    revenue: r.revenue,
    currency: r.currency,
    occurred_at: etToTimestamptz(r.occurredAtEt),
    last_postback_at: etToTimestamptz(r.lastPostbackAtEt),
    status_history: r.statusHistory,
    raw_params: r.rawParams,
  };
}

// The incoming mapping names a DIFFERENT event type than the row's locked one
// (e.g. Registration → Sale on a reused tid). The locked type stays; the
// disagreement is recorded for the monitor instead of being kept silently. A
// status-only mapping (NULL event type) or a still-unmapped row neither raises
// nor clears it; an agreeing mapping clears it.
const CONFLICTING_EVENT_TYPE = sql`CASE
  WHEN excluded.event_type_id IS NULL OR conversion_events.event_type_id IS NULL
    THEN conversion_events.conflicting_event_type_id
  WHEN excluded.event_type_id <> conversion_events.event_type_id
    THEN excluded.event_type_id
  ELSE NULL END`;
const EVENT_TYPE_CONFLICT_AT = sql`CASE
  WHEN excluded.event_type_id IS NULL OR conversion_events.event_type_id IS NULL
    THEN conversion_events.event_type_conflict_at
  WHEN excluded.event_type_id <> conversion_events.event_type_id
    THEN COALESCE(conversion_events.event_type_conflict_at, now())
  ELSE NULL END`;

// Idempotent upsert keyed on Keitaro's event_id.
//   - occurred_at is never updated (the original conversion time).
//   - event_type_id is LOCKED once set, and attribution is sticky:
//     COALESCE(existing, new), so a status-only mapping (NULL event type) can't
//     erase the type, and a later mapping/offer link fills a NULL.
//   - a mapping that disagrees with the locked type is recorded in
//     conflicting_event_type_id / event_type_conflict_at (see above).
//   - status, revenue, version and the raw keitaro_status/keitaro_type take the
//     newest values.
//   - setWhere skips no-op writes, so a re-poll of unchanged data touches nothing.
// Counts come from comparing the returned ids with the ids that already existed;
// `conflicts` = rows written this call that carry a type conflict.
// Column references in SET/WHERE are written literally (conversion_events.col) —
// ${table.col} can render unqualified.
export async function upsertConversionEvents(
  ex: Executor,
  rows: readonly ConversionEventInsert[],
): Promise<{ inserted: number; updated: number; conflicts: number }> {
  let inserted = 0;
  let updated = 0;
  let conflicts = 0;
  for (const chunk of chunks(rows, UPSERT_CHUNK)) {
    const existing = new Set(
      (
        await ex
          .select({ id: conversion_events.keitaro_event_id })
          .from(conversion_events)
          .where(inArray(conversion_events.keitaro_event_id, chunk.map((r) => r.keitaroEventId)))
      ).map((r) => r.id),
    );
    const written = await ex
      .insert(conversion_events)
      .values(chunk.map(toInsertValues))
      .onConflictDoUpdate({
        target: conversion_events.keitaro_event_id,
        set: {
          tid: sql`excluded.tid`,
          keitaro_click_subid: sql`excluded.keitaro_click_subid`,
          keitaro_status: sql`excluded.keitaro_status`,
          keitaro_type: sql`excluded.keitaro_type`,
          keitaro_version: sql`excluded.keitaro_version`,
          keitaro_offer_id: sql`excluded.keitaro_offer_id`,
          stage_send_id: sql`COALESCE(conversion_events.stage_send_id, excluded.stage_send_id)`,
          contact_id: sql`COALESCE(conversion_events.contact_id, excluded.contact_id)`,
          campaign_id: sql`COALESCE(conversion_events.campaign_id, excluded.campaign_id)`,
          stage_id: sql`COALESCE(conversion_events.stage_id, excluded.stage_id)`,
          offer_id: sql`COALESCE(conversion_events.offer_id, excluded.offer_id)`,
          event_type_id: sql`COALESCE(conversion_events.event_type_id, excluded.event_type_id)`,
          conflicting_event_type_id: CONFLICTING_EVENT_TYPE,
          event_type_conflict_at: EVENT_TYPE_CONFLICT_AT,
          status: sql`excluded.status`,
          revenue: sql`excluded.revenue`,
          currency: sql`excluded.currency`,
          last_postback_at: sql`excluded.last_postback_at`,
          status_history: sql`excluded.status_history`,
          raw_params: sql`excluded.raw_params`,
          updated_at: sql`now()`,
        },
        setWhere: sql`(
          conversion_events.keitaro_version, conversion_events.keitaro_status,
          conversion_events.keitaro_type, conversion_events.status,
          conversion_events.revenue, conversion_events.event_type_id,
          conversion_events.conflicting_event_type_id, conversion_events.offer_id,
          conversion_events.stage_id, conversion_events.last_postback_at
        ) IS DISTINCT FROM (
          excluded.keitaro_version, excluded.keitaro_status,
          excluded.keitaro_type, excluded.status,
          excluded.revenue,
          COALESCE(conversion_events.event_type_id, excluded.event_type_id),
          ${CONFLICTING_EVENT_TYPE},
          COALESCE(conversion_events.offer_id, excluded.offer_id),
          COALESCE(conversion_events.stage_id, excluded.stage_id),
          excluded.last_postback_at
        )`,
      })
      .returning({
        id: conversion_events.keitaro_event_id,
        conflict: conversion_events.conflicting_event_type_id,
      });
    for (const w of written) {
      if (existing.has(w.id)) updated++;
      else inserted++;
      if (w.conflict !== null) conflicts++;
    }
  }
  return { inserted, updated, conflicts };
}

export interface IngestResult {
  ok: boolean;
  dryRun: boolean;
  range: KeitaroReportRange;
  fetched: number;
  // Rows that failed to parse (missing event_id / conversion_type / malformed
  // datetime / non-finite revenue). Counted and sampled — never dropped silently.
  invalid: number;
  invalidSamples: string[];
  unresolved: number;
  unresolvedSamples: string[];
  rows: number;
  unmappedInBatch: number;
  inserted: number;
  updated: number;
  unchanged: number;
  typeConflicts: number; // rows written this run whose Keitaro type now maps to a different event type
  error: string | null;
}

// Fetch one window of Keitaro conversions, attribute + classify, and upsert them
// in one transaction. dryRun does everything except the write.
export async function ingestKeitaroConversions(
  database: typeof db,
  opts: { range: KeitaroReportRange; dryRun?: boolean },
): Promise<IngestResult> {
  const dryRun = opts.dryRun ?? false;
  const base: IngestResult = {
    ok: false,
    dryRun,
    range: opts.range,
    fetched: 0,
    invalid: 0,
    invalidSamples: [],
    unresolved: 0,
    unresolvedSamples: [],
    rows: 0,
    unmappedInBatch: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    typeConflicts: 0,
    error: null,
  };

  // A failed or TRUNCATED fetch returns ok:false before anything is written, so a
  // partial window is never stored as if it were complete.
  const res = await fetchKeitaroConversionLedger(opts.range);
  if (!res.ok) return { ...base, error: res.error };

  const sources: LedgerSourceRow[] = [];
  const invalidRows: typeof res.rows = [];
  for (const raw of res.rows) {
    const parsed = parseKeitaroLedgerRow(raw);
    if (parsed) sources.push(parsed);
    else invalidRows.push(raw);
  }

  const lookups = await loadLookups(database, sources);
  const built = buildConversionEventRows(sources, lookups);
  // One row per event_id: ON CONFLICT cannot touch the same row twice in one statement.
  const rows = [...new Map(built.rows.map((r) => [r.keitaroEventId, r])).values()];

  const result: IngestResult = {
    ...base,
    ok: true,
    fetched: res.rows.length,
    invalid: invalidRows.length,
    invalidSamples: invalidRows
      .slice(0, 10)
      .map((r) => `event_id=${String(r.event_id ?? "∅")} conversion_type=${String(r.conversion_type ?? "∅")} datetime=${String(r.datetime ?? "∅")} revenue=${String(r.revenue ?? "∅")}`),
    unresolved: built.unresolved.length,
    unresolvedSamples: built.unresolved
      .slice(0, 10)
      .map((s) => `${s.eventId} sub_id_3=${s.subId3 ?? "∅"} keitaro_offer=${s.keitaroOfferId ?? "∅"} type=${s.keitaroType}`),
    rows: rows.length,
    unmappedInBatch: rows.filter((r) => r.eventTypeId === null || r.status === null).length,
  };
  if (dryRun || rows.length === 0) return result;

  const { inserted, updated, conflicts } = await database.transaction((tx) =>
    upsertConversionEvents(tx, rows),
  );
  return {
    ...result,
    inserted,
    updated,
    unchanged: rows.length - inserted - updated,
    typeConflicts: conflicts,
  };
}
```

- [ ] **Step 3: Type-check, then run the DB test on camman-v2**

Run: `npx tsc --noEmit -p .` (expected: exit 0; allow up to 10 minutes; a timeout is not a pass)
Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-events-upsert.ts`
Expected: `Target DB: camman-v2 (preview)`, then `14 passed, 0 failed`, exit 0.

If U5 fails, `occurred_at` is being updated; check that `set` has no `occurred_at`. If U2 reports updates, the `setWhere` tuple is comparing a column whose stored and bound representations differ (e.g. `revenue` numeric scale). Fix the tuple, don't loosen the check.

- [ ] **Step 4: Ingest-level guard checks in the pure test**

User requirements (2026-09-17): a truncated window must not be ingested, and unparseable rows must be counted and sampled, never dropped silently. In `scripts/test-conversion-ledger-rows.ts`, add `import { ingestKeitaroConversions } from "../lib/conversions/ingest";`. Then, inside `fetchGuardChecks`' `try` block right after the F2 check, add the block below.

Both paths return before any database call. The truncated fetch returns `ok:false` first; for all-invalid rows, `loadLookups` over zero sources issues no query and `rows.length === 0` returns before the upsert. That's why a dummy database object is safe.

```ts
    // Ingest must refuse a truncated window before touching the database.
    stub({ rows: [{ event_id: "a" }], total: 2 });
    const ingTrunc = await ingestKeitaroConversions({} as never, { range });
    check(
      "I1 truncated window → ingest not ok, nothing parsed or written, error names the truncation",
      !ingTrunc.ok && ingTrunc.rows === 0 && ingTrunc.inserted === 0 && ingTrunc.updated === 0 && (ingTrunc.error ?? "").includes("truncated"),
      JSON.stringify(ingTrunc),
    );

    // Unparseable rows are counted and sampled.
    stub({
      rows: [
        { event_id: "", datetime: "2026-09-01 10:00:00", status: "lead", conversion_type: "Lead", revenue: 0 },
        { event_id: "bad-dt", datetime: "2026-09-01T10:00:00Z", status: "lead", conversion_type: "Lead", revenue: 0 },
        { event_id: "no-type", datetime: "2026-09-01 10:00:00", status: "lead", revenue: 0 },
      ],
      total: 3,
    });
    const ingInvalid = await ingestKeitaroConversions({} as never, { range });
    check(
      "I2 unparseable rows are counted and sampled, never silently dropped",
      ingInvalid.ok && ingInvalid.invalid === 3 && ingInvalid.invalidSamples.length === 3 && ingInvalid.rows === 0 &&
        ingInvalid.invalidSamples.some((s) => s.includes("event_id=bad-dt")),
      JSON.stringify(ingInvalid),
    );
```

Run: `npx tsx scripts/test-conversion-ledger-rows.ts`
Expected: `33 passed, 0 failed`.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint lib/conversions/ingest.ts scripts/test-conversion-events-upsert.ts scripts/test-conversion-ledger-rows.ts
git add lib/conversions/ingest.ts scripts/test-conversion-events-upsert.ts scripts/test-conversion-ledger-rows.ts
git commit -m "feat(conversions): ledger lookups, idempotent upsert, ingest orchestrator

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Backfill script (dry-run by default)

**Files:**
- Create: `scripts/backfill-conversion-events.ts`

**Interfaces:**
- Consumes: `ingestKeitaroConversions`, `etDayWindows`.

- [ ] **Step 1: Write the script**

```ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "../lib/campaign-timezone";
import { ingestKeitaroConversions } from "../lib/conversions/ingest";
import { etDayWindows } from "../lib/conversions/keitaro-row";

// Backfill conversion_events from Keitaro's full conversion history.
//   npx tsx scripts/backfill-conversion-events.ts            # DRY RUN — no writes
//   npx tsx scripts/backfill-conversion-events.ts --apply    # writes (prod: needs approval)
// Idempotent: re-running changes only conversions Keitaro has changed since.
// Exit 1 on any fetch error, unparseable row, unresolved or unmapped conversion,
// or an empty scope — each needs a human decision, not a silent pass.

// Keitaro's earliest conversion is 2026-06-15; starting earlier costs nothing.
const FROM = process.env.BACKFILL_FROM ?? "2026-06-01";
// A window whose fetch is TRUNCATED fails (nothing from it is written); re-run
// with a smaller window, e.g. BACKFILL_WINDOW_DAYS=1.
const WINDOW_DAYS = Number(process.env.BACKFILL_WINDOW_DAYS ?? 7);
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!Number.isInteger(WINDOW_DAYS) || WINDOW_DAYS < 1) {
    console.log(`FAIL: BACKFILL_WINDOW_DAYS must be a positive integer, got ${process.env.BACKFILL_WINDOW_DAYS}`);
    process.exit(1);
  }
  const nowEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd HH:mm:ss");
  const windows = etDayWindows(FROM, nowEt, WINDOW_DAYS);
  console.log(APPLY ? "APPLY — writes conversion_events" : "DRY RUN — no writes (pass --apply to write)");
  console.log(`Scope: ${FROM} 00:00:00 → ${nowEt} ${CAMPAIGN_TIMEZONE}, ${windows.length} windows of ${WINDOW_DAYS} day(s)\n`);

  const t = { fetched: 0, invalid: 0, unresolved: 0, rows: 0, unmapped: 0, inserted: 0, updated: 0, unchanged: 0, typeConflicts: 0 };
  let errors = 0;
  for (const w of windows) {
    const r = await ingestKeitaroConversions(db, { range: w, dryRun: !APPLY });
    console.log(
      `${w.from.slice(0, 10)} → ${w.to.slice(0, 10)}  fetched ${r.fetched}  rows ${r.rows}  unmapped ${r.unmappedInBatch}  unresolved ${r.unresolved}  invalid ${r.invalid}` +
        (APPLY ? `  inserted ${r.inserted}  updated ${r.updated}  unchanged ${r.unchanged}  type-conflicts ${r.typeConflicts}` : "") +
        (r.error ? `  ERROR ${r.error}` : ""),
    );
    for (const s of r.invalidSamples) console.log(`    unparseable: ${s}`);
    for (const s of r.unresolvedSamples) console.log(`    unresolved: ${s}`);
    if (!r.ok) errors++;
    t.fetched += r.fetched;
    t.invalid += r.invalid;
    t.unresolved += r.unresolved;
    t.rows += r.rows;
    t.unmapped += r.unmappedInBatch;
    t.inserted += r.inserted;
    t.updated += r.updated;
    t.unchanged += r.unchanged;
    t.typeConflicts += r.typeConflicts;
  }

  console.log(`\nTotals: ${JSON.stringify(t)}`);
  const problems: string[] = [];
  if (errors > 0) problems.push(`${errors} window(s) failed to fetch or came back truncated — NOTHING from those windows was written; re-run with a smaller BACKFILL_WINDOW_DAYS`);
  if (t.fetched === 0) problems.push("Keitaro returned no conversions — an empty scope is a failure, not a pass");
  if (t.invalid > 0) problems.push(`${t.invalid} unparseable row(s)`);
  if (t.unresolved > 0) problems.push(`${t.unresolved} unresolvable conversion(s) (no stage, no offers.keitaro_offer_id)`);
  if (t.unmapped > 0) problems.push(`${t.unmapped} unmapped conversion(s) in this run (no mapping for their network/offer + type)`);
  // The per-run counts only see rows WRITTEN this run (an unchanged conflicted or
  // unmapped row is skipped by the upsert), so after --apply the TABLE is the truth.
  if (APPLY) {
    const [tbl] = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE event_type_id IS NULL OR status IS NULL)::int AS unmapped,
             count(*) FILTER (WHERE conflicting_event_type_id IS NOT NULL)::int AS conflicts
      FROM conversion_events
    `)) as unknown as { total: number; unmapped: number; conflicts: number }[];
    console.log(`Table after apply: ${tbl.total} rows · ${tbl.unmapped} unmapped · ${tbl.conflicts} event-type conflict(s)`);
    if (tbl.unmapped > 0) problems.push(`${tbl.unmapped} unmapped row(s) in conversion_events`);
    if (tbl.conflicts > 0) problems.push(`${tbl.conflicts} event-type conflict(s) in conversion_events (a Keitaro type now maps to a different event than the locked one)`);
  }
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Dry-run it against camman-v2 (proves it runs; the preview has no Keitaro-attributed stages)**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/backfill-conversion-events.ts`
Expected: `DRY RUN` banner, ~16 window lines with `fetched` > 0 on and after the 2026-06-15 window, **`invalid 0` on every line** (every live Keitaro row parses with `KEITARO_LEDGER_COLUMNS`), and `unresolved` ≈ `fetched` (the preview DB has none of prod's stages). Exit 1 with `PROBLEM: … unresolvable` is the correct result on the preview DB. It proves the script runs end-to-end without writing.

- [ ] **Step 3: Lint and commit**

```bash
npx eslint scripts/backfill-conversion-events.ts
git add scripts/backfill-conversion-events.ts
git commit -m "feat(conversions): backfill script (dry-run default, --apply to write)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Verify script (read-only)

**Files:**
- Create: `scripts/verify-conversion-events.ts`

**Interfaces:**
- Consumes: `fetchKeitaroConversionLedger`, `parseKeitaroLedgerRow`, `etDayWindows`.

- [ ] **Step 1: Write the script**

```ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "../lib/campaign-timezone";
import { etDayWindows, parseKeitaroLedgerRow, type LedgerSourceRow } from "../lib/conversions/keitaro-row";
import { fetchKeitaroConversionLedger } from "../lib/keitaro/client";

// Read-only. Proves conversion_events against a FRESH Keitaro pull (the anchor),
// then PRINTS the documented deltas against today's two conversion sources
// (stage_sends per-recipient, keitaro_stage_results per stage-day).
//   npx tsx scripts/verify-conversion-events.ts
// Phase 1 note: the ledger is not kept live until Phase 2 wires the poll, so
// run this right after the backfill (or re-run the backfill first).

const FROM = process.env.VERIFY_FROM ?? "2026-06-01";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const units = (s: string) => Math.round(Number(s) * 10000); // 4dp integer units
const usd = (u: number) => `$${(u / 10000).toFixed(2)}`;

interface LedgerRow {
  id: string;
  type: string;
  revenue: string;
  org: string;
  occurred_et: string;
  last_postback_et: string | null;
}

async function main() {
  const nowEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd HH:mm:ss");
  const windows = etDayWindows(FROM, nowEt, 7);

  const live: LedgerSourceRow[] = [];
  let invalid = 0;
  for (const w of windows) {
    const res = await fetchKeitaroConversionLedger(w);
    if (!res.ok) {
      console.log(`FATAL: Keitaro fetch failed for ${w.from}: ${res.error}`);
      process.exit(1);
    }
    for (const raw of res.rows) {
      const p = parseKeitaroLedgerRow(raw);
      if (p) live.push(p);
      else invalid++;
    }
  }
  const ledger = (await db.execute(sql`
    SELECT keitaro_event_id AS id, keitaro_type AS type, revenue::text AS revenue, org_id::text AS org,
           to_char(occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI:SS') AS occurred_et,
           to_char(last_postback_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI:SS') AS last_postback_et
    FROM conversion_events
  `)) as unknown as LedgerRow[];

  console.log(`Scope: Keitaro conversions/log ${FROM} 00:00:00 → ${nowEt} ${CAMPAIGN_TIMEZONE} (${windows.length} windows)`);
  console.log(`       Keitaro rows ${live.length} (+${invalid} unparseable) · ledger rows ${ledger.length} · orgs ${[...new Set(ledger.map((r) => r.org))].join(", ") || "none"}\n`);

  check("V0 scope is not empty (Keitaro and ledger both have rows)", live.length > 0 && ledger.length > 0);
  check("V0b every Keitaro row parses", invalid === 0, `${invalid} unparseable`);

  const byId = new Map(ledger.map((r) => [r.id, r]));
  const liveIds = new Set(live.map((r) => r.eventId));
  const missing = live.filter((r) => !byId.has(r.eventId));
  const extra = ledger.filter((r) => !liveIds.has(r.id));
  check(
    "V1 every Keitaro conversion is in the ledger",
    missing.length === 0,
    `${missing.length} missing: ${missing.slice(0, 5).map((m) => `${m.eventId} sub_id_3=${m.subId3 ?? "∅"} keitaro_offer=${m.keitaroOfferId ?? "∅"}`).join("; ")}`,
  );
  check("V1b the ledger holds nothing Keitaro doesn't", extra.length === 0, `${extra.length} extra: ${extra.slice(0, 5).map((e) => e.id).join(", ")}`);

  const tally = (pairs: { type: string; revenue: string }[]) => {
    const m = new Map<string, { n: number; u: number }>();
    for (const p of pairs) {
      const t = m.get(p.type) ?? { n: 0, u: 0 };
      t.n++;
      t.u += units(p.revenue);
      m.set(p.type, t);
    }
    return m;
  };
  const k = tally(live.map((r) => ({ type: r.keitaroType, revenue: r.revenue })));
  const l = tally(ledger);
  for (const type of [...new Set([...k.keys(), ...l.keys()])].sort()) {
    const a = k.get(type) ?? { n: 0, u: 0 };
    const b = l.get(type) ?? { n: 0, u: 0 };
    check(
      `V2 ${type}: ledger ${b.n} conv / ${usd(b.u)} = Keitaro ${a.n} conv / ${usd(a.u)}`,
      a.n === b.n && a.u === b.u,
    );
  }

  const unmapped = (await db.execute(sql`
    SELECT ce.keitaro_event_id AS id, ce.keitaro_type AS type, an.network_id AS network
    FROM conversion_events ce
    LEFT JOIN offers o ON o.id = ce.offer_id
    LEFT JOIN affiliate_networks an ON an.id = o.network_id
    WHERE ce.event_type_id IS NULL OR ce.status IS NULL
  `)) as unknown as { id: string; type: string; network: string | null }[];
  check("V3 no unmapped conversions", unmapped.length === 0, unmapped.slice(0, 10).map((u) => `${u.id} ${u.network ?? "∅"}/${u.type}`).join("; "));

  const conflicts = (await db.execute(sql`
    SELECT ce.keitaro_event_id AS id, ce.keitaro_type AS type, et.key AS locked, ct.key AS mapped,
           to_char(ce.event_type_conflict_at AT TIME ZONE ${CAMPAIGN_TIMEZONE}, 'YYYY-MM-DD HH24:MI') AS since
    FROM conversion_events ce
    JOIN event_types et ON et.id = ce.event_type_id
    JOIN event_types ct ON ct.id = ce.conflicting_event_type_id
    WHERE ce.conflicting_event_type_id IS NOT NULL
  `)) as unknown as { id: string; type: string; locked: string; mapped: string; since: string }[];
  check(
    "V5 no event-type conflicts (a Keitaro type that now maps to a different event than the locked one)",
    conflicts.length === 0,
    conflicts.slice(0, 10).map((c) => `${c.id} locked ${c.locked}, keitaro type ${c.type} → ${c.mapped} since ${c.since}`).join("; "),
  );

  // Revenue currency (user question 2026-09-17): every conversion to date carries
  // params.currency USD (or none) and revenue == params.payout, so `revenue` is USD.
  // A non-USD postback would leave it unproven whether Keitaro converted the
  // payout — fail loudly so a human decides before those numbers are summed.
  const nonUsd = live.filter((r) => r.currency !== null && r.currency !== "USD");
  check(
    "V6 every conversion's currency param is USD or absent (revenue is summed as USD)",
    nonUsd.length === 0,
    nonUsd.slice(0, 5).map((r) => `${r.eventId} currency=${r.currency} revenue=${r.revenue}`).join("; "),
  );

  const liveById = new Map(live.map((r) => [r.eventId, r]));
  const badTime = ledger.filter((r) => {
    const s = liveById.get(r.id);
    return s !== undefined && r.occurred_et !== s.occurredAtEt;
  });
  check(
    "V4 occurred_at = the original conversion time (earliest status_history entry), in ET",
    badTime.length === 0,
    badTime.slice(0, 5).map((r) => `${r.id} ledger ${r.occurred_et} vs ${liveById.get(r.id)?.occurredAtEt}`).join("; "),
  );
  const redated = ledger.filter((r) => r.last_postback_et !== null && r.occurred_et !== r.last_postback_et);
  console.log(`  info  ${redated.length} conversion(s) re-posted after their original time: ${redated.slice(0, 10).map((r) => `${r.id} ${r.occurred_et} → ${r.last_postback_et}`).join("; ")}`);

  const [head] = (await db.execute(sql`
    SELECT coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'approved'), 0)::text AS approved_revenue,
           coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'pending'), 0)::text AS pending_revenue,
           count(*) FILTER (WHERE et.is_purchase AND ce.status IN ('pending', 'approved'))::int AS purchases,
           count(*) FILTER (WHERE et.is_purchase AND ce.status = 'rejected')::int AS rejected_purchases,
           count(*) FILTER (WHERE et.is_retarget_signal)::int AS registrations
    FROM conversion_events ce LEFT JOIN event_types et ON et.id = ce.event_type_id
  `)) as unknown as { approved_revenue: string; pending_revenue: string; purchases: number; rejected_purchases: number; registrations: number }[];
  console.log(`\nLedger headline: approved revenue ${usd(units(head.approved_revenue))} · pending revenue ${usd(units(head.pending_revenue))} · purchases ${head.purchases} (+${head.rejected_purchases} rejected) · registrations ${head.registrations}`);

  const [rec] = (await db.execute(sql`
    WITH s AS (SELECT id, sale_revenue, keitaro_conversion_id FROM stage_sends WHERE sale_status IS NOT NULL)
    SELECT
      (SELECT count(*) FROM s)::int AS ss_rows,
      (SELECT coalesce(sum(sale_revenue), 0) FROM s)::text AS ss_revenue,
      (SELECT count(*) FROM conversion_events WHERE stage_send_id IS NOT NULL)::int AS ledger_rows,
      (SELECT coalesce(sum(revenue), 0) FROM conversion_events WHERE stage_send_id IS NOT NULL)::text AS ledger_revenue,
      (SELECT count(DISTINCT ce.stage_send_id) FROM conversion_events ce JOIN s ON s.id = ce.stage_send_id
        WHERE ce.keitaro_event_id IS DISTINCT FROM s.keitaro_conversion_id)::int AS extra_recipients,
      (SELECT coalesce(sum(ce.revenue), 0) FROM conversion_events ce JOIN s ON s.id = ce.stage_send_id
        WHERE ce.keitaro_event_id IS DISTINCT FROM s.keitaro_conversion_id)::text AS extra_revenue,
      (SELECT count(*) FROM conversion_events WHERE stage_id IS NOT NULL AND stage_send_id IS NULL)::int AS stage_only_rows,
      (SELECT coalesce(sum(revenue), 0) FROM conversion_events WHERE stage_id IS NOT NULL AND stage_send_id IS NULL)::text AS stage_only_revenue,
      (SELECT count(*) FROM conversion_events WHERE stage_id IS NULL)::int AS offer_only_rows
  `)) as unknown as {
    ss_rows: number; ss_revenue: string; ledger_rows: number; ledger_revenue: string;
    extra_recipients: number; extra_revenue: string; stage_only_rows: number; stage_only_revenue: string; offer_only_rows: number;
  }[];
  const recDelta = units(rec.ledger_revenue) - units(rec.ss_revenue);
  console.log(`\nDelta vs stage_sends (per recipient):`);
  console.log(`  stage_sends ${rec.ss_rows} conv / ${usd(units(rec.ss_revenue))} → ledger (recipient-attributed) ${rec.ledger_rows} conv / ${usd(units(rec.ledger_revenue))}  (${recDelta >= 0 ? "+" : ""}${usd(recDelta)})`);
  console.log(`  explained by conversions latest-wins dropped: ${rec.extra_recipients} recipient(s), ${usd(units(rec.extra_revenue))} · unexplained ${usd(recDelta - units(rec.extra_revenue))}`);
  console.log(`  stage known, no recipient: ${rec.stage_only_rows} conv / ${usd(units(rec.stage_only_revenue))} · offer-only (no stage): ${rec.offer_only_rows}`);

  const [ksr] = (await db.execute(sql`
    SELECT (SELECT coalesce(sum(sales), 0) FROM keitaro_stage_results)::int AS k_sales,
           (SELECT coalesce(sum(revenue), 0) FROM keitaro_stage_results)::text AS k_revenue,
           (SELECT count(*) FROM conversion_events WHERE stage_id IS NOT NULL AND keitaro_type IN ('lead', 'sale', 'rejected'))::int AS l_sales,
           (SELECT coalesce(sum(revenue), 0) FROM conversion_events WHERE stage_id IS NOT NULL AND keitaro_type IN ('lead', 'sale', 'rejected'))::text AS l_revenue
  `)) as unknown as { k_sales: number; k_revenue: string; l_sales: number; l_revenue: string }[];
  const diffs = (await db.execute(sql`
    WITH k AS (SELECT stage_id, stat_date, sales, revenue FROM keitaro_stage_results WHERE sales > 0),
         l AS (SELECT stage_id, (occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
                      count(*)::int AS sales, sum(revenue) AS revenue
               FROM conversion_events
               WHERE stage_id IS NOT NULL AND keitaro_type IN ('lead', 'sale', 'rejected')
               GROUP BY 1, 2)
    SELECT coalesce(k.stage_id, l.stage_id) AS stage_id, coalesce(k.stat_date, l.stat_date)::text AS day,
           coalesce(k.sales, 0) AS k_sales, coalesce(l.sales, 0) AS l_sales,
           coalesce(k.revenue, 0)::text AS k_revenue, coalesce(l.revenue, 0)::text AS l_revenue
    FROM k FULL JOIN l ON l.stage_id = k.stage_id AND l.stat_date = k.stat_date
    WHERE coalesce(k.sales, 0) <> coalesce(l.sales, 0) OR coalesce(k.revenue, 0) <> coalesce(l.revenue, 0)
    ORDER BY 1, 2
  `)) as unknown as { stage_id: number; day: string; k_sales: number; l_sales: number; k_revenue: string; l_revenue: string }[];
  console.log(`\nDelta vs keitaro_stage_results (stage-day, same statuses as the aggregate: lead/sale/rejected):`);
  console.log(`  aggregate ${ksr.k_sales} / ${usd(units(ksr.k_revenue))} → ledger ${ksr.l_sales} / ${usd(units(ksr.l_revenue))}  (${usd(units(ksr.l_revenue) - units(ksr.k_revenue))})`);
  for (const d of diffs) {
    console.log(`  stage ${d.stage_id} ${d.day}: aggregate ${d.k_sales} / ${usd(units(d.k_revenue))} vs ledger ${d.l_sales} / ${usd(units(d.l_revenue))}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-run on camman-v2 (expected to FAIL V0, which proves the empty-scope bar is live)**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/verify-conversion-events.ts`
Expected: the scope lines print; `FAIL V0 scope is not empty` (the preview ledger is empty); exit 1.

- [ ] **Step 3: Lint and commit**

```bash
npx eslint scripts/verify-conversion-events.ts
git add scripts/verify-conversion-events.ts
git commit -m "feat(conversions): read-only verify — ledger vs live Keitaro, printed deltas

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/04-features/conversion-events.md`
- Modify: `docs/03-data-model.md` (header date; ERD after line `campaign_stages ||--o{ keitaro_stage_results : "sub_id_3 = stage tracking id"`; new table section after `### Reporting (migration 0093)`'s block; `offers` row in `### Registry`)
- Modify: `docs/06-integrations.md` (header date; append to the Keitaro gotchas paragraph, line ~50)
- Modify: `docs/07-conventions.md` (header date; two new sections at the end)
- Modify: `docs/CHANGELOG.md` (new entry at the top of the log)
- Modify: `docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md` (already carries the Decisions section; no change unless the build changed a decision)

- [ ] **Step 1: Write `docs/04-features/conversion-events.md`**

````markdown
# Conversion events (multi-event conversions)

_Last updated: 2026-09-17_

**Status:** Phase 1 — ledger + backfill. **Nothing reads the ledger yet.** Revenue, EPC, the purchased tier, segment purchase rules, drip and reports still read `stage_sends.sale_*` and `keitaro_stage_results` until Phase 3.

## Why

A click can now produce several conversions: Psycho Book (Affise) fires a $0 **registration** and a paid **purchase**, each with its own transaction id. Before this, CamMan held one sale per recipient (`stage_sends.sale_status`, latest wins), and every `lead` counted as a purchase. A registration arriving as `lead` would have been a buyer everywhere. Recon: [specs/2026-09-17-multi-event-conversions-recon.md](../superpowers/specs/2026-09-17-multi-event-conversions-recon.md).

## Model (migration 0181)

| Table | One row per | Key facts |
|---|---|---|
| `event_types` | org × event | `key`, `label`, `display_order`, flags `is_purchase`, `counts_revenue`, `is_retarget_signal`. Seeded: `purchase` (is_purchase, counts_revenue), `registration` (is_retarget_signal) |
| `conversion_event_mappings` | org × (network **or** offer) × Keitaro type | `keitaro_type` → `event_type_id` + `conversion_status` (`pending`/`approved`/`rejected`). An offer rule beats a network rule. `event_type_id` NULL = status transition only |
| `conversion_events` | Keitaro conversion | unique `keitaro_event_id`; `tid`; attribution `stage_send_id`/`contact_id`/`campaign_id`/`stage_id`/`offer_id` (all SET NULL); `event_type_id` (locked once set) + `status` (NULL = unmapped); `conflicting_event_type_id` + `event_type_conflict_at`; `revenue`, `currency`; `occurred_at` (original time, never moves), `last_postback_at`; `keitaro_status`, `keitaro_type`, `keitaro_version`, `status_history`, `raw_params` |
| `offers.keitaro_offer_id` | — | Keitaro's offer id (Psycho Book = 41), for conversions with no resolvable click |

Flags, not keys, carry meaning. A future `deposit` is a new `event_types` row with the right flags plus mapping rows. No code change.

## How a Keitaro conversion becomes a row

`lib/conversions/ingest.ts` → `ingestKeitaroConversions(db, { range })`:

1. `fetchKeitaroConversionLedger` pulls **all** conversion types. It fails on a truncated page (`rows < total`).
2. `parseKeitaroLedgerRow` (pure) normalises the row. The mapping key is the lowercased **conversion type** name, not the raw status. `occurred_at` is the earliest `status_history` stamp.
3. `buildConversionEventRows` (pure) attributes it:
   - `sub_id_1` = `stage_sends.id` → recipient
   - else `sub_id_3` = stage tracking id → stage
   - else `offers.keitaro_offer_id` → offer
   - else **unresolved**: reported, not stored
4. `resolveMapping` classifies it. No rule means NULL event type + status: stored, never a purchase.
5. `upsertConversionEvents` upserts on `keitaro_event_id`:
   - `occurred_at` never updates
   - event type is locked and attribution is sticky (`COALESCE`)
   - status/revenue and the raw Keitaro status/type take the newest values
   - no-op writes are skipped

## Event-type conflicts

A conversion's event type is **locked** once set, so a declined registration stays a registration. If Keitaro later reports a type whose mapping names a *different* event type — e.g. Registration → Sale because the advertiser reused a `tid` — the row keeps its locked type and stores the new raw type. It also records `conflicting_event_type_id` (the event the new type maps to) and `event_type_conflict_at` (first seen). The conflict is never silent:
- the ingest result counts it
- the backfill exits 1
- `verify-conversion-events.ts` fails V5
- Phase 2 alerts on it

A status-only mapping (NULL event type, e.g. Affise `rejected`) neither raises nor clears a conflict; a mapping that agrees again clears it. To resolve one: decide which event is right. If the lock is wrong, correct the row by SQL (`UPDATE conversion_events SET event_type_id = <right>, conflicting_event_type_id = NULL, event_type_conflict_at = NULL WHERE keitaro_event_id = '…'`) after approval.

## Seeded mappings (network level)

| Network (code) | Keitaro type | Event | Status | Why |
|---|---|---|---|---|
| Property Leads (`pl`) | lead | purchase | approved | Keitaro network #4 has a bare postback template (no status mapping), so the seed mirrors today's treatment: lead-gen CPA, the lead is payable |
| Property Leads (`pl`) | sale | purchase | approved | |
| Property Leads (`pl`) | rejected | purchase | rejected | |
| Sweeply (`swp`) | lead | purchase | approved | template hardcodes `status=lead` for paid conversions |
| Sweeply (`swp`) | rejected | purchase | rejected | |
| Secco (`scc`) | sale | purchase | approved | Everflow template `status={status}` |
| Secco (`scc`) | rejected | purchase | rejected | |
| PsychoBook (`psb`) | lead | **registration** | approved | the advertiser can only send `lead`/`sale`, on two separate postback URLs: `lead` = registration ($0) |
| PsychoBook (`psb`) | sale | purchase | approved | sent only after the customer pays; no hold |
| PsychoBook (`psb`) | rejected | — (keeps existing) | rejected | declines either event |
| PsychoBook (`psb`) | registration | registration | approved | Keitaro built-in type; unused today |

> `lead` does **not** mean the same thing across networks: paid on Sweeply, registration on PsychoBook. That is why mappings are per network. PsychoBook conversions arrive under Keitaro network #5 ("Affise.com PsychoBook", offer #41), but the mapping keys on the CamMan network reached through the offer, never on Keitaro's network id.

## How to add an event type or a mapping

```sql
-- New event type (per org)
INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
VALUES ('<org uuid>', 'deposit', 'Deposit', 30, false, true, false);

-- Network-level rule
INSERT INTO conversion_event_mappings (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status)
SELECT n.org_id, n.id, 'deposit', et.id, 'approved'
FROM affiliate_networks n JOIN event_types et ON et.org_id = n.org_id AND et.key = 'deposit'
WHERE n.network_id = 'psb';

-- Offer-level override (beats the network rule for this offer only)
INSERT INTO conversion_event_mappings (org_id, offer_id, keitaro_type, event_type_id, conversion_status)
SELECT o.org_id, o.id, 'lead', et.id, 'approved'
FROM offers o JOIN event_types et ON et.org_id = o.org_id AND et.key = 'purchase'
WHERE o.id = <offer id>;

-- Link a CamMan offer to its Keitaro offer id
UPDATE offers SET keitaro_offer_id = 41 WHERE id = 134;
```

To retire a rule, set `status = 'archived', archived_at = now()`; the unique indexes only cover active rules. Rows stored before a rule existed are healed on the next ingest of their window (sticky `COALESCE` fills NULLs). Re-run the backfill to heal older windows.

## Backfill and verification

```bash
npx tsx scripts/backfill-conversion-events.ts            # dry run
npx tsx scripts/backfill-conversion-events.ts --apply    # write (prod needs approval)
npx tsx scripts/verify-conversion-events.ts              # read-only
```

`verify-conversion-events.ts` asserts the ledger against a fresh Keitaro pull: every conversion present, per-type count and revenue to 4dp, no unmapped rows, no event-type conflicts, every currency USD, `occurred_at` = original time. It then prints the deltas against the old sources.

**Fail-loud rules.**
- **Truncated fetch:** a page with fewer rows than its own `total` is refused. The window writes nothing and the backfill exits 1; re-run with a smaller `BACKFILL_WINDOW_DAYS`.
- **Unparseable rows** (missing event_id / conversion_type / revenue, malformed datetime): counted and sampled in the ingest result. The backfill prints them and exits 1.
- **Currency:** `revenue` is USD. Every conversion to date carries `params.currency` USD or none, and `revenue` equals the postback payout. `currency` stores the postback's claim; a non-USD one fails verify V6. Recorded at recon, all accepted as corrections:

- **+$715** per recipient: 14 recipients' second conversions that latest-wins dropped
- **26 conversions / $1,463** known at stage level but with no recipient (blank `sub_id_1`)
- **−$100** stage-day: one conversion `keitaro_stage_results` counted on two days after a re-post

Checks: `scripts/test-conversion-ledger-rows.ts` (pure, 34), `scripts/test-conversion-events-upsert.ts` (camman-v2 only, rolled back, 15).

## Not built yet

- **Phase 2:** the ledger is written on the Keitaro poll tick. Telegram alerts for unmapped conversions and event-type conflicts, plus a monitor with heartbeat.
- **Bug-2 PR:** `keitaro_stage_results` conversion side aggregated from the ledger by `occurred_at`, not Keitaro's moving `datetime`.
- **Phase 3:** readers switch.
  - `purchasedClause` → purchase events in `pending`/`approved`
  - revenue and EPC → `counts_revenue` and `approved` only, with pending revenue as its own column
- **Phase 4:** Registered lane (tier 3; converted becomes 4; CHECK widened then).
- **Phase 5:** per-event report columns.
````

- [ ] **Step 2: `docs/03-data-model.md`**

Set line 3 to `_Last updated: 2026-09-17_`. Insert these ERD lines after `  campaign_stages ||--o{ keitaro_stage_results : "sub_id_3 = stage tracking id"`:

```
  organizations ||--o{ event_types : "event registry (0181)"
  organizations ||--o{ conversion_event_mappings : "keitaro type -> event (0181)"
  affiliate_networks ||--o{ conversion_event_mappings : "network-level rule"
  offers ||--o{ conversion_event_mappings : "offer-level override"
  event_types ||--o{ conversion_event_mappings : "maps to (null = keep)"
  event_types ||--o{ conversion_events : classifies
  stage_sends ||--o{ conversion_events : "sub_id_1 (set null)"
  campaign_stages ||--o{ conversion_events : "sub_id_3 (set null)"
  offers ||--o{ conversion_events : "set null"
```

In the `### Registry` table's `offers` row, append to the notes cell: ` · `keitaro_offer_id` (0181, nullable, unique per org) — Keitaro's offer id, for conversions with no resolvable click`.

Add this section immediately before `### Reports rollup (migration 0112)`:

```markdown
### Conversion events (migration 0181)
| Table | Key columns | Notes |
|-------|------------|-------|
| `event_types` | UNIQUE(`org_id`, `key`); `label`, `display_order`, `is_purchase`, `counts_revenue`, `is_retarget_signal`, `status`/`archived_at` | org event registry; seeded `purchase` and `registration` for every org. Meaning lives in the flags. [04-features/conversion-events.md](04-features/conversion-events.md) |
| `conversion_event_mappings` | `affiliate_network_id` XOR `offer_id` (CHECK `num_nonnulls = 1`), `keitaro_type`, `event_type_id` (nullable = keep existing), `conversion_status` pending/approved/rejected; partial UNIQUE per (network, type) and (offer, type) among active rows | Keitaro conversion TYPE → (event, status); offer rule beats network rule; no rule ⇒ unmapped. Seeded for `pl`, `swp`, `scc`, `psb` |
| `conversion_events` | UNIQUE(`keitaro_event_id`); `tid`, `stage_send_id`/`contact_id`/`campaign_id`/`stage_id`/`offer_id` (all **SET NULL**), `event_type_id` (locked once set) + `status` (NULL = unmapped), `conflicting_event_type_id` + `event_type_conflict_at` (a later type mapped to a different event), `revenue numeric(12,4)`, `occurred_at` (original time, never updated), `last_postback_at`, `keitaro_status`/`keitaro_type`/`keitaro_version`, `status_history`, `raw_params jsonb` | one row per Keitaro conversion (several per click). Written by `lib/conversions/ingest.ts`; **no reader until Phase 3**. Indexes: (campaign, event, contact), (contact, event), (offer, event, occurred_at), (stage, occurred_at), (stage_send), partial unmapped (org, created_at), partial type-conflict (org, event_type_conflict_at) |

> RLS: all three tables enable RLS with an own-org `SELECT` policy (pattern `0178`); writes go through the server connection.
```

- [ ] **Step 3: `docs/06-integrations.md`**

Set line 3 to `_Last updated: 2026-09-17_`. Append to the end of the `> Keitaro gotchas` paragraph (line ~50):

```markdown
 **Conversion ledger** (`fetchKeitaroConversionLedger`, `KEITARO_LEDGER_COLUMNS`, 0181): no status filter, all conversion types. Extra columns verified live 2026-09-17:
 - `tid`
 - `sub_id` (click id)
 - `conversion_type` — canonical type name: Lead/Sale/Rejected/Trash/Registration/Deposit. Many raw statuses resolve to one type, so this is the mapping key.
 - `version` — bumps on an in-place update
 - `status_history` — `"N. Type (YYYY-MM-DD HH:MM:SS)"` in the report timezone
 - `params` — the postback query as JSON

 Gotchas:
 - A bad column's 400 body lists the entire `events` definition. `original_status`/`previous_status`/`conversion_id`/`postback_datetime` return 200 but are silently omitted.
 - **Keitaro updates a conversion in place:** `event_id` is stable, `datetime` moves to the latest re-post.
 - A different `tid` on one click is a separate conversion.
 - The response carries `total`, and a page with `rows < total` is refused.
 - Keitaro conversion types are listed at `GET /admin_api/v1/conversion_types`. Network postback templates are at `GET /admin_api/v1/affiliate_networks/{id}`; the URL contains the postback key, so redact it before logging.
```

- [ ] **Step 4: `docs/07-conventions.md`**

Set line 3 to `_Last updated: 2026-09-17_`. Append at the end of the file:

```markdown
## Keitaro updates a conversion in place — `event_id` is stable, `datetime` is not (2026-09-17)

A repeat postback for a conversion — same click and no `tid`, or the same `tid` — updates it: Keitaro bumps `version`, appends to `status_history`, and moves `datetime` to the new postback. `event_id` stays the same. Measured on one conversion re-posted 09-14 → 09-17. Two consequences in pre-ledger code:

- **Dedup on `event_id` alone drops the update.** `poll-conversions.ts` skips a row whose stored `keitaro_conversion_id` equals the incoming `event_id`, so a hold → approved or → rejected transition never reached `stage_sends`.
- **Dating by `datetime` inside a rolling window double-counts.** The aggregate poll re-dates the conversion to the new day while the old day's row sits outside its 3-day window, frozen. Measured: +1 sale / +$100 on one stage.

The ledger (`conversion_events`) keys on `event_id`, **updates** changed rows, and dates by `occurred_at` = the earliest `status_history` stamp, which never moves.

## Map Keitaro conversions by conversion TYPE, per network — `lead` does not mean one thing (2026-09-17)

Sweeply's postback template hardcodes `status=lead` for **paid** conversions. Keitaro's Affise template maps Affise pending/hold (2, 5) to `lead`. The same word means approved on one network and on-hold on another, so a global "lead = X" rule is wrong for somebody.

`conversion_event_mappings` classifies per network or offer, keyed on Keitaro's canonical conversion **type** (many raw statuses — `approved`, `confirmed`, `paid` — resolve to the one `Sale` type). An unknown network/type is stored with NULL event type and status and is never counted as a purchase. Guessing "it's probably a sale" is exactly how a $0 registration would have become a buyer.
```

- [ ] **Step 5: `docs/CHANGELOG.md`**

Insert as the first entry, directly after the intro paragraph:

```markdown
2026-09-17 - Conversion events ledger, Phase 1 (migration 0181, additive; nothing reads it yet). New `event_types` (seeded purchase + registration), `conversion_event_mappings` (Keitaro conversion type → event + pending/approved/rejected, per network or offer; seeded for Property Leads, Sweeply, Secco, PsychoBook), `conversion_events` (one row per Keitaro conversion, keyed on event_id, original-time `occurred_at`, locked event type with a recorded `conflicting_event_type_id` when a later type maps elsewhere), `offers.keitaro_offer_id`. New `lib/conversions/` (fetch all conversion types, pure parse/attribute/map, idempotent upsert), `scripts/backfill-conversion-events.ts` (dry-run default), `scripts/verify-conversion-events.ts` (ledger vs live Keitaro; prints the accepted +$715 / 26 conv $1,463 / −$100 deltas). Checks: test-conversion-ledger-rows 34, test-conversion-events-upsert 15 (camman-v2, rolled back). — docs updated: 04-features/conversion-events.md (new), 03-data-model.md (+ERD), 06-integrations.md, 07-conventions.md, spec + plan.
```

- [ ] **Step 6: Docs check + commit**

Run: `npm run check:docs`
Expected: exit 0.

```bash
git add docs/04-features/conversion-events.md docs/03-data-model.md docs/06-integrations.md docs/07-conventions.md docs/CHANGELOG.md docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md docs/superpowers/plans/2026-09-17-conversion-events-phase1.md
git diff --cached --stat -- docs/CHANGELOG.md docs/07-conventions.md   # insertions only
git commit -m "docs(conversions): conversion events ledger — feature doc, data model, conventions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Review, prod gates, backfill

No new code. Each **GATE** needs the user's explicit go-ahead in the conversation.

- [ ] **Step 1: Whole-branch checks**

```bash
git fetch origin && git rev-list --count HEAD..origin/main   # if >0: rebase, re-run everything
npx tsc --noEmit -p .
npx eslint lib/keitaro/client.ts lib/conversions/*.ts scripts/test-conversion-ledger-rows.ts scripts/test-conversion-events-upsert.ts scripts/test-conversion-lookups.ts scripts/backfill-conversion-events.ts scripts/verify-conversion-events.ts
npx tsx scripts/test-conversion-ledger-rows.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-events-upsert.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/test-conversion-lookups.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/verify-migration-integrity.ts
npm run check:docs
git push
```

Expected: tsc 0; eslint no problems; ledger-rows 38/0; upsert 17/0; lookups 7/0; camman-v2 integrity shows 0181 `hash ✓` (0167–0169 carry a pre-existing, unrelated rotated-hash mismatch on the preview DB); docs 0. Then run the whole-branch code review (`superpowers:requesting-code-review`), fix findings, re-run this step, and mark the PR ready.

Fix wave 2 (after the final review) reordered 0181 — `SET LOCAL lock_timeout = '5s'` first, the `offers` column + index before any FK lock, a seed guard against a mistyped event key. That changed the file hash, so camman-v2's recorded 0181 hash was repaired in `drizzle.__drizzle_migrations` (the SQL was not re-applied; the schema is unchanged). 0181 is not applied on prod yet (GATE A below), so prod records the new hash when it applies.

- [ ] **Step 2: GATE A — apply migration 0181 to prod** (user approval required)

First re-run the read-only network-code check on prod (Supabase MCP, project `rtdarhkkjwcetlmruftl`). The mapping seed resolves networks by code, and a missing code seeds nothing:

```sql
SELECT id, network_id, name FROM affiliate_networks WHERE network_id IN ('swp', 'scc', 'pl', 'psb') ORDER BY network_id;
```

Expected: 4 rows, names as recorded at recon (verified on prod 2026-09-17): `pl` Property Leads (id 42), `psb` PsychoBook AstroAff (43), `scc` Secco (38), `swp` Sweeply (1). A missing code, or a name pointing at a different network, is a stop.

Then apply. 0181 runs under `lock_timeout = 5s`: a lock-timeout failure (`55P03`) rolls the whole migration back, so just retry (ideally while the drain is idle).

```bash
npm run db:migrate
npx tsx scripts/verify-migration-integrity.ts
```

Expected: the integrity check ends `Migration integrity OK.` Then confirm the seeds on prod (Supabase MCP, project `rtdarhkkjwcetlmruftl`, read-only):

```sql
SELECT (SELECT count(*) FROM event_types) AS event_types,
       (SELECT string_agg(an.network_id || ':' || m.keitaro_type || '→' || coalesce(et.key, '(keep)') || '/' || m.conversion_status, ', ' ORDER BY an.network_id, m.keitaro_type)
          FROM conversion_event_mappings m
          JOIN affiliate_networks an ON an.id = m.affiliate_network_id
          LEFT JOIN event_types et ON et.id = m.event_type_id) AS mappings;
```

Expected: `event_types = 2`, and mappings:
`pl:lead→purchase/approved, pl:rejected→purchase/rejected, pl:sale→purchase/approved, psb:lead→registration/approved, psb:registration→registration/approved, psb:rejected→(keep)/rejected, psb:sale→purchase/approved, scc:rejected→purchase/rejected, scc:sale→purchase/approved, swp:lead→purchase/approved, swp:rejected→purchase/rejected`.

- [ ] **Step 3: Merge the PR** (ship-on-green policy; the code is inert, since no route calls it). Confirm the prod deployment is READY.

- [ ] **Step 4: Map Psycho Book (prod data write, user approval required), then backfill dry run on prod (read-only)**

**First, map Psycho Book — BEFORE the dry run, with the user's explicit approval (a prod data write, decision 8c):**

```sql
UPDATE offers SET keitaro_offer_id = 41 WHERE id = 134;
```

Why first: conversion `01a0af9b-d2e0-702b-a7c1-2f50d2c35c46` has no `sub_id_1`/`sub_id_3`. Without the Keitaro offer link it is **unresolved**, which fails the dry run and verify V1. The column exists only after GATE A.

**Expected:** PsychoBook's `status=lead` registrations (recon 2026-09-17: `01a0af9b-d2e0-702b-a7c1-2f50d2c35c46`, `01a0afa8-9098-7017-a108-ca0262ced958`, plus any since) enter the ledger correctly as **registration/approved** via the `psb` `lead` mapping. No Keitaro-side fix is needed for the ledger. The old pollers still count these as sales until Phase 3; that correction is separate.

Run: `npx tsx scripts/backfill-conversion-events.ts`
Expected: `fetched` totals the Keitaro history (1,460 at recon, more now), with `unresolved 0`, `unmapped 0`, `invalid 0`, no window ERROR (truncated or malformed page), exit 0. Paste the totals line to the user. Any unresolved or unmapped conversion stops here for a decision. A `status-only` WARNING is not a stop on its own: those rows are unmapped only if brand-new, and only the `--apply` table check can tell (Step 5). A dry run doesn't upsert, so it can't report org mismatches.

- [ ] **Step 5: GATE B — backfill apply** (user approval required, on the dry-run output)

Run: `npx tsx scripts/backfill-conversion-events.ts --apply`
Expected: `inserted` = dry-run `rows`, `updated 0`, `org-mismatch 0`, and `Table after apply: N rows · 0 unmapped · 0 event-type conflict(s)`, exit 0. Re-run once more with `--apply`; expected `inserted 0 updated 0 unchanged N org-mismatch 0`, which is idempotence on real data.

- [ ] **Step 6: Verify**

Run: `npx tsx scripts/verify-conversion-events.ts`
Expected: all V-checks PASS, and printed deltas close to recon:
- recipient delta ≈ +$715 plus any new second conversions, with unexplained $0.00
- stage-only 26 conv / $1,463 plus new ones
- stage-day list = the re-dated stage(s) and the offer-126 sibling swap

Paste the output to the user. A delta that recon didn't explain is a stop, not a note.

- [ ] **Step 7: Close out**

(Psycho Book's `keitaro_offer_id = 41` was already set in Step 4, before the dry run.) Post the verify output on the card, and update memory (`project_multi_event_conversions_recon.md` → Phase 1 LIVE). Unlink the worktree junction with `cmd //c "rmdir node_modules"`.

---

## Later phases (separate plans, in order)

1. **Phase 2 — ingest live:** call `ingestKeitaroConversions` on the Keitaro poll tick (one fetch feeding both the ledger and the aggregate). Add Tier-2 Telegram alerts for unmapped conversions, **event-type conflicts** (`conflicting_event_type_id IS NOT NULL`), **unparseable Keitaro rows** (ingest `invalid > 0`) and **truncated/failed fetches** (a window refused, nothing written), plus a 24h monitor with heartbeat.
2. **Bug-2 PR:** aggregate `keitaro_stage_results` conversions from the ledger by `occurred_at`/`event_id`, with today's semantics (−$100 correction only).
3. **Phase 3 — readers:**
   - `purchasedClause` → ledger purchase events in pending/approved
   - revenue/EPC → `counts_revenue` and approved, plus a pending revenue column
   - stage_sends projection kept until all readers move; a destructive drop follows later
   - byte-identical proof script
4. **Phase 4 — Registered lane:** tier 3 registered / 4 converted; CHECK widened to `IN (0,1,2,3)`; the two lane-count copies updated; minimum drip changes.
5. **Phase 5 — reports.** Design recorded by the user 2026-09-17; no build yet.
   - **Surfaces:** campaign, stage, /reports By-X, and the offer report.
   - **Columns:** Clicks (human) · Registrations · Reg rate · Purchases · Pending · Reg→Purchase % · Revenue (approved) · Pending $ · EPC (approved only).
   - Columns are generated from the `event_types` registry, so an offer without an event doesn't show its column.
   - An "unmapped conversions" badge. Telegram gets the same split.
