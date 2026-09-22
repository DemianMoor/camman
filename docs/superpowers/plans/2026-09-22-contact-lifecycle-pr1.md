# Contact lifecycle — PR 1 (migration 0187, engagement job, dry-run report) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the data layer of the contact lifecycle feature:
- migration 0187;
- the engagement job, which computes each contact's lifecycle status and is inert until switched on per org;
- a production dry-run report and a one-off backfill script.

**Architecture:**
- `lib/engagement/` holds three pieces:
  - the lifecycle rules as SQL builders (`status-sql.ts`, the single definition of spec §3.2);
  - an orchestrator (`refresh.ts`) that recounts facts into temp tables, evaluates status, and either reports (dry run) or writes changed rows;
  - a heartbeat watcher (`monitor.ts`).
- One cron route runs it every 15 minutes (incremental) and nightly (full), for orgs whose `lifecycle_settings.engine_mode = 'write'`.
- The one-off backfill flips that switch after the owner approves the dry-run numbers.

**Tech Stack:** Next.js 16 route handlers · Drizzle (`sql` templates over postgres-js) · Postgres 15 (Supabase, transaction pooler) · tsx test scripts against the preview DB (camman-v2).

**Spec:** [docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md](../specs/2026-09-22-contact-lifecycle-status-design.md), §3–§5, §12, §13, §15 PR 1.

## Global Constraints

- **Worktree:** `C:\AFF\camman\.claude\worktrees\lifecycle-recon`, branch `feat/contact-lifecycle`. Never work in `C:\AFF\camman` (shared checkout). Use absolute paths in shell commands.
- **Migration number `0187`.** 0186 is taken on main by `0186_stage_delivery_rollup`. Re-check `git ls-tree --name-only origin/main db/migrations/` right before opening the PR; if 0187 is taken, renumber and tell the user.
- **No prod migration apply without the user's explicit approval of the SQL.** Preview (camman-v2, ref `fdzxzxayhknywvmrhjcj`) is fine. Prod ref is `rtdarhkkjwcetlmruftl`.
- **No prod data write without the user's explicit approval.** The backfill `--apply` is a data write. The dry run is not: it always rolls back.
- **Status is never computed in the send loop.** No trigger on `stage_sends`, and no change to `lib/sends/*`, `lib/audience-snapshot.ts`, the segment-rule registration files, or the campaign Audience components in this PR.
- **Do not change** the `stage_sends.status` or `segment_rules.rule_type` CHECK constraints in this PR (they ship with PR 4 / PR 3).
- **Definitions are imported, never retyped:**
  - human click = `HUMAN_CLICK` from `lib/reporting/counted-clickers.ts` (`ck.classification = 'human' AND ck.scored_at IS NOT NULL`);
  - message = `stage_sends.status = 'sent'`;
  - status = `evaluationSelectSql()` from `lib/engagement/status-sql.ts`.
- **Every domain query filters `org_id`.**
- **Tests:**
  - DB tests run on the preview DB only. Order: `import "./_env-preload"` then `import "./_require-preview-db"`, then dynamic imports inside `main()`.
  - Contacts use `fictionalPhones()` + `refuseIfPhonesInUse()` from `scripts/_fictional-phones.ts`.
  - Teardown deletes by the org id the test created, after re-reading its marker, and ends with a post-teardown count of 0.
  - Run with `npx tsx --conditions=react-server`.
- **Preview DB env prefix** (used in every preview command below): `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)"`
- **Lint only changed files** (`npx eslint <files>`). `npm run lint` walks every worktree and is unusable.
- **Docs are part of done** (CLAUDE.md "Documentation maintenance").
- **Commits** end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Stage files explicitly; never `git add -A`.

## Deviations from the spec (tell the user when presenting the SQL)

1. **The two CHECK-constraint changes are not in 0187.**
   - `segment_rules.rule_type` moves to PR 3, because `scripts/test-segment-rule-type-registration.ts` compares the CHECK with `RULE_TYPES` in both directions.
   - `stage_sends.status` moves to PR 4, because rewriting that CHECK scans the 4.3 GB send table under ACCESS EXCLUSIVE; PR 4 does NOT VALID + VALIDATE.
   - Everything else in spec §4 is in 0187.
2. **`lifecycle_settings.engine_mode`** (`'off'` | `'write'`, default `'off'`) is the dry-run switch the spec asks for. It is per org and audited, and needs no redeploy.
3. **`contact_engagement.time_due_at`** (+ partial index): the instant a row's status can change with no new send or click. The 15-minute run re-evaluates rows whose instant has passed, so hot→warm, warm→cold and freeze→suppressed happen without a full recount.
4. **Only `(org_id, status)` and `(org_id, time_due_at)` indexes on `contact_engagement`.** The date indexes the segment rules need ship with PR 3.

## Execution order and gates

```
Task 0  worktree env                          ─┐
Task 1  migration 0187 + schema (preview only) ─┤→ GATE A: user approves the SQL
Task 2  status-sql + evaluator tests           │
Task 3  refresh orchestrator + world tests     │
Task 4  cron route, monitor, heartbeats        │
Task 5  backfill / dry-run script              │
Task 6  docs                                   │
Task 7  verify, rebase, PR                    ─┘
Task 8  (after GATE A) apply 0187 to prod, run the prod dry run → GATE B: user approves the numbers
Task 9  (after GATE B, and after merge) run --apply, watch the first cron ticks
```

## File map

| File | Responsibility |
|---|---|
| `db/migrations/0187_contact_engagement.sql` | New tables and columns (create) |
| `db/migrations/meta/0187_snapshot.json`, `_journal.json` | Migration chain (create / modify) |
| `db/schema.ts` | Drizzle mirror of 0187 (modify) |
| `lib/engagement/constants.ts` | Statuses, reasons, thresholds type + defaults, job names |
| `lib/engagement/status-sql.ts` | THE rules: `evaluationSelectSql()` and its parts |
| `lib/engagement/refresh.ts` | `refreshContactEngagement()` orchestrator |
| `lib/engagement/settings.ts` | `orgsWithEngineOn()` |
| `lib/engagement/monitor.ts` | `watchEngagementHeartbeat()` |
| `app/api/cron/refresh-contact-engagement/route.ts` | Cron entry point |
| `lib/reporting/cron-heartbeat.ts` | + two `HEARTBEAT_JOBS` entries (modify) |
| `app/api/cron/tracking-monitors/route.ts` | + one watch call (modify) |
| `lib/authz/route-map.ts`, `vercel.json` | Route classification + schedules (modify) |
| `scripts/test-engagement-db.ts` | Preview tests: evaluator, world, monitor |
| `scripts/engagement-backfill.ts` | Prod dry-run report and `--apply` backfill |
| `scripts/test-preview-db-guard.ts` | + EXCLUSIONS entry (modify) |
| `docs/…` | Feature doc, data model + ERD, crons, conventions, changelog |

---

### Task 0: Worktree environment

**Files:** none committed.

- [ ] **Step 1: Link node_modules and .env.local into the worktree.** Use a junction for node_modules and a hard link for .env.local. Never `rm -rf` the junction.

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
[ -e node_modules ] || cmd //c "mklink /J node_modules C:\AFF\camman\node_modules"
[ -e .env.local ] || cmd //c "mklink /H .env.local C:\AFF\camman\.env.local"
git check-ignore -q .env.local && echo "env ignored OK"
git status --short
```
Expected: `env ignored OK`; `git status` shows no `node_modules` or `.env.local`.

- [ ] **Step 2: Confirm the branch base.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon && git fetch origin --quiet && git rev-list --count HEAD..origin/main && git ls-tree --name-only origin/main db/migrations/ | grep -E '/0[0-9]{3}_' | tail -2
```
Expected:
- `0`, or a small number: rebase with `git rebase origin/main` and report any conflict instead of resolving it silently.
- The last migration listed is `0186_stage_delivery_rollup.sql`.

---

### Task 1: Migration 0187 + Drizzle schema (applied to PREVIEW only)

**Files:**
- Create: `db/migrations/0187_contact_engagement.sql`
- Create: `db/migrations/meta/0187_snapshot.json` (a verbatim copy of 0186's, with a new id/prevId)
- Modify: `db/migrations/meta/_journal.json`
- Modify: `db/schema.ts` — the `contact_groups` block (~line 1034), the `campaigns` block (after `exclude_prior_offer_contacts`, ~line 1833), and new tables appended after `stage_delivery_rollup`

**Interfaces:**
- Produces:
  - tables `lifecycle_settings`, `contact_engagement`, `contact_engagement_transitions`, `contact_offer_campaigns`, `stage_send_lifecycle`;
  - columns `contact_groups.{freeze_after_messages, freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages}` and `campaigns.lifecycle_rules`;
  - Drizzle exports `lifecycle_settings`, `contact_engagement`, `contact_engagement_transitions`, `contact_offer_campaigns`, `stage_send_lifecycle`.

- [ ] **Step 1: Write the migration.** Create `db/migrations/0187_contact_engagement.sql`:

```sql
-- Migration 0187: contact engagement — per-contact lifecycle status.
-- Spec: docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md §4.
--
-- WHAT. Five new tables and five new columns, all additive:
--   lifecycle_settings              org singleton: the six thresholds, engine_mode
--                                   (the job's on/off switch) and
--                                   reevaluate_requested_at (used by PR 2's settings save)
--   contact_engagement              one row per contact: facts, status, freeze clock
--   contact_engagement_transitions  status history, with the thresholds in effect
--   contact_offer_campaigns         per (contact, offer, campaign) exposure — the data
--                                   ClickUp 869f53efz needs; offer_exposures keeps only
--                                   the FIRST exposure per contact x offer
--   stage_send_lifecycle            status-at-send for the cohort report; send records
--                                   are never rewritten
--   contact_groups.{freeze_after_messages, freeze_cadence_days, suppress_after_days,
--                   suppress_min_freeze_messages}  per-group overrides, NULL = inherit
--   campaigns.lifecycle_rules       false for every existing campaign; the create route
--                                   sets it once the lifecycle chips ship (PR 4)
--
-- WRITERS. Only the engagement job (lib/engagement/refresh.ts, run by
-- /api/cron/refresh-contact-engagement and scripts/engagement-backfill.ts) writes
-- contact_engagement, its transitions and contact_offer_campaigns. Nothing on
-- stage_sends, clicks or the send path changes. The job skips an org unless its
-- lifecycle_settings.engine_mode is 'write'; no row means 'off'.
--
-- NOT HERE, deliberately (each ships with the PR that uses it):
--   segment_rules.rule_type CHECK (+8 rule types) — PR 3.
--     scripts/test-segment-rule-type-registration.ts compares the CHECK with
--     RULE_TYPES in both directions, so the CHECK cannot run ahead of the code.
--   stage_sends.status CHECK (+skipped_ineligible) — PR 4. Rewriting that CHECK
--     scans the 4.3 GB send table under ACCESS EXCLUSIVE; PR 4 adds it NOT VALID
--     and VALIDATEs separately so the drain never waits.
--
-- LOCKS. The two ALTER TABLEs are catalog-only (nullable columns, a constant
-- default, and a CHECK over the ~21 contact_groups rows). They take ACCESS
-- EXCLUSIVE briefly and go first, per the strongest-lock-first rule. The new
-- foreign keys take SHARE ROW EXCLUSIVE on contacts, campaigns, offers and
-- stage_sends until commit, which pauses send-status writes for the few ms the
-- transaction lasts. lock_timeout makes a busy moment fail fast (and roll back)
-- instead of queueing behind the drain.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS lifecycle_rules boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS freeze_after_messages smallint,
  ADD COLUMN IF NOT EXISTS freeze_cadence_days smallint,
  ADD COLUMN IF NOT EXISTS suppress_after_days smallint,
  ADD COLUMN IF NOT EXISTS suppress_min_freeze_messages smallint;
--> statement-breakpoint
ALTER TABLE public.contact_groups
  DROP CONSTRAINT IF EXISTS contact_groups_lifecycle_overrides_check;
--> statement-breakpoint
ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_lifecycle_overrides_check CHECK (
    (freeze_after_messages IS NULL OR freeze_after_messages BETWEEN 1 AND 1000)
    AND (freeze_cadence_days IS NULL OR freeze_cadence_days BETWEEN 1 AND 365)
    AND (suppress_after_days IS NULL OR suppress_after_days BETWEEN 1 AND 730)
    AND (suppress_min_freeze_messages IS NULL OR suppress_min_freeze_messages BETWEEN 1 AND 100)
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.lifecycle_settings (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  hot_days smallint NOT NULL DEFAULT 30,
  warm_days smallint NOT NULL DEFAULT 120,
  freeze_after_messages smallint NOT NULL DEFAULT 10,
  freeze_cadence_days smallint NOT NULL DEFAULT 14,
  suppress_after_days smallint NOT NULL DEFAULT 60,
  suppress_min_freeze_messages smallint NOT NULL DEFAULT 2,
  -- 'off' = the job skips this org; 'write' = it maintains contact_engagement.
  -- The dry run never needs this: it rolls its own transaction back.
  engine_mode text NOT NULL DEFAULT 'off',
  reevaluate_requested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT lifecycle_settings_ranges_check CHECK (
    hot_days BETWEEN 1 AND 365
    AND warm_days BETWEEN 2 AND 730
    AND warm_days > hot_days
    AND freeze_after_messages BETWEEN 1 AND 1000
    AND freeze_cadence_days BETWEEN 1 AND 365
    AND suppress_after_days BETWEEN 1 AND 730
    AND suppress_min_freeze_messages BETWEEN 1 AND 100
  ),
  CONSTRAINT lifecycle_settings_engine_mode_check CHECK (engine_mode IN ('off', 'write'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_engagement (
  contact_id uuid PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL,
  status_changed_at timestamptz NOT NULL,
  msgs_total integer NOT NULL DEFAULT 0,
  msgs_since_click integer NOT NULL DEFAULT 0,
  msgs_7d integer NOT NULL DEFAULT 0,
  msgs_14d integer NOT NULL DEFAULT 0,
  msgs_30d integer NOT NULL DEFAULT 0,
  msgs_90d integer NOT NULL DEFAULT 0,
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  first_click_at timestamptz,
  last_click_at timestamptz,
  freeze_entered_at timestamptz,
  freeze_started_at timestamptz,
  freeze_msgs integer NOT NULL DEFAULT 0,
  freeze_cadence_days smallint NOT NULL,
  thresholds jsonb NOT NULL,
  -- Earliest instant at which status can change with no new send or click
  -- (hot -> warm, warm -> cold, freeze -> suppressed). NULL = never by time alone.
  time_due_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_engagement_status_check
    CHECK (status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_status_idx
  ON public.contact_engagement (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_time_due_idx
  ON public.contact_engagement (org_id, time_due_at) WHERE time_due_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_engagement_transitions (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  thresholds jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_engagement_transitions_to_check
    CHECK (to_status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')),
  CONSTRAINT contact_engagement_transitions_from_check
    CHECK (from_status IS NULL OR from_status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')),
  CONSTRAINT contact_engagement_transitions_reason_check
    CHECK (reason IN ('backfill', 'first_seen', 'first_message', 'freeze_threshold',
                      'threshold_change', 'freeze_expired', 'human_click',
                      'click_aged_warm', 'click_aged_cold', 'recount'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_transitions_contact_idx
  ON public.contact_engagement_transitions (contact_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_transitions_org_idx
  ON public.contact_engagement_transitions (org_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_offer_campaigns (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  offer_id integer NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  first_sent_at timestamptz NOT NULL,
  last_sent_at timestamptz NOT NULL,
  messages integer NOT NULL,
  PRIMARY KEY (contact_id, offer_id, campaign_id)
);
--> statement-breakpoint
-- The 869f53efz read: one offer's exposures per contact.
CREATE INDEX IF NOT EXISTS contact_offer_campaigns_org_offer_contact_idx
  ON public.contact_offer_campaigns (org_id, offer_id, contact_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.stage_send_lifecycle (
  stage_send_id uuid PRIMARY KEY REFERENCES public.stage_sends(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL,
  reconstructed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_send_lifecycle_status_check
    CHECK (status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE public.lifecycle_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_engagement ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_engagement_transitions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_offer_campaigns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stage_send_lifecycle ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read-only to members of the org. No INSERT/UPDATE/DELETE policy: the server's
-- own connection bypasses RLS, and it is the only writer.
DROP POLICY IF EXISTS "lifecycle_settings_select_own_org" ON public.lifecycle_settings;
--> statement-breakpoint
CREATE POLICY "lifecycle_settings_select_own_org" ON public.lifecycle_settings
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_engagement_select_own_org" ON public.contact_engagement;
--> statement-breakpoint
CREATE POLICY "contact_engagement_select_own_org" ON public.contact_engagement
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_engagement_transitions_select_own_org" ON public.contact_engagement_transitions;
--> statement-breakpoint
CREATE POLICY "contact_engagement_transitions_select_own_org" ON public.contact_engagement_transitions
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_offer_campaigns_select_own_org" ON public.contact_offer_campaigns;
--> statement-breakpoint
CREATE POLICY "contact_offer_campaigns_select_own_org" ON public.contact_offer_campaigns
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "stage_send_lifecycle_select_own_org" ON public.stage_send_lifecycle;
--> statement-breakpoint
CREATE POLICY "stage_send_lifecycle_select_own_org" ON public.stage_send_lifecycle
  FOR SELECT USING (org_id = public.current_org_id());
```

- [ ] **Step 2: Snapshot and journal.** The snapshot is a verbatim clone; only id and prevId change (the 0185 → 0186 precedent).

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
sed -e 's/"id": "0186a000-0186-4186-8186-000000000186"/"id": "0187a000-0187-4187-8187-000000000187"/' \
    -e 's/"prevId": "0185a000-0185-4185-8185-000000000185"/"prevId": "0186a000-0186-4186-8186-000000000186"/' \
    db/migrations/meta/0186_snapshot.json > db/migrations/meta/0187_snapshot.json
head -3 db/migrations/meta/0187_snapshot.json
```
Expected: id `0187a000-…`, prevId `0186a000-…`.

Then add this entry to the end of the `"entries"` array in `db/migrations/meta/_journal.json`, after the `0186_stage_delivery_rollup` object:

```json
    {
      "idx": 187,
      "version": "7",
      "when": 1792713600000,
      "tag": "0187_contact_engagement",
      "breakpoints": true
    }
```

- [ ] **Step 3: Mirror in `db/schema.ts`.**

(a) In `contact_groups`, after `status` and before `archived_at`, add:

```ts
    // Lifecycle overrides (migration 0187). NULL = inherit the org default in
    // lifecycle_settings. A contact in several active groups takes the strictest
    // value across them (lib/engagement/refresh.ts).
    freeze_after_messages: smallint("freeze_after_messages"),
    freeze_cadence_days: smallint("freeze_cadence_days"),
    suppress_after_days: smallint("suppress_after_days"),
    suppress_min_freeze_messages: smallint("suppress_min_freeze_messages"),
```

Add this to the table's constraints array, after `contact_groups_status_check`:

```ts
    check(
      "contact_groups_lifecycle_overrides_check",
      sql`(${table.freeze_after_messages} IS NULL OR ${table.freeze_after_messages} BETWEEN 1 AND 1000) AND (${table.freeze_cadence_days} IS NULL OR ${table.freeze_cadence_days} BETWEEN 1 AND 365) AND (${table.suppress_after_days} IS NULL OR ${table.suppress_after_days} BETWEEN 1 AND 730) AND (${table.suppress_min_freeze_messages} IS NULL OR ${table.suppress_min_freeze_messages} BETWEEN 1 AND 100)`,
    ),
```

(b) In `campaigns`, right after the `exclude_prior_offer_contacts` column, add:

```ts
    // Migration 0187. true once a campaign is created with lifecycle chips
    // (PR 4); every campaign that existed before stays false and keeps its
    // legacy audience semantics. Gates the lifecycle eligibility layers.
    lifecycle_rules: boolean("lifecycle_rules").notNull().default(false),
```

(c) After the `stage_delivery_rollup` table (and its type export), add:

```ts
// ---- Contact lifecycle / engagement (migration 0187) -------------------------
// Spec: docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md.
// Written ONLY by lib/engagement/refresh.ts (cron + one-off backfill).

export const lifecycle_settings = pgTable(
  "lifecycle_settings",
  {
    org_id: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    hot_days: smallint("hot_days").notNull().default(30),
    warm_days: smallint("warm_days").notNull().default(120),
    freeze_after_messages: smallint("freeze_after_messages").notNull().default(10),
    freeze_cadence_days: smallint("freeze_cadence_days").notNull().default(14),
    suppress_after_days: smallint("suppress_after_days").notNull().default(60),
    suppress_min_freeze_messages: smallint("suppress_min_freeze_messages").notNull().default(2),
    engine_mode: text("engine_mode").notNull().default("off"),
    reevaluate_requested_at: timestamp("reevaluate_requested_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updated_by: uuid("updated_by"),
  },
  (table) => [
    check(
      "lifecycle_settings_ranges_check",
      sql`${table.hot_days} BETWEEN 1 AND 365 AND ${table.warm_days} BETWEEN 2 AND 730 AND ${table.warm_days} > ${table.hot_days} AND ${table.freeze_after_messages} BETWEEN 1 AND 1000 AND ${table.freeze_cadence_days} BETWEEN 1 AND 365 AND ${table.suppress_after_days} BETWEEN 1 AND 730 AND ${table.suppress_min_freeze_messages} BETWEEN 1 AND 100`,
    ),
    check("lifecycle_settings_engine_mode_check", sql`${table.engine_mode} IN ('off', 'write')`),
  ],
);

export const contact_engagement = pgTable(
  "contact_engagement",
  {
    contact_id: uuid("contact_id")
      .primaryKey()
      .references(() => contacts.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    status_changed_at: timestamp("status_changed_at", { withTimezone: true }).notNull(),
    msgs_total: integer("msgs_total").notNull().default(0),
    msgs_since_click: integer("msgs_since_click").notNull().default(0),
    msgs_7d: integer("msgs_7d").notNull().default(0),
    msgs_14d: integer("msgs_14d").notNull().default(0),
    msgs_30d: integer("msgs_30d").notNull().default(0),
    msgs_90d: integer("msgs_90d").notNull().default(0),
    first_sent_at: timestamp("first_sent_at", { withTimezone: true }),
    last_sent_at: timestamp("last_sent_at", { withTimezone: true }),
    first_click_at: timestamp("first_click_at", { withTimezone: true }),
    last_click_at: timestamp("last_click_at", { withTimezone: true }),
    freeze_entered_at: timestamp("freeze_entered_at", { withTimezone: true }),
    freeze_started_at: timestamp("freeze_started_at", { withTimezone: true }),
    freeze_msgs: integer("freeze_msgs").notNull().default(0),
    freeze_cadence_days: smallint("freeze_cadence_days").notNull(),
    thresholds: jsonb("thresholds").notNull(),
    time_due_at: timestamp("time_due_at", { withTimezone: true }),
    computed_at: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("contact_engagement_org_status_idx").on(table.org_id, table.status),
    index("contact_engagement_org_time_due_idx")
      .on(table.org_id, table.time_due_at)
      .where(sql`${table.time_due_at} IS NOT NULL`),
    check(
      "contact_engagement_status_check",
      sql`${table.status} IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')`,
    ),
  ],
);

export const contact_engagement_transitions = pgTable(
  "contact_engagement_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    from_status: text("from_status"),
    to_status: text("to_status").notNull(),
    reason: text("reason").notNull(),
    thresholds: jsonb("thresholds").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("contact_engagement_transitions_contact_idx").on(table.contact_id, table.created_at),
    index("contact_engagement_transitions_org_idx").on(table.org_id, table.created_at),
    check(
      "contact_engagement_transitions_to_check",
      sql`${table.to_status} IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')`,
    ),
    check(
      "contact_engagement_transitions_from_check",
      sql`${table.from_status} IS NULL OR ${table.from_status} IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')`,
    ),
    check(
      "contact_engagement_transitions_reason_check",
      sql`${table.reason} IN ('backfill', 'first_seen', 'first_message', 'freeze_threshold', 'threshold_change', 'freeze_expired', 'human_click', 'click_aged_warm', 'click_aged_cold', 'recount')`,
    ),
  ],
);

export const contact_offer_campaigns = pgTable(
  "contact_offer_campaigns",
  {
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    first_sent_at: timestamp("first_sent_at", { withTimezone: true }).notNull(),
    last_sent_at: timestamp("last_sent_at", { withTimezone: true }).notNull(),
    messages: integer("messages").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.contact_id, table.offer_id, table.campaign_id] }),
    index("contact_offer_campaigns_org_offer_contact_idx").on(
      table.org_id,
      table.offer_id,
      table.contact_id,
    ),
  ],
);

export const stage_send_lifecycle = pgTable(
  "stage_send_lifecycle",
  {
    stage_send_id: uuid("stage_send_id")
      .primaryKey()
      .references(() => stage_sends.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    reconstructed: boolean("reconstructed").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "stage_send_lifecycle_status_check",
      sql`${table.status} IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')`,
    ),
  ],
);
```

- [ ] **Step 4: Typecheck.**

Run: `cd /c/AFF/camman/.claude/worktrees/lifecycle-recon && npx tsc --noEmit -p . 2>&1 | tail -5`
Expected: no output (exit 0).

- [ ] **Step 5: Apply to PREVIEW only and prove the target.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npm run db:migrate
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/verify-migration-integrity.ts | tail -6
```
Expected:
- the migrate step applies 1 migration;
- the integrity check prints `0187_contact_engagement` with hash ✓, snapshot ✓ and prevId-chain ✓.

Then confirm with the Supabase MCP `execute_sql`:
- On **camman-v2** (`fdzxzxayhknywvmrhjcj`), `SELECT to_regclass('public.contact_engagement')` returns `contact_engagement`.
- On **prod** (`rtdarhkkjwcetlmruftl`), the same query returns `null`. This proves prod was not touched.

Then run `get_advisors type=security` on camman-v2. Expected: no new ERROR for the five new tables.

- [ ] **Step 6: Commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git add db/migrations/0187_contact_engagement.sql db/migrations/meta/0187_snapshot.json db/migrations/meta/_journal.json db/schema.ts
git commit -m "feat(engagement): migration 0187 — contact engagement tables + group overrides

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: GATE A. Show the user the full SQL of 0187 and the four deviations above; ask for approval to apply it to prod later (Task 8).** Continue with Tasks 2–7 while waiting; they only touch preview.

---

### Task 2: The lifecycle rules as SQL (`status-sql.ts`) + evaluator tests

**Files:**
- Create: `lib/engagement/constants.ts`
- Create: `lib/engagement/status-sql.ts`
- Create: `scripts/test-engagement-db.ts` (Part A now; Parts B and C are added in Tasks 3 and 4)

**Interfaces:**
- Produces:
  - `ENGAGEMENT_STATUSES`, `EngagementStatus`, `TRANSITION_REASONS`, `TransitionReason`, `LifecycleThresholds`, `DEFAULT_LIFECYCLE_THRESHOLDS`, `ENGAGEMENT_LEASE`, `ENGAGEMENT_JOB`, `ENGAGEMENT_FULL_JOB`, `INCREMENTAL_OVERLAP_MINUTES`, `FULL_FALLBACK_HOURS` (constants.ts);
  - `evaluationSelectSql(input: SQL, asOf: SQL, initialReason: "backfill" | "first_seen"): SQL`;
  - `ENGAGEMENT_VALUE_COLUMNS: readonly string[]` (status-sql.ts).
- `evaluationSelectSql` input columns: `contact_id, prev_status, prev_status_changed_at, prev_freeze_entered_at, msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d, first_sent_at, last_sent_at, first_click_at, last_click_at, calc_freeze_started_at, calc_freeze_msgs, hot_days, warm_days, freeze_after_messages, freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages, override_group_ids`.
- Output columns: `contact_id, prev_status, prev_status_changed_at, reason, status, msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d, first_sent_at, last_sent_at, first_click_at, last_click_at, freeze_entered_at, freeze_started_at, freeze_msgs, freeze_cadence_days, thresholds, time_due_at`.

- [ ] **Step 1: Write the failing test.** Create `scripts/test-engagement-db.ts`:

```ts
import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Contact engagement (migration 0187) against the PREVIEW DB.
//
// Part A — the evaluator (lib/engagement/status-sql.ts) over hand-written
//   VALUES rows at a fixed instant: every transition and boundary of spec §3.2,
//   the freeze clock, the transition reason and time_due_at. No writes.
// Part B — refreshContactEngagement over a throwaway org whose expected facts
//   are hand-derived (Task 3).
// Part C — watchEngagementHeartbeat (Task 4).
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-engagement-db.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const A = new Date("2026-03-01T12:00:00Z"); // the evaluation instant of Part A and the world's "now"

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const epoch = (d: Date | null) => (d == null ? null : Math.floor(d.getTime() / 1000));
const plus = (base: Date, days: number, hours = 0) => new Date(base.getTime() + days * DAY + hours * HOUR);

type EvalCase = {
  label: string;
  prev_status: string | null;
  prev_freeze_entered_at?: Date | null;
  msgs_total: number;
  msgs_since_click: number;
  last_click_at?: Date | null;
  calc_freeze_started_at?: Date | null;
  calc_freeze_msgs?: number;
  freeze_after_messages?: number;
  expect: {
    status: string;
    reason?: string;
    freeze_entered_at?: Date | null;
    freeze_started_at?: Date | null;
    freeze_msgs?: number;
    time_due_at?: Date | null;
  };
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const S = await import("@/lib/engagement/status-sql");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  // ── PART A — the evaluator ────────────────────────────────────────────────
  console.log("PART A — evaluator (spec §3.2) at a fixed instant");
  const ts = (d: Date | null | undefined) => (d ? sql`${d.toISOString()}::timestamptz` : sql`NULL::timestamptz`);
  const cases: EvalCase[] = [
    { label: "E1 never messaged ⇒ new (first row reason = backfill)", prev_status: null, msgs_total: 0, msgs_since_click: 0,
      expect: { status: "new", reason: "backfill" } },
    { label: "E2 new → cold on the first message", prev_status: "new", msgs_total: 1, msgs_since_click: 1,
      expect: { status: "cold", reason: "first_message" } },
    { label: "E3 9 messages, no click ⇒ cold", prev_status: "cold", msgs_total: 9, msgs_since_click: 9,
      expect: { status: "cold" } },
    { label: "E4 cold → freeze at exactly 10; clock enters now, nothing sent in freeze yet", prev_status: "cold", msgs_total: 10, msgs_since_click: 10,
      expect: { status: "freeze", reason: "freeze_threshold", freeze_entered_at: A, freeze_started_at: null, freeze_msgs: 0, time_due_at: null } },
    { label: "E5 freeze with 0 in-freeze messages stays freeze after 200 days", prev_status: "freeze", prev_freeze_entered_at: plus(A, -200), msgs_total: 12, msgs_since_click: 12,
      expect: { status: "freeze", freeze_entered_at: plus(A, -200), freeze_started_at: null, freeze_msgs: 0, time_due_at: null } },
    { label: "E6 freeze → suppressed at 60 days + 2 in-freeze messages", prev_status: "freeze", prev_freeze_entered_at: plus(A, -70), msgs_total: 14, msgs_since_click: 14, calc_freeze_started_at: plus(A, -60), calc_freeze_msgs: 2,
      expect: { status: "suppressed", reason: "freeze_expired" } },
    { label: "E7 59 days + 2 messages ⇒ still freeze, due in 1 day", prev_status: "freeze", prev_freeze_entered_at: plus(A, -70), msgs_total: 14, msgs_since_click: 14, calc_freeze_started_at: plus(A, -59), calc_freeze_msgs: 2,
      expect: { status: "freeze", freeze_started_at: plus(A, -59), freeze_msgs: 2, time_due_at: plus(A, 1) } },
    { label: "E8 60 days + 1 message ⇒ still freeze, nothing due by time", prev_status: "freeze", prev_freeze_entered_at: plus(A, -70), msgs_total: 13, msgs_since_click: 13, calc_freeze_started_at: plus(A, -60), calc_freeze_msgs: 1,
      expect: { status: "freeze", freeze_msgs: 1, time_due_at: null } },
    { label: "E9 suppressed stays suppressed when the threshold is raised", prev_status: "suppressed", msgs_total: 12, msgs_since_click: 12, freeze_after_messages: 20,
      expect: { status: "suppressed" } },
    { label: "E10 cold → hot on a human click", prev_status: "cold", msgs_total: 5, msgs_since_click: 0, last_click_at: plus(A, 0, -1),
      expect: { status: "hot", reason: "human_click", freeze_entered_at: null } },
    { label: "E11 freeze → hot clears the freeze clock", prev_status: "freeze", prev_freeze_entered_at: plus(A, -30), msgs_total: 12, msgs_since_click: 0, last_click_at: plus(A, 0, -1), calc_freeze_started_at: plus(A, -20), calc_freeze_msgs: 1,
      expect: { status: "hot", reason: "human_click", freeze_entered_at: null, freeze_started_at: null, freeze_msgs: 0 } },
    { label: "E12 suppressed → hot on a human click", prev_status: "suppressed", msgs_total: 16, msgs_since_click: 0, last_click_at: plus(A, 0, -1),
      expect: { status: "hot", reason: "human_click" } },
    { label: "E13 warm → hot on a new click", prev_status: "warm", msgs_total: 8, msgs_since_click: 0, last_click_at: plus(A, 0, -1),
      expect: { status: "hot", reason: "human_click" } },
    { label: "E14 click exactly 30 days ago ⇒ still hot, due now", prev_status: "hot", msgs_total: 8, msgs_since_click: 1, last_click_at: plus(A, -30),
      expect: { status: "hot", time_due_at: A } },
    { label: "E15 hot → warm at 31 days, due at click + 120 days", prev_status: "hot", msgs_total: 8, msgs_since_click: 3, last_click_at: plus(A, -31),
      expect: { status: "warm", reason: "click_aged_warm", time_due_at: plus(A, 89) } },
    { label: "E16 click exactly 120 days ago ⇒ still warm", prev_status: "warm", msgs_total: 8, msgs_since_click: 3, last_click_at: plus(A, -120),
      expect: { status: "warm" } },
    { label: "E17 warm → cold at 121 days", prev_status: "warm", msgs_total: 8, msgs_since_click: 3, last_click_at: plus(A, -121),
      expect: { status: "cold", reason: "click_aged_cold" } },
    { label: "E18 warm → freeze on the same run when ≥10 messages since the last click", prev_status: "warm", msgs_total: 25, msgs_since_click: 10, last_click_at: plus(A, -121),
      expect: { status: "freeze", reason: "click_aged_cold", freeze_entered_at: A } },
    { label: "E19 threshold lowered to 5: cold → freeze", prev_status: "cold", msgs_total: 6, msgs_since_click: 6, freeze_after_messages: 5,
      expect: { status: "freeze", reason: "freeze_threshold" } },
    { label: "E20 threshold raised to 20: freeze → cold, clock cleared", prev_status: "freeze", prev_freeze_entered_at: plus(A, -5), msgs_total: 12, msgs_since_click: 12, freeze_after_messages: 20,
      expect: { status: "cold", reason: "threshold_change", freeze_entered_at: null, freeze_msgs: 0 } },
    { label: "E21 backfill of a 12-message contact: freeze, clock starts at the backfill instant", prev_status: null, msgs_total: 12, msgs_since_click: 12,
      expect: { status: "freeze", reason: "backfill", freeze_entered_at: A, freeze_started_at: null, freeze_msgs: 0 } },
    { label: "E22 freeze stays; the clock is carried", prev_status: "freeze", prev_freeze_entered_at: plus(A, -10), msgs_total: 13, msgs_since_click: 13, calc_freeze_started_at: plus(A, -9), calc_freeze_msgs: 1,
      expect: { status: "freeze", freeze_entered_at: plus(A, -10), freeze_started_at: plus(A, -9), freeze_msgs: 1 } },
    { label: "E23 suppression needs a PREVIOUS freeze (a cold contact that qualifies becomes freeze first)", prev_status: "cold", msgs_total: 12, msgs_since_click: 12, calc_freeze_started_at: plus(A, -100), calc_freeze_msgs: 5,
      expect: { status: "freeze" } },
    { label: "E24 suppression needs the freeze condition to still hold", prev_status: "freeze", prev_freeze_entered_at: plus(A, -80), msgs_total: 12, msgs_since_click: 12, calc_freeze_started_at: plus(A, -70), calc_freeze_msgs: 3, freeze_after_messages: 20,
      expect: { status: "cold", reason: "threshold_change" } },
  ];
  const values = sql.join(
    cases.map((c) => sql`(
      ${c.label}::text, ${c.prev_status}::text, NULL::timestamptz, ${ts(c.prev_freeze_entered_at)},
      ${c.msgs_total}::int, ${c.msgs_since_click}::int, 0::int, 0::int, 0::int, 0::int,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, ${ts(c.last_click_at)},
      ${ts(c.calc_freeze_started_at)}, ${c.calc_freeze_msgs ?? 0}::int,
      30::int, 120::int, ${c.freeze_after_messages ?? 10}::int, 14::int, 60::int, 2::int, '{}'::int[])`),
    sql`, `,
  );
  const input = sql`(SELECT * FROM (VALUES ${values}) v(
    contact_id, prev_status, prev_status_changed_at, prev_freeze_entered_at,
    msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
    first_sent_at, last_sent_at, first_click_at, last_click_at,
    calc_freeze_started_at, calc_freeze_msgs,
    hot_days, warm_days, freeze_after_messages, freeze_cadence_days,
    suppress_after_days, suppress_min_freeze_messages, override_group_ids))`;
  const out = (await db.execute(sql`
    SELECT contact_id AS label, status, reason,
           extract(epoch FROM freeze_entered_at)::bigint AS fe,
           extract(epoch FROM freeze_started_at)::bigint AS fs,
           freeze_msgs,
           extract(epoch FROM time_due_at)::bigint AS due
    FROM (${S.evaluationSelectSql(input, sql`${A.toISOString()}::timestamptz`, "backfill")}) x
  `)) as unknown as { label: string; status: string; reason: string; fe: string | null; fs: string | null; freeze_msgs: number; due: string | null }[];
  const num = (v: string | null) => (v == null ? null : Number(v));
  for (const c of cases) {
    const r = out.find((o) => o.label === c.label);
    if (!r) { bar(c.label, false, "row missing"); continue; }
    const problems: string[] = [];
    if (r.status !== c.expect.status) problems.push(`status ${r.status} ≠ ${c.expect.status}`);
    if (c.expect.reason !== undefined && r.reason !== c.expect.reason) problems.push(`reason ${r.reason} ≠ ${c.expect.reason}`);
    if (c.expect.freeze_entered_at !== undefined && num(r.fe) !== epoch(c.expect.freeze_entered_at)) problems.push(`freeze_entered_at ${r.fe}`);
    if (c.expect.freeze_started_at !== undefined && num(r.fs) !== epoch(c.expect.freeze_started_at)) problems.push(`freeze_started_at ${r.fs}`);
    if (c.expect.freeze_msgs !== undefined && Number(r.freeze_msgs) !== c.expect.freeze_msgs) problems.push(`freeze_msgs ${r.freeze_msgs}`);
    if (c.expect.time_due_at !== undefined && num(r.due) !== epoch(c.expect.time_due_at)) problems.push(`time_due_at ${r.due}`);
    bar(c.label, problems.length === 0, problems.join("; "));
  }

  // PART B and PART C are appended here by Tasks 3 and 4.

  console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and verify it fails.**

Run: `cd /c/AFF/camman/.claude/worktrees/lifecycle-recon && DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts`
Expected: FAIL with `Cannot find module '@/lib/engagement/status-sql'`.

- [ ] **Step 3: Write `lib/engagement/constants.ts`.**

```ts
// Contact lifecycle status — constants shared by the job, the settings UI (PR 2)
// and the tests. Spec: docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md.
// The code says "engagement" because lib/drip/lifecycle.ts already means the
// drip-journey lifecycle, and opt_outs.reason 'suppressed' means Global Suppression.

export const ENGAGEMENT_STATUSES = ["new", "cold", "hot", "warm", "freeze", "suppressed"] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

// Mirrors contact_engagement_transitions_reason_check (migration 0187).
export const TRANSITION_REASONS = [
  "backfill",
  "first_seen",
  "first_message",
  "freeze_threshold",
  "threshold_change",
  "freeze_expired",
  "human_click",
  "click_aged_warm",
  "click_aged_cold",
  "recount",
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

export interface LifecycleThresholds {
  hot_days: number;
  warm_days: number;
  freeze_after_messages: number;
  freeze_cadence_days: number;
  suppress_after_days: number;
  suppress_min_freeze_messages: number;
}

/** Org defaults when an org has no lifecycle_settings row. Must equal the column DEFAULTs of migration 0187. */
export const DEFAULT_LIFECYCLE_THRESHOLDS: LifecycleThresholds = {
  hot_days: 30,
  warm_days: 120,
  freeze_after_messages: 10,
  freeze_cadence_days: 14,
  suppress_after_days: 60,
  suppress_min_freeze_messages: 2,
};

// cron_locks rows. The lease and the heartbeats are separate rows, as in
// lib/reporting/delivery-rollup.ts: a lease row's watermark is not a heartbeat.
export const ENGAGEMENT_LEASE = "contact-engagement-run";
export const ENGAGEMENT_JOB = "contact-engagement"; // heartbeat: any successful run
export const ENGAGEMENT_FULL_JOB = "contact-engagement-full"; // heartbeat: a successful full recount

/** An incremental run re-reads sends/clicks from this long before the last success. The recount is idempotent, so overlap is free. */
export const INCREMENTAL_OVERLAP_MINUTES = 30;
/** If the last success is older than this, the next run is a full one instead. */
export const FULL_FALLBACK_HOURS = 24;
```

- [ ] **Step 4: Write `lib/engagement/status-sql.ts`.**

```ts
import { sql, type SQL } from "drizzle-orm";

// =============================================================================
// THE lifecycle rules (spec §3.2) as SQL. The job (lib/engagement/refresh.ts),
// the settings preview (PR 2) and scripts/test-engagement-db.ts all evaluate
// status through evaluationSelectSql — never retype a threshold comparison.
//
// Rules, first match wins:
//   1 hot         last_click_at >= asOf - hot_days
//   2 warm        last_click_at >= asOf - warm_days
//   3 new         msgs_total = 0
//   4 suppressed  previous status suppressed (sticky; only rules 1-2 leave it)
//   5 suppressed  previous status freeze AND rule 6 still holds AND the first
//                 in-freeze message is >= suppress_after_days old AND
//                 >= suppress_min_freeze_messages were sent in freeze
//   6 freeze      msgs_since_click >= freeze_after_messages
//   7 cold        otherwise
//
// The freeze clock: freeze_entered_at is set when a contact ENTERS freeze (the
// evaluation instant) and carried while it stays; freeze_started_at / freeze_msgs
// are the first / count of messages sent after freeze_entered_at. Leaving
// freeze (a click, or a raised threshold) clears all three. Suppressed keeps
// them for the record.
// =============================================================================

const col = (alias: string, name: string): SQL => sql.raw(`${alias}.${name}`);

function statusSql(a: string, asOf: SQL): SQL {
  const c = (n: string) => col(a, n);
  return sql`(CASE
    WHEN ${c("last_click_at")} >= ${asOf} - make_interval(days => ${c("hot_days")}) THEN 'hot'
    WHEN ${c("last_click_at")} >= ${asOf} - make_interval(days => ${c("warm_days")}) THEN 'warm'
    WHEN ${c("msgs_total")} = 0 THEN 'new'
    WHEN ${c("prev_status")} = 'suppressed' THEN 'suppressed'
    WHEN ${c("msgs_since_click")} >= ${c("freeze_after_messages")}
     AND ${c("prev_status")} = 'freeze'
     AND ${c("calc_freeze_started_at")} <= ${asOf} - make_interval(days => ${c("suppress_after_days")})
     AND ${c("calc_freeze_msgs")} >= ${c("suppress_min_freeze_messages")} THEN 'suppressed'
    WHEN ${c("msgs_since_click")} >= ${c("freeze_after_messages")} THEN 'freeze'
    ELSE 'cold'
  END)`;
}

function freezeClockSql(a: string, asOf: SQL): { entered: SQL; started: SQL; msgs: SQL } {
  const c = (n: string) => col(a, n);
  const inFreeze = sql`${c("next_status")} IN ('freeze', 'suppressed')`;
  const wasInFreeze = sql`${c("prev_status")} IN ('freeze', 'suppressed')`;
  return {
    entered: sql`(CASE WHEN ${inFreeze} THEN
                    CASE WHEN ${wasInFreeze} THEN coalesce(${c("prev_freeze_entered_at")}, ${asOf}) ELSE ${asOf} END
                  END)`,
    started: sql`(CASE WHEN ${inFreeze} AND ${wasInFreeze} THEN ${c("calc_freeze_started_at")} END)`,
    msgs: sql`(CASE WHEN ${inFreeze} AND ${wasInFreeze} THEN ${c("calc_freeze_msgs")} ELSE 0 END)`,
  };
}

function reasonSql(a: string, initialReason: "backfill" | "first_seen"): SQL {
  const prev = col(a, "prev_status");
  const next = col(a, "next_status");
  return sql`(CASE
    WHEN ${prev} IS NULL THEN ${initialReason}::text
    WHEN ${next} = 'hot' THEN 'human_click'
    WHEN ${next} = 'warm' AND ${prev} = 'hot' THEN 'click_aged_warm'
    WHEN ${next} = 'warm' THEN 'human_click'
    WHEN ${prev} IN ('hot', 'warm') THEN 'click_aged_cold'
    WHEN ${prev} = 'new' THEN 'first_message'
    WHEN ${next} = 'suppressed' THEN 'freeze_expired'
    WHEN ${next} = 'freeze' THEN 'freeze_threshold'
    WHEN ${prev} = 'freeze' AND ${next} = 'cold' THEN 'threshold_change'
    ELSE 'recount'
  END)`;
}

// Earliest instant at which the row's status changes with no new send or click.
// The incremental run re-evaluates rows whose instant has passed (<= asOf).
function timeDueSql(a: string): SQL {
  const c = (n: string) => col(a, n);
  return sql`(CASE ${c("next_status")}
    WHEN 'hot' THEN ${c("last_click_at")} + make_interval(days => ${c("hot_days")})
    WHEN 'warm' THEN ${c("last_click_at")} + make_interval(days => ${c("warm_days")})
    WHEN 'freeze' THEN CASE
      WHEN ${c("freeze_started_at")} IS NOT NULL AND ${c("freeze_msgs")} >= ${c("suppress_min_freeze_messages")}
      THEN ${c("freeze_started_at")} + make_interval(days => ${c("suppress_after_days")})
    END
  END)`;
}

/** contact_engagement columns the job compares to decide whether a row changed. */
export const ENGAGEMENT_VALUE_COLUMNS = [
  "status",
  "msgs_total",
  "msgs_since_click",
  "msgs_7d",
  "msgs_14d",
  "msgs_30d",
  "msgs_90d",
  "first_sent_at",
  "last_sent_at",
  "first_click_at",
  "last_click_at",
  "freeze_entered_at",
  "freeze_started_at",
  "freeze_msgs",
  "freeze_cadence_days",
  "thresholds",
  "time_due_at",
] as const;

/**
 * The whole evaluation as one SELECT over `input`, a parenthesised relation
 * exposing the input columns listed in the plan (Task 2 Interfaces).
 * `initialReason` is recorded for a contact with no previous row.
 */
export function evaluationSelectSql(
  input: SQL,
  asOf: SQL,
  initialReason: "backfill" | "first_seen",
): SQL {
  const clock = freezeClockSql("s", asOf);
  return sql`
    SELECT k.contact_id, k.prev_status, k.prev_status_changed_at, k.reason,
           k.next_status AS status,
           k.msgs_total, k.msgs_since_click, k.msgs_7d, k.msgs_14d, k.msgs_30d, k.msgs_90d,
           k.first_sent_at, k.last_sent_at, k.first_click_at, k.last_click_at,
           k.freeze_entered_at, k.freeze_started_at, k.freeze_msgs,
           k.freeze_cadence_days::smallint AS freeze_cadence_days, k.thresholds,
           ${timeDueSql("k")} AS time_due_at
    FROM (
      SELECT s.*,
             ${clock.entered} AS freeze_entered_at,
             ${clock.started} AS freeze_started_at,
             ${clock.msgs} AS freeze_msgs,
             ${reasonSql("s", initialReason)} AS reason,
             jsonb_build_object(
               'hot_days', s.hot_days,
               'warm_days', s.warm_days,
               'freeze_after_messages', s.freeze_after_messages,
               'freeze_cadence_days', s.freeze_cadence_days,
               'suppress_after_days', s.suppress_after_days,
               'suppress_min_freeze_messages', s.suppress_min_freeze_messages,
               'override_group_ids', to_jsonb(s.override_group_ids)
             ) AS thresholds
      FROM (SELECT e.*, ${statusSql("e", asOf)} AS next_status FROM ${input} e) s
    ) k`;
}
```

- [ ] **Step 5: Run the test and verify it passes.**

Run: the command from Step 2.
Expected: 24 `✓` lines, then `All checks passed.`, exit 0. If a case fails, fix `status-sql.ts`, not the expectation. The expectations are spec §3.2 verbatim.

- [ ] **Step 6: Lint and commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint lib/engagement/constants.ts lib/engagement/status-sql.ts scripts/test-engagement-db.ts
git add lib/engagement/constants.ts lib/engagement/status-sql.ts scripts/test-engagement-db.ts
git commit -m "feat(engagement): lifecycle rules as one SQL evaluator + boundary tests

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The orchestrator (`refresh.ts`) + world tests

**Files:**
- Create: `lib/engagement/refresh.ts`
- Modify: `scripts/test-engagement-db.ts` (add Part B)

**Interfaces:**
- Consumes: `evaluationSelectSql`, `ENGAGEMENT_VALUE_COLUMNS` (Task 2); `DEFAULT_LIFECYCLE_THRESHOLDS`, `ENGAGEMENT_STATUSES`, `EngagementStatus` (Task 2); `HUMAN_CLICK` from `@/lib/reporting/counted-clickers`; `DbOrTx` from `@/lib/reporting/cron-heartbeat`.
- Produces:

```ts
export type RefreshMode = "full" | "incremental";
export interface RefreshOptions {
  mode: RefreshMode;
  dryRun: boolean;
  asOf?: Date;               // default: the transaction's now()
  since?: Date;              // required for incremental; the caller subtracts the overlap
  initialReason?: "backfill" | "first_seen"; // default "first_seen"
  withReport?: boolean;      // per-group + opted-out breakdowns (the dry-run report)
}
export interface GroupBreakdownRow { group_id: number; name: string; counts: Record<EngagementStatus, number> }
export interface RefreshResult {
  mode: RefreshMode; dryRun: boolean;
  recounted: number; evaluated: number;
  statusCounts: Record<EngagementStatus, number>;
  transitions: Record<string, number>;   // "cold→freeze": n, "∅→new" for first rows
  rowsWritten: number; transitionsWritten: number;   // dry run: would write
  offerRowsWritten: number; offerRowsDeleted: number; // dry run: would write/delete
  freezeNotDue: number;
  groups?: GroupBreakdownRow[];
  optedOutByStatus?: Record<EngagementStatus, number>;
  phaseMs: Record<string, number>; durationMs: number;
}
export async function refreshContactEngagement(dbc: DbOrTx, orgId: string, opts: RefreshOptions): Promise<RefreshResult>
```

**The caller owns the transaction.** The function creates `ON COMMIT DROP` temp tables, so it must run inside `db.transaction`, with `SET LOCAL statement_timeout` set by the caller.

- [ ] **Step 1: Append Part B to `scripts/test-engagement-db.ts`.** Replace the line `// PART B and PART C are appended here by Tasks 3 and 4.` with the block below. Add at the top of `main()`, after the existing imports:
- `const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");`
- `const { refreshContactEngagement } = await import("@/lib/engagement/refresh");`

```ts
  // ── PART B — the job over a throwaway world ───────────────────────────────
  // Timeline (A = 2026-03-01T12:00Z). Sends are placed away from every window
  // edge (7/14/30/90 d) so a recount one day later gives the same windows —
  // that is what lets "full after incremental writes 0 rows" be an exact bar.
  console.log("\nPART B — refreshContactEngagement over a throwaway org");
  const MARKER = "__ENGAGEMENT_TEST__";
  const tag = `eng-${Date.now()}`;
  let orgId = "";
  const one = async <T,>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T,>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
  const iso = (d: Date) => d.toISOString();
  const run = (opts: Parameters<typeof refreshContactEngagement>[2]) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      return refreshContactEngagement(tx, orgId, opts);
    });
  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    // Org row: cadence 21, everything else default. Engine stays 'off' (the job
    // is called directly here; the switch only gates the cron).
    await db.execute(sql`INSERT INTO lifecycle_settings (org_id, freeze_cadence_days) VALUES (${org}, 21)`);

    const group = async (name: string, status: string, o: { fam?: number; fcd?: number; sad?: number; smm?: number }) =>
      (await one<{ id: number }>(sql`
        INSERT INTO contact_groups (contact_group_id, org_id, name, status,
          freeze_after_messages, freeze_cadence_days, suppress_after_days, suppress_min_freeze_messages)
        VALUES (${`${tag}-${name}`}, ${org}, ${name}, ${status},
          ${o.fam ?? null}::smallint, ${o.fcd ?? null}::smallint, ${o.sad ?? null}::smallint, ${o.smm ?? null}::smallint)
        RETURNING id`)).id;
    const GA = await group("A", "active", { fcd: 7 });
    const GB = await group("B", "active", {});
    const GC = await group("C", "archived", { fam: 3 });
    const GD = await group("D", "active", { fam: 8, sad: 30, smm: 1 });

    const brand = (await one<{ id: number }>(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`B-${tag}`}, ${`Brand ${tag}`}) RETURNING id`)).id;
    const sd = (await one<{ id: number }>(sql`INSERT INTO short_domains (org_id, brand_id, domain) VALUES (${org}, ${brand}, ${`${tag}.test`}) RETURNING id`)).id;
    const dest = (await one<{ id: number }>(sql`INSERT INTO link_destinations (org_id, url, url_hash) VALUES (${org}, 'https://example.test/o', ${`h-${tag}`}) RETURNING id`)).id;
    const net = (await one<{ id: number }>(sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, 'net') RETURNING id`)).id;
    const offer = async (code: string) =>
      (await one<{ id: number }>(sql`INSERT INTO offers (org_id, network_id, offer_id, name) VALUES (${org}, ${net}, ${`${tag}-${code}`}, ${code}) RETURNING id`)).id;
    const O1 = await offer("o1");
    const O2 = await offer("o2");
    const campaign = async (code: string, offerId: number) =>
      (await one<{ id: number }>(sql`INSERT INTO campaigns (org_id, slug, name, link_mode, status, offer_id)
        VALUES (${org}, ${`${tag}-${code}`}, ${code}, 'tracked', 'active', ${offerId}) RETURNING id`)).id;
    const K1 = await campaign("k1", O1);
    const K2 = await campaign("k2", O2);
    const stage = async (campaignId: number) =>
      (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id)
        VALUES (${org}, ${campaignId}, 1, ${`trk-${tag}-${campaignId}`}) RETURNING id`)).id;
    const S1 = await stage(K1);
    const S2 = await stage(K2);

    const phones = fictionalPhones(8);
    await refuseIfPhonesInUse(db, phones);
    type C = { id: string; phone: string };
    const contact = async (i: number, groups: number[]): Promise<C> => {
      const id = (await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${phones[i]}) RETURNING id`)).id;
      for (const g of groups) {
        await db.execute(sql`INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id) VALUES (${id}::uuid, ${g}, ${org})`);
      }
      return { id, phone: phones[i] };
    };
    const cNew = await contact(0, [GA]);
    const cCold = await contact(1, [GA, GB]);
    const cFreeze = await contact(2, []);
    const cHot = await contact(3, []);
    const cWarm = await contact(4, []);
    const cBot = await contact(5, [GC]);
    const cD = await contact(6, [GD, GB]);
    const cOpt = await contact(7, []);

    const send = async (c: C, k: 1 | 2, when: Date): Promise<string> =>
      (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${org}, ${k === 1 ? K1 : K2}, ${k === 1 ? S1 : S2}, ${c.id}::uuid, ${c.phone}, 'x', 'sent', ${iso(when)}::timestamptz)
        RETURNING id`)).id;
    let linkSeq = 0;
    const click = async (c: C, k: 1 | 2, sendId: string, clickedAt: Date, classification: string, scoredAt: Date | null) => {
      linkSeq++;
      const link = (await one<{ id: number }>(sql`
        INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
                           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES (${org}, ${`${tag}-${linkSeq}`}, ${sd}, ${dest}, ${k === 1 ? K1 : K2}, ${k === 1 ? S1 : S2},
                ${c.id}::uuid, ${sendId}, ${`ct-${tag}`}, ${`st-${tag}`})
        RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification, clicked_at, scored_at)
        VALUES (${org}, ${link}, ${classification}, ${iso(clickedAt)}::timestamptz,
                ${scoredAt ? iso(scoredAt) : null}::timestamptz)`);
    };

    // cCold: 3 sends (K1) at -10/-9/-8 d.
    for (const d of [-10, -9, -8]) await send(cCold, 1, plus(A, d));
    const cColdLast = await send(cCold, 1, plus(A, -7, -12)); // 4th send, -7.5 d
    // cFreeze: 10 sends, 5 on K1 (O1) and 5 on K2 (O2).
    for (const d of [-55, -50, -45, -40, -35]) await send(cFreeze, 1, plus(A, d));
    for (const d of [-25, -20, -15, -12, -11]) await send(cFreeze, 2, plus(A, d));
    // cHot: 12 sends on K1 at -45..-34 d, a human click at -5 d, 2 sends on K2 at -3/-2 d.
    let hotSend = "";
    for (let d = -45; d <= -34; d++) hotSend = await send(cHot, 1, plus(A, d));
    await click(cHot, 1, hotSend, plus(A, -5), "human", plus(A, -5, 1));
    for (const d of [-3, -2]) await send(cHot, 2, plus(A, d));
    // cWarm: 5 sends at -60..-56 d, a human click at -45 d.
    let warmSend = "";
    for (let d = -60; d <= -56; d++) warmSend = await send(cWarm, 1, plus(A, d));
    await click(cWarm, 1, warmSend, plus(A, -45), "human", plus(A, -45, 1));
    // cBot: 3 sends, a scored bot click and an UNSCORED human click — neither counts.
    let botSend = "";
    for (const d of [-20, -19, -18]) botSend = await send(cBot, 1, plus(A, d));
    await click(cBot, 1, botSend, plus(A, -17), "bot", plus(A, -17, 1));
    await click(cBot, 1, botSend, plus(A, -16), "human", null);
    // cD: 8 sends — freeze only because group D lowers the threshold to 8.
    for (let d = -50; d <= -43; d++) await send(cD, 1, plus(A, d));
    // cOpt: 1 send and an opt-out (always excluded; the report counts it separately).
    await send(cOpt, 1, plus(A, -33));
    await db.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number) VALUES (${org}, ${cOpt.id}::uuid, ${cOpt.phone})`);

    // Rows AFTER A (invisible to any run whose asOf precedes them):
    await send(cNew, 1, plus(A, 0, 1));                                    // cNew's first message
    await send(cFreeze, 2, plus(A, 0, 1));                                 // 1st in-freeze message
    await send(cFreeze, 2, plus(A, 15));                                   // 2nd in-freeze message
    await click(cCold, 1, cColdLast, plus(A, 0, 2), "human", plus(A, 0, 3)); // cCold clicks
    await click(cBot, 1, botSend, plus(A, 0, 2), "bot", plus(A, 0, 2));      // ignored

    const row = async (c: C) =>
      one<Record<string, unknown>>(sql`
        SELECT status, msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
               extract(epoch FROM last_click_at)::bigint AS last_click,
               extract(epoch FROM freeze_entered_at)::bigint AS fe,
               extract(epoch FROM freeze_started_at)::bigint AS fs,
               freeze_msgs, freeze_cadence_days, thresholds,
               extract(epoch FROM time_due_at)::bigint AS due
        FROM contact_engagement WHERE contact_id = ${c.id}::uuid`);
    const count = async (table: string) =>
      Number((await one<{ n: string }>(sql`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE org_id = ${org}`)).n);
    const n = (v: unknown) => (v == null ? null : Number(v));

    // B1 — DRY RUN writes nothing and reports the right counts.
    const r0 = await run({ mode: "full", dryRun: true, asOf: A, initialReason: "backfill", withReport: true });
    bar("B1 dry run: status counts", JSON.stringify(r0.statusCounts) ===
      JSON.stringify({ new: 1, cold: 3, hot: 1, warm: 1, freeze: 2, suppressed: 0 }), JSON.stringify(r0.statusCounts));
    bar("B1 dry run: would write 8 rows, 8 transitions, 9 offer rows",
      r0.rowsWritten === 8 && r0.transitionsWritten === 8 && r0.offerRowsWritten === 9,
      `${r0.rowsWritten}/${r0.transitionsWritten}/${r0.offerRowsWritten}`);
    bar("B1 dry run: freeze not due = 1 (cFreeze last message 11 d ago < cadence 21)", r0.freezeNotDue === 1, String(r0.freezeNotDue));
    bar("B1 dry run: opted-out per status (cOpt is cold)", r0.optedOutByStatus?.cold === 1, JSON.stringify(r0.optedOutByStatus));
    const gA = r0.groups?.find((g) => g.group_id === GA);
    const gNone = r0.groups?.find((g) => g.group_id === 0);
    bar("B1 dry run: group A = new 1 + cold 1; archived group C not listed",
      gA?.counts.new === 1 && gA?.counts.cold === 1 && !r0.groups?.some((g) => g.group_id === GC), JSON.stringify(gA));
    bar("B1 dry run: no-active-group bucket = freeze 1, hot 1, warm 1, cold 2 (cBot's only group is archived)",
      gNone?.counts.freeze === 1 && gNone?.counts.hot === 1 && gNone?.counts.warm === 1 && gNone?.counts.cold === 2, JSON.stringify(gNone));
    bar("B1 dry run: nothing written",
      (await count("contact_engagement")) === 0 && (await count("contact_engagement_transitions")) === 0 && (await count("contact_offer_campaigns")) === 0);

    // B2 — FULL (the backfill) at A.
    const r1 = await run({ mode: "full", dryRun: false, asOf: A, initialReason: "backfill" });
    bar("B2 full: 8 rows, 8 backfill transitions, 9 offer rows",
      r1.rowsWritten === 8 && r1.transitionsWritten === 8 && r1.offerRowsWritten === 9, `${r1.rowsWritten}/${r1.transitionsWritten}/${r1.offerRowsWritten}`);
    const reasons = await all<{ reason: string; n: string }>(sql`SELECT reason, count(*) AS n FROM contact_engagement_transitions WHERE org_id = ${org} GROUP BY 1`);
    bar("B2 every first row is reason 'backfill' from ∅", reasons.length === 1 && reasons[0].reason === "backfill" && Number(reasons[0].n) === 8, JSON.stringify(reasons));
    const vNew = await row(cNew);
    bar("B2 cNew: new, cadence 7 (only in group A)", vNew.status === "new" && n(vNew.freeze_cadence_days) === 7, JSON.stringify(vNew));
    const vCold = await row(cCold);
    bar("B2 cCold: cold, 4 msgs, windows 7d/14d/30d/90d = 0/4/4/4, cadence 21 (strictest of A 7 and B → org 21)",
      vCold.status === "cold" && n(vCold.msgs_total) === 4 && n(vCold.msgs_7d) === 0 && n(vCold.msgs_14d) === 4 &&
      n(vCold.msgs_30d) === 4 && n(vCold.msgs_90d) === 4 && n(vCold.freeze_cadence_days) === 21, JSON.stringify(vCold));
    const vFreeze = await row(cFreeze);
    bar("B2 cFreeze: freeze, 10 msgs, clock entered at A, nothing sent in freeze, not due",
      vFreeze.status === "freeze" && n(vFreeze.msgs_total) === 10 && n(vFreeze.fe) === epoch(A) &&
      vFreeze.fs == null && n(vFreeze.freeze_msgs) === 0 && vFreeze.due == null, JSON.stringify(vFreeze));
    const vHot = await row(cHot);
    bar("B2 cHot: hot, 14 msgs, 2 since click, 7d = 2, due = click + 30 d",
      vHot.status === "hot" && n(vHot.msgs_total) === 14 && n(vHot.msgs_since_click) === 2 && n(vHot.msgs_7d) === 2 &&
      n(vHot.due) === epoch(plus(A, 25)), JSON.stringify(vHot));
    const vWarm = await row(cWarm);
    bar("B2 cWarm: warm, due = click + 120 d", vWarm.status === "warm" && n(vWarm.due) === epoch(plus(A, 75)), JSON.stringify(vWarm));
    const vBot = await row(cBot);
    bar("B2 cBot: cold; bot and unscored clicks ignored; archived group C's threshold 3 ignored",
      vBot.status === "cold" && vBot.last_click == null && (vBot.thresholds as { freeze_after_messages: number }).freeze_after_messages === 10,
      JSON.stringify(vBot));
    const vD = await row(cD);
    const tD = vD.thresholds as { freeze_after_messages: number; suppress_after_days: number; suppress_min_freeze_messages: number; override_group_ids: number[] };
    bar("B2 cD: freeze via group D (8 / 30 / 1), override_group_ids = [D]",
      vD.status === "freeze" && tD.freeze_after_messages === 8 && tD.suppress_after_days === 30 &&
      tD.suppress_min_freeze_messages === 1 && JSON.stringify(tD.override_group_ids) === JSON.stringify([GD]), JSON.stringify(vD));
    const offers = await all<{ contact_id: string; offer_id: number; messages: number; first: string; last: string }>(sql`
      SELECT contact_id, offer_id, messages,
             extract(epoch FROM first_sent_at)::bigint AS first, extract(epoch FROM last_sent_at)::bigint AS last
      FROM contact_offer_campaigns WHERE org_id = ${org} AND contact_id = ${cFreeze.id}::uuid ORDER BY offer_id`);
    bar("B2 cFreeze offer rows: O1 5 msgs (-55..-35), O2 5 msgs (-25..-11)",
      offers.length === 2 &&
      offers[0].offer_id === O1 && Number(offers[0].messages) === 5 && Number(offers[0].first) === epoch(plus(A, -55)) && Number(offers[0].last) === epoch(plus(A, -35)) &&
      offers[1].offer_id === O2 && Number(offers[1].messages) === 5 && Number(offers[1].last) === epoch(plus(A, -11)),
      JSON.stringify(offers));

    // B3 — the same full run again changes nothing.
    const r1b = await run({ mode: "full", dryRun: false, asOf: A });
    bar("B3 full again: 0 rows, 0 transitions, 0 offer writes, 0 deletes",
      r1b.rowsWritten === 0 && r1b.transitionsWritten === 0 && r1b.offerRowsWritten === 0 && r1b.offerRowsDeleted === 0, JSON.stringify(r1b));

    // B4 — INCREMENTAL at A + 1 d.
    const A2 = plus(A, 1);
    const r2 = await run({ mode: "incremental", dryRun: false, asOf: A2, since: plus(A, 0, -0.5) });
    bar("B4 incremental: recounted 3 (cNew, cFreeze, cCold); the bot click touches nobody", r2.recounted === 3, String(r2.recounted));
    bar("B4 transitions: new→cold 1, cold→hot 1", r2.transitions["new→cold"] === 1 && r2.transitions["cold→hot"] === 1 && r2.transitionsWritten === 2, JSON.stringify(r2.transitions));
    const v2Freeze = await row(cFreeze);
    bar("B4 cFreeze: clock carried from A, first in-freeze message at A+1h, 1 message, not due (needs 2)",
      v2Freeze.status === "freeze" && n(v2Freeze.fe) === epoch(A) && n(v2Freeze.fs) === epoch(plus(A, 0, 1)) &&
      n(v2Freeze.freeze_msgs) === 1 && v2Freeze.due == null, JSON.stringify(v2Freeze));
    bar("B4 offer rows: cNew's new row + cFreeze's O2 row changed", r2.offerRowsWritten === 2, String(r2.offerRowsWritten));
    const lastReason = await one<{ reason: string }>(sql`
      SELECT reason FROM contact_engagement_transitions WHERE contact_id = ${cCold.id}::uuid ORDER BY id DESC LIMIT 1`);
    bar("B4 cCold's transition reason is human_click", lastReason.reason === "human_click", lastReason.reason);

    // B5 — FULL right after INCREMENTAL, same instant: nothing to write (equality).
    const r2b = await run({ mode: "full", dryRun: false, asOf: A2 });
    bar("B5 full after incremental at the same instant writes 0 rows / 0 transitions / 0 offer changes",
      r2b.rowsWritten === 0 && r2b.transitionsWritten === 0 && r2b.offerRowsWritten === 0 && r2b.offerRowsDeleted === 0, JSON.stringify(r2b));

    // B6 — time alone: hot → warm (cHot's click is 31 d old at A + 26 d).
    const A3 = plus(A, 26);
    const r3 = await run({ mode: "incremental", dryRun: false, asOf: A3, since: plus(A2, 0, -0.5) });
    bar("B6 cHot hot→warm by time_due (no send, no click)", (await row(cHot)).status === "warm" && r3.transitions["hot→warm"] === 1, JSON.stringify(r3.transitions));
    const v3Freeze = await row(cFreeze);
    bar("B6 cFreeze: 2 in-freeze messages, due at first in-freeze message + 60 d",
      n(v3Freeze.freeze_msgs) === 2 && n(v3Freeze.due) === epoch(plus(A, 60, 1)), JSON.stringify(v3Freeze));

    // B7 — time alone: freeze → suppressed, and cCold hot → warm.
    const A4 = plus(A, 60, 2);
    const r4 = await run({ mode: "incremental", dryRun: false, asOf: A4, since: plus(A3, 0, -0.5) });
    bar("B7 cFreeze freeze→suppressed (reason freeze_expired)", (await row(cFreeze)).status === "suppressed" && r4.transitions["freeze→suppressed"] === 1, JSON.stringify(r4.transitions));
    bar("B7 cCold hot→warm (its click is 60 d old)", (await row(cCold)).status === "warm" && r4.transitions["hot→warm"] === 1);
    bar("B7 cD stays freeze: no in-freeze message, so never suppressed", (await row(cD)).status === "freeze");
    const expired = await one<{ reason: string; t: { suppress_after_days: number } }>(sql`
      SELECT reason, thresholds AS t FROM contact_engagement_transitions
      WHERE contact_id = ${cFreeze.id}::uuid ORDER BY id DESC LIMIT 1`);
    bar("B7 the suppression transition records the thresholds in effect", expired.reason === "freeze_expired" && expired.t.suppress_after_days === 60, JSON.stringify(expired));
    bar("B7 transition history total = 8 + 2 + 1 + 2 = 13", (await count("contact_engagement_transitions")) === 13, String(await count("contact_engagement_transitions")));
  } finally {
    if (orgId) {
      const name = ((await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the test marker (name=${JSON.stringify(name)})`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_engagement WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_engagement_transitions WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_offer_campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM lifecycle_settings WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left for this run`);
      if (Number(left.n) !== 0) fail++;
    }
  }
```

- [ ] **Step 2: Run it and verify Part B fails.**

Run: the Task 2 test command.
Expected: Part A passes; Part B fails with `Cannot find module '@/lib/engagement/refresh'`.

- [ ] **Step 3: Write `lib/engagement/refresh.ts`.**

```ts
import { sql, type SQL } from "drizzle-orm";

import {
  DEFAULT_LIFECYCLE_THRESHOLDS as D,
  ENGAGEMENT_STATUSES,
  type EngagementStatus,
} from "@/lib/engagement/constants";
import { ENGAGEMENT_VALUE_COLUMNS, evaluationSelectSql } from "@/lib/engagement/status-sql";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";
import { HUMAN_CLICK } from "@/lib/reporting/counted-clickers";

// =============================================================================
// CONTACT ENGAGEMENT REFRESH (migration 0187; spec §5)
//
// The ONLY writer of contact_engagement, contact_engagement_transitions and
// contact_offer_campaigns. Runs inside the CALLER's transaction: every stage
// is an ON COMMIT DROP temp table (ANALYZEd — see the snapshot perf notes in
// CLAUDE.md §10b for why set-op cardinalities need real stats).
//
//   full         recount every contact's facts org-wide (two stage_sends
//                passes + one human-click pass), evaluate everyone.
//   incremental  recount only contacts with a send or a newly scored human
//                click since `since`, plus evaluate rows whose time_due_at has
//                passed (hot→warm, warm→cold, freeze→suppressed need no event).
//                Per-contact recounts go through stage_sends_org_phone_sent_idx
//                (org_id, phone, sent_at) WHERE status='sent' — the only index
//                that reaches one contact's sends (0 phone mismatches on prod,
//                2026-09-22; the nightly full recount by contact_id is the backstop).
//
// Recounts are from FULL history, so re-reading an overlapping window is
// idempotent. Only changed rows are written (IS DISTINCT FROM). `dryRun`
// computes everything and skips every write to a real table.
// =============================================================================

export type RefreshMode = "full" | "incremental";

export interface RefreshOptions {
  mode: RefreshMode;
  dryRun: boolean;
  asOf?: Date;
  since?: Date;
  initialReason?: "backfill" | "first_seen";
  withReport?: boolean;
}

export interface GroupBreakdownRow {
  group_id: number;
  name: string;
  counts: Record<EngagementStatus, number>;
}

export interface RefreshResult {
  mode: RefreshMode;
  dryRun: boolean;
  recounted: number;
  evaluated: number;
  statusCounts: Record<EngagementStatus, number>;
  transitions: Record<string, number>;
  rowsWritten: number;
  transitionsWritten: number;
  offerRowsWritten: number;
  offerRowsDeleted: number;
  freezeNotDue: number;
  groups?: GroupBreakdownRow[];
  optedOutByStatus?: Record<EngagementStatus, number>;
  phaseMs: Record<string, number>;
  durationMs: number;
}

const zeroCounts = (): Record<EngagementStatus, number> =>
  Object.fromEntries(ENGAGEMENT_STATUSES.map((s) => [s, 0])) as Record<EngagementStatus, number>;

const tuple = (alias: string): SQL =>
  sql.raw(`(${ENGAGEMENT_VALUE_COLUMNS.map((c) => `${alias}.${c}`).join(", ")})`);

export async function refreshContactEngagement(
  dbc: DbOrTx,
  orgId: string,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const started = Date.now();
  if (opts.mode === "incremental" && !opts.since) {
    throw new Error("refreshContactEngagement: an incremental run needs `since`");
  }
  const phaseMs: Record<string, number> = {};
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const r = await fn();
    phaseMs[name] = Date.now() - t;
    return r;
  };
  const q = async <T>(query: SQL): Promise<T[]> => (await dbc.execute(query)) as unknown as T[];
  const org = sql`${orgId}::uuid`;
  const asOf = opts.asOf ? sql`${opts.asOf.toISOString()}::timestamptz` : sql`now()`;
  const full = opts.mode === "full";

  // ── 1. Who gets recounted ────────────────────────────────────────────────
  await phase("touched", async () => {
    await dbc.execute(sql`CREATE TEMP TABLE eng_touched (contact_id uuid PRIMARY KEY) ON COMMIT DROP`);
    if (full) {
      await dbc.execute(sql`INSERT INTO eng_touched SELECT id FROM contacts WHERE org_id = ${org}`);
    } else {
      const since = sql`${opts.since!.toISOString()}::timestamptz`;
      await dbc.execute(sql`
        INSERT INTO eng_touched
        SELECT contact_id FROM stage_sends
         WHERE sent_at >= ${since} AND sent_at <= ${asOf} AND status = 'sent' AND org_id = ${org}
        UNION
        SELECT l.contact_id FROM clicks ck JOIN links l ON l.id = ck.link_id
         WHERE ${HUMAN_CLICK} AND ck.scored_at >= ${since} AND ck.scored_at <= ${asOf}
           AND ck.org_id = ${org}`);
    }
    await dbc.execute(sql`ANALYZE eng_touched`);
  });

  // The sends a recount reads. Full: the org's whole table in one pass.
  // Incremental: one index probe per touched contact.
  const sendsFrom = full
    ? sql`FROM stage_sends ss`
    : sql`FROM eng_touched t
          JOIN contacts c ON c.id = t.contact_id AND c.org_id = ${org}
          JOIN stage_sends ss ON ss.org_id = ${org} AND ss.phone = c.phone_number AND ss.contact_id = t.contact_id`;

  // ── 2. Human clicks (first / last) ───────────────────────────────────────
  await phase("clicks", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_clicks ON COMMIT DROP AS
      SELECT l.contact_id, min(ck.clicked_at) AS first_click_at, max(ck.clicked_at) AS last_click_at
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      ${full ? sql`` : sql`JOIN eng_touched t ON t.contact_id = l.contact_id`}
      WHERE ${HUMAN_CLICK} AND ck.org_id = ${org}
        AND ck.clicked_at <= ${asOf} AND ck.scored_at <= ${asOf}
      GROUP BY l.contact_id`);
    await dbc.execute(sql`ANALYZE eng_clicks`);
  });

  // ── 3. Send facts, relative to the click and the stored freeze clock ─────
  await phase("sends", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_facts ON COMMIT DROP AS
      SELECT ss.contact_id,
             count(*)::int AS msgs_total,
             count(*) FILTER (WHERE cl.last_click_at IS NULL OR ss.sent_at > cl.last_click_at)::int AS msgs_since_click,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '7 days')::int AS msgs_7d,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '14 days')::int AS msgs_14d,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '30 days')::int AS msgs_30d,
             count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '90 days')::int AS msgs_90d,
             min(ss.sent_at) AS first_sent_at,
             max(ss.sent_at) AS last_sent_at,
             min(ss.sent_at) FILTER (WHERE ss.sent_at > p.freeze_entered_at) AS calc_freeze_started_at,
             count(*) FILTER (WHERE ss.sent_at > p.freeze_entered_at)::int AS calc_freeze_msgs
      ${sendsFrom}
      LEFT JOIN eng_clicks cl ON cl.contact_id = ss.contact_id
      LEFT JOIN contact_engagement p ON p.contact_id = ss.contact_id
      WHERE ss.org_id = ${org} AND ss.status = 'sent' AND ss.sent_at <= ${asOf}
      GROUP BY ss.contact_id`);
    await dbc.execute(sql`ANALYZE eng_facts`);
  });

  // ── 4. Per (contact, offer, campaign) exposure — ClickUp 869f53efz's data ─
  await phase("offers", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_offer ON COMMIT DROP AS
      SELECT ss.contact_id, ca.offer_id, ss.campaign_id,
             min(ss.sent_at) AS first_sent_at, max(ss.sent_at) AS last_sent_at, count(*)::int AS messages
      ${sendsFrom}
      JOIN campaigns ca ON ca.id = ss.campaign_id AND ca.org_id = ${org}
      WHERE ss.org_id = ${org} AND ss.status = 'sent' AND ss.sent_at <= ${asOf} AND ca.offer_id IS NOT NULL
      GROUP BY 1, 2, 3`);
  });

  // ── 5. Effective thresholds: org row (or defaults), then strictest across
  //      the contact's ACTIVE groups. Only contacts in at least one active
  //      group WITH an override need the aggregate; everyone else is org.
  await phase("thresholds", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_org_thr ON COMMIT DROP AS
      SELECT coalesce(ls.hot_days, ${D.hot_days})::int AS hot_days,
             coalesce(ls.warm_days, ${D.warm_days})::int AS warm_days,
             coalesce(ls.freeze_after_messages, ${D.freeze_after_messages})::int AS freeze_after_messages,
             coalesce(ls.freeze_cadence_days, ${D.freeze_cadence_days})::int AS freeze_cadence_days,
             coalesce(ls.suppress_after_days, ${D.suppress_after_days})::int AS suppress_after_days,
             coalesce(ls.suppress_min_freeze_messages, ${D.suppress_min_freeze_messages})::int AS suppress_min_freeze_messages
      FROM (SELECT 1) one
      LEFT JOIN lifecycle_settings ls ON ls.org_id = ${org}`);
    const hasOverride = sql`(g2.freeze_after_messages IS NOT NULL OR g2.freeze_cadence_days IS NOT NULL
                             OR g2.suppress_after_days IS NOT NULL OR g2.suppress_min_freeze_messages IS NOT NULL)`;
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_grp_thr ON COMMIT DROP AS
      SELECT ccg.contact_id,
             min(coalesce(g.freeze_after_messages, o.freeze_after_messages))::int AS freeze_after_messages,
             max(coalesce(g.freeze_cadence_days, o.freeze_cadence_days))::int AS freeze_cadence_days,
             min(coalesce(g.suppress_after_days, o.suppress_after_days))::int AS suppress_after_days,
             min(coalesce(g.suppress_min_freeze_messages, o.suppress_min_freeze_messages))::int AS suppress_min_freeze_messages,
             coalesce(array_agg(g.id ORDER BY g.id) FILTER (
               WHERE g.freeze_after_messages IS NOT NULL OR g.freeze_cadence_days IS NOT NULL
                  OR g.suppress_after_days IS NOT NULL OR g.suppress_min_freeze_messages IS NOT NULL
             ), '{}')::int[] AS override_group_ids
      FROM contact_contact_groups ccg
      JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
      CROSS JOIN eng_org_thr o
      WHERE ccg.org_id = ${org}
        AND ccg.contact_id IN (
          SELECT ccg2.contact_id FROM contact_contact_groups ccg2
          JOIN contact_groups g2 ON g2.id = ccg2.contact_group_id AND g2.status = 'active' AND g2.org_id = ${org}
          WHERE ccg2.org_id = ${org} AND ${hasOverride})
      GROUP BY ccg.contact_id`);
    await dbc.execute(sql`ANALYZE eng_grp_thr`);
  });

  // ── 6. The evaluation set and its inputs ─────────────────────────────────
  await phase("evaluate", async () => {
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_set ON COMMIT DROP AS
      SELECT contact_id FROM eng_touched
      ${full ? sql`` : sql`UNION SELECT contact_id FROM contact_engagement
                            WHERE org_id = ${org} AND time_due_at <= ${asOf}`}`);
    // Recounted contacts take the fresh facts; the others keep their stored ones.
    const pick = (fresh: SQL, stored: SQL) => sql`CASE WHEN t.contact_id IS NOT NULL THEN ${fresh} ELSE ${stored} END`;
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_eval ON COMMIT DROP AS
      SELECT s.contact_id,
             p.status AS prev_status,
             p.status_changed_at AS prev_status_changed_at,
             p.freeze_entered_at AS prev_freeze_entered_at,
             ${pick(sql`coalesce(f.msgs_total, 0)`, sql`p.msgs_total`)} AS msgs_total,
             ${pick(sql`coalesce(f.msgs_since_click, 0)`, sql`p.msgs_since_click`)} AS msgs_since_click,
             ${pick(sql`coalesce(f.msgs_7d, 0)`, sql`p.msgs_7d`)} AS msgs_7d,
             ${pick(sql`coalesce(f.msgs_14d, 0)`, sql`p.msgs_14d`)} AS msgs_14d,
             ${pick(sql`coalesce(f.msgs_30d, 0)`, sql`p.msgs_30d`)} AS msgs_30d,
             ${pick(sql`coalesce(f.msgs_90d, 0)`, sql`p.msgs_90d`)} AS msgs_90d,
             ${pick(sql`f.first_sent_at`, sql`p.first_sent_at`)} AS first_sent_at,
             ${pick(sql`f.last_sent_at`, sql`p.last_sent_at`)} AS last_sent_at,
             ${pick(sql`cl.first_click_at`, sql`p.first_click_at`)} AS first_click_at,
             ${pick(sql`cl.last_click_at`, sql`p.last_click_at`)} AS last_click_at,
             ${pick(sql`f.calc_freeze_started_at`, sql`p.freeze_started_at`)} AS calc_freeze_started_at,
             ${pick(sql`coalesce(f.calc_freeze_msgs, 0)`, sql`p.freeze_msgs`)} AS calc_freeze_msgs,
             o.hot_days, o.warm_days,
             coalesce(g.freeze_after_messages, o.freeze_after_messages) AS freeze_after_messages,
             coalesce(g.freeze_cadence_days, o.freeze_cadence_days) AS freeze_cadence_days,
             coalesce(g.suppress_after_days, o.suppress_after_days) AS suppress_after_days,
             coalesce(g.suppress_min_freeze_messages, o.suppress_min_freeze_messages) AS suppress_min_freeze_messages,
             coalesce(g.override_group_ids, '{}'::int[]) AS override_group_ids
      FROM eng_set s
      LEFT JOIN eng_touched t ON t.contact_id = s.contact_id
      LEFT JOIN eng_facts f ON f.contact_id = s.contact_id
      LEFT JOIN eng_clicks cl ON cl.contact_id = s.contact_id
      LEFT JOIN contact_engagement p ON p.contact_id = s.contact_id
      LEFT JOIN eng_grp_thr g ON g.contact_id = s.contact_id
      CROSS JOIN eng_org_thr o`);
    await dbc.execute(sql`
      CREATE TEMP TABLE eng_final ON COMMIT DROP AS
      ${evaluationSelectSql(sql`eng_eval`, asOf, opts.initialReason ?? "first_seen")}`);
    await dbc.execute(sql`ANALYZE eng_final`);
  });

  // ── 7. What changed (the same numbers whether or not we write) ──────────
  const statusCounts = zeroCounts();
  for (const r of await q<{ status: EngagementStatus; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM eng_final GROUP BY 1`)) {
    statusCounts[r.status] = Number(r.n);
  }
  const transitions: Record<string, number> = {};
  for (const r of await q<{ from_status: string | null; to_status: string; n: number }>(sql`
    SELECT prev_status AS from_status, status AS to_status, count(*)::int AS n
    FROM eng_final WHERE prev_status IS DISTINCT FROM status GROUP BY 1, 2`)) {
    transitions[`${r.from_status ?? "∅"}→${r.to_status}`] = Number(r.n);
  }
  const [counts] = await q<{ evaluated: number; recounted: number; changed: number; freeze_not_due: number; offer_changed: number; offer_gone: number }>(sql`
    SELECT (SELECT count(*) FROM eng_final)::int AS evaluated,
           (SELECT count(*) FROM eng_touched)::int AS recounted,
           (SELECT count(*) FROM eng_final f LEFT JOIN contact_engagement ce ON ce.contact_id = f.contact_id
             WHERE ce.contact_id IS NULL OR ${tuple("ce")} IS DISTINCT FROM ${tuple("f")})::int AS changed,
           (SELECT count(*) FROM eng_final
             WHERE status = 'freeze' AND last_sent_at > ${asOf} - make_interval(days => freeze_cadence_days))::int AS freeze_not_due,
           (SELECT count(*) FROM eng_offer e LEFT JOIN contact_offer_campaigns oc
              ON oc.contact_id = e.contact_id AND oc.offer_id = e.offer_id AND oc.campaign_id = e.campaign_id
             WHERE oc.contact_id IS NULL
                OR (oc.first_sent_at, oc.last_sent_at, oc.messages) IS DISTINCT FROM (e.first_sent_at, e.last_sent_at, e.messages))::int AS offer_changed,
           (SELECT count(*) FROM contact_offer_campaigns oc
             WHERE oc.org_id = ${org} AND oc.contact_id IN (SELECT contact_id FROM eng_touched)
               AND NOT EXISTS (SELECT 1 FROM eng_offer e WHERE e.contact_id = oc.contact_id
                                AND e.offer_id = oc.offer_id AND e.campaign_id = oc.campaign_id))::int AS offer_gone`);
  const transitionsTotal = Object.values(transitions).reduce((a, b) => a + b, 0);

  let rowsWritten = Number(counts.changed);
  let transitionsWritten = transitionsTotal;
  let offerRowsWritten = Number(counts.offer_changed);
  let offerRowsDeleted = Number(counts.offer_gone);

  // ── 8. Write (skipped entirely in a dry run) ─────────────────────────────
  if (!opts.dryRun) {
    await phase("write", async () => {
      const setList = sql.raw(
        [...ENGAGEMENT_VALUE_COLUMNS, "status_changed_at", "computed_at"].map((c) => `${c} = EXCLUDED.${c}`).join(", "),
      );
      const [w] = await q<{ n: number }>(sql`
        WITH w AS (
          INSERT INTO contact_engagement AS ce (
            contact_id, org_id, status, status_changed_at,
            msgs_total, msgs_since_click, msgs_7d, msgs_14d, msgs_30d, msgs_90d,
            first_sent_at, last_sent_at, first_click_at, last_click_at,
            freeze_entered_at, freeze_started_at, freeze_msgs, freeze_cadence_days,
            thresholds, time_due_at, computed_at)
          SELECT f.contact_id, ${org}, f.status,
                 CASE WHEN f.prev_status IS DISTINCT FROM f.status THEN ${asOf} ELSE f.prev_status_changed_at END,
                 f.msgs_total, f.msgs_since_click, f.msgs_7d, f.msgs_14d, f.msgs_30d, f.msgs_90d,
                 f.first_sent_at, f.last_sent_at, f.first_click_at, f.last_click_at,
                 f.freeze_entered_at, f.freeze_started_at, f.freeze_msgs, f.freeze_cadence_days,
                 f.thresholds, f.time_due_at, ${asOf}
          FROM eng_final f
          ON CONFLICT (contact_id) DO UPDATE SET ${setList}
          WHERE ${tuple("ce")} IS DISTINCT FROM ${tuple("EXCLUDED")}
          RETURNING 1)
        SELECT count(*)::int AS n FROM w`);
      rowsWritten = Number(w.n);

      const [tw] = await q<{ n: number }>(sql`
        WITH w AS (
          INSERT INTO contact_engagement_transitions (org_id, contact_id, from_status, to_status, reason, thresholds, created_at)
          SELECT ${org}, contact_id, prev_status, status, reason, thresholds, ${asOf}
          FROM eng_final WHERE prev_status IS DISTINCT FROM status
          RETURNING 1)
        SELECT count(*)::int AS n FROM w`);
      transitionsWritten = Number(tw.n);

      const [ow] = await q<{ n: number }>(sql`
        WITH w AS (
          INSERT INTO contact_offer_campaigns AS oc (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
          SELECT ${org}, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages FROM eng_offer
          ON CONFLICT (contact_id, offer_id, campaign_id) DO UPDATE
            SET first_sent_at = EXCLUDED.first_sent_at, last_sent_at = EXCLUDED.last_sent_at, messages = EXCLUDED.messages
          WHERE (oc.first_sent_at, oc.last_sent_at, oc.messages)
                IS DISTINCT FROM (EXCLUDED.first_sent_at, EXCLUDED.last_sent_at, EXCLUDED.messages)
          RETURNING 1)
        SELECT count(*)::int AS n FROM w`);
      offerRowsWritten = Number(ow.n);

      const [od] = await q<{ n: number }>(sql`
        WITH d AS (
          DELETE FROM contact_offer_campaigns oc
          WHERE oc.org_id = ${org} AND oc.contact_id IN (SELECT contact_id FROM eng_touched)
            AND NOT EXISTS (SELECT 1 FROM eng_offer e WHERE e.contact_id = oc.contact_id
                             AND e.offer_id = oc.offer_id AND e.campaign_id = oc.campaign_id)
          RETURNING 1)
        SELECT count(*)::int AS n FROM d`);
      offerRowsDeleted = Number(od.n);
    });
  }

  // ── 9. The dry-run report's breakdowns ───────────────────────────────────
  let groups: GroupBreakdownRow[] | undefined;
  let optedOutByStatus: Record<EngagementStatus, number> | undefined;
  if (opts.withReport) {
    const byGroup = new Map<number, GroupBreakdownRow>();
    for (const r of await q<{ group_id: number; name: string; status: EngagementStatus; n: number }>(sql`
      SELECT g.id::int AS group_id, g.name, f.status, count(*)::int AS n
      FROM eng_final f
      JOIN contact_contact_groups ccg ON ccg.contact_id = f.contact_id AND ccg.org_id = ${org}
      JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT 0, '(no active group)', f.status, count(*)::int
      FROM eng_final f
      WHERE NOT EXISTS (
        SELECT 1 FROM contact_contact_groups ccg
        JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.status = 'active' AND g.org_id = ${org}
        WHERE ccg.contact_id = f.contact_id AND ccg.org_id = ${org})
      GROUP BY 3`)) {
      const id = Number(r.group_id);
      const g = byGroup.get(id) ?? { group_id: id, name: r.name, counts: zeroCounts() };
      g.counts[r.status] = Number(r.n);
      byGroup.set(id, g);
    }
    groups = [...byGroup.values()].sort((a, b) => a.group_id - b.group_id);
    optedOutByStatus = zeroCounts();
    for (const r of await q<{ status: EngagementStatus; n: number }>(sql`
      SELECT f.status, count(*)::int AS n FROM eng_final f
      WHERE EXISTS (SELECT 1 FROM opt_outs o WHERE o.org_id = ${org} AND o.contact_id = f.contact_id)
      GROUP BY 1`)) {
      optedOutByStatus[r.status] = Number(r.n);
    }
  }

  return {
    mode: opts.mode,
    dryRun: opts.dryRun,
    recounted: Number(counts.recounted),
    evaluated: Number(counts.evaluated),
    statusCounts,
    transitions,
    rowsWritten,
    transitionsWritten,
    offerRowsWritten,
    offerRowsDeleted,
    freezeNotDue: Number(counts.freeze_not_due),
    groups,
    optedOutByStatus,
    phaseMs,
    durationMs: Date.now() - started,
  };
}
```

- [ ] **Step 4: Run the test and verify it passes.**

Run: the Task 2 test command.
Expected: every A and B bar `✓`, `Teardown: 0 row(s) left for this run`, `All checks passed.`, exit 0.
- If a B bar fails, re-derive its expectation from the fixture comments before changing code. The fixture numbers are hand-derived and the bar text states them.
- A likely first failure is a planner or type error in a temp-table statement. Read the Postgres error and fix the SQL.

- [ ] **Step 5: Lint and commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx eslint lib/engagement/refresh.ts scripts/test-engagement-db.ts
git add lib/engagement/refresh.ts scripts/test-engagement-db.ts
git commit -m "feat(engagement): refresh orchestrator (full/incremental, dry run) + world tests

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Cron route, engine switch, heartbeats, monitor

**Files:**
- Create: `lib/engagement/settings.ts`, `lib/engagement/monitor.ts`, `app/api/cron/refresh-contact-engagement/route.ts`
- Modify:
  - `lib/reporting/cron-heartbeat.ts` (`HEARTBEAT_JOBS`: two entries after `deliveryRollupReconcile`)
  - `app/api/cron/tracking-monitors/route.ts` (one call, right after `await watchIngestHeartbeat(db);`)
  - `lib/authz/route-map.ts` (one key, alphabetical among `cron/*`)
  - `vercel.json` (two entries at the end of `crons`)
  - `scripts/test-engagement-db.ts` (Part C)

**Interfaces:**
- Consumes: `refreshContactEngagement` (Task 3); `ENGAGEMENT_LEASE`, `ENGAGEMENT_JOB`, `ENGAGEMENT_FULL_JOB`, `INCREMENTAL_OVERLAP_MINUTES`, `FULL_FALLBACK_HOURS` (Task 2); `withCronLease`, `recordHeartbeat`, `checkHeartbeats`, `heartbeatBreaches`, `notifyOnTransition`, `clearAlert` (existing).
- Produces:
  - `orgsWithEngineOn(dbc: DbOrTx): Promise<string[]>`;
  - `watchEngagementHeartbeat(dbc: DbOrTx, which: "incremental" | "full", opts?: { send?: (text: string) => Promise<boolean> }): Promise<HeartbeatStatus | null>`;
  - `HEARTBEAT_JOBS.contactEngagement`, `HEARTBEAT_JOBS.contactEngagementFull`.

- [ ] **Step 1: Append Part C to the test.** Insert it after Part B's `finally` block, before the final `console.log(fail === 0 …`. Add `const { watchEngagementHeartbeat } = await import("@/lib/engagement/monitor");` to the imports at the top of `main()`.

```ts
  // ── PART C — the heartbeat watch is silent while every engine is off ──────
  console.log("\nPART C — watchEngagementHeartbeat");
  const onNow = (await db.execute(sql`SELECT count(*)::int AS n FROM lifecycle_settings WHERE engine_mode = 'write'`)) as unknown as { n: number }[];
  if (Number(onNow[0].n) !== 0) {
    bar("C0 precondition: no org on this preview DB has the engine on", false, `${onNow[0].n} org(s) do — skipping C1/C2`);
  } else {
    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); return true; };
    const r = await watchEngagementHeartbeat(db, "incremental", { send });
    bar("C1 engine off everywhere ⇒ no check, no alert", r === null && sent.length === 0, JSON.stringify(r));
    const cOrg = (await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${"__ENGAGEMENT_TEST__"} monitor-${Date.now()}`}) RETURNING id`)) as unknown as { id: string }[];
    const monitorOrg = cOrg[0].id;
    try {
      await db.execute(sql`INSERT INTO lifecycle_settings (org_id, engine_mode) VALUES (${monitorOrg}::uuid, 'write')`);
      const hb = (await db.execute(sql`SELECT watermark FROM cron_locks WHERE job_name = 'contact-engagement'`)) as unknown as { watermark: string | null }[];
      if (hb.length > 0 && hb[0].watermark != null) {
        bar("C2 precondition: preview has no contact-engagement heartbeat", false, "a heartbeat exists — skipping");
      } else {
        const s1 = await watchEngagementHeartbeat(db, "incremental", { send });
        const s2 = await watchEngagementHeartbeat(db, "incremental", { send });
        bar("C2 engine on + never ran ⇒ stale, one alert, latched on the second check",
          s1?.stale === true && s2?.stale === true && sent.length === 1, `sent=${sent.length}`);
      }
    } finally {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${monitorOrg}::uuid AND name LIKE '__ENGAGEMENT_TEST__%'`);
      await watchEngagementHeartbeat(db, "incremental", { send }); // engine off again ⇒ clears the latch
    }
  }
```

- [ ] **Step 2: Run the test and verify Part C fails** with `Cannot find module '@/lib/engagement/monitor'`.

- [ ] **Step 3: Write `lib/engagement/settings.ts`.**

```ts
import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

/**
 * Orgs whose engagement job is switched on (lifecycle_settings.engine_mode =
 * 'write'). No row, or 'off', means the cron skips the org. Trusted-context
 * read: the cron iterates orgs explicitly, like the other per-org jobs.
 */
export async function orgsWithEngineOn(dbc: DbOrTx): Promise<string[]> {
  const rows = (await dbc.execute(sql`
    SELECT org_id FROM lifecycle_settings WHERE engine_mode = 'write' ORDER BY org_id
  `)) as unknown as { org_id: string }[];
  return rows.map((r) => r.org_id);
}
```

- [ ] **Step 4: Add the heartbeat expectations.** In `lib/reporting/cron-heartbeat.ts`, inside `HEARTBEAT_JOBS`, after the `deliveryRollupReconcile` entry:

```ts
  // ---- Contact engagement (migration 0187). The 15-min job is watched by the
  // hourly tracking-monitors; the nightly full recount is watched by the 15-min
  // job. Both watches stay silent while no org has the engine on
  // (lib/engagement/monitor.ts), so the PR can deploy before the backfill.
  contactEngagement: {
    job_name: "contact-engagement",
    max_age_hours: 0.75, // spec §5: alert when the last successful run is > 45 min old
    label: "Contact lifecycle refresh (every 15 min)",
  },
  contactEngagementFull: {
    job_name: "contact-engagement-full",
    max_age_hours: 50, // nightly; ~2 missed runs
    label: "Contact lifecycle full recount (nightly)",
  },
```

- [ ] **Step 5: Write `lib/engagement/monitor.ts`.**

```ts
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import {
  checkHeartbeats,
  HEARTBEAT_JOBS,
  heartbeatBreaches,
  type DbOrTx,
  type HeartbeatStatus,
} from "@/lib/reporting/cron-heartbeat";

export const ENGAGEMENT_STALE_ALERT = "contact-engagement-stale";
export const ENGAGEMENT_FULL_STALE_ALERT = "contact-engagement-full-stale";

/**
 * Dead-man check for the engagement job, run by ANOTHER job (never itself):
 * "incremental" from /api/cron/tracking-monitors, "full" from the 15-min run.
 * Silent while no org has the engine on — a job that is switched off is not
 * stale. Latched per key: one message per transition.
 */
export async function watchEngagementHeartbeat(
  dbc: DbOrTx,
  which: "incremental" | "full",
  opts: { send?: (text: string) => Promise<boolean> } = {},
): Promise<HeartbeatStatus | null> {
  const alertKey = which === "incremental" ? ENGAGEMENT_STALE_ALERT : ENGAGEMENT_FULL_STALE_ALERT;
  if ((await orgsWithEngineOn(dbc)).length === 0) {
    await clearAlert(dbc, { alertKey });
    return null;
  }
  const expectation =
    which === "incremental" ? HEARTBEAT_JOBS.contactEngagement : HEARTBEAT_JOBS.contactEngagementFull;
  const [status] = await checkHeartbeats(dbc, [expectation]);
  const [breach] = heartbeatBreaches([status]);
  if (breach !== undefined) {
    await notifyOnTransition(dbc, {
      alertKey,
      text:
        `⚠️ Contact lifecycle: ${breach} Freeze cadence, suppression and the lifecycle ` +
        `chips read statuses this job maintains; they go stale while it is down. ` +
        `Check /api/cron/refresh-contact-engagement in Vercel.`,
      send: opts.send,
    });
  } else {
    await clearAlert(dbc, { alertKey });
  }
  return status;
}
```

- [ ] **Step 6: Run the test and verify Part C passes.** Parts A and B still pass; C1 and C2 `✓`, or the precondition bar explains a skip. Exit 0.

- [ ] **Step 7: Write the cron route** `app/api/cron/refresh-contact-engagement/route.ts`:

```ts
import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import {
  ENGAGEMENT_FULL_JOB,
  ENGAGEMENT_JOB,
  ENGAGEMENT_LEASE,
  FULL_FALLBACK_HOURS,
  INCREMENTAL_OVERLAP_MINUTES,
} from "@/lib/engagement/constants";
import { watchEngagementHeartbeat } from "@/lib/engagement/monitor";
import { refreshContactEngagement, type RefreshMode, type RefreshResult } from "@/lib/engagement/refresh";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import { recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Maintains contact_engagement (migration 0187) — see lib/engagement/refresh.ts.
//
//   every 15 min at :10/:25/:40/:55   incremental (after propagate-clickers :08/:23/…)
//   ?mode=full at 06:35 UTC           full recount (02:35 ET, off the send windows)
//
// Only orgs with lifecycle_settings.engine_mode = 'write' are processed; until
// the one-off backfill (scripts/engagement-backfill.ts --apply) flips it, every
// tick is a no-op. Heartbeats are stamped only when every org succeeded. The
// incremental run falls back to full when the last success is missing or older
// than FULL_FALLBACK_HOURS. Status is never computed in the send loop — the
// drain only ever READS contact_engagement.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000; // > maxDuration: a killed function's SQL keeps running

type OrgResult = { org_id: string; error?: string } & Partial<RefreshResult>;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const requested: RefreshMode = req.nextUrl.searchParams.get("mode") === "full" ? "full" : "incremental";

  const outcome = await withCronLease(
    ENGAGEMENT_LEASE,
    async () => {
      const orgs = await orgsWithEngineOn(db);
      if (orgs.length === 0) return { ok: true, engine: "off" as const, results: [] as OrgResult[] };

      const hb = (await db.execute(sql`
        SELECT watermark FROM cron_locks WHERE job_name = ${ENGAGEMENT_JOB}
      `)) as unknown as { watermark: string | null }[];
      const last = hb[0]?.watermark ? new Date(hb[0].watermark) : null;
      const stale = last == null || Date.now() - last.getTime() > FULL_FALLBACK_HOURS * 3_600_000;
      const mode: RefreshMode = requested === "full" || stale ? "full" : "incremental";
      const since = last ? new Date(last.getTime() - INCREMENTAL_OVERLAP_MINUTES * 60_000) : undefined;

      const results: OrgResult[] = [];
      for (const org_id of orgs) {
        // One org's failure must not stop the rest; it withholds the heartbeat.
        try {
          const r = await db.transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${mode === "full" ? "270s" : "100s"}'`));
            return refreshContactEngagement(tx, org_id, { mode, dryRun: false, since });
          });
          results.push({ org_id, ...r });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error("[contact-engagement] refresh failed", { org_id, mode, error });
          results.push({ org_id, error });
        }
      }
      const ok = results.every((r) => !r.error);
      if (ok) {
        await recordHeartbeat(db, ENGAGEMENT_JOB);
        if (mode === "full") await recordHeartbeat(db, ENGAGEMENT_FULL_JOB);
      }
      // Watch the nightly recount from the frequent job (never itself).
      if (mode === "incremental") await watchEngagementHeartbeat(db, "full");
      return { ok, engine: "on" as const, mode, results };
    },
    LEASE_MS,
  );
  if (!outcome.ran) return NextResponse.json({ ok: true, skipped: true });
  const r = outcome.result;
  return NextResponse.json({ ...r, ts: new Date().toISOString() }, { status: r.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
```

- [ ] **Step 8: Wire the watch, route map and schedule.**

(a) In `app/api/cron/tracking-monitors/route.ts`, add `import { watchEngagementHeartbeat } from "@/lib/engagement/monitor";` to the imports. Then add this right after `await watchIngestHeartbeat(db);`:

```ts
    // Contact lifecycle job dead-man (HEARTBEAT_JOBS.contactEngagement), silent
    // while no org has the engine on. Not try/caught, for the same reason as above.
    await watchEngagementHeartbeat(db, "incremental");
```

(b) In `lib/authz/route-map.ts`, among the `cron/*` keys, in alphabetical position after `"cron/refresh-audience-pools"` (or wherever sorts correctly):

```ts
  "cron/refresh-contact-engagement": null, // cron / webhook / import machinery -- no operator session reaches these
```

(c) In `vercel.json`, append these two objects to `crons`, after the `delivery-rollup-reconcile` entry:

```json
    {
      "path": "/api/cron/refresh-contact-engagement",
      "schedule": "10,25,40,55 * * * *"
    },
    {
      "path": "/api/cron/refresh-contact-engagement?mode=full",
      "schedule": "35 6 * * *"
    }
```

- [ ] **Step 9: Verify.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -5
npx tsx scripts/test-route-map-coverage.ts 2>&1 | tail -3
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json OK')"
npx eslint lib/engagement/settings.ts lib/engagement/monitor.ts app/api/cron/refresh-contact-engagement/route.ts lib/reporting/cron-heartbeat.ts app/api/cron/tracking-monitors/route.ts lib/authz/route-map.ts scripts/test-engagement-db.ts
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts | tail -4
```
Expected:
- tsc prints nothing.
- The route-map coverage run passes.
- `vercel.json OK`.
- eslint prints no errors. `tracking-monitors` and `route-map` may carry pre-existing warnings; compare against `git show HEAD:<file>` if unsure.
- The test ends with `All checks passed.`

- [ ] **Step 10: Commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git add lib/engagement/settings.ts lib/engagement/monitor.ts app/api/cron/refresh-contact-engagement/route.ts lib/reporting/cron-heartbeat.ts app/api/cron/tracking-monitors/route.ts lib/authz/route-map.ts vercel.json scripts/test-engagement-db.ts
git commit -m "feat(engagement): cron (15-min incremental + nightly full), engine switch, heartbeat watches

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The prod dry-run report and one-off backfill script

**Files:**
- Create: `scripts/engagement-backfill.ts`
- Modify: `scripts/test-preview-db-guard.ts` (one `EXCLUSIONS` entry, alphabetical among the `backfill-*` / production tools)

**Interfaces:**
- Consumes: `refreshContactEngagement`, `RefreshResult` (Task 3); `recordHeartbeat` (existing); `ENGAGEMENT_JOB`, `ENGAGEMENT_FULL_JOB`, `ENGAGEMENT_STATUSES` (Task 2).

- [ ] **Step 1: Write the script.**

```ts
import "./_env-preload";

// PRODUCTION TOOL — contact engagement (migration 0187): the dry-run report and
// the one-off backfill. Listed in scripts/test-preview-db-guard.ts EXCLUSIONS.
//
//   default   DRY RUN. The full refresh inside a transaction that is ALWAYS
//             rolled back (and dryRun=true, so no write statement even runs).
//             Prints: status counts org-wide, opted-out per status, freeze not
//             due today, per active contact group (a contact in several groups
//             is counted in each), the transitions and rows it would write, and
//             phase timings. --out <file.json> also writes the raw result.
//   --apply   THE BACKFILL, in ONE transaction: the full refresh with reason
//             'backfill', both heartbeats, lifecycle_settings.engine_mode =
//             'write', and an org_setting_events audit row. Refuses if the org
//             already has contact_engagement rows. Needs the user's explicit
//             approval of the dry-run numbers first (it is a data write).
//
// Run:  npx tsx --conditions=react-server scripts/engagement-backfill.ts [--org <uuid>] [--out <file>] [--apply]
// Without --org the database must hold exactly one organization.

import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

class RolledBack extends Error {
  constructor(public readonly payload: unknown) {
    super("dry run — rolled back");
  }
}

async function main() {
  const { db } = await import("@/db/client");
  const { refreshContactEngagement } = await import("@/lib/engagement/refresh");
  const { recordHeartbeat } = await import("@/lib/reporting/cron-heartbeat");
  const { ENGAGEMENT_FULL_JOB, ENGAGEMENT_JOB, ENGAGEMENT_STATUSES } = await import("@/lib/engagement/constants");
  type Result = Awaited<ReturnType<typeof refreshContactEngagement>>;

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let orgId = arg("--org");
  if (!orgId) {
    const orgs = (await db.execute(sql`SELECT id FROM organizations ORDER BY created_at`)) as unknown as { id: string }[];
    if (orgs.length !== 1) throw new Error(`${orgs.length} organizations — pass --org <uuid>`);
    orgId = orgs[0].id;
  }
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${apply ? "APPLY" : "DRY RUN"} — org ${orgId} — db host ${host}\n`);

  const print = (r: Result) => {
    const pad = (s: string | number, n: number) => String(s).padStart(n);
    console.log("status        contacts   of which opted out");
    for (const s of ENGAGEMENT_STATUSES) {
      console.log(`${s.padEnd(12)} ${pad(r.statusCounts[s], 9)}   ${pad(r.optedOutByStatus?.[s] ?? 0, 9)}`);
    }
    console.log(`\nfreeze contacts NOT due today (last message inside their cadence): ${r.freezeNotDue}`);
    console.log(`\nper active contact group (fan-out: a contact in several groups counts in each)`);
    console.log(`${"group".padEnd(34)}${ENGAGEMENT_STATUSES.map((s) => pad(s, 11)).join("")}`);
    for (const g of r.groups ?? []) {
      console.log(`${`${g.group_id} ${g.name}`.slice(0, 33).padEnd(34)}${ENGAGEMENT_STATUSES.map((s) => pad(g.counts[s], 11)).join("")}`);
    }
    console.log(`\ntransitions: ${JSON.stringify(r.transitions)}`);
    console.log(`rows ${r.dryRun ? "that would be " : ""}written: contact_engagement ${r.rowsWritten}, transitions ${r.transitionsWritten}, contact_offer_campaigns ${r.offerRowsWritten} (+${r.offerRowsDeleted} deleted)`);
    console.log(`timing (ms): ${JSON.stringify(r.phaseMs)}  total ${r.durationMs}`);
  };

  if (!apply) {
    let result: Result | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
        const r = await refreshContactEngagement(tx, orgId!, {
          mode: "full", dryRun: true, initialReason: "backfill", withReport: true,
        });
        throw new RolledBack(r);
      });
    } catch (err) {
      if (!(err instanceof RolledBack)) throw err;
      result = err.payload as Result;
    }
    print(result!);
    const out = arg("--out");
    if (out) {
      writeFileSync(out, JSON.stringify(result, null, 2));
      console.log(`\nraw result written to ${out}`);
    }
    console.log("\nDRY RUN — nothing was written (transaction rolled back).");
    return;
  }

  const existing = (await db.execute(sql`
    SELECT count(*)::int AS n FROM contact_engagement WHERE org_id = ${orgId}::uuid
  `)) as unknown as { n: number }[];
  if (Number(existing[0].n) > 0) {
    throw new Error(`REFUSING: org already has ${existing[0].n} contact_engagement rows — the backfill is one-off.`);
  }
  const r = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '1200s'`);
    const res = await refreshContactEngagement(tx, orgId!, {
      mode: "full", dryRun: false, initialReason: "backfill", withReport: true,
    });
    const prev = (await tx.execute(sql`
      SELECT engine_mode FROM lifecycle_settings WHERE org_id = ${orgId}::uuid
    `)) as unknown as { engine_mode: string }[];
    await tx.execute(sql`
      INSERT INTO lifecycle_settings (org_id, engine_mode, updated_at)
      VALUES (${orgId}::uuid, 'write', now())
      ON CONFLICT (org_id) DO UPDATE SET engine_mode = 'write', updated_at = now()
    `);
    await tx.execute(sql`
      INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
      VALUES (${orgId}::uuid, 'lifecycle.engine_mode', ${prev[0]?.engine_mode ?? "off"}, 'write', NULL)
    `);
    await recordHeartbeat(tx, ENGAGEMENT_JOB);
    await recordHeartbeat(tx, ENGAGEMENT_FULL_JOB);
    return res;
  });
  print(r);
  console.log("\nAPPLIED — engine_mode = 'write'; the 15-min cron takes over from here.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

- [ ] **Step 2: Register it in the guard.** In `scripts/test-preview-db-guard.ts`, add to `EXCLUSIONS` in alphabetical position among the production one-shots (after `backfill-drip-journey-lifecycle.ts`, or wherever `engagement-backfill.ts` sorts):

```ts
  { file: "engagement-backfill.ts", why: "production dry-run report + one-off backfill of contact_engagement (migration 0187); dry run always rolls back, writes only behind --apply after the owner approves the numbers" },
```

- [ ] **Step 3: Verify.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npm run check:guards 2>&1 | tail -4
npx eslint scripts/engagement-backfill.ts scripts/test-preview-db-guard.ts
npx tsc --noEmit -p . 2>&1 | tail -3
```
Expected: the guards pass, eslint is clean and tsc prints nothing. Do NOT run the script against prod yet; that is Task 8.

- [ ] **Step 4: Dry-run it against PREVIEW** to prove the report path end to end. Preview has 500 contacts.

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/engagement-backfill.ts --org "$(DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx -e "import('./db/client').then(async ({db})=>{const {sql}=await import('drizzle-orm');const r:any=await db.execute(sql\`SELECT id FROM organizations WHERE name = 'CamMan Demo'\`);console.log(r[0].id);process.exit(0)})")"
```
Expected:
- a report with 6 status rows and a group table;
- `DRY RUN — nothing was written`;
- then, via MCP on camman-v2, `SELECT count(*) FROM contact_engagement` = 0.

If the inline org lookup is awkward, look the id up with the MCP (`SELECT id FROM organizations WHERE name = 'CamMan Demo'`) and pass it literally.

- [ ] **Step 5: Commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git add scripts/engagement-backfill.ts scripts/test-preview-db-guard.ts
git commit -m "feat(engagement): prod dry-run report + one-off backfill script

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/04-features/contact-lifecycle.md`
- Modify: `docs/03-data-model.md` (tables + Mermaid ERD), `docs/04-features/crons.md` (two rows), `docs/07-conventions.md` (one convention block), `docs/CHANGELOG.md` (one line)

- [ ] **Step 1: Read the precedent.** Run `git -C /c/AFF/camman/.claude/worktrees/lifecycle-recon show 3a4b9c83 -- docs/03-data-model.md docs/04-features/crons.md docs/CHANGELOG.md` and match its structure and tone exactly: where a table is documented, how the ERD entity is written, the crons table columns, and the changelog line shape.

- [ ] **Step 2: Write `docs/04-features/contact-lifecycle.md`** with these sections. Headings are exact; content comes from the spec and this PR only:
  - `# Contact lifecycle status` with a `_Last updated: 2026-09-22_` line.
  - `## What it is`: the six statuses and one line each (spec §3.2 table). A link to the spec. State "PR 1 of 5: data layer only; nothing reads it yet."
  - `## Where it lives`: the five tables and the `contact_groups` / `campaigns` columns, with one line each. The files `lib/engagement/{constants,status-sql,refresh,settings,monitor}.ts` and `app/api/cron/refresh-contact-engagement/route.ts`.
  - `## The job`: incremental vs full, the touched set, time_due_at, the 30-min overlap, the full fallback after 24 h, engine_mode, heartbeats and watchers.
  - `## Turning it on`: the dry run → approval → `--apply` sequence (Tasks 8–9 of the plan), with the exact commands.
  - `## Invariants`: status only via `evaluationSelectSql`; human click = `HUMAN_CLICK`; a missing row reads as `new`; no trigger on `stage_sends`; existing freeze contacts' clock starts at the backfill instant (no suppression at launch).
- [ ] **Step 3: `docs/03-data-model.md`.** Document the five tables and six columns in the precedent's format. Add them to the Mermaid ERD with relationships:
  - `contacts ||--o| contact_engagement`
  - `contacts ||--o{ contact_engagement_transitions`
  - `contacts ||--o{ contact_offer_campaigns`
  - `offers ||--o{ contact_offer_campaigns`
  - `campaigns ||--o{ contact_offer_campaigns`
  - `stage_sends ||--o| stage_send_lifecycle`
  - `organizations ||--o| lifecycle_settings`

  Bump its last-updated date.
- [ ] **Step 4: `docs/04-features/crons.md`.** Add the two schedules (path, schedule, lease, maxDuration 300, purpose, "no-op until engine_mode = 'write'"). Bump the date.
- [ ] **Step 5: `docs/07-conventions.md`.** Add `## Contact lifecycle status has one definition (2026-09-22)` with four bullets:
  1. evaluate status only through `lib/engagement/status-sql.ts`'s `evaluationSelectSql`;
  2. read it from `contact_engagement`, and treat a missing row as `new`;
  3. never compute it in the send path, which only reads it;
  4. `engine_mode` gates the cron per org.

  Bump the date.
- [ ] **Step 6: `docs/CHANGELOG.md`.** Append: `2026-09-22 — Contact lifecycle PR 1: migration 0187 (contact_engagement + transitions, lifecycle_settings, contact_offer_campaigns, stage_send_lifecycle, group overrides, campaigns.lifecycle_rules), engagement job (inert until engine_mode='write'), dry-run/backfill script — docs: 04-features/contact-lifecycle.md (new), 03-data-model.md, 04-features/crons.md, 07-conventions.md`
- [ ] **Step 7: Verify and commit.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npm run check:docs 2>&1 | tail -3
git diff --stat origin/main -- docs/CHANGELOG.md
git add docs/04-features/contact-lifecycle.md docs/03-data-model.md docs/04-features/crons.md docs/07-conventions.md docs/CHANGELOG.md
git commit -m "docs(engagement): contact lifecycle PR 1 — feature doc, data model + ERD, crons, conventions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
Expected:
- `check:docs` passes.
- The CHANGELOG diff against origin/main is a pure insertion (`+N` lines, 0 deletions), and upstream's newest entry is still present.

---

### Task 7: Full verification, rebase, PR

- [ ] **Step 1: Run everything.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsc --noEmit -p . 2>&1 | tail -3
npm run check:guards 2>&1 | tail -2
npm run check:docs 2>&1 | tail -2
npx tsx scripts/test-route-map-coverage.ts 2>&1 | tail -2
npx tsx scripts/test-segment-rule-type-registration.ts 2>&1 | tail -2
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-engagement-db.ts | tail -3
DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx scripts/verify-migration-integrity.ts | tail -3
npx eslint $(git diff --name-only origin/main -- '*.ts' '*.tsx')
```
Expected: all green. The segment-rule registration check proves 0187 did not touch the rule-type CHECK. Record the output lines for the PR body. That is the "Verified: …" list.

- [ ] **Step 2: Build.** Run `npx next build 2>&1 | tail -15`. Expected: build succeeds, and `/api/cron/refresh-contact-engagement` is listed as a route.

- [ ] **Step 3: Rebase and re-check the migration number.**

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git fetch origin --quiet && git rebase origin/main
git ls-tree --name-only origin/main db/migrations/ | grep -E '/0187_' || echo "0187 still free"
```
Expected: `0187 still free`. **On any rebase conflict, stop and report it to the user; do not resolve silently.** If 0187 was taken, renumber the SQL file, snapshot id/prevId and journal entry, and tell the user.

- [ ] **Step 4: Push and open the PR** (do not merge; Tasks 8–9 gate it).

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
git push -u origin feat/contact-lifecycle
gh pr create --base main --head feat/contact-lifecycle --title "feat(engagement): contact lifecycle PR 1 — migration 0187, engagement job (inert), dry-run report" --body-file <(cat <<'EOF'
PR 1 of 5 for the contact lifecycle spec (docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md).

- Migration 0187 (additive): contact_engagement + transitions, lifecycle_settings (engine_mode switch), contact_offer_campaigns (ClickUp 869f53efz data), stage_send_lifecycle, contact_groups lifecycle overrides, campaigns.lifecycle_rules.
- lib/engagement: the lifecycle rules as ONE SQL evaluator; full / incremental refresh; dry run.
- /api/cron/refresh-contact-engagement: every 15 min + nightly full. No-op until an org's engine_mode = 'write'.
- scripts/engagement-backfill.ts: prod dry-run report; --apply = one-off backfill + engine on.
- Nothing reads contact_engagement yet; no send-path change; no CHECK change on stage_sends / segment_rules (PR 4 / PR 3).

Verified: <paste the Task 7 Step 1–2 results>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```
Then check that the preview deploy goes green. It auto-applies 0187 to camman-v2, where it is already applied, so the step is a no-op.

---

### Task 8: (after GATE A) prod migration + prod dry run → GATE B

- [ ] **Step 1: Only with the user's explicit approval of the 0187 SQL:** apply to prod outside a send burst. Apply order: migration first, before merging, because it is additive.

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npm run db:migrate            # .env.local = PROD
npx tsx scripts/verify-migration-integrity.ts | tail -4
```
Expected: 1 migration applied, and the chain clean up to 0187. If it fails with `lock_timeout`, nothing was applied. Retry a few minutes later.

Then run `get_advisors type=security` on prod. Expected: no new ERROR.

- [ ] **Step 2: Prod dry run (read-only: always rolls back).** Run it off the :29/:59 pools cron minutes.

```bash
cd /c/AFF/camman/.claude/worktrees/lifecycle-recon
npx tsx --conditions=react-server scripts/engagement-backfill.ts --out "C:/Users/dimat/AppData/Local/Temp/claude/c--AFF-camman/05a283c6-2d93-408f-b57c-229b19def952/scratchpad/engagement-dry-run.json"
```
Then confirm via MCP on prod: `SELECT count(*) FROM contact_engagement` = 0.

- [ ] **Step 3: GATE B.** Report to the user:
  - counts per status, org-wide and per active group;
  - freeze not due today;
  - opted-out per status;
  - rows it would write;
  - phase timings. The full-run timing tells whether the nightly cron fits inside `maxDuration` 300. If `durationMs` exceeds ~200 000, say so and propose moving the nightly run to a session-mode connection before enabling it.

  Wait for approval.

- [ ] **Step 4: Merge after green checks** per the merge policy. The cron deploys inert. Smoke check with `curl -s -H "Authorization: Bearer $CRON_SECRET" https://camman.vercel.app/api/cron/refresh-contact-engagement`. Expected: `{"ok":true,"engine":"off",…}`.

### Task 9: (after GATE B) the backfill

- [ ] **Step 1: Only with the user's explicit approval of the dry-run numbers:** run `npx tsx --conditions=react-server scripts/engagement-backfill.ts --apply` off-peak. Expected: the printed counts equal the dry run's (± contacts added in between), then `APPLIED — engine_mode = 'write'`.
- [ ] **Step 2: Watch the first two cron ticks.**
  - `cron_locks` watermark for `contact-engagement` advances.
  - The response `results[0]` shows `mode: "incremental"` with a small `recounted`.
  - No Telegram alert.
- [ ] **Step 3: Verified list to the user.** Include:
  - migration chain clean;
  - dry run = apply counts;
  - two ticks healthy;
  - `SELECT status, count(*) FROM contact_engagement GROUP BY 1` matches;
  - 0 suppressed at launch.
