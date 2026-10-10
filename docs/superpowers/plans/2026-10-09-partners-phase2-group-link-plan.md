# Partner attribution Phase 2 — group → partner link, appearance repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link contact groups to partners (the attribution's one input), make a drip lead's partner-group membership date from its delivery, mark the two system drip groups, finish C2 with `SET NOT NULL`, and create the recalc job table Phase 3 will consume — with no send-path change and nothing Phase 3 cannot build on.

**Architecture:** ONE migration, **0201** (schema): `SET NOT NULL` on `partner_keys.partner_id` behind an in-SQL zero-NULLs guard; `contact_groups.partner_id` (RESTRICT) + partial index; `contact_groups.system_role` marker (C4) backfilled onto `drip-intake` / `drip-sandbox`; the Q6 auto-link backfill (`pml-aca` → pml, `bsd-untagged` → bsd); `partner_attribution_recalcs`. The appearance repair (Q2) is **not a migration** (owner fix F1, 2026-10-09): it is an idempotent, re-runnable script with a dry-run mode that runs on prod only after the new enrichment code is deployed and one fresh pml lead is confirmed stamped at `received_at`, behind its own go. Code: the drip group helpers stamp delivery time and set the link/marker at creation; the group screen gets a partner select behind `partner_keys.manage` (locked read-only on drip partner×tag groups, F3); a source-scan guard proves no send-path reader of the membership timestamp exists. Rows in `partner_attribution_recalcs` are written on link changes and consumed by nothing until Phase 3.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle (hand-authored SQL migrations + cloned snapshots), Zod, shadcn/ui, tsx proof scripts against the camman-v2 preview database.

**Source of truth:** [docs/superpowers/specs/2026-10-08-partner-attribution-recon.md](../specs/2026-10-08-partner-attribution-recon.md) §2, §3, §5.3, §9.3, §9.5 (phase 2) and its **Approval** section (C2, C4, Q2, Q3, Q4, Q6, Q9, Q12), plus the owner's Phase 2 build fixes **F1–F5 (2026-10-09)** below. Phase 1 plan: [2026-10-09-partners-entity-phase1.md](2026-10-09-partners-entity-phase1.md). Where this plan and the recon body disagree, the Approval section and F1–F5 win.

## Global Constraints

- **Gating (owner):** every prod migration and data write stops at the proposal and waits for an explicit go; preview (camman-v2, ref `fdzxzxayhknywvmrhjcj`) first; the prod apply is attended, any time before 12:00 UTC. This phase has **two prod gates**: (A) the 0201 apply; (B) the appearance-repair script, run only after the 0201 code is deployed and one fresh pml lead is confirmed stamped at `received_at`. Stop and report after this phase; Phase 3 needs its own go.
- **F1 — the repair is a script, not a migration.** `scripts/repair-drip-membership-appearance.ts`: default = dry run (prints the counts); `--apply` fills the backup table, then updates. Re-runnable: a later run appends newly found rows to the backup (`ON CONFLICT DO NOTHING`, so an existing `old_created_at` is never overwritten) and repairs only rows still stamped after delivery. `--revert --apply` restores from the backup. Exit checks (Task 0 `--after`) run after the script. Listed in the preview-DB guard's `EXCLUSIONS` with the reason (it writes prod on purpose).
- **F2 — `partners-phase2-measure.ts --before` runs on the PRE-0201 schema.** Its core numbers reference neither `contact_groups.system_role` nor `contact_groups.partner_id`: system groups are identified by `contact_group_id IN ('drip-intake','drip-sandbox')`, drip partner×tag groups by `contact_group_id LIKE 'drip:%'`, in BOTH modes (one predicate). `--after` additionally asserts the post-0201 state. **The real prod output (read-only, run on 2026-10-09) is pasted in the Proposal section below.**
- **F3 — the link on drip partner×tag groups is locked.** For a group whose `contact_group_id LIKE 'drip:%'`, `PATCH … partner_id` → 409 `code: "drip_group"`, and the form shows the select read-only with "Set by the drip pipeline from the partner key — cannot be changed here." Only the pipeline (`ensurePartnerTagGroup`, 0201's backfill) sets it.
- **F4 — auto-link match is an exact prefix comparison:** `left(g.name, length(p.slug) + 1) = p.slug || '-'` (never `LIKE`: `_` is a LIKE wildcard and slugs allow it), longest matching slug wins, in 0201 and its test.
- **F5 — the Q6 exit check asserts the exact links** (`pml-aca` → partner slug `pml`, `bsd-untagged` → `bsd`), not a count. Form helper text: "Links this group's contacts to the partner for attribution. Reports update after a recalculation."
- **C2 (finished here):** `ALTER TABLE partner_keys ALTER COLUMN partner_id SET NOT NULL` is the FIRST statement of 0201 after `SET LOCAL lock_timeout`, behind a `DO $$` guard that raises if any NULL exists. Prod read **0 of 4 NULL** on 2026-10-09; Task 0 re-measures right before the apply.
- **C4:** the system drip groups are exempt from R3 via `contact_groups.system_role` (`'drip_intake'` / `'drip_sandbox'`), set by `ensureDripGroup` at creation and backfilled in 0201 by `contact_group_id IN ('drip-intake','drip-sandbox')` — never by hard-coded ids (113 / 114 in prod).
- **Q2:** `contact_contact_groups.created_at` is REWRITTEN to the lead's first delivery for drip partner×tag groups (by the script); enrichment stamps delivery time going forward. No `appeared_at` column.
- **Q3:** R3 uses strict `<`; R4 ties go to the lowest `contact_group_id` (Phase 3 resolver rules; the measurements here use the same strict `<`).
- **Q6:** drip `<slug>-<tag>` groups are auto-linked at creation; existing ones backfilled in 0201.
- **Q9:** changing a (non-drip) group's partner requires `partner_keys.manage`; `contact_groups.update` alone cannot.
- **Q12:** large-group recalcs are Phase 3's; here the link change only ENQUEUES a `partner_attribution_recalcs` row. No consumer yet.
- **Measured on prod 2026-10-09 (read-only; the exact script output is in the Proposal section):** pml-aca = group 311, 15,785 members, every member has a `lead_events` row; **8,171** stamped > 10 min after first delivery (the #311 backfill); **15,785** (all) stamped after delivery at all (enrichment stamps processing time, seconds later); max lag 1 h 23 m 38 s; **R3 count 73** (the recon's 63 was 2026-10-08 on 14,180 members — a live count that grows with intake; the repair cannot move it: 73 against the current stamps and against first delivery). The exit check is **"R3 count after == the count measured minutes before the repair == the count against first delivery"**, printed, not the constant 63. Drip groups: `113 drip-intake`, `114 drip-sandbox`, `311 drip:<org>:pml-aca`, `1129 drip:<org>:bsd-untagged`; partners `1 internal-test, 2 pml, 3 docs-curl-verify, 4 bsd`.
- Prod migration ledger is at **0200**; this phase's migration is **0201** (`when` 1794009600000). Hand-authored SQL + cloned snapshot + journal entry, as in Phase 1. (0202 stays free for Phase 3.)
- Prod `statement_timeout` is 120 s server-wide; the repair UPDATE touches ~15.8K rows of a 1.16M-row table through the PK — seconds (the preview rehearsal in Task 3 times it); 0201 is milliseconds.
- **Preview caveats (card 869fevxhb):** both Vercel projects run `db:migrate` on preview builds against the same preview DB (race); the preview DB had drifted on 0172 and was repaired by hand. Before trusting a preview failure, run drizzle-orm's `migrate()` directly to see the real error.
- Work in the throwaway worktree `.claude/worktrees/partners-phase2` (branch `feat/partners-phase2-plan` → the build continues on it), off `origin/main` `69a77635`; never touch the shared checkout's branch. `npm run check:guards` is a required CI check; a DB-writing script imports `./_require-preview-db` second, or is named in `EXCLUSIONS` with a reason.
- Docs are part of done: `docs/03-data-model.md` (+ ERD), `docs/04-features/partner-lead-intake.md`, `docs/04-features/drip-partner-reporting.md`, the contact-groups feature doc, `docs/07-conventions.md`, `docs/CHANGELOG.md` (CRLF).

---

## Proof: nothing on the send path or the audience snapshot reads `contact_contact_groups.created_at`

Grep at `origin/main` `69a77635`, every file under `lib/`, `app/`, `db/schema.ts` that references `contact_contact_groups` (34 files), and every read of its timestamp:

| file | what it reads from the junction |
|---|---|
| `lib/audience-snapshot.ts` | membership only (`ccg.contact_id = ANY(gids)` set building) |
| `lib/segment-rules-eval.ts` | membership only (`is_in_contact_group`) |
| `lib/audience/pools.ts`, `lib/audience/fresh-counts.ts`, `lib/audience-preview-reference/*` | membership only |
| `lib/sends/import-optout-attribution.ts` | INSERT membership (default stamp) |
| `lib/upload/audience-upload.ts`, `lib/drip/groups.ts`, `app/api/contacts/upload`, `app/api/contacts/bulk-apply-groups`, `app/api/contact-groups/[id]/contacts/add|remove`, `app/api/campaigns/[campaignId]/upload-contacts` | INSERT / DELETE membership (default stamp) |
| `lib/engagement/*`, `lib/reporting/grading.ts`, `lib/reporting/group-lifecycle.ts`, `lib/reporting/performance-report.ts`, `lib/reporting/rollup.ts`, `lib/telnyx/*`, `app/(protected)/offers/[id]/report/page.tsx` | membership only (which group a contact is in) |
| `app/api/contacts/list`, `app/api/contacts/[id]`, `app/(protected)/contacts/page.tsx`, `app/api/segments/[id]/*`, `app/api/contact-groups/list` | membership only |
| **`app/api/contact-groups/[id]/contacts/route.ts` lines 27, 80, 105** | **`contact_contact_groups.created_at AS joined_at`** — the group's Contacts tab "joined" column and its sort. The ONLY reader. |

`lib/sends/kickoff.ts`, `lib/sends/drain.ts`, `lib/sends/eligibility.ts`, `lib/campaign-tier.ts`, `lib/drip/scheduler.ts`, `lib/drip/send-one.ts`, `lib/drip/routing*.ts` do not reference the junction at all. `ccg.created_at`, `ccg2.created_at`, `contact_contact_groups.created_at` appear nowhere else. **Consequence:** the repair changes what the Contacts tab shows as "joined" for drip partner groups (delivery time instead of processing/backfill time — the intended meaning) and nothing else. Task 6 turns this grep into a guard so it stays true.

---

## Proposal numbers (prod, read-only)

Filled by Task 0 Step 2 with the verbatim output of `scripts/partners-phase2-measure.ts` run on 2026-10-09 against production on the pre-0201 schema. See the section at the end of this file: **"Measurement output 2026-10-09"**.

---

## File map

| file | change |
|---|---|
| `scripts/partners-phase2-measure.ts` | **create** — read-only prod measurement + exit check (`--before` on the pre-0201 schema, `--after` after the repair) |
| `db/migrations/0201_contact_group_partner_link.sql`, `db/migrations/meta/0201_snapshot.json`, `_journal.json` | **create / modify** |
| `db/schema.ts` | **modify** — `partner_keys.partner_id` notNull; `contact_groups.partner_id`, `contact_groups.system_role`; `partner_attribution_recalcs` |
| `scripts/repair-drip-membership-appearance.ts` | **create** — the Q2 repair: dry run / `--apply` / `--revert --apply`; idempotent, re-runnable (F1) |
| `scripts/test-preview-db-guard.ts` | **modify** — `EXCLUSIONS` gains the repair script with its reason |
| `scripts/_partner-fixture.ts` | **create** — `createPartnerWithKey()` for every script that inserts a key |
| 11 scripts: `test-drip-enrichment-schema`, `test-drip-geo-exclude-mode`, `test-drip-lifecycle`, `test-drip-routing-schema`, `test-drip-sends-schema`, `test-drip-unengaged-close`, `test-intake-hourly-db`, `test-intake-schema`, `test-registered-lane-consumers`, `verify-drip-enrichment-production`, `verify-drip-routing-production` | **modify** — use the fixture; `test-intake-schema` flips its "duplicate (org, partner_slug) ⇒ rejected" assertion (that index is gone since 0200 — the bar is RED on the preview today) |
| `lib/drip/groups.ts` | **modify** — `ensureDripGroup` sets `system_role`; `ensurePartnerTagGroup` takes `partnerId`; `addContactsToGroup` takes `createdAt` |
| `lib/drip/enrichment.ts` | **modify** — claim SELECT joins `partner_keys.partner_id`; the partner×tag membership is stamped `received_at` |
| `scripts/backfill-partner-tag-groups.ts` | **modify** — passes the partner id `ensurePartnerTagGroup` now requires |
| `lib/validators/contact-groups.ts` | **modify** — `partner_id` |
| `app/api/contact-groups/[id]/route.ts` | **modify** — `partner_keys.manage` gate, org/archived/system/drip checks, recalc row on change |
| `app/api/contact-groups/list/route.ts` | **modify** — `partner_id`, `partner_name`, `system_role` |
| `app/(protected)/contact-groups/page.tsx` | **modify** — Partner column |
| `app/(protected)/contact-groups/[id]/page.tsx` | **modify** — partner badge in the header; `partner_id` through the edit dialog |
| `components/contact-groups/contact-group-form.tsx` | **modify** — Partner `<Select>` (plain; read-only on drip groups) |
| `scripts/test-0201-group-partner-link-db.ts`, `scripts/test-drip-membership-repair-db.ts`, `scripts/test-drip-groups-stamping-db.ts`, `scripts/test-contact-group-partner-link-api.ts` | **create** — preview-only tests |
| `scripts/test-membership-timestamp-readers.ts` + `package.json` `check:guards` | **create / modify** — the proof as a guard |
| docs listed above | **modify** |

---

### Task 0: Measurement + exit-check script (read-only, prod; pre-0201 schema in `--before`)

**Files:**
- Create: `scripts/partners-phase2-measure.ts`

**Interfaces:**
- Produces: a read-only report. `--before` writes `%LOCALAPPDATA%/Temp/claude/partners-phase2-before.json` and touches NO post-0201 column; `--after` re-measures with the same core predicate, compares, and asserts the post-0201 state (links by slug, markers, backup) — exits non-zero on any mismatch. No flag: print only.

- [ ] **Step 1: Write the script**

```ts
// scripts/partners-phase2-measure.ts
import "./_env-preload";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Partner attribution Phase 2 — measurements and the exit check. READ-ONLY.
//
//   (no flag)  print the core numbers (safe on any schema)
//   --before   same, and write the baseline file — run on the PRE-0201 schema
//              right before the repair (F2: this mode references neither
//              contact_groups.system_role nor contact_groups.partner_id)
//   --after    after the repair: re-measure, compare, and assert the post-0201
//              state (exact links by slug, the markers, the backup table)
//
// ONE predicate for both modes: system groups are contact_group_id IN
// ('drip-intake','drip-sandbox'); drip partner×tag groups are
// contact_group_id LIKE 'drip:%'. The match between a membership and its lead
// events is the naming rule of lib/drip/groups.ts partnerTagGroupName, restated
// in SQL so this script does not import the code it is checking.
//
//   npx tsx --conditions=react-server scripts/partners-phase2-measure.ts [--before|--after]

const FILE = `${process.env.LOCALAPPDATA}/Temp/claude/partners-phase2-before.json`;
type M = Record<string, number | string | null>;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}

const MEMBERS = sql`
  SELECT ccg.contact_id, ccg.contact_group_id, g.name AS group_name, ccg.created_at AS stamped,
         (SELECT min(le.received_at) FROM lead_events le
           WHERE le.contact_id = ccg.contact_id AND le.sandbox = false
             AND lower(le.partner_slug) || '-' || coalesce(nullif(lower(trim(le.interest_tag)), ''), 'untagged') = g.name) AS first_received
  FROM contact_contact_groups ccg
  JOIN contact_groups g ON g.id = ccg.contact_group_id
  WHERE g.contact_group_id LIKE 'drip:%'`;

// R3 (strict <, ruling Q3): a membership in a group that is neither a system
// drip group nor a drip partner×tag group, stamped strictly before `at`.
const r3 = (at: ReturnType<typeof sql>) => sql`count(*) FILTER (WHERE EXISTS (
  SELECT 1 FROM contact_contact_groups o JOIN contact_groups og ON og.id = o.contact_group_id
  WHERE o.contact_id = m.contact_id AND o.contact_group_id <> m.contact_group_id
    AND og.contact_group_id NOT IN ('drip-intake', 'drip-sandbox') AND og.contact_group_id NOT LIKE 'drip:%'
    AND o.created_at < ${at}))::int`;

async function core(): Promise<M> {
  const r = (await db.execute(sql`
    WITH m AS (${MEMBERS})
    SELECT count(*)::int AS members,
           count(*) FILTER (WHERE first_received IS NULL)::int AS no_lead_event,
           count(*) FILTER (WHERE stamped > first_received + interval '10 minutes')::int AS lag_over_10m,
           count(*) FILTER (WHERE stamped > first_received)::int AS lag_positive,
           count(*) FILTER (WHERE stamped = first_received)::int AS stamped_at_delivery,
           count(*) FILTER (WHERE stamped < first_received)::int AS stamped_before_delivery,
           max(stamped - first_received)::text AS max_lag,
           ${r3(sql`m.stamped`)} AS r3_against_stamp,
           ${r3(sql`m.first_received`)} AS r3_against_delivery,
           (SELECT count(*) FROM partner_keys WHERE partner_id IS NULL)::int AS keys_null_partner,
           (SELECT string_agg(id || ':' || contact_group_id || ':' || name, ' | ' ORDER BY id) FROM contact_groups
             WHERE contact_group_id IN ('drip-intake', 'drip-sandbox') OR contact_group_id LIKE 'drip:%') AS drip_groups,
           (SELECT string_agg(id || ':' || slug, ',' ORDER BY id) FROM partners) AS partners
    FROM m
  `)) as unknown as M[];
  return r[0];
}

async function after(): Promise<M> {
  const r = (await db.execute(sql`
    SELECT (SELECT string_agg(g.name || '→' || coalesce(p.slug, 'null'), ',' ORDER BY g.name)
              FROM contact_groups g LEFT JOIN partners p ON p.id = g.partner_id
             WHERE g.contact_group_id LIKE 'drip:%') AS drip_links,
           (SELECT string_agg(contact_group_id || '=' || coalesce(system_role, 'null'), ',' ORDER BY contact_group_id)
              FROM contact_groups WHERE contact_group_id IN ('drip-intake', 'drip-sandbox')) AS markers,
           (SELECT count(*) FROM contact_groups WHERE system_role IS NOT NULL AND partner_id IS NOT NULL)::int AS system_with_partner,
           (SELECT count(*) FROM partner_attribution_recalcs)::int AS recalc_rows,
           (SELECT count(*) FROM drip_membership_stamp_backup)::int AS backup_rows,
           (SELECT count(*) FROM drip_membership_stamp_backup b
              JOIN contact_contact_groups c ON c.contact_id = b.contact_id AND c.contact_group_id = b.contact_group_id
             WHERE c.created_at <> b.new_created_at)::int AS backup_rows_not_applied
  `)) as unknown as M[];
  return r[0];
}

async function main() {
  const m = await core();
  for (const [k, v] of Object.entries(m)) console.log(`  ${k}: ${v}`);
  if (process.argv.includes("--before")) {
    writeFileSync(FILE, JSON.stringify(m, null, 2));
    console.log(`\nbaseline written (${FILE})`);
  } else if (process.argv.includes("--after")) {
    const b = JSON.parse(readFileSync(FILE, "utf-8")) as M;
    const a = await after();
    for (const [k, v] of Object.entries(a)) console.log(`  ${k}: ${v}`);
    console.log("\n── exit checks ──");
    check("0201 (C2): partner_keys.partner_id has 0 NULLs", m.keys_null_partner === 0);
    check("0201 (C4): drip-intake=drip_intake, drip-sandbox=drip_sandbox", a.markers === "drip-intake=drip_intake,drip-sandbox=drip_sandbox", String(a.markers));
    check("0201: no system group carries a partner", a.system_with_partner === 0);
    check("⭐ 0201 (Q6, F5): exact links — bsd-untagged→bsd, pml-aca→pml", a.drip_links === "bsd-untagged→bsd,pml-aca→pml", String(a.drip_links));
    check("⭐ repair: no drip partner×tag membership is stamped after delivery", m.lag_positive === 0, `lag_positive=${m.lag_positive}`);
    check("⭐ repair: every membership is stamped exactly at first delivery", m.stamped_at_delivery === m.members && m.stamped_before_delivery === 0, `${m.stamped_at_delivery}/${m.members}, before=${m.stamped_before_delivery}`);
    check("⭐ R3 count did NOT move (before == after == against delivery)",
      m.r3_against_stamp === b.r3_against_stamp && m.r3_against_stamp === m.r3_against_delivery && b.r3_against_stamp === b.r3_against_delivery,
      `before: stamp ${b.r3_against_stamp} / delivery ${b.r3_against_delivery}; after: stamp ${m.r3_against_stamp} / delivery ${m.r3_against_delivery}`);
    check("repair: backup rows ≥ the rows that were repairable before, and every backup row is applied",
      Number(a.backup_rows) >= Number(b.lag_positive) && a.backup_rows_not_applied === 0, `backup ${a.backup_rows} vs before lag_positive ${b.lag_positive}; not applied ${a.backup_rows_not_applied}`);
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    if (failures > 0) process.exitCode = 1;
  }
  await pgConn.end();
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
```

- [ ] **Step 2: Run it now (read-only, prod, no flag) and paste the verbatim output into the "Measurement output" section at the end of this file** — that is the Proposal's evidence (F2).
- [ ] **Step 3: Commit** `git add scripts/partners-phase2-measure.ts docs/superpowers/plans/2026-10-09-partners-phase2-group-link-plan.md && git commit -m "test(partners): phase 2 measurement + exit check (pre-0201 schema in --before); proposal numbers"`.

---

### Task 1: Migration 0201 — SET NOT NULL, group → partner link, system marker, recalc table

**Files:**
- Create: `db/migrations/0201_contact_group_partner_link.sql`, `db/migrations/meta/0201_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts`
- Test: `scripts/test-0201-group-partner-link-db.ts`

**Interfaces:**
- Produces: `partner_keys.partner_id NOT NULL`; `contact_groups.partner_id integer NULL → partners(id) ON DELETE RESTRICT`; `contact_groups.system_role text NULL CHECK IN ('drip_intake','drip_sandbox')`, with `CHECK (system_role IS NULL OR partner_id IS NULL)`; table `partner_attribution_recalcs(id bigserial, org_id, contact_group_id → contact_groups CASCADE, requested_at, requested_by, reason link|unlink|relink|manual, status queued|running|done|failed, campaigns_total, campaigns_done, started_at, finished_at, error)`; Drizzle exports `partner_attribution_recalcs`, `contact_groups.partner_id`, `contact_groups.system_role`.

- [ ] **Step 1: Write the failing test (preview DB; Part A catalog after the preview apply, Part B rolled back)**

```ts
// scripts/test-0201-group-partner-link-db.ts
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-0201-group-partner-link-db.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");
const pgMessage = (e: unknown) => (e as { cause?: Error }).cause?.message ?? (e as Error).message;

// The 0201 Q6 backfill statement, verbatim (F4: exact prefix, longest slug wins).
const AUTOLINK = sql`
  UPDATE contact_groups g SET partner_id = p.id FROM partners p
  WHERE g.org_id = p.org_id AND g.contact_group_id LIKE 'drip:%' AND g.partner_id IS NULL AND g.system_role IS NULL
    AND left(g.name, length(p.slug) + 1) = p.slug || '-'
    AND NOT EXISTS (SELECT 1 FROM partners p2 WHERE p2.org_id = g.org_id AND p2.id <> p.id
                      AND left(g.name, length(p2.slug) + 1) = p2.slug || '-' AND length(p2.slug) > length(p.slug))`;

async function main() {
  // ── A. catalog ──────────────────────────────────────────────────────────
  const nn = (await db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'partner_keys' AND column_name = 'partner_id'`)) as unknown as { is_nullable: string }[];
  check("A1 partner_keys.partner_id is NOT NULL (C2 done)", nn[0]?.is_nullable === "NO", JSON.stringify(nn[0]));
  const cols = (await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'contact_groups' AND column_name IN ('partner_id','system_role') ORDER BY 1`)) as unknown as { column_name: string }[];
  check("A2 contact_groups has partner_id + system_role", cols.map((c) => c.column_name).join(",") === "partner_id,system_role", JSON.stringify(cols));
  const idx = (await db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('contact_groups','partner_attribution_recalcs') ORDER BY 1`)) as unknown as { indexname: string; indexdef: string }[];
  check("A3 partial index contact_groups_org_partner_idx WHERE partner_id IS NOT NULL", idx.some((i) => i.indexname === "contact_groups_org_partner_idx" && /WHERE \(partner_id IS NOT NULL\)/.test(i.indexdef)), idx.map((i) => i.indexname).join(","));
  check("A4 recalc indexes exist", ["partner_attribution_recalcs_org_status_idx", "partner_attribution_recalcs_group_idx"].every((n) => idx.some((i) => i.indexname === n)));
  const marks = (await db.execute(sql`SELECT contact_group_id, system_role FROM contact_groups WHERE contact_group_id IN ('drip-intake','drip-sandbox') ORDER BY 1`)) as unknown as { contact_group_id: string; system_role: string | null }[];
  check("A5 (C4) drip-intake → drip_intake, drip-sandbox → drip_sandbox (for the groups that exist here)",
    marks.every((m) => (m.contact_group_id === "drip-intake" ? m.system_role === "drip_intake" : m.system_role === "drip_sandbox")), JSON.stringify(marks));
  const rls = (await db.execute(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'partner_attribution_recalcs'`)) as unknown as { relrowsecurity: boolean }[];
  check("A6 RLS on partner_attribution_recalcs", rls[0]?.relrowsecurity === true);

  // ── B. behaviour, rolled back ────────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      let notNull = false;
      await tx.execute(sql`SAVEPOINT s1`);
      try { await tx.execute(sql`INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash) VALUES (${orgId}::uuid, 'zz-nopartner', 'x', 'tok-zz-nopartner', 'h')`); }
      catch (e) { notNull = /null value in column "partner_id"/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`); }
      check("B1 a key without partner_id → 23502", notNull);

      const mk = async (slug: string) => ((await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, ${slug}, ${slug}) RETURNING id`)) as unknown as { id: number }[])[0].id;
      const pAb = await mk("zz-ab"); const pAbCd = await mk("zz-ab-cd"); const pOther = await mk("zz-other"); const pUnder = await mk("zz_u");
      const grp = async (key: string, name: string) =>
        ((await tx.execute(sql`INSERT INTO contact_groups (contact_group_id, org_id, name, status) VALUES (${key}, ${orgId}::uuid, ${name}, 'active') RETURNING id`)) as unknown as { id: number }[])[0].id;
      const g1 = await grp(`drip:${orgId}:zz-ab-cd-x`, "zz-ab-cd-x");
      const g2 = await grp(`drip:${orgId}:zz-ab-y`, "zz-ab-y");
      const g3 = await grp(`zz-manual-ab-z`, "zz-ab-z");           // not a drip key → never auto-linked
      const g4 = await grp(`drip:${orgId}:zz-ab-w`, "zz-ab-w");
      await tx.execute(sql`UPDATE contact_groups SET partner_id = ${pOther} WHERE id = ${g4}`); // operator's choice must survive
      const g5 = await grp(`drip:${orgId}:zzxu-t`, "zzxu-t");       // F4: 'zz_u' must NOT match 'zzxu-t' (underscore is not a wildcard here)
      const g6 = await grp(`drip:${orgId}:zz_u-t`, "zz_u-t");       // …but DOES match its own slug
      await tx.execute(AUTOLINK);
      const got = (await tx.execute(sql`SELECT id, partner_id FROM contact_groups WHERE id IN (${g1}, ${g2}, ${g3}, ${g4}, ${g5}, ${g6}) ORDER BY id`)) as unknown as { id: number; partner_id: number | null }[];
      check("B2 longest slug wins: zz-ab-cd-x → zz-ab-cd", got[0].partner_id === pAbCd, JSON.stringify(got));
      check("B2b zz-ab-y → zz-ab", got[1].partner_id === pAb);
      check("B2c a non-drip key is never auto-linked", got[2].partner_id === null);
      check("B2d an already-linked group keeps the operator's partner", got[3].partner_id === pOther);
      check("B2e (F4) 'zz_u' does not match 'zzxu-t' — exact prefix, not LIKE", got[4].partner_id === null);
      check("B2f (F4) 'zz_u' matches 'zz_u-t'", got[5].partner_id === pUnder);
      await tx.execute(AUTOLINK);
      const again = (await tx.execute(sql`SELECT partner_id FROM contact_groups WHERE id = ${g1}`)) as unknown as { partner_id: number }[];
      check("B2g idempotent", again[0].partner_id === pAbCd);

      let sysLinked = false;
      await tx.execute(sql`SAVEPOINT s2`);
      try { await tx.execute(sql`UPDATE contact_groups SET system_role = 'drip_intake', partner_id = ${pAb} WHERE id = ${g2}`); }
      catch (e) { sysLinked = /contact_groups_system_not_partner_check/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s2`); }
      check("B3 a system group cannot carry a partner (CHECK)", sysLinked);
      let badRole = false;
      await tx.execute(sql`SAVEPOINT s3`);
      try { await tx.execute(sql`UPDATE contact_groups SET system_role = 'other' WHERE id = ${g3}`); }
      catch (e) { badRole = /contact_groups_system_role_check/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s3`); }
      check("B3b system_role is constrained", badRole);
      let restrict = false;
      await tx.execute(sql`SAVEPOINT s4`);
      try { await tx.execute(sql`DELETE FROM partners WHERE id = ${pAbCd}`); }
      catch (e) { restrict = /violates foreign key constraint/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s4`); }
      check("B3c deleting a linked partner is RESTRICTed", restrict);

      const rc = (await tx.execute(sql`INSERT INTO partner_attribution_recalcs (org_id, contact_group_id, reason) VALUES (${orgId}::uuid, ${g1}, 'link') RETURNING status, campaigns_done`)) as unknown as { status: string; campaigns_done: number }[];
      check("B4 a recalc row starts queued with 0 done", rc[0].status === "queued" && rc[0].campaigns_done === 0, JSON.stringify(rc[0]));
      throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails** (`relation "partner_attribution_recalcs" does not exist` / A1 `is_nullable` YES).

- [ ] **Step 3: Write the migration**

```sql
-- db/migrations/0201_contact_group_partner_link.sql
-- Migration 0201: contact group → partner link (partner attribution Phase 2).
--
-- Leads the batch. The appearance repair is NOT here (owner fix F1): it is
-- scripts/repair-drip-membership-appearance.ts, run on its own go after the
-- enrichment code that stamps delivery time is deployed.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── C2, finished: partner_keys.partner_id becomes NOT NULL ──────────────────
-- Prod read 0 NULLs of 4 on 2026-10-09 after the 0200 backfill, and every code
-- path that inserts a key has written it since (#329). The guard makes the
-- apply fail loudly instead of SET NOT NULL failing on an opaque row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.partner_keys WHERE partner_id IS NULL) THEN
    RAISE EXCEPTION '0201: partner_keys.partner_id has NULL rows — assign them before SET NOT NULL';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE public.partner_keys ALTER COLUMN partner_id SET NOT NULL;
--> statement-breakpoint

-- ── R1: the link lives on the group ─────────────────────────────────────────
-- ⚠️ On a drip partner×tag group (contact_group_id LIKE 'drip:%') ONLY the
-- pipeline sets it (owner fix F3): ensurePartnerTagGroup at creation, and the
-- backfill below. The group screen shows it read-only there.
ALTER TABLE public.contact_groups
  ADD COLUMN partner_id integer REFERENCES public.partners(id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE INDEX contact_groups_org_partner_idx
  ON public.contact_groups (org_id, partner_id) WHERE partner_id IS NOT NULL;
--> statement-breakpoint

-- ── C4: the system drip groups carry an explicit marker, never a hard-coded id
ALTER TABLE public.contact_groups ADD COLUMN system_role text;
--> statement-breakpoint

ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_system_role_check
  CHECK (system_role IS NULL OR system_role IN ('drip_intake', 'drip_sandbox'));
--> statement-breakpoint

-- A pipeline artifact is not an acquisition source: it can never be a partner entry.
ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_system_not_partner_check
  CHECK (system_role IS NULL OR partner_id IS NULL);
--> statement-breakpoint

UPDATE public.contact_groups
SET system_role = CASE contact_group_id WHEN 'drip-intake' THEN 'drip_intake' ELSE 'drip_sandbox' END
WHERE contact_group_id IN ('drip-intake', 'drip-sandbox') AND system_role IS NULL;
--> statement-breakpoint

-- ── Q6: link the existing drip partner×tag groups to their partner ──────────
-- The group name is partnerTagGroupName(slug, tag) = '<slug>-<tag>'. Exact
-- prefix comparison (F4): `_` is a LIKE wildcard and slugs allow it. Slugs may
-- contain '-', so the LONGEST matching slug in the org wins ('ab-cd-x' belongs
-- to 'ab-cd', not 'ab'). Idempotent: partner_id IS NULL only. Prod (F5 exit
-- check asserts exactly these): pml-aca → pml, bsd-untagged → bsd.
UPDATE public.contact_groups g
SET partner_id = p.id
FROM public.partners p
WHERE g.org_id = p.org_id
  AND g.contact_group_id LIKE 'drip:%'
  AND g.partner_id IS NULL AND g.system_role IS NULL
  AND left(g.name, length(p.slug) + 1) = p.slug || '-'
  AND NOT EXISTS (
    SELECT 1 FROM public.partners p2
    WHERE p2.org_id = g.org_id AND p2.id <> p.id
      AND left(g.name, length(p2.slug) + 1) = p2.slug || '-'
      AND length(p2.slug) > length(p.slug));
--> statement-breakpoint

-- ── §5.3: the recalc job table (consumed by Phase 3's cron; written from Phase 2's PATCH)
CREATE TABLE public.partner_attribution_recalcs (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_group_id integer NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  requested_by     uuid,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'queued',
  campaigns_total  integer,
  campaigns_done   integer NOT NULL DEFAULT 0,
  started_at       timestamptz,
  finished_at      timestamptz,
  error            text,
  CONSTRAINT partner_attribution_recalcs_reason_check CHECK (reason IN ('link', 'unlink', 'relink', 'manual')),
  CONSTRAINT partner_attribution_recalcs_status_check CHECK (status IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint

CREATE INDEX partner_attribution_recalcs_org_status_idx
  ON public.partner_attribution_recalcs (org_id, status, requested_at);
--> statement-breakpoint

CREATE INDEX partner_attribution_recalcs_group_idx
  ON public.partner_attribution_recalcs (contact_group_id);
--> statement-breakpoint

ALTER TABLE public.partner_attribution_recalcs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partner_attribution_recalcs_select_own_org"
  ON public.partner_attribution_recalcs FOR SELECT
  USING (org_id = public.current_org_id());
```

- [ ] **Step 4: `db/schema.ts`** — in `partner_keys`: `partner_id: integer("partner_id").notNull().references(() => partners.id, { onDelete: "restrict" })`. In `contact_groups`: add `partner_id: integer("partner_id").references(() => partners.id, { onDelete: "restrict" })`, `system_role: text("system_role")`, index `contact_groups_org_partner_idx` on `(org_id, partner_id)` `.where(sql\`${table.partner_id} IS NOT NULL\`)`, checks `contact_groups_system_role_check`, `contact_groups_system_not_partner_check`. New table `partner_attribution_recalcs` (`bigserial("id", { mode: "number" }).primaryKey()` + the columns above, its two indexes and two checks). `partners` is declared after `contact_groups` in the file today — the `references(() => partners.id)` arrow is lazy, so no reordering is needed; add a one-line comment saying so.

- [ ] **Step 5: Snapshot + journal** — clone `0200_snapshot.json` → `0201_snapshot.json` (`id` `0201a000-0201-4201-8201-000000000201`, `prevId` = 0200's id); `partner_keys.columns.partner_id.notNull = true`; `contact_groups`: + columns, + fk `contact_groups_partner_id_partners_id_fk` (restrict), + index with `where`, + the two checkConstraints; + table `public.partner_attribution_recalcs` (two fks, two indexes, two checks, policy, `isRLSEnabled: true`). Journal: `{ "idx": 201, "version": "7", "when": 1794009600000, "tag": "0201_contact_group_partner_link", "breakpoints": true }`.

- [ ] **Step 6: `npx tsc --noEmit`**, push the draft PR so the preview applies 0201, run Step 1's test → `All checks passed.`; `DATABASE_URL=<preview> npx tsx scripts/verify-migration-integrity.ts` → OK.

- [ ] **Step 7: Commit** `git commit -m "feat(partners): migration 0201 — SET NOT NULL (C2), contact_groups.partner_id + system_role (C4), Q6 auto-link backfill (exact prefix), recalc job table"`.

---

### Task 2: The shared partner fixture, and the 11 scripts that insert keys

**Files:**
- Create: `scripts/_partner-fixture.ts`
- Modify: the 11 scripts in the file map (each `INSERT INTO partner_keys (…)` → `createPartnerWithKey(tx, …)`), plus `scripts/test-intake-schema.ts` lines 146–148.

**Interfaces:**

```ts
// scripts/_partner-fixture.ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/intake/partner-key";

// Since 0200 a key belongs to a partner and since 0201 that is NOT NULL, so a
// fixture that inserts a key must create (or reuse) its partner first. One
// helper, so the 11 scripts cannot drift on the column list again.
export async function createPartnerWithKey(
  tx: DbOrTx,
  o: {
    orgId: string; slug: string; name?: string; token?: string; secretHash?: string;
    sandbox?: boolean; status?: "active" | "disabled";
    interestTagMode?: "force" | "default"; interestTag?: string | null;
    ratePerSec?: number; ratePerDay?: number; maxPayloadBytes?: number;
  },
): Promise<{ partnerId: number; keyId: number; token: string }> {
  const p = (await tx.execute(sql`
    INSERT INTO partners (org_id, slug, name) VALUES (${o.orgId}::uuid, ${o.slug}, ${o.name ?? o.slug})
    ON CONFLICT (org_id, slug) DO UPDATE SET name = partners.name
    RETURNING id`)) as unknown as { id: number }[];
  const token = o.token ?? `tok-${o.slug}-${Math.random().toString(36).slice(2, 8)}`;
  const k = (await tx.execute(sql`
    INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, sandbox, status,
                              interest_tag_mode, interest_tag, rate_per_sec, rate_per_day, max_payload_bytes)
    VALUES (${o.orgId}::uuid, ${p[0].id}, ${o.slug}, ${o.name ?? o.slug}, ${token}, ${o.secretHash ?? "h"},
            ${o.sandbox ?? true}, ${o.status ?? "active"}, ${o.interestTagMode ?? "default"}, ${o.interestTag ?? null},
            ${o.ratePerSec ?? 10}, ${o.ratePerDay ?? 50000}, ${o.maxPayloadBytes ?? 262144})
    RETURNING id`)) as unknown as { id: number }[];
  return { partnerId: p[0].id, keyId: k[0].id, token };
}
```

- [ ] **Step 1:** write the helper; replace each direct insert (`grep -n "INSERT INTO partner_keys" scripts/` lists all sites in the 11 files; `test-intake-schema.ts`'s five *rejection* probes keep inserting directly — they test CHECKs — with `partner_id` added to their column list from the fixture's returned `partnerId`).
- [ ] **Step 2:** `test-intake-schema.ts` 146–148: replace `expectReject(… "duplicate (org, partner_slug) ⇒ rejected" … "23505")` with an insert of a SECOND key under the same partner + `check("two keys of one partner share the slug (0200)", …)`.
- [ ] **Step 3:** on the preview (0201 applied): run the 9 preview-only scripts → all green. The two `verify-*-production` scripts are prod-writing probes (in `EXCLUSIONS`) — edit, type-check, do NOT run.
- [ ] **Step 4: Commit** `git commit -m "test(partners): shared partner fixture for every key-inserting script; slug-uniqueness assertion flipped (0200)"`.

---

### Task 3: The appearance repair script (F1) — dry run, apply, revert; idempotent and re-runnable

**Files:**
- Create: `scripts/repair-drip-membership-appearance.ts`
- Modify: `scripts/test-preview-db-guard.ts` (`EXCLUSIONS` entry: `{ file: "repair-drip-membership-appearance.ts", reason: "Phase 2 Q2 data repair; writes prod on the owner's go, dry-run by default, backs up every stamp it changes" }`)
- Test: `scripts/test-drip-membership-repair-db.ts` (preview, rolled back)

**The script (exact):**

```ts
// scripts/repair-drip-membership-appearance.ts
import "./_env-preload";
import { sql, type SQL } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";

// Appearance = delivery (ruling Q2) for drip partner×tag memberships — the
// Phase 2 data repair. PRODUCTION-WRITING ON PURPOSE (owner fix F1: a script,
// not a migration; listed in scripts/test-preview-db-guard.ts EXCLUSIONS).
//
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts              dry run: prints the counts, writes nothing
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts --apply      fills the backup, then updates
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts --revert --apply   restores every backed-up stamp
//
// Why: the #311 backfill stamped 8,171 pml-aca memberships up to 1 h 24 m after
// the lead arrived, and enrichment stamped processing time (seconds after) for
// every other one — 15,785 of 15,785 on 2026-10-09. R4 reads "appeared" off
// this stamp, so it must carry the lead's FIRST DELIVERY from that partner×tag.
//
// Scope: memberships of groups keyed 'drip:%' that are not the system groups
// ('drip-intake' / 'drip-sandbox' by key — no dependency on 0201's marker),
// stamped later than the first matching lead_events.received_at. The match is
// the naming rule of lib/drip/groups.ts partnerTagGroupName, restated in SQL.
//
// Re-runnable: the backup takes ON CONFLICT DO NOTHING (an old_created_at is
// never overwritten), the UPDATE touches only rows still stamped after their
// delivery, so a later run appends the rows that arrived meanwhile and changes
// nothing it already fixed. Runs on prod only AFTER the enrichment code that
// stamps delivery time is deployed and one fresh pml lead is confirmed stamped
// at received_at — otherwise new leads keep arriving late-stamped.

export const BACKUP = "drip_membership_stamp_backup";

/** Membership → first delivery for exactly that partner×tag group. */
export const FIRST_DELIVERY: SQL = sql`
  SELECT ccg2.contact_id, ccg2.contact_group_id, min(le.received_at) AS first_received
  FROM contact_contact_groups ccg2
  JOIN contact_groups g ON g.id = ccg2.contact_group_id
   AND g.contact_group_id LIKE 'drip:%'
   AND g.contact_group_id NOT IN ('drip-intake', 'drip-sandbox')
  JOIN lead_events le ON le.contact_id = ccg2.contact_id AND le.sandbox = false
   AND lower(le.partner_slug) || '-' || coalesce(nullif(lower(trim(le.interest_tag)), ''), 'untagged') = g.name
  GROUP BY 1, 2`;

export interface Counts { rows_to_repair: number; backfilled_rows: number; max_lag: string | null }

/** The before/after count query. */
export async function countRepairable(dbc: DbOrTx): Promise<Counts> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS rows_to_repair,
           count(*) FILTER (WHERE ccg.created_at > fr.first_received + interval '10 minutes')::int AS backfilled_rows,
           max(ccg.created_at - fr.first_received)::text AS max_lag
    FROM contact_contact_groups ccg
    JOIN (${FIRST_DELIVERY}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received`)) as unknown as Counts[];
  return r[0];
}

/** Fill the backup (append-only), then repair. Returns what each step touched. */
export async function repair(dbc: DbOrTx): Promise<{ backed_up_new: number; updated: number }> {
  await dbc.execute(sql`
    CREATE TABLE IF NOT EXISTS public.drip_membership_stamp_backup (
      contact_id       uuid NOT NULL,
      contact_group_id integer NOT NULL,
      old_created_at   timestamptz NOT NULL,
      new_created_at   timestamptz NOT NULL,
      backed_up_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contact_id, contact_group_id))`);
  await dbc.execute(sql`ALTER TABLE public.drip_membership_stamp_backup ENABLE ROW LEVEL SECURITY`);
  const b = (await dbc.execute(sql`
    INSERT INTO public.drip_membership_stamp_backup (contact_id, contact_group_id, old_created_at, new_created_at)
    SELECT ccg.contact_id, ccg.contact_group_id, ccg.created_at, fr.first_received
    FROM contact_contact_groups ccg
    JOIN (${FIRST_DELIVERY}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received
    ON CONFLICT (contact_id, contact_group_id) DO NOTHING
    RETURNING contact_id`)) as unknown as unknown[];
  const u = (await dbc.execute(sql`
    UPDATE contact_contact_groups ccg
    SET created_at = b.new_created_at
    FROM public.drip_membership_stamp_backup b
    WHERE b.contact_id = ccg.contact_id AND b.contact_group_id = ccg.contact_group_id
      AND ccg.created_at > b.new_created_at
    RETURNING ccg.contact_id`)) as unknown as unknown[];
  return { backed_up_new: b.length, updated: u.length };
}

/** Restore every backed-up stamp. The backup table is kept (dropped only on the owner's say-so). */
export async function revert(dbc: DbOrTx): Promise<number> {
  const r = (await dbc.execute(sql`
    UPDATE contact_contact_groups ccg
    SET created_at = b.old_created_at
    FROM public.drip_membership_stamp_backup b
    WHERE b.contact_id = ccg.contact_id AND b.contact_group_id = ccg.contact_group_id
    RETURNING ccg.contact_id`)) as unknown as unknown[];
  return r.length;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const doRevert = process.argv.includes("--revert");
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}   mode: ${doRevert ? "REVERT" : "repair"}${apply ? " (APPLY)" : " (dry run)"}`);
  const before = await countRepairable(db);
  console.log(`before: rows_to_repair=${before.rows_to_repair} backfilled_rows(>10 min)=${before.backfilled_rows} max_lag=${before.max_lag}`);
  if (!apply) { console.log("dry run — nothing written. Re-run with --apply."); await pgConn.end(); return; }
  if (doRevert) {
    const n = await revert(db);
    const after = await countRepairable(db);
    console.log(`reverted ${n} stamp(s); now rows_to_repair=${after.rows_to_repair}`);
  } else {
    const t0 = Date.now();
    const r = await db.transaction((tx) => repair(tx));
    const after = await countRepairable(db);
    console.log(`backed up ${r.backed_up_new} new row(s), updated ${r.updated} in ${Date.now() - t0} ms; now rows_to_repair=${after.rows_to_repair} (expect 0)`);
    if (after.rows_to_repair !== 0) process.exitCode = 1;
  }
  await pgConn.end();
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
```

**Before / after (the same `countRepairable` query, by hand):** before (2026-10-09): `rows_to_repair 15785 | backfilled_rows 8171 | max_lag 01:23:38`; after `--apply`: `0 | 0 | NULL`; `SELECT count(*) FROM drip_membership_stamp_backup` == the before `rows_to_repair` (plus any rows that arrived late-stamped between the deploy and the run — there should be none once enrichment stamps delivery time, which is why the fresh-lead confirmation precedes the run).

**Revert:** `--revert --apply` runs the `revert()` statement above (`UPDATE … SET created_at = b.old_created_at FROM drip_membership_stamp_backup b …`); verify with the count query (`rows_to_repair` returns to the before number); `DROP TABLE drip_membership_stamp_backup` only after the owner confirms.

- [ ] **Step 1: Write the failing test** (`scripts/test-drip-membership-repair-db.ts`, preview, ONE rolled-back transaction that imports `countRepairable`, `repair`, `revert`): seed partner `zz-rep` + key, group `drip:<org>:zz-rep-aca` (name `zz-rep-aca`), contact A with a `lead_events` row at T0 and a membership stamped T0 + 50 min; contact B with a membership stamped exactly T0 (its own lead event at T0); contact C in a group whose key is `drip-intake` (system) with a late stamp; contact D whose lead events are under slug `zz_rep` (underscore) — must not match `zz-rep-aca`. Assert: `countRepairable` = 1 before; `repair()` → `{ backed_up_new: 1, updated: 1 }`; A's stamp == T0; B, C, D untouched; the backup holds one row with `old_created_at = T0 + 50 min`; `repair()` again → `{ 0, 0 }` (idempotent); add contact E late-stamped → `repair()` → `{ 1, 1 }` and the backup has 2 rows with A's `old_created_at` unchanged (append-only); `revert()` → 2, A and E back to their old stamps; `countRepairable` = 2 again. Everything rolls back (the backup table too — it is created inside the transaction).
- [ ] **Step 2:** run → fails (module not found).
- [ ] **Step 3:** write the script + the `EXCLUSIONS` entry; `npm run check:guards` → green.
- [ ] **Step 4:** run the test → `All checks passed.`; note the preview timing of `repair()` on the seeded rows. Run the DRY RUN against prod (read-only) and paste its line into the Gate B proposal.
- [ ] **Step 5: Commit** `git commit -m "feat(drip): appearance repair script — drip partner×tag memberships dated at first delivery (Q2), dry-run/apply/revert, append-only backup"`.

---

### Task 4: Enrichment stamps delivery time; group helpers set the link and the marker

**Files:**
- Modify: `lib/drip/groups.ts`, `lib/drip/enrichment.ts`, `scripts/backfill-partner-tag-groups.ts`
- Test: `scripts/test-drip-groups-stamping-db.ts`

**Interfaces:**
- `ensureDripGroup(dbc, { orgId, sandbox })` — unchanged signature; the INSERT adds `system_role` and `ON CONFLICT (contact_group_id) DO UPDATE SET system_role = EXCLUDED.system_role` (heals a pre-0201 row).
- `ensurePartnerTagGroup(dbc, { orgId, partnerSlug, interestTag, partnerId })` — `partnerId: number` (NOT optional — an optional field hides the call sites nobody updated); INSERT sets `partner_id`; `ON CONFLICT … DO UPDATE SET partner_id = COALESCE(contact_groups.partner_id, EXCLUDED.partner_id)`.
- `addContactsToGroup(dbc, { orgId, groupId, contactIds, createdAt? })` — `createdAt?: Date | string`; when given, every VALUES row carries it; `ON CONFLICT DO NOTHING` keeps the first delivery.
- `lib/drip/enrichment.ts`: the claim SELECT joins `partner_keys k ON k.id = li.partner_key_id` and selects `k.partner_id`; the partner×tag call passes `partnerId: row.partner_id` and `createdAt: row.received_at`; the system-group membership keeps `now()`.

- [ ] **Step 1: Write the failing test** (preview, rolled back): `ensureDripGroup` twice → one row, `system_role` set; `ensurePartnerTagGroup` with partner A → `partner_id = A`; again with partner B → still A; `addContactsToGroup` with `createdAt = T0` → `created_at = T0`; again with `createdAt = T0 + 1h` → still T0; then the real enrichment path on a seeded `lead_inbox` row with `received_at = T0` (call the batch function the way `scripts/test-drip-enrichment-schema.ts` does) → the partner×tag membership's `created_at` == T0 to the microsecond, the `drip-intake` membership's is not T0, the group's `partner_id` is the key's partner.
- [ ] **Step 2:** run → fails on `system_role` / `partner_id` / the stamp.
- [ ] **Step 3:** implement; `npx tsc --noEmit` enumerates every `ensurePartnerTagGroup` call site (enrichment + `scripts/backfill-partner-tag-groups.ts`).
- [ ] **Step 4:** run → passes; `scripts/test-drip-enrichment-schema.ts` (preview) still green.
- [ ] **Step 5: Commit** `git commit -m "feat(drip): partner×tag membership stamped at delivery; groups carry the partner link and the system marker at creation (Q2, Q6, C4)"`.

---

### Task 5: The group screen — Partner select, list column, header badge, PATCH gate

**Files:**
- Modify: `lib/validators/contact-groups.ts`, `app/api/contact-groups/[id]/route.ts`, `app/api/contact-groups/list/route.ts`, `app/(protected)/contact-groups/page.tsx`, `app/(protected)/contact-groups/[id]/page.tsx`, `components/contact-groups/contact-group-form.tsx`
- Test: `scripts/test-contact-group-partner-link-api.ts` (preview deployment, throwaway owner — the Phase 1 `test-partners-api.ts` recipe), visual check on the preview.

**Rules:**
- `partner_id: z.number().int().positive().nullable().optional()` on create and update.
- PATCH: when `partner_id` is in the payload → `can(role, "partner_keys.manage")` else 403 (Q9) — the same shape as the `touchesLifecycle` gate; the group's `contact_group_id LIKE 'drip:%'` → 409 `code: "drip_group"` (**F3**, even for an owner, even when the value is unchanged); a group with `system_role` set → 409 `code: "system_group"`; the partner must be in the org (404) and active (409 `partner_archived`); when the stored value changes → in the SAME transaction insert `partner_attribution_recalcs (org_id, contact_group_id, requested_by, reason)` with `reason` = `'link'` (null → id), `'unlink'` (id → null) or `'relink'` (id → other id). Linking an **archived group** is allowed (history is the point).
- List API: `partner_id`, `partner_name` (LEFT JOIN `partners`), `system_role`; list page: a **Partner** column (name; `system` badge for a system group; `drip` chip on `drip:%` groups).
- Detail header: a `Handshake` badge with the partner's name when linked; "System group" badge when `system_role` is set.
- Form: a plain `<Select>` "Partner" with "No partner" + active partners from `GET /api/partners` (fetched only when `can("partner_keys.view")`); disabled with a hint when the viewer lacks `partner_keys.manage`; on a drip partner×tag group the select is **read-only** with "Set by the drip pipeline from the partner key — cannot be changed here." (**F3**); hidden with "System group — cannot be linked" when `system_role` is set. Helper text (**F5**): "Links this group's contacts to the partner for attribution. Reports update after a recalculation."

- [ ] **Step 1: Write the API test** (fixtures: partners `zz-link`, `zz-link-2`, an archived partner, a plain group, a drip group keyed `drip:<org>:zz-link-aca` with `partner_id` set by SQL, a system group seeded by SQL): PATCH `{partner_id}` as owner on the plain group → 200 + 1 recalc row `link`; to the other partner → `relink`; `null` → `unlink`; on the drip group → 409 `drip_group` (also with the same value it already has); on the system group → 409 `system_group`; to the archived partner → 409 `partner_archived`; a partner id from another org → 404; GET list → `partner_name` on the linked row and on the drip row; as an **operator** (demote the throwaway membership) → PATCH `{partner_id}` → 403 while PATCH `{description}` → 200. Teardown by id.
- [ ] **Step 2:** run → fails (400 unknown field).
- [ ] **Step 3:** implement validators → route → list API → UI.
- [ ] **Step 4:** `tsc`, `eslint`, the API test → green; visual: `/contact-groups` with the Partner column, `/contact-groups/[id]` header badge, the Edit dialog's Partner select on a plain group and read-only on a drip group. Screenshots → card 869fem8bq.
- [ ] **Step 5: Commit** `git commit -m "feat(contact-groups): partner link on the group — select behind partner_keys.manage, locked on drip groups, Partner column, header badge, recalc row on change (R1, Q9, Q12, F3)"`.

---

### Task 6: The proof as a guard — nothing reads the membership timestamp but the Contacts tab

**Files:**
- Create: `scripts/test-membership-timestamp-readers.ts`
- Modify: `package.json` (`check:guards` gains `&& tsx scripts/test-membership-timestamp-readers.ts`)

- [ ] **Step 1: Write the guard**

```ts
// scripts/test-membership-timestamp-readers.ts
// contact_contact_groups.created_at MEANS "appeared" (appearance = delivery for
// drip partner groups since the Phase 2 repair), and Phase 3's resolver reads it
// for R3/R4. Nothing on the send path or in the audience snapshot may read it:
// a reader there would make a membership stamp change the audience, and the
// repair rewrote 15,785 of them. This bar enumerates every reader from the
// filesystem (docs/07-conventions.md: a list of "files I think read it" only
// tests the author's imagination) and allows exactly the known ones.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOTS = ["lib", "app", "db"];
const ALLOWED = new Set([
  "app/api/contact-groups/[id]/contacts/route.ts", // the group's Contacts tab: "joined" column + sort
  // Phase 3 adds: lib/partners/attribution-resolver.ts
]);
const JUNCTION = /contact_contact_groups/;
const READS_STAMP = /\bccg\w*\.created_at\b|contact_contact_groups\.created_at|"contact_contact_groups"\."created_at"|contactContactGroups\.created_at/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

let failed = 0;
const hits: string[] = [];
for (const root of ROOTS) {
  for (const f of walk(resolve(process.cwd(), root))) {
    const src = readFileSync(f, "utf-8");
    if (!JUNCTION.test(src) || !READS_STAMP.test(src)) continue;
    const rel = relative(process.cwd(), f).split(sep).join("/");
    if (!ALLOWED.has(rel)) { failed++; hits.push(rel); }
  }
}
console.log(hits.length ? `✗ unallowed readers of contact_contact_groups.created_at:\n  ${hits.join("\n  ")}` : "✓ no reader of contact_contact_groups.created_at outside the allowlist");
const allowedSrc = readFileSync(resolve(process.cwd(), "app/api/contact-groups/[id]/contacts/route.ts"), "utf-8");
const control1 = READS_STAMP.test("select ccg.created_at as joined_at from contact_contact_groups ccg");
const control2 = READS_STAMP.test(allowedSrc) && JUNCTION.test(allowedSrc);
if (!control1 || !control2) failed++;
console.log(`${control1 ? "✓" : "✗"} control: a synthetic reader is flagged`);
console.log(`${control2 ? "✓" : "✗"} control: the allowed file is a real reader (the scan is not blind)`);
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2:** run → passes on the current tree; add it to `check:guards`; `npm run check:guards` → green.
- [ ] **Step 3: Commit** `git commit -m "test(guards): no reader of contact_contact_groups.created_at outside the Contacts tab"`.

---

### Task 7: Docs

- `docs/03-data-model.md`: `partner_keys.partner_id` NOT NULL (0201); `contact_groups.partner_id` (RESTRICT, partial index; locked on drip groups), `system_role` + both CHECKs; `partner_attribution_recalcs`; `drip_membership_stamp_backup` as a script artifact (revert source, RLS on, append-only, dropped later on approval); ERD: `partners ||--o{ contact_groups : "attribution link (0201)"`, `contact_groups ||--o{ partner_attribution_recalcs`.
- `docs/04-features/partner-lead-intake.md`: enrichment stamps the partner×tag membership at `received_at`; the system groups' marker; auto-link at creation; the repair script and its gating.
- The contact-groups feature doc: the Partner link (who may set it, locked on drip groups, archived groups allowed, system groups never, what a change queues), the Partner column.
- `docs/04-features/drip-partner-reporting.md`: a one-line pointer (no report change in this phase).
- `docs/07-conventions.md`: **"contact_contact_groups.created_at means APPEARED"** — appearance = delivery for drip partner groups, the Contacts tab is the only reader, the guard; "R3 count is a live number" (63 on 10-08 → 73 on 10-09: measure before and after, assert equality, never a constant); the C4 marker rule (never hard-code 113/114); the exact-prefix longest-slug auto-link rule (F4); "a data repair of a hot table is a dry-run-first, append-only-backup script, not a migration" (F1). Update "Last updated".
- `docs/CHANGELOG.md`: one line, newest-first, CRLF.
- `npm run check:docs` → green. Commit.

---

### Task 8: Ship — two gates

- [ ] **Step 1: Green on the PR** (`tsc`, `eslint`, `check:docs`, `check:guards` incl. the new guard, route-map coverage, the preview tests of Tasks 1–5, `verify-migration-integrity` on the preview, the 9 preview-only scripts of Task 2). PR title: `feat(partners): group → partner link, SET NOT NULL, enrichment stamps delivery, appearance-repair script (0201, Phase 2 of partner attribution)`; body with the audit table, the measurement output, the dry-run line, the revert, the rollback target.
- [ ] **Step 2: STOP — Gate A proposal on card 869fem8bq:** 0201 only (schema; ms on 4 keys + 26 groups); the measurement output (`--before` of that morning, pre-0201 schema); that the repair is NOT in it. **Wait for the owner's go.**
- [ ] **Step 3: Apply 0201 (attended, before 12:00 UTC):** `partners-phase2-measure.ts --before` → `npm run db:migrate` (pending list exactly `0201…`) → verify by QUERY: `partner_keys.partner_id` NOT NULL; `system_role` on 113/114; `pml-aca → pml`, `bsd-untagged → bsd` (by slug); `partner_attribution_recalcs` exists; ledger max `when` = 1794009600000 with one 0201 row → `verify-migration-integrity.ts` OK. Any mismatch → STOP before the merge, report.
- [ ] **Step 4: Merge, deploy** (prod deployment on the merge sha, state success).
- [ ] **Step 5: Confirm the enrichment stamp on a fresh lead:** wait for the next real pml lead (`SELECT ccg.created_at = le.received_at … ORDER BY le.received_at DESC LIMIT 1` on a lead received after the deploy) → `true`. Also the group screen on prod: pml-aca shows partner pml read-only, the system groups show the marker; Phase 1 proofs still pass.
- [ ] **Step 6: STOP — Gate B proposal:** the dry-run lines from prod that morning (`rows_to_repair`, `backfilled_rows`, `max_lag`, `rows_in_backup`, `R3` per group — the owner's three numbers: rows to repair, rows already in backup, R3 before), the fresh-lead confirmation, the exact `--apply` command, the revert command, "R3 before == after" as the exit check with the live numbers. **Wait for the owner's go.**
  - **Scope note (owner question, 2026-10-09 15:31 UTC, read-only):** the repair scope is every drip partner×tag membership stamped strictly after its first delivery, not only the 8,171 the recon counted. Prod breakdown of `rows_to_repair` = 16,813 at 15:31:
    | group | rows | lag | stamped |
    |---|---|---|---|
    | pml-aca | **8,171** | 47 m 04 s – 1 h 23 m 39 s (median 1 h 07 m) | ALL at one instant, 2026-10-06 22:42:00.93 UTC — the #311 backfill |
    | pml-aca | **8,626** | 2.6 s – 5 m 12 s (8,582 of them 1–5 min; median 2 m 05 s, p95 2 m 59 s) | one per enrichment cron tick (`:18` of every minute) from 2026-10-07 14:02 UTC to now — the live path stamps the tick that processed the lead, not `received_at` |
    | bsd-untagged | 16 | 1 m 30 s – 2 m 14 s | one tick, 2026-10-08 22:58:18 UTC — bsd key 81's real leads |
    Why they are in scope: ruling Q2 makes `created_at` mean *appeared = delivered*; the 10-08 recon measured only the backfill's lag (vs the "Drip intake" stamp), and the 10-09 measurement found the live path late too (`stamped_at_delivery` 0 of 16,813), so the plan widened the predicate to `created_at > first_received` and the exit check to "every stamp == first delivery". **What `--apply` touches = `rows_to_repair` on the morning of the run** (all three rows above, growing by one per late-stamped lead until the gate A deploy makes new stamps exact; 16,722 at 15:25, 16,813 at 15:31). R3 is identical against the current stamps and against delivery (80/80 at 15:32), so neither scope moves R3. **Alternative if the owner wants the Q2-literal 8,171:** add `AND ccg.created_at > fr.first_received + interval '10 minutes'` to `countRepairable`/`repair` (one line each) and relax the `--after` check to "no stamp more than 10 min late" — the 8,642 tick-stamped rows then keep a 1–5 min lag forever while rows after the deploy are exact (two meanings for one column). Recommendation: full scope.
- [ ] **Step 7: Run the repair (attended, before 12:00 UTC):** `partners-phase2-measure.ts --before` (fresh baseline, minutes before) → `repair-drip-membership-appearance.ts` (dry run, read the counts) → `--apply` (one transaction per group — pml-aca, bsd-untagged, pml-medicare — backup then update; owner requirement 2026-10-10, and the proposal must quote the dry run's runtime, that both scripts carry the `le.org_id = g.org_id` index predicate, and fresh-lead proof for BOTH pml groups) → the script's own after-count must be 0 → `partners-phase2-measure.ts --after` → all PASS (lag_positive 0; every stamp == first delivery; **R3 unchanged**; exact links; markers; backup applied) → `check-intake-hourly-invariant.ts` 0 breaks → screenshots → card.
- [ ] **Step 8: Report and stop** before Phase 3 (0202 `partner_send_attributions`, the C3 stateless-lookback cron, the recalc worker that consumes `partner_attribution_recalcs`).

---

## Self-review

- Spec coverage: C2 → Task 1 (guard + SET NOT NULL) + Task 2; 0201 (§9.3) → Task 1; Q2 repair → Task 3 as a script (F1) with the exact statements, counts, revert, idempotency and re-runnability, gated after the fresh-lead confirmation; enrichment stamping → Task 4; Q6 auto-link → Tasks 1 (backfill, F4 exact prefix) + 4 (at creation), exit check by exact links (F5); C4 marker → Tasks 1 + 4, exempted by key in the measurements (F2); group form/list/header → Task 5 with the drip-group lock (F3) and the helper text (F5); Q9 → Task 5 gate; Q12 → the recalc row only; the owner's three original demands → Task 3, Task 0 / Task 8 Step 7, the Proof section + Task 6; F2's "paste the real output" → the Measurement section below.
- Placeholders: none; every migration statement, query, script and test is written out.
- Consistency: the naming rule in Task 0's `MEMBERS`, in `FIRST_DELIVERY` and in `partnerTagGroupName` is the same expression; system groups are identified by key (`drip-intake`/`drip-sandbox`) in both the measurement and the repair, and by `system_role` only in 0201's CHECKs and the PATCH; `reason` values `link|unlink|relink|manual`; `createPartnerWithKey` returns `{ partnerId, keyId, token }`; the backup table is `drip_membership_stamp_backup` everywhere.
- Deliberate deviation from the owner's original wording, carried over: the R3 exit check is "unchanged by the repair and equal to the count against first delivery", with both numbers printed, not "= 63".

---

## Measurement output 2026-10-09

Verbatim `npx tsx --conditions=react-server scripts/partners-phase2-measure.ts` against production, read-only, pre-0201 schema (no post-0201 column referenced):

```
target project ref: rtdarhkkjwcetlmruftl   at 2026-10-09T14:08:26.699Z
  members: 16182
  no_lead_event: 0
  lag_over_10m: 8171
  lag_positive: 16182
  stamped_at_delivery: 0
  stamped_before_delivery: 0
  max_lag: 01:23:38.911987
  r3_against_stamp: 74
  r3_against_delivery: 74
  keys_null_partner: 0
  drip_groups: 113:drip-intake:Drip intake | 114:drip-sandbox:Drip sandbox | 311:drip:b0ce3435-5ea2-4510-ab11-8cdd0d0c125b:pml-aca:pml-aca | 1129:drip:b0ce3435-5ea2-4510-ab11-8cdd0d0c125b:bsd-untagged:bsd-untagged
  partners: 1:internal-test,2:pml,3:docs-curl-verify,4:bsd
```

Reading: pml-aca has grown to 16,182 members since the morning's 15,785; **every** membership is stamped after delivery (`lag_positive == members`, `stamped_at_delivery 0`) — the 8,171 backfilled ones by up to 1 h 24 m, the rest by seconds; the R3 count is now **74** (73 in the morning, 63 in the recon) and is identical against the current stamps and against first delivery, so the repair cannot move it. `keys_null_partner 0` is 0201's precondition. `drip-intake` / `drip-sandbox` are identified by key, which is how `--before` will read them on the pre-0201 schema.
