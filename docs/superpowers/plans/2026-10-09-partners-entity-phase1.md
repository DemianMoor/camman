# Partner entity (Phase 1 of partner attribution) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `partners` entity above `partner_keys` so that the signed report link, the revenue toggle and the Settings screen hang off the partner, while every existing key, token, counter and report row keeps working unchanged.

**Architecture:** One additive migration (0200) creates `partners`, adds a nullable `partner_keys.partner_id`, backfills one partner per existing key (token hash and revenue flag copied, so pml's live link survives), and drops the per-key slug uniqueness. Code then reads the link and the revenue flag from `partners`, always writes `partner_id` on new keys, and reports through key → partner. `SET NOT NULL` is deferred to a later migration (C2). Nothing in the send path, the intake counters or the drip pipeline changes.

**Tech Stack:** Next.js 16 App Router, Drizzle (hand-authored SQL migrations + cloned snapshots), Zod, shadcn/ui, tsx proof scripts against the camman-v2 preview database.

**Source of truth:** [docs/superpowers/specs/2026-10-08-partner-attribution-recon.md](../specs/2026-10-08-partner-attribution-recon.md) §1.3, §8, §9.5 (phase 1) and its **Approval** section (C2, Q7, Q9, Q10, Q11). Where this plan and the recon body disagree, the Approval section wins.

## Global Constraints

- **Gating (owner, 2026-10-08, amended 2026-10-09 F4):** every prod migration and data write stops at the proposal and waits for an explicit go; preview (camman-v2, ref `fdzxzxayhknywvmrhjcj`) first; the prod apply is **attended, any time before 12:00 UTC (14:00 Warsaw)**. Stop and report after this phase; Phase 2 needs its own go.
- **Owner fixes applied 2026-10-09 (F1–F5):** F1 the exit-check baseline is captured by the OLD code from a checkout of `origin/main`, the compared range ends YESTERDAY (ET), capture and compare run the same morning minutes apart and both print the lookup rate; F2 every caller of `getPartnerReport`'s 4th argument moves to a partner id (findings in Task 3); F3 the exit check runs the resolver's exact WHERE against key 77's copied hash, and the owner opens pml's live link after the deploy; F4 the window above; F5 the slug-uniqueness drop was checked against every lookup by slug (findings in Task 1).
- **C2:** 0200 adds `partner_keys.partner_id` **nullable** + backfill. No `SET NOT NULL` in 0200. The follow-up `SET NOT NULL` is the first statement of the next migration batch, after `SELECT count(*) FROM partner_keys WHERE partner_id IS NULL` reads 0 in prod with the new code deployed.
- **Q7:** archiving a partner disables intake on its keys and kills its report link; the confirm dialog says both; restore re-enables. A sandbox-only partner gets no link; a file-only partner (no keys) can have one.
- **Q9:** permission ids stay `partner_keys.view` / `partner_keys.manage`.
- **Q10:** the link moves to the partner; pml's hash is copied verbatim. **Exit check:** pml's existing link resolves and shows identical numbers before and after.
- **Q11:** the internal report table gains a **Partner** column.
- Prod migration ledger is at **0199**; this phase's migration is **0200** and must lead with `SET LOCAL lock_timeout`.
- Prod `statement_timeout` is 120 s server-wide (binds `drizzle-kit migrate`); every 0200 statement is milliseconds on 4 rows.
- Migrations are hand-authored: SQL file + cloned `meta/NNNN_snapshot.json` + `_journal.json` entry (memory: `project_migrations_handwritten`). Write JSON with the Write tool (no PowerShell BOM).
- Every new `app/api/**/route.ts` needs a line in `lib/authz/route-map.ts` or `scripts/test-route-map-coverage.ts` goes red; keys removed from disk must leave the map.
- `npm run check:guards` is a required CI check on `main`; a new script that writes a database must import `./_require-preview-db` second, or be listed in `EXCLUSIONS` with a reason.
- Work in the throwaway worktree `.claude/worktrees/partners-entity` (branch `feat/partners-entity`, based on `origin/main` `739ff7e1`). Never touch the shared checkout's branch.
- Docs are part of done: `docs/03-data-model.md` (+ ERD), `docs/04-features/drip-partner-reporting.md`, `docs/04-features/partner-lead-intake.md`, `docs/06-integrations.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md` (CRLF; newest entry first after the intro paragraph).

---

## File map

| file | change |
|---|---|
| `db/migrations/0200_partners.sql` | **create** — table, indexes, RLS, `partner_keys.partner_id`, backfill, slug-uniqueness swap |
| `db/migrations/meta/0200_snapshot.json`, `db/migrations/meta/_journal.json` | **create / modify** — cloned snapshot + journal entry |
| `db/schema.ts` | **modify** — `partners` table; `partner_keys.partner_id`; `partner_keys_org_slug_uniq` → `partner_keys_org_slug_idx` |
| `lib/reporting/partner-report-token.ts` | **modify** — issue/revoke/resolve on `partners`; executor parameter; link-eligibility rule |
| `lib/intake/partner-key.ts` | **modify** — `ResolvedPartnerKey.partner_status` |
| `app/api/intake/leads/[token]/route.ts` | **modify** — 403 when the partner is archived |
| `lib/reporting/partner-report.ts` | **modify** — `partnerId?` filter; rows carry `partner_id`, `partner_name` from `partners` |
| `app/partner-report/[token]/page.tsx` | **modify** — pass `resolved.partnerId` |
| `components/reports/partner-report-view.tsx`, `components/reports/internal-partner-report.tsx` | **modify** — Partner column + CSV column on the internal view |
| `lib/validators/partners.ts` | **create** — `partnerCreateSchema`, `partnerUpdateSchema`, exported `partnerSlugSchema` |
| `lib/validators/partner-keys.ts` | **modify** — create takes `partner_id`, not `partner_slug`; update drops `report_show_revenue` |
| `app/api/partners/route.ts`, `app/api/partners/[partnerId]/route.ts`, `app/api/partners/[partnerId]/archive/route.ts`, `app/api/partners/[partnerId]/restore/route.ts`, `app/api/partners/[partnerId]/report-link/route.ts` | **create** |
| `app/api/partner-keys/route.ts`, `app/api/partner-keys/[keyId]/route.ts` | **modify** — POST under a partner; PATCH without revenue |
| `app/api/partner-keys/[keyId]/report-link/route.ts` | **delete** (moved to the partner) |
| `lib/authz/route-map.ts` | **modify** — five `partners/*` entries added, one key entry removed |
| `components/settings/partners.tsx` | **create** — partner cards, New partner, archive/restore, link + revenue controls |
| `components/settings/partner-key-card.tsx` | **create** — one key's card, moved out of `partner-keys.tsx` |
| `components/settings/partner-key-create-dialog.tsx` | **create** — the create-key dialog, partner fixed, no slug field |
| `components/settings/partner-keys.tsx` | **delete** (split into the three files above) |
| `app/(protected)/settings/partners/page.tsx`, `components/protected/nav-config.ts` | **modify** — copy: "Partners" |
| `scripts/test-partners-migration-db.ts`, `scripts/test-partner-report-token-db.ts`, `scripts/test-partners-api.ts` | **create** — preview-only tests |
| `scripts/partners-phase1-exit-check.ts` | **create** — read-only prod exit check (pml link resolves, numbers identical to the baseline) |
| docs listed above | **modify** |

---

### Task 0: Baseline for the exit check (read-only, prod)

**Files:**
- Create: `scripts/partners-phase1-exit-check.ts`

**Interfaces:**
- Produces: a JSON baseline file `%LOCALAPPDATA%/Temp/claude/partners-phase1-baseline.json` = `getPartnerReport(orgId, "2026-10-01", <YESTERDAY ET>, <pml>)` rows + the lookup rate + key 77's hash, captured BEFORE 0200 is applied to prod. The same script re-runs after deploy in `--compare` mode.

**F1 — two checkouts, one script.** `--capture` must run the OLD code: the worktree's `getPartnerReport` joins `partners`, which does not exist in prod before 0200, and its 4th argument is a partner id. So the capture runs from a detached checkout of `origin/main` (`git worktree add .claude/worktrees/partners-baseline origin/main --detach`, junction `node_modules`, hard-link `.env.local`), with this script copied in untracked; there the 4th argument is key 77. `--compare` runs from `partners-entity` after the deploy, where the 4th argument is pml's partner id (looked up through `partner_keys.partner_id`). The compared range ends **yesterday ET** (campaign 1606 sends live; today's rows move between the two runs), both runs happen the same morning minutes apart, and both print the lookup rate — a rate difference is printed next to the row diff, never hidden by it.

- [ ] **Step 1: Write the script**

```ts
// scripts/partners-phase1-exit-check.ts
import "./_env-preload";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { getPartnerReport } from "@/lib/reporting/partner-report";

// Phase 1 exit check (Q10, owner fixes F1–F3). READ-ONLY.
//
//   --capture  run from a checkout of origin/main (the OLD code, whose 4th
//              argument is a partner KEY id and which does not know `partners`),
//              BEFORE 0200 is applied to prod. Writes the baseline file.
//   --compare  run from the Phase 1 worktree AFTER the deploy. Re-reads the same
//              range with the NEW code (4th argument = pml's PARTNER id) and
//              must print identical rows; also proves the link moved (F3) and
//              that scoping by partner equals filtering the whole report (F2).
//
// The range ends YESTERDAY in ET: campaign 1606 sends live, so today's rows
// move between the two runs. Capture and compare the same morning, minutes
// apart; both print the lookup rate, and a rate difference is reported on its
// own line, never hidden inside the row diff.
//
//   npx tsx --conditions=react-server scripts/partners-phase1-exit-check.ts --capture
//   npx tsx --conditions=react-server scripts/partners-phase1-exit-check.ts --compare

const PML_KEY_ID = 77;
const FROM = "2026-10-01";
const FILE = `${process.env.LOCALAPPDATA}/Temp/claude/partners-phase1-baseline.json`;

function etDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

type Baseline = { rows: unknown[]; rate: number; rateSource: string; keyHash: string | null; from: string; to: string };
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}
// Columns that only the NEW row shape carries; dropped on both sides so the
// comparison is about numbers.
const strip = (r: Record<string, unknown>) => {
  const { partner_id: _p, ...rest } = r;
  return rest;
};

async function main() {
  const capture = process.argv.includes("--capture");
  const org = (await db.execute(sql`SELECT org_id, report_token_hash FROM partner_keys WHERE id = ${PML_KEY_ID}`)) as unknown as
    { org_id: string; report_token_hash: string | null }[];
  const orgId = org[0].org_id;

  if (capture) {
    const to = etDay(1);
    // OLD code: the 4th argument is the KEY id.
    const report = await getPartnerReport(orgId, FROM, to, PML_KEY_ID);
    const rows = report.rows.map((r) => strip(r as unknown as Record<string, unknown>));
    const baseline: Baseline = { rows, rate: report.rate.rate, rateSource: report.rate.source, keyHash: org[0].report_token_hash, from: FROM, to };
    writeFileSync(FILE, JSON.stringify(baseline, null, 2));
    console.log(`baseline written: ${rows.length} row(s), ${FROM}..${to}, rate ${report.rate.rate} (${report.rate.source}), key 77 link live=${org[0].report_token_hash !== null}`);
    await pgConn.end();
    return;
  }

  const base = JSON.parse(readFileSync(FILE, "utf-8")) as Baseline;
  console.log(`baseline: ${base.rows.length} row(s), ${base.from}..${base.to}, rate ${base.rate} (${base.rateSource})`);
  check("the compare runs on the baseline's day (range ends yesterday ET)", base.to === etDay(1), `baseline to=${base.to}, yesterday=${etDay(1)} — re-capture is NOT allowed; investigate instead`);

  // NEW code: the 4th argument is the PARTNER id, reached through the key.
  const pm = (await db.execute(sql`
    SELECT p.id, p.slug, p.status, p.report_token_hash
    FROM partner_keys k JOIN partners p ON p.id = k.partner_id WHERE k.id = ${PML_KEY_ID}
  `)) as unknown as { id: number; slug: string; status: string; report_token_hash: string | null }[];
  check("key 77 has a partner and it is pml", pm[0]?.slug === "pml", JSON.stringify(pm[0]));
  const partnerId = pm[0].id;

  const scoped = await getPartnerReport(orgId, base.from, base.to, partnerId);
  const whole = await getPartnerReport(orgId, base.from, base.to);
  const rows = scoped.rows.map((r) => strip(r as unknown as Record<string, unknown>));
  console.log(`now:      ${rows.length} row(s), rate ${scoped.rate.rate} (${scoped.rate.source})`);
  check("lookup rate unchanged between the two runs", scoped.rate.rate === base.rate && scoped.rate.source === base.rateSource,
        `baseline ${base.rate} (${base.rateSource}) vs now ${scoped.rate.rate} (${scoped.rate.source})`);
  check("⭐ Q10: pml's rows are identical before and after", JSON.stringify(rows) === JSON.stringify(base.rows),
        `baseline ${JSON.stringify(base.rows)}\n        now      ${JSON.stringify(rows)}`);
  check("⭐ F2: scoping the report by pml's partner id == filtering the whole report to pml",
        JSON.stringify(scoped.rows) === JSON.stringify(whole.rows.filter((r) => r.partner_slug === "pml")));

  // F3: the resolver's EXACT WHERE, with key 77's copied hash. Same text as
  // resolveReportToken minus the hash parameter (the plaintext is the partner's).
  const resolved = (await db.execute(sql`
    SELECT p.id, p.slug
    FROM partners p
    WHERE p.report_token_hash = ${base.keyHash}
      AND p.status = 'active'
      AND (
        NOT EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id)
        OR EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id AND k.sandbox = false)
      )
    LIMIT 1
  `)) as unknown as { id: number; slug: string }[];
  check("⭐ F3: the resolver's WHERE with key 77's copied hash returns pml's partner", resolved[0]?.id === partnerId && resolved[0]?.slug === "pml", JSON.stringify(resolved));
  check("Q10: the hash on the partner is byte-identical to the key's", pm[0].report_token_hash === base.keyHash);

  console.log(failures === 0 ? "\nAll checks passed. Owner step: open pml's live report link and confirm it renders." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
```

⚠️ `scripts/partners-phase1-exit-check.ts` imports `PARTNER_CAN_HAVE_LINK`'s text as a literal on purpose: the baseline checkout does not have Task 2's module. Task 2 Step 3 must keep `PARTNER_CAN_HAVE_LINK` byte-identical to the fragment above, and `scripts/test-partner-report-token-db.ts` check 3/4 exercises the module version.

- [ ] **Step 2: Capture the baseline (prod, read-only, OLD code) — the morning of the prod apply, BEFORE `npm run db:migrate`**

```bash
cd /c/AFF/camman && git fetch -q origin main \
  && git worktree add .claude/worktrees/partners-baseline origin/main --detach \
  && cd .claude/worktrees/partners-baseline \
  && cmd //c "mklink /J node_modules C:\\AFF\\camman\\node_modules" \
  && cmd //c "mklink /H .env.local C:\\AFF\\camman\\.env.local" \
  && cp ../partners-entity/scripts/partners-phase1-exit-check.ts scripts/ \
  && npx tsx --conditions=react-server scripts/partners-phase1-exit-check.ts --capture
```

Expected: `baseline written: 1 row(s), 2026-10-01..<yesterday ET>, rate 0.001592 (ledger), key 77 link live=true`. (The old code's `getPartnerReport` accepts a key id, so this type-checks there; in the Phase 1 worktree the same call site is never executed because `--capture` is only ever run from the baseline checkout — `npx tsc` in the worktree still passes because `PML_KEY_ID` is a number.)

Tear the baseline checkout down after `--compare` has passed: `cmd //c "rmdir node_modules"` → `rm .env.local` → `git worktree remove --force .claude/worktrees/partners-baseline`.

- [ ] **Step 3: Commit**

```bash
git add scripts/partners-phase1-exit-check.ts
git commit -m "test(partners): phase 1 exit check — pml rows and link identical before/after 0200"
```

---

### Task 1: Migration 0200 — `partners` + `partner_keys.partner_id` (additive, C2)

**Files:**
- Create: `db/migrations/0200_partners.sql`
- Create: `db/migrations/meta/0200_snapshot.json` (clone of `0199_snapshot.json`)
- Modify: `db/migrations/meta/_journal.json` (append entry idx 200)
- Modify: `db/schema.ts` (add `partners` ABOVE `partner_keys`; add `partner_id`; swap the slug index)
- Test: `scripts/test-partners-migration-db.ts`

**Interfaces:**
- Produces: table `partners(id serial, org_id, slug, name, status 'active'|'archived', archived_at, created_at, created_by, report_token_hash, report_token_issued_at, report_token_expires_at, report_show_revenue)`; `partner_keys.partner_id integer NULL REFERENCES partners(id) ON DELETE RESTRICT`; Drizzle exports `partners` and `partner_keys.partner_id`.

- [ ] **Step 1: Write the failing test (preview DB only, rolled back)**

```ts
// scripts/test-partners-migration-db.ts
// 0200 on the PREVIEW database. Runs after the preview deploy has applied the
// migration (camman-v2 auto-applies on every preview build). Part A asserts
// the catalog + backfill; Part B inserts fixtures inside ONE rolled-back
// transaction to prove two keys of one partner may share a slug and that
// ON DELETE RESTRICT holds.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-partners-migration-db.ts
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

async function main() {
  // ── A. catalog + backfill ────────────────────────────────────────────────
  const cols = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'partners' ORDER BY ordinal_position
  `)) as unknown as { column_name: string }[];
  check("A1 partners has the 12 columns", cols.map((c) => c.column_name).join(",") ===
    "id,org_id,slug,name,status,archived_at,created_at,created_by,report_token_hash,report_token_issued_at,report_token_expires_at,report_show_revenue",
    cols.map((c) => c.column_name).join(","));
  const idx = (await db.execute(sql`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('partners', 'partner_keys') ORDER BY indexname
  `)) as unknown as { indexname: string }[];
  const names = idx.map((i) => i.indexname);
  check("A2 partners indexes exist", ["partners_org_slug_uniq", "partners_report_token_hash_uniq", "partners_org_status_idx"].every((n) => names.includes(n)), names.join(","));
  check("A3 partner_keys_org_slug_uniq is GONE and partner_keys_org_slug_idx exists",
    !names.includes("partner_keys_org_slug_uniq") && names.includes("partner_keys_org_slug_idx") && names.includes("partner_keys_partner_id_idx"), names.join(","));
  const rls = (await db.execute(sql`
    SELECT relrowsecurity FROM pg_class WHERE relname = 'partners'
  `)) as unknown as { relrowsecurity: boolean }[];
  check("A4 RLS enabled on partners", rls[0]?.relrowsecurity === true);
  const pol = (await db.execute(sql`SELECT policyname FROM pg_policies WHERE tablename = 'partners'`)) as unknown as { policyname: string }[];
  check("A5 the SELECT policy exists and is the only one", pol.length === 1 && pol[0].policyname === "partners_select_own_org", JSON.stringify(pol));
  const bf = (await db.execute(sql`
    SELECT count(*)::int AS keys,
           count(*) FILTER (WHERE partner_id IS NULL)::int AS unassigned,
           count(*) FILTER (WHERE p.slug = k.partner_slug AND p.name = k.name
                              AND p.report_show_revenue = k.report_show_revenue
                              AND p.report_token_hash IS NOT DISTINCT FROM k.report_token_hash)::int AS copied
    FROM partner_keys k LEFT JOIN partners p ON p.id = k.partner_id
  `)) as unknown as { keys: number; unassigned: number; copied: number }[];
  check("A6 every key has a partner, and slug/name/revenue/token hash were copied", bf[0].unassigned === 0 && bf[0].copied === bf[0].keys, JSON.stringify(bf[0]));
  const nn = (await db.execute(sql`
    SELECT is_nullable FROM information_schema.columns WHERE table_name = 'partner_keys' AND column_name = 'partner_id'
  `)) as unknown as { is_nullable: string }[];
  check("A7 partner_keys.partner_id is still NULLABLE (C2)", nn[0]?.is_nullable === "YES");

  // ── B. behaviour, rolled back ────────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const p = (await tx.execute(sql`
        INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'zz-plan-test', 'Plan test') RETURNING id
      `)) as unknown as { id: number }[];
      const pid = p[0].id;
      const mk = (token: string) => tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId}::uuid, ${pid}, 'zz-plan-test', 'Plan test', ${token}, 'x')
      `);
      await mk("plan-token-1");
      await mk("plan-token-2");
      const two = (await tx.execute(sql`SELECT count(*)::int AS n FROM partner_keys WHERE partner_id = ${pid}`)) as unknown as { n: number }[];
      check("B1 two keys of one partner share a slug", two[0].n === 2);
      let restricted = false;
      try {
        await tx.execute(sql`SAVEPOINT s1`);
        await tx.execute(sql`DELETE FROM partners WHERE id = ${pid}`);
      } catch (e) {
        restricted = /violates foreign key constraint/.test(((e as { cause?: Error }).cause?.message ?? (e as Error).message));
        await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
      }
      check("B2 deleting a partner with keys is RESTRICTed", restricted);
      let dupSlug = false;
      try {
        await tx.execute(sql`SAVEPOINT s2`);
        await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'zz-plan-test', 'again')`);
      } catch (e) {
        dupSlug = /partners_org_slug_uniq/.test(((e as { cause?: Error }).cause?.message ?? (e as Error).message));
        await tx.execute(sql`ROLLBACK TO SAVEPOINT s2`);
      }
      check("B3 partner slug is unique per org", dupSlug);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
```

- [ ] **Step 2: Run it against the preview DB to see it fail**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-partners-migration-db.ts`
Expected: `✗ A1 partners has the 12 columns` (relation `partners` does not exist yet; the script may throw on the first query — either is the red).

**F5 — dropping `partner_keys_org_slug_uniq`, what was checked (2026-10-09, read at `739ff7e1`).** Every lookup of a key by slug, and whether it assumes one row:

| where | query | assumes one row? |
|---|---|---|
| `lib/intake/partner-key.ts` `resolvePartnerKey` | by `token` | n/a — token stays globally unique |
| `lib/reporting/partner-report.ts` | joins `partner_keys` by `id` | no |
| `lib/drip/intake-digest.ts` | joins `partner_keys` by `id` | no |
| `lib/drip/enrichment.ts` | reads `lead_inbox.partner_slug` per lead (denormalized at capture) and derives the `<slug>-<tag>` group name from it | no — per-lead text, never a key lookup |
| `lib/drip/groups.ts` | slug is a name component | no |
| `lib/intake/capture.ts` | writes the key's slug onto `lead_inbox` / `lead_events` | no — two keys of one partner carry the same slug, so provenance stays right |
| `scripts/backfill-partner-tag-groups.ts` | `lead_events … WHERE partner_slug = $PARTNER` | set semantics — fine |
| `scripts/partner-report-cost-proof.ts` | `JOIN partner_keys k ON k.id = le.partner_key_id AND k.partner_slug = 'internal-test'` | no — join per lead event |
| `scripts/test-intake-schema.ts` | `count(*) … WHERE partner_slug LIKE 'probe-%'` | counts — fine |
| `scripts/drip-p5-proof-setup.ts` | `SELECT id, token FROM partner_keys WHERE partner_slug = 'internal-test'` → `existing[0]` | **yes** (fixture; picks an arbitrary key if internal-test ever gets a second one) |
| `scripts/drip-p7-proof.ts` | `… WHERE org_id = … AND partner_slug = 'internal-test' LIMIT 1` | **yes** (fixture, same caveat) |

No application code assumes one key per slug. The two fixture scripts take the first `internal-test` key; that partner has one key and the scripts issue/revoke on it, so they stay correct until someone adds a second internal-test key — noted in their headers in Task 6, not changed here. Safe to drop.

- [ ] **Step 3: Write the migration**

```sql
-- db/migrations/0200_partners.sql
-- Migration 0200: the partner ENTITY (partner attribution, Phase 1).
--
-- Until now the only partner identity was partner_keys: one row = one intake
-- credential AND the partner. The signed report link, the revenue toggle, the
-- counters and every report row hung off partner_key_id. A partner with two
-- keys, or a partner who delivers files and has no key at all, could not be
-- expressed. This creates `partners` above `partner_keys`.
--
-- ⚠️ ADDITIVE, AND THE COLUMN STAYS NULLABLE (owner ruling C2, 2026-10-08).
-- Code deployed after this always writes partner_keys.partner_id; a follow-up
-- migration adds SET NOT NULL once prod reads 0 NULLs. Additive leads code.
--
-- ⚠️ THE TOKEN HASH IS COPIED VERBATIM FROM THE KEY (ruling Q10). The plaintext
-- of a report link is unrecoverable by construction, so moving the link to the
-- partner is the ONLY way to keep pml's live link alive. The four token columns
-- and report_show_revenue stay on partner_keys as dead copies until a later
-- destructive migration drops them (additive leads, destructive follows).
--
-- ⚠️ partner_keys_org_slug_uniq IS DROPPED: two keys of one partner share the
-- partner's slug (partner_keys.partner_slug stays as a denormalized copy for
-- lead_inbox / lead_events provenance). The uniqueness lives on
-- partners(org_id, slug) now. Replaced by a plain index for slug lookups.
--
-- Leads the batch: the lock is held for milliseconds on 4 rows, but a reader
-- queued behind ACCESS EXCLUSIVE must fail fast rather than sit.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE public.partners (
  id                      serial PRIMARY KEY,
  org_id                  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug                    text NOT NULL,
  name                    text NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  -- Signed report link, moved here from partner_keys (0172). Same contract:
  -- SHA-256 at rest, plaintext shown once, NULL = no link.
  report_token_hash       text,
  report_token_issued_at  timestamptz,
  report_token_expires_at timestamptz,
  report_show_revenue     boolean NOT NULL DEFAULT false,
  CONSTRAINT partners_status_check CHECK (status IN ('active', 'archived')),
  -- Same shape the key validator enforces; the slug is stamped onto every lead.
  CONSTRAINT partners_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9_-]*$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX partners_org_slug_uniq ON public.partners (org_id, slug);
--> statement-breakpoint

CREATE UNIQUE INDEX partners_report_token_hash_uniq
  ON public.partners (report_token_hash)
  WHERE report_token_hash IS NOT NULL;
--> statement-breakpoint

CREATE INDEX partners_org_status_idx ON public.partners (org_id, status);
--> statement-breakpoint

-- Tenant table => RLS enabled WITH an org-scoped SELECT policy, never
-- policy-less. Mirrors 0152. No write policies: every writer is the server's
-- privileged connection, which bypasses RLS.
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partners_select_own_org"
  ON public.partners FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

ALTER TABLE public.partner_keys
  ADD COLUMN partner_id integer REFERENCES public.partners(id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE INDEX partner_keys_partner_id_idx ON public.partner_keys (partner_id);
--> statement-breakpoint

-- Backfill: one partner per existing key, in key order so ids are stable
-- (prod: 15 internal-test, 77 pml, 78 docs-curl-verify, 81 bsd). Idempotent:
-- re-running creates nothing for a slug that already has a partner.
INSERT INTO public.partners
  (org_id, slug, name, status, created_at, created_by,
   report_token_hash, report_token_issued_at, report_token_expires_at, report_show_revenue)
SELECT k.org_id, k.partner_slug, k.name, 'active', k.created_at, k.created_by,
       k.report_token_hash, k.report_token_issued_at, k.report_token_expires_at, k.report_show_revenue
FROM public.partner_keys k
WHERE NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.org_id = k.org_id AND p.slug = k.partner_slug)
ORDER BY k.id;
--> statement-breakpoint

UPDATE public.partner_keys k
SET partner_id = p.id
FROM public.partners p
WHERE p.org_id = k.org_id AND p.slug = k.partner_slug AND k.partner_id IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS public.partner_keys_org_slug_uniq;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS partner_keys_org_slug_idx ON public.partner_keys (org_id, partner_slug);
```

- [ ] **Step 4: Update `db/schema.ts`**

Insert `partners` immediately ABOVE `export const partner_keys = pgTable(` (the lazy `references(() => partners.id)` would work either way, but reading order should match dependency order):

```ts
// The partner ENTITY (partner attribution Phase 1, migration 0200). One row per
// commercial partner; its intake credentials are partner_keys rows below. The
// signed report link and the revenue toggle live HERE since 0200 — a partner
// with two keys, or with no key at all (file delivery), has exactly one link.
export const partners = pgTable(
  "partners",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    created_by: uuid("created_by"),
    report_token_hash: text("report_token_hash"),
    report_token_issued_at: timestamp("report_token_issued_at", { withTimezone: true }),
    report_token_expires_at: timestamp("report_token_expires_at", { withTimezone: true }),
    report_show_revenue: boolean("report_show_revenue").notNull().default(false),
  },
  (table) => [
    uniqueIndex("partners_org_slug_uniq").on(table.org_id, table.slug),
    uniqueIndex("partners_report_token_hash_uniq")
      .on(table.report_token_hash)
      .where(sql`${table.report_token_hash} IS NOT NULL`),
    index("partners_org_status_idx").on(table.org_id, table.status),
    check("partners_status_check", sql`${table.status} IN ('active', 'archived')`),
    check("partners_slug_check", sql`${table.slug} ~ '^[a-z0-9][a-z0-9_-]*$'`),
  ],
);
```

In `partner_keys`: add after `last_seen_at`:

```ts
    // The partner this key belongs to (0200). NULLABLE until the follow-up
    // migration sets NOT NULL (ruling C2: additive leads code). Every code path
    // that inserts a key writes it.
    partner_id: integer("partner_id").references(() => partners.id, { onDelete: "restrict" }),
```

and replace

```ts
    uniqueIndex("partner_keys_org_slug_uniq").on(
      table.org_id,
      table.partner_slug,
    ),
```

with

```ts
    // Non-unique since 0200: two keys of one partner share the partner's slug.
    index("partner_keys_org_slug_idx").on(table.org_id, table.partner_slug),
    index("partner_keys_partner_id_idx").on(table.partner_id),
```

- [ ] **Step 5: Clone the snapshot and add the journal entry**

Copy `db/migrations/meta/0199_snapshot.json` to `db/migrations/meta/0200_snapshot.json`, then:
- set `"id": "0200a000-0200-4200-8200-000000000200"`, `"prevId": "0199a000-0199-4199-8199-000000000199"`;
- add `tables["public.partners"]` modelled on `tables["public.partner_keys"]` (name `partners`, schema `""`, the 12 columns with `notNull`/`default` as in the SQL — `status` default `'active'`, `report_show_revenue` default `false`, `created_at` default `now()`; `indexes`: `partners_org_slug_uniq` (isUnique true, columns org_id, slug), `partners_report_token_hash_uniq` (isUnique true, column report_token_hash, `"where": "\"partners\".\"report_token_hash\" IS NOT NULL"`), `partners_org_status_idx`; `foreignKeys`: `partners_org_id_organizations_id_fk` (org_id → organizations.id, onDelete cascade); `checkConstraints`: `partners_status_check` and `partners_slug_check` with the SQL text; `policies`: `{"partners_select_own_org": {"name": "partners_select_own_org", "as": "PERMISSIVE", "for": "SELECT", "to": ["public"]}}`; `isRLSEnabled: true`);
- in `tables["public.partner_keys"]`: add column `"partner_id": {"name": "partner_id", "type": "integer", "primaryKey": false, "notNull": false}`; add fk `"partner_keys_partner_id_partners_id_fk": {"name": "partner_keys_partner_id_partners_id_fk", "tableFrom": "partner_keys", "columnsFrom": ["partner_id"], "tableTo": "partners", "columnsTo": ["id"], "onUpdate": "no action", "onDelete": "restrict"}`; remove index `partner_keys_org_slug_uniq`; add `partner_keys_org_slug_idx` (same columns, `isUnique: false`) and `partner_keys_partner_id_idx`.

Append to `_journal.json` `entries` (after idx 199):

```json
    {
      "idx": 200,
      "version": "7",
      "when": 1793923200000,
      "tag": "0200_partners",
      "breakpoints": true
    }
```

Write both JSON files with the Write tool (UTF-8, no BOM).

- [ ] **Step 6: Type-check and open the PR so the preview applies 0200 to camman-v2**

Run: `npx tsc --noEmit -p tsconfig.json` → clean.
Commit and push (see Step 8), open the PR (title below), wait for `Vercel – camman` and `Vercel – camman-v2` to pass. The camman-v2 build runs `npm run db:migrate` (`RUN_PREVIEW_MIGRATIONS=1`), which applies 0200 to the preview database.

- [ ] **Step 7: Run the test to verify it passes (preview DB)**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-partners-migration-db.ts`
Expected: `All checks passed.` (A1–A7, B1–B3).
Also: `DATABASE_URL=<preview> npx tsx scripts/verify-migration-integrity.ts` → `Migration integrity OK.`

- [ ] **Step 8: Commit**

```bash
git add db/migrations/0200_partners.sql db/migrations/meta/0200_snapshot.json db/migrations/meta/_journal.json db/schema.ts scripts/test-partners-migration-db.ts
git commit -m "feat(partners): migration 0200 — partners table, partner_keys.partner_id (nullable, C2), backfill one partner per key"
```

---

### Task 2: The signed link and the intake gate read the partner

**Files:**
- Modify: `lib/reporting/partner-report-token.ts`
- Modify: `lib/intake/partner-key.ts` (`ResolvedPartnerKey.partner_status`, the SELECT)
- Modify: `app/api/intake/leads/[token]/route.ts` (after the `key.status !== "active"` check)
- Test: `scripts/test-partner-report-token-db.ts`

**Interfaces:**
- Produces:
  - `export interface ResolvedReportToken { partnerId: number; orgId: string; partnerSlug: string; partnerName: string; showRevenue: boolean }`
  - `issueReportToken(orgId: string, partnerId: number, expiresAt: Date | null, dbc: DbOrTx = db): Promise<string | null>` — `null` when the partner is missing, archived, or sandbox-only.
  - `revokeReportToken(orgId: string, partnerId: number, dbc: DbOrTx = db): Promise<boolean>`
  - `resolveReportToken(token: string | null | undefined, dbc: DbOrTx = db): Promise<ResolvedReportToken | null>`
  - `export const PARTNER_CAN_HAVE_LINK: SQL` — the one definition of "file-only OR has a live key", used by issue and resolve.
  - `ResolvedPartnerKey.partner_status: "active" | "archived" | null`
- Consumes: `DbOrTx` from `lib/intake/partner-key.ts`.

- [ ] **Step 1: Write the failing test (preview DB, rolled back)**

```ts
// scripts/test-partner-report-token-db.ts
// The signed link lives on the PARTNER (0200, Q7/Q10). Fixtures inside one
// rolled-back transaction; the token functions take the transaction as their
// executor so they can see the fixtures.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-partner-report-token-db.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { issueReportToken, resolveReportToken, revokeReportToken } from "@/lib/reporting/partner-report-token";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const partner = async (slug: string) =>
        ((await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, ${slug}, ${slug}) RETURNING id`)) as unknown as { id: number }[])[0].id;
      const key = (pid: number, slug: string, sandbox: boolean, status = "active") =>
        tx.execute(sql`INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, sandbox, status)
                       VALUES (${orgId}::uuid, ${pid}, ${slug}, ${slug}, ${slug + "-" + Math.random()}, 'x', ${sandbox}, ${status})`);

      // 1. file-only partner (no keys) can have a link
      const fileOnly = await partner("zz-file-only");
      const t1 = await issueReportToken(orgId, fileOnly, null, tx);
      check("1 a file-only partner gets a link", typeof t1 === "string" && t1.length > 20);
      const r1 = await resolveReportToken(t1, tx);
      check("1b …and it resolves to the PARTNER (not a key)", r1?.partnerId === fileOnly && r1?.partnerSlug === "zz-file-only" && r1?.showRevenue === false, JSON.stringify(r1));

      // 2. sandbox-only partner gets NO link
      const sandboxOnly = await partner("zz-sandbox-only");
      await key(sandboxOnly, "zz-sandbox-only", true);
      const t2 = await issueReportToken(orgId, sandboxOnly, null, tx);
      check("2 a sandbox-only partner is refused a link", t2 === null);

      // 3. live key → link; a DISABLED key does not kill the partner's link (Q7: the partner's status does)
      const live = await partner("zz-live");
      await key(live, "zz-live", false, "disabled");
      await key(live, "zz-live", true);
      const t3 = await issueReportToken(orgId, live, null, tx);
      check("3 a partner with a live (even disabled) key gets a link", typeof t3 === "string");
      check("3b it resolves", (await resolveReportToken(t3, tx))?.partnerId === live);

      // 4. archiving the partner kills the link; restoring brings it back
      await tx.execute(sql`UPDATE partners SET status = 'archived', archived_at = now() WHERE id = ${live}`);
      check("4 archived partner → link resolves to null", (await resolveReportToken(t3, tx)) === null);
      await tx.execute(sql`UPDATE partners SET status = 'active', archived_at = NULL WHERE id = ${live}`);
      check("4b restored → resolves again", (await resolveReportToken(t3, tx))?.partnerId === live);

      // 5. revoke
      check("5 revoke returns true", await revokeReportToken(orgId, live, tx));
      check("5b …and the link is dead", (await resolveReportToken(t3, tx)) === null);

      // 6. stored hashed, never the plaintext; expiry honoured
      const t6 = await issueReportToken(orgId, fileOnly, new Date(Date.now() - 1000), tx);
      check("6 an expired link resolves to null", (await resolveReportToken(t6, tx)) === null);
      const stored = (await tx.execute(sql`SELECT report_token_hash FROM partners WHERE id = ${fileOnly}`)) as unknown as { report_token_hash: string }[];
      check("6b the plaintext is NOT stored", stored[0].report_token_hash !== t6 && /^[0-9a-f]{64}$/.test(stored[0].report_token_hash));

      // 7. wrong org cannot issue
      check("7 another org id cannot issue for this partner", (await issueReportToken("00000000-0000-0000-0000-000000000000", fileOnly, null, tx)) === null);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" npx tsx --conditions=react-server scripts/test-partner-report-token-db.ts`
Expected: TypeScript error (the 4th `dbc` argument does not exist yet) or `✗ 1 a file-only partner gets a link` (the UPDATE targets `partner_keys`, which has no row for the partner id).

- [ ] **Step 3: Rewrite `lib/reporting/partner-report-token.ts`**

Replace the three functions and the interface (keep the header comment, updating "KEY ROW" → "PARTNER ROW"):

```ts
import "server-only";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";

// (header comment as before, with: ⚠️ SCOPE COMES FROM THE PARTNER ROW, NEVER
// THE URL — since 0200 the link lives on `partners`, one per partner, so a
// partner with two keys or with no key at all (file delivery) has exactly one.)

const TOKEN_BYTES = 24;

export interface ResolvedReportToken {
  partnerId: number;
  orgId: string;
  partnerSlug: string;
  partnerName: string;
  showRevenue: boolean;
}

/**
 * Who may hold a link (ruling Q7): a partner with NO keys (file-only) or with at
 * least one NON-sandbox key. A sandbox-only partner never resolves. One
 * definition, used by issue AND resolve, so the Settings button's precondition
 * and the public page agree. The key's own status does not matter here: a
 * disabled key stops intake, archiving the PARTNER stops the link.
 */
export const PARTNER_CAN_HAVE_LINK: SQL = sql`(
  NOT EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id)
  OR EXISTS (SELECT 1 FROM partner_keys k WHERE k.partner_id = p.id AND k.sandbox = false)
)`;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

export async function issueReportToken(
  orgId: string,
  partnerId: number,
  expiresAt: Date | null,
  dbc: DbOrTx = db,
): Promise<string | null> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const rows = (await dbc.execute(sql`
    UPDATE partners p
    SET report_token_hash = ${hashToken(token)},
        report_token_issued_at = now(),
        report_token_expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
    WHERE p.id = ${partnerId} AND p.org_id = ${orgId}::uuid
      AND p.status = 'active'
      AND ${PARTNER_CAN_HAVE_LINK}
    RETURNING p.id
  `)) as unknown as { id: number }[];
  return rows.length > 0 ? token : null;
}

export async function revokeReportToken(
  orgId: string,
  partnerId: number,
  dbc: DbOrTx = db,
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    UPDATE partners p
    SET report_token_hash = NULL, report_token_issued_at = NULL, report_token_expires_at = NULL
    WHERE p.id = ${partnerId} AND p.org_id = ${orgId}::uuid
    RETURNING p.id
  `)) as unknown as { id: number }[];
  return rows.length > 0;
}

export async function resolveReportToken(
  token: string | null | undefined,
  dbc: DbOrTx = db,
): Promise<ResolvedReportToken | null> {
  const t = (token ?? "").trim();
  if (!t || t.length > 128) return null;

  const rows = (await dbc.execute(sql`
    SELECT p.id, p.org_id, p.slug, p.name, p.report_show_revenue,
           p.report_token_hash, p.report_token_expires_at
    FROM partners p
    WHERE p.report_token_hash = ${hashToken(t)}
      AND p.status = 'active'
      AND ${PARTNER_CAN_HAVE_LINK}
    LIMIT 1
  `)) as unknown as {
    id: number; org_id: string; slug: string; name: string; report_show_revenue: boolean;
    report_token_hash: string; report_token_expires_at: string | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  const a = Buffer.from(hashToken(t), "utf-8");
  const b = Buffer.from(row.report_token_hash, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (row.report_token_expires_at && new Date(row.report_token_expires_at) <= new Date()) return null;
  return {
    partnerId: row.id,
    orgId: row.org_id,
    partnerSlug: row.slug,
    partnerName: row.name,
    showRevenue: row.report_show_revenue === true,
  };
}
```

- [ ] **Step 4: The intake gate**

`lib/intake/partner-key.ts`: add `partner_status: "active" | "archived" | null;` to `ResolvedPartnerKey` and change the SELECT to

```ts
    SELECT k.id, k.org_id, k.partner_slug, k.name, k.secret_hash, k.interest_tag_mode, k.interest_tag,
           k.field_mapping, k.sandbox, k.rate_per_sec, k.rate_per_day, k.max_payload_bytes, k.status,
           p.status AS partner_status
    FROM partner_keys k
    LEFT JOIN partners p ON p.id = k.partner_id
    WHERE k.token = ${token}
    LIMIT 1
```

`app/api/intake/leads/[token]/route.ts`, directly after the `key.status !== "active"` block:

```ts
  if (key.partner_status === "archived") {
    // Ruling Q7: archiving a partner stops intake on every key it owns, without
    // touching the keys' own status — restore re-enables them in one step.
    return jsonError(403, "This partner is archived");
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: the Step 2 command. Expected: `All checks passed.` (1–7).

- [ ] **Step 6: Commit**

```bash
git add lib/reporting/partner-report-token.ts lib/intake/partner-key.ts "app/api/intake/leads/[token]/route.ts" scripts/test-partner-report-token-db.ts
git commit -m "feat(partners): signed report link and intake gate read the partner (Q7, Q10)"
```

---

### Task 3: The report joins key → partner; Partner column on the internal table (Q11)

**Files:**
- Modify: `lib/reporting/partner-report.ts` (signature, final SELECT, row type)
- Modify: `app/partner-report/[token]/page.tsx` (`resolved.partnerId`)
- Modify: `components/reports/partner-report-view.tsx` (`showPartnerColumn` prop; table + CSV)
- Modify: `components/reports/internal-partner-report.tsx` (`showPartnerColumn`)
- Test: `scripts/partner-report-activity-proof.ts` and `scripts/partner-report-cost-proof.ts` (existing, read-only, unchanged — they key rows by `partner_key_id`; re-run as regression)

**Interfaces:**
- Produces: `getPartnerReport(orgId, from, to, partnerId?: number)` — the 4th argument is now a **partner** id. `PartnerReportRow` gains `partner_id: number | null` and keeps `partner_key_id`, `partner_slug`, `partner_name` (now from `partners`, COALESCE'd to the key for an unassigned key).

**F2 — every caller of the 4th argument (grep at `739ff7e1`, `getPartnerReport(` + `partnerKeyId`):**

| caller | today | change |
|---|---|---|
| `app/partner-report/[token]/page.tsx` | passes `resolved.partnerKeyId` | → `resolved.partnerId` (Step 2) |
| `app/api/reports/partners/route.ts` (internal) | `getPartnerReport(orgId, from, to)` — **no partner filter exists**; the internal page has no partner dropdown, and the Settings "Partner report" button links to `/reports/partners` without a parameter | none; the test below covers it at the function level |
| `components/reports/partner-report-view.tsx` CSV | client-side from `rows`; no id | gains the Partner column on the internal view (Step 3) |
| `scripts/drip-p7-proof.ts`, `scripts/partner-report-cost-proof.ts`, `scripts/partner-report-activity-proof.ts` | call with 3 arguments (and p7 with `resolved!.partnerKeyId`) | p7: `resolved!.partnerId` (its `ResolvedReportToken` field is renamed in Task 2); the other two are unchanged |

**Test (F2):** `scripts/partners-phase1-exit-check.ts --compare` asserts `getPartnerReport(org, from, to, <pml partner id>).rows` deep-equals `getPartnerReport(org, from, to).rows.filter(r => r.partner_slug === "pml")`, i.e. filtering the internal report by pml returns the same rows as the scoped report, and the Q10 check asserts those rows equal the pre-0200 baseline.

- [ ] **Step 1: Change the report**

In `lib/reporting/partner-report.ts`:

```ts
export interface PartnerReportRow {
  partner_key_id: number;
  /** The key's partner (0200). NULL only for a key created before the code that writes it (C2 window). */
  partner_id: number | null;
  partner_slug: string;
  partner_name: string;
  // … unchanged …
}

export async function getPartnerReport(
  orgId: string,
  from: string,
  to: string,
  /** restrict to one PARTNER (the signed-link view always does). */
  partnerId?: number,
): Promise<PartnerReportResult> {
  const rate = await getCalibratedLookupRate();
  const onlyPartner = partnerId != null ? sql`AND p.id = ${partnerId}` : sql``;
```

Final SELECT: replace the `k.id AS partner_key_id, k.partner_slug, k.name AS partner_name,` line and the `FROM keys ky JOIN partner_keys k …` block with

```sql
    SELECT k.id AS partner_key_id,
           p.id AS partner_id,
           COALESCE(p.slug, k.partner_slug) AS partner_slug,
           COALESCE(p.name, k.name)         AS partner_name,
           ky.interest_tag,
           …(the COALESCE'd metric columns, unchanged)…
    FROM keys ky
    JOIN partner_keys k
      ON k.id = ky.partner_key_id
     AND k.org_id = ${orgId}::uuid
     -- ⚠️ A sandbox KEY never appears at all (card): absent, not zeroed.
     AND k.sandbox = false
    -- LEFT, not INNER: a key with no partner yet (C2 window) must still report
    -- internally; the partner-scoped view filters on p.id so it can never see it.
    LEFT JOIN partners p ON p.id = k.partner_id
    LEFT JOIN intake  i  …(unchanged)…
    WHERE TRUE ${onlyPartner}
    ORDER BY 3, ky.interest_tag
```

and in the row mapping add `partner_id: r.partner_id == null ? null : Number(r.partner_id),`.

Update the header comment's "intake half" paragraph with one line: "Rows are still keyed `(partner_key_id, interest_tag)`; the partner is one join away (0200). Phase 5 moves the grain to `(partner_id, contact_group_id)`."

- [ ] **Step 2: The signed page**

`app/partner-report/[token]/page.tsx`: `resolved.partnerKeyId` → `resolved.partnerId` (the comment "scope — from the key row" → "scope — from the partner row").

- [ ] **Step 3: The view**

`components/reports/partner-report-view.tsx`:
- add prop `showPartnerColumn?: boolean` (default `false`);
- `toCsv(rows, showRevenue, showPartnerColumn)`: head starts with `...(showPartnerColumn ? ["partner"] : [])`, each line with `...(showPartnerColumn ? [r.partner_name] : [])`;
- `<thead>`: `{showPartnerColumn && <th className="p-2 text-left">Partner</th>}` before Tag; body: `{showPartnerColumn && <td className="p-2">{r.partner_name}</td>}`; empty-state `colSpan={(showRevenue ? 17 : 13) + (showPartnerColumn ? 1 : 0)}`; totals first cell `<td className="p-2" colSpan={showPartnerColumn ? 2 : 1}>Total</td>`.

`components/reports/internal-partner-report.tsx`: pass `showPartnerColumn` to `<PartnerReportView … showPartnerColumn />`.

- [ ] **Step 4: Type-check and run the two existing proofs (prod, read-only)**

Run: `npx tsc --noEmit -p tsconfig.json` → clean.
Run: `npx tsx --conditions=react-server scripts/partner-report-activity-proof.ts` → `All checks passed.` (prod has no `partners` table yet at this point, so the LEFT JOIN **must not** be exercised before 0200 is applied — run this step against the PREVIEW DB with `DATABASE_URL=<preview>` instead; it prints the preview org's rows, likely zero activity, and must pass with 0 rows.)
Run: `DATABASE_URL=<preview> npx tsx --conditions=react-server scripts/partner-report-cost-proof.ts` — this one hardcodes campaign 994 and will print `FAIL` on the preview; accept that and re-run it on prod AFTER 0200 is applied (Task 7).

- [ ] **Step 5: Commit**

```bash
git add lib/reporting/partner-report.ts "app/partner-report/[token]/page.tsx" components/reports/partner-report-view.tsx components/reports/internal-partner-report.tsx
git commit -m "feat(partners): report scoped by partner, Partner column on the internal table (Q11)"
```

---

### Task 4: `/api/partners/*`, keys created under a partner, link routes moved

**Files:**
- Create: `lib/validators/partners.ts`
- Modify: `lib/validators/partner-keys.ts`
- Create: `app/api/partners/route.ts`, `app/api/partners/[partnerId]/route.ts`, `app/api/partners/[partnerId]/archive/route.ts`, `app/api/partners/[partnerId]/restore/route.ts`, `app/api/partners/[partnerId]/report-link/route.ts`
- Modify: `app/api/partner-keys/route.ts`, `app/api/partner-keys/[keyId]/route.ts`
- Delete: `app/api/partner-keys/[keyId]/report-link/route.ts`
- Modify: `lib/authz/route-map.ts`
- Test: `scripts/test-partners-api.ts` (against the PR's `camman-*` preview URL, with a throwaway owner user — recipe in memory `reference_preview_operator_verify_recipe` / `reference_playwright_visual_check_recipe`)

**Interfaces:**
- Produces (JSON shapes the UI in Task 5 consumes):
  - `GET /api/partners` → `{ data: PartnerRow[], unassigned_keys: PartnerKeyRow[] }` where `PartnerRow = { id, slug, name, status, archived_at, created_at, report_link_active, report_token_issued_at, report_token_expires_at, report_show_revenue, can_have_link: boolean, keys: PartnerKeyRow[] }` and `PartnerKeyRow` is the existing list row (`id, partner_id, partner_slug, name, interest_tag_mode, interest_tag, field_mapping, sandbox, rate_per_sec, rate_per_day, max_payload_bytes, status, created_at, rotated_at, last_seen_at, secret_last4, leads_24h, auth_fails_today, total_leads`) — the four `report_*` fields are **no longer** on a key row.
  - `POST /api/partners` `{ slug, name }` → 201 `PartnerRow` (keys `[]`); 409 `DUPLICATE` field `slug`.
  - `GET /api/partners/[partnerId]` → `PartnerRow`; `PATCH` `{ name?, report_show_revenue? }` → `PartnerRow`.
  - `POST /api/partners/[partnerId]/archive` → `PartnerRow` (409 `already_archived`); `POST …/restore` → `PartnerRow` (409 `not_archived`).
  - `POST /api/partners/[partnerId]/report-link` `{ expires_at? }` → `{ ok, token, url, shown_once }`; 409 `code: "sandbox_only"` when `can_have_link` is false; 409 `code: "archived"`; `DELETE` → `{ ok, revoked }`.
  - `POST /api/partner-keys` `{ partner_id, name, interest_tag_mode?, interest_tag?, … }` → 201 (slug copied from the partner; 404 unknown partner; 409 `code: "partner_archived"`).
  - `PATCH /api/partner-keys/[keyId]` no longer accepts `report_show_revenue` (400 VALIDATION, unknown key).

- [ ] **Step 1: Validators**

```ts
// lib/validators/partners.ts
import { z } from "zod";

// The partner ENTITY (0200). The slug is stamped onto every lead the partner's
// keys capture and is a report dimension, so it is immutable after creation —
// same rule as partner_keys.partner_slug, which it now feeds.
export const partnerSlugSchema = z
  .string()
  .trim()
  .min(2, "Partner slug must be at least 2 characters")
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, _ and - only");

export const partnerCreateSchema = z.object({
  slug: partnerSlugSchema,
  name: z.string().trim().min(1, "Name is required").max(200),
});

export const partnerUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200).optional(),
    // Revenue is our margin, not the partner's number — opt-in per partner (R2).
    report_show_revenue: z.boolean().optional(),
  })
  .strict();

export type PartnerCreateInput = z.infer<typeof partnerCreateSchema>;
export type PartnerUpdateInput = z.infer<typeof partnerUpdateSchema>;
```

`lib/validators/partner-keys.ts`: replace the local `slug` const with `import { partnerSlugSchema } from "./partners";` (keep nothing else of it); remove `report_show_revenue` from `shared`; `partnerKeyCreateSchema` becomes

```ts
export const partnerKeyCreateSchema = z
  .object({
    // The key belongs to a partner (0200); its slug is COPIED from the partner
    // server-side, never typed — two keys of one partner share it.
    partner_id: z.number().int().positive(),
    ...shared,
    interest_tag_mode: shared.interest_tag_mode.default("default"),
  })
  .superRefine(forceNeedsTag);
```

(`partnerSlugSchema` stays exported for any other caller; `grep -rn "partner_slug" lib/validators components` to confirm the create dialog is the only one, which Task 5 removes.)

- [ ] **Step 2: `app/api/partners/route.ts`**

```ts
import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { PARTNER_CAN_HAVE_LINK } from "@/lib/reporting/partner-report-token";
import { partnerCreateSchema } from "@/lib/validators/partners";

// Partners (partner attribution Phase 1). The entity above partner_keys: one
// row per commercial partner, owning the signed report link and the revenue
// toggle (0200). Keys are nested in the list response so the Settings page is
// two queries, not N+1 — and never token / secret_hash / report_token_hash.
export const dynamic = "force-dynamic";

export const KEY_LIST_SQL = drizzleSql`
    SELECT k.id, k.partner_id, k.partner_slug, k.name, k.interest_tag_mode, k.interest_tag,
           k.field_mapping, k.sandbox, k.rate_per_sec, k.rate_per_day,
           k.max_payload_bytes, k.status, k.created_at, k.rotated_at, k.last_seen_at,
           k.secret_last4,
           COALESCE(u.leads_24h, 0)::int   AS leads_24h,
           COALESCE(f.auth_fails_today, 0)::int AS auth_fails_today,
           COALESCE(l.total_leads, 0)::int AS total_leads
    FROM partner_keys k
    LEFT JOIN LATERAL (
      SELECT sum(count) AS leads_24h FROM partner_key_usage
      WHERE partner_key_id = k.id AND window_kind = 'day'
        AND window_start > now() - interval '24 hours'
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT sum(count) AS auth_fails_today FROM partner_key_usage
      WHERE partner_key_id = k.id AND window_kind = 'auth_fail'
        AND window_start > now() - interval '24 hours'
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS total_leads FROM lead_inbox WHERE partner_key_id = k.id
    ) l ON true`;

export const PARTNER_ROW_SQL = drizzleSql`
    SELECT p.id, p.slug, p.name, p.status, p.archived_at, p.created_at,
           (p.report_token_hash IS NOT NULL) AS report_link_active,
           p.report_token_issued_at, p.report_token_expires_at, p.report_show_revenue,
           ${PARTNER_CAN_HAVE_LINK} AS can_have_link
    FROM partners p`;

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.view")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);

  const ps = (await db.execute(drizzleSql`${PARTNER_ROW_SQL}
    WHERE p.org_id = ${orgId}::uuid
    ORDER BY (p.status = 'active') DESC, p.slug`)) as unknown as Record<string, unknown>[];
  const ks = (await db.execute(drizzleSql`${KEY_LIST_SQL}
    WHERE k.org_id = ${orgId}::uuid
    ORDER BY (k.status = 'active') DESC, k.created_at`)) as unknown as { partner_id: number | null }[];

  const byPartner = new Map<number, unknown[]>();
  const unassigned: unknown[] = [];
  for (const k of ks) {
    if (k.partner_id == null) unassigned.push(k);
    else (byPartner.get(k.partner_id) ?? byPartner.set(k.partner_id, []).get(k.partner_id)!).push(k);
  }
  return NextResponse.json({
    data: ps.map((p) => ({ ...p, keys: byPartner.get(p.id as number) ?? [] })),
    // C2 window: a key created by pre-0200 code has no partner yet. Shown, never hidden.
    unassigned_keys: unassigned,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  if (!can(role, "partner_keys.manage")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);

  let json: unknown;
  try { json = await req.json(); } catch { return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION); }
  const parsed = partnerCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION, {
      field: parsed.error.issues[0]?.path.join("."),
    });
  }
  try {
    const [row] = await db
      .insert(partners)
      .values({ org_id: orgId, slug: parsed.data.slug, name: parsed.data.name, created_by: user.id })
      .returning({ id: partners.id });
    const full = (await db.execute(drizzleSql`${PARTNER_ROW_SQL} WHERE p.id = ${row.id}`)) as unknown as Record<string, unknown>[];
    return NextResponse.json({ ...full[0], keys: [] }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError(409, "A partner with that slug already exists", API_ERROR_CODES.DUPLICATE, { field: "slug" });
    }
    throw e;
  }
}
```

⚠️ A Next.js `route.ts` may only export route fields — `KEY_LIST_SQL` / `PARTNER_ROW_SQL` must NOT be exported from the route. Put them in `lib/partners/queries.ts` (new, `import "server-only"`) and import them in both partner routes and `app/api/partner-keys/route.ts` (whose GET then becomes `${KEY_LIST_SQL} WHERE k.org_id = … ORDER BY …` — one definition of the key row).

- [ ] **Step 3: `app/api/partners/[partnerId]/route.ts`** (GET + PATCH), modelled on `app/api/partner-keys/[keyId]/route.ts`: `parseId`, `partner_keys.view` for GET / `partner_keys.manage` for PATCH, `partnerUpdateSchema`, `UPDATE partners SET name = COALESCE(…), report_show_revenue = COALESCE(…) WHERE id AND org_id RETURNING id`, then `PARTNER_ROW_SQL WHERE p.id = …` + its keys (`KEY_LIST_SQL WHERE k.partner_id = …`). 404 `{ entity: "partner" }`.

- [ ] **Step 4: archive / restore**, modelled on `app/api/brands/[id]/archive/route.ts` with `partner_keys.manage`:
  - archive: `UPDATE partners SET status = 'archived', archived_at = now() WHERE id AND org_id AND status = 'active'`; on 0 rows → 404 or 409 `{ reason: "already_archived" }`. **Keys are NOT touched** — intake (Task 2) and the link (Task 2) read the partner's status, which is what makes restore a one-column flip (Q7).
  - restore: `… SET status = 'active', archived_at = NULL WHERE … AND status = 'archived'`; 409 `{ reason: "not_archived" }`.

- [ ] **Step 5: `app/api/partners/[partnerId]/report-link/route.ts`** = the deleted key route with `keyId` → `partnerId`, plus the precondition made explicit before issuing:

```ts
  const p = (await db.execute(drizzleSql`${PARTNER_ROW_SQL} WHERE p.id = ${id} AND p.org_id = ${orgId}::uuid`)) as unknown as
    { status: string; can_have_link: boolean }[];
  if (!p[0]) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  if (p[0].status !== "active") return apiError(409, "An archived partner cannot have a report link", API_ERROR_CODES.CONFLICT, { code: "archived" });
  if (!p[0].can_have_link) {
    return apiError(409, "Report links work for partners with a live key (or no keys at all)", API_ERROR_CODES.CONFLICT, { code: "sandbox_only" });
  }
  const token = await issueReportToken(orgId, id, expiresAt);
```

Then `git rm "app/api/partner-keys/[keyId]/report-link/route.ts"`.

- [ ] **Step 6: Keys under a partner**

`app/api/partner-keys/route.ts` POST: after parsing, resolve the partner:

```ts
  const owner = (await db.execute(drizzleSql`
    SELECT id, slug, status FROM partners WHERE id = ${input.partner_id} AND org_id = ${orgId}::uuid
  `)) as unknown as { id: number; slug: string; status: string }[];
  if (!owner[0]) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  if (owner[0].status !== "active") {
    return apiError(409, "Cannot add a key to an archived partner", API_ERROR_CODES.CONFLICT, { code: "partner_archived" });
  }
```

and in `.values({ … })`: `partner_id: owner[0].id, partner_slug: owner[0].slug,`. The 409 branch for `isUniqueViolation` now reads `"A key with that token already exists"` (only `partner_keys_token_uniq` remains — practically unreachable).

`app/api/partner-keys/[keyId]/route.ts` PATCH: delete the `report_show_revenue` spread (the validator no longer accepts it).

- [ ] **Step 7: Route map**

`lib/authz/route-map.ts`, in the partner-keys block: remove `"partner-keys/[keyId]/report-link": null,` and add

```ts
  // ── partners (0200) ──────────────────────────────────────────────────────────
  "partners": null, // drip / partner intake -- hidden from the operator
  "partners/[partnerId]": null, // drip / partner intake -- hidden from the operator
  "partners/[partnerId]/archive": null, // drip / partner intake -- hidden from the operator
  "partners/[partnerId]/restore": null, // drip / partner intake -- hidden from the operator
  "partners/[partnerId]/report-link": null, // drip / partner intake -- hidden from the operator
```

Run: `npx tsx scripts/test-route-map-coverage.ts` → passes (every route on disk classified, no stale key).

- [ ] **Step 8: Write the API test (preview deployment) and run it**

`scripts/test-partners-api.ts`: follows `scripts/verify-operator-access.ts` (throwaway owner via `.env.demo` service role, cookie jar, `BASE_URL` = the PR's `camman-*` preview). Steps and expected status codes:

1. `POST /api/partners {slug:"zz-api-test", name:"API test"}` → 201, `can_have_link === true` (file-only), `keys: []`.
2. `POST /api/partners` same slug → 409 `DUPLICATE`.
3. `POST /api/partner-keys {partner_id, name:"k1"}` → 201, `partner_slug === "zz-api-test"`, response carries `secret` + `token`; `POST` again `{partner_id, name:"k2"}` → 201 (same slug, no 409).
4. `GET /api/partners` → the partner has 2 keys, `can_have_link === false` (both sandbox), `unassigned_keys` is an array.
5. `POST /api/partners/[id]/report-link` → 409 `sandbox_only`.
6. `PATCH /api/partner-keys/[k1] {sandbox:false}` → 200; `POST …/report-link` → 200 with `url`; `GET <url>` (no cookie) → 200 and the HTML contains `API test`.
7. `PATCH /api/partners/[id] {report_show_revenue:true}` → 200 `report_show_revenue === true`; `PATCH /api/partner-keys/[k1] {report_show_revenue:true}` → 400.
8. `POST /api/partners/[id]/archive` → 200 `status === "archived"`; `GET <url>` → 404; `POST /api/intake/leads/<k1 token>` with the secret header and a minimal body → 403 body contains `archived`; `POST /api/partner-keys {partner_id, name:"k3"}` → 409 `partner_archived`.
9. `POST /api/partners/[id]/restore` → 200; `GET <url>` → 200 again.
10. `DELETE /api/partners/[id]/report-link` → 200; `GET <url>` → 404.
11. Teardown by id (preview DB, guarded): `DELETE FROM partner_key_usage WHERE partner_key_id IN (…)`, `DELETE FROM lead_inbox WHERE partner_key_id IN (…)` (the 403 wrote nothing, but be explicit), `DELETE FROM partner_keys WHERE id IN (…)`, `DELETE FROM partners WHERE id = …`, then the throwaway membership / org / auth user.

Run it with `NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon> BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-partners-api.ts` → `All checks passed.`

- [ ] **Step 9: Commit**

```bash
git add lib/validators/partners.ts lib/validators/partner-keys.ts lib/partners/queries.ts app/api/partners app/api/partner-keys lib/authz/route-map.ts scripts/test-partners-api.ts
git rm "app/api/partner-keys/[keyId]/report-link/route.ts"
git commit -m "feat(partners): /api/partners CRUD + archive/restore + report link; keys created under a partner"
```

---

### Task 5: Settings → Partners

**Files:**
- Create: `components/settings/partners.tsx` (export `Partners`)
- Create: `components/settings/partner-key-card.tsx` (export `PartnerKeyCard`)
- Create: `components/settings/partner-key-create-dialog.tsx` (export `PartnerKeyCreateDialog`)
- Delete: `components/settings/partner-keys.tsx`
- Modify: `app/(protected)/settings/partners/page.tsx`, `components/protected/nav-config.ts` (label `"Partner Keys"` → `"Partners"`, icon `Handshake`)

**Interfaces:**
- Consumes: Task 4's `GET /api/partners` shape; `POST /api/partners`; `PATCH /api/partners/[id]`; `POST …/archive|restore|report-link`; `DELETE …/report-link`; `POST /api/partner-keys {partner_id,…}`; `PATCH /api/partner-keys/[id]`; `POST /api/partner-keys/[id]/rotate`; `GET /api/partner-keys/[id]` (token reveal).
- Types: `PartnerRow`, `PartnerKeyRow` as declared in Task 4 (declare them once in `components/settings/partner-types.ts`).

- [ ] **Step 1: `partner-key-card.tsx`** — move the per-key `<Card>` JSX from `partner-keys.tsx` lines 205–383 (card header, usage grid, endpoint reveal, actions **Show endpoint URL / Rotate secret / Disable–Enable / Sandbox switch**) verbatim into `PartnerKeyCard({ row, canManage, onChanged })`. **Remove** from it: the Generate/Rotate/Revoke report-link buttons, the "Report links work on live keys only" hint and the **Show revenue** switch (they move to the partner card). The rotate-secret `AlertDialog` and the one-time-secret `FormDialog` stay with the key card (they are per key).

- [ ] **Step 2: `partner-key-create-dialog.tsx`** — the create `FormDialog` from lines 385–466 as `PartnerKeyCreateDialog({ partner, open, onOpenChange, onCreated })`: **no slug input** (the dialog title reads `New key for {partner.name}` and the body says `Slug: {partner.slug} (from the partner)`), fields Name / Interest tag mode / Interest tag; `POST /api/partner-keys` with `partner_id: partner.id`. The one-time secret dialog (`created !== null`, lines 519–560) moves here too.

- [ ] **Step 3: `partners.tsx`** — the page component:

```tsx
"use client";
// Settings → Partners (partner attribution Phase 1). One card per PARTNER;
// its keys are nested cards. The signed report link and the revenue switch are
// partner-level controls since 0200 (Q7/Q10): a partner with two keys, or a
// file-only partner with no key, has exactly one link.
export function Partners() {
  // state: partners (PartnerRow[]), unassigned (PartnerKeyRow[]), tick/reload,
  // newPartnerOpen, newPartnerSlug/Name, createKeyFor (PartnerRow | null),
  // reportLink ({ slug, url } | null), revokeTarget, archiveTarget, restoreTarget
  // load: GET /api/partners → setPartners(r.data.data); setUnassigned(r.data.unassigned_keys)
}
```

Partner card header: `{p.name}` + `<Badge variant="outline">{p.slug}</Badge>` + `{p.status === "archived" && <Badge variant="secondary">archived</Badge>}` + `{p.report_link_active && <Badge>report link</Badge>}`; a line `{p.keys.length} key(s)`.

Partner actions (only when `canManage`):
- **New key** → `setCreateKeyFor(p)` (disabled when archived, title "Restore the partner first").
- **Generate / Rotate report link** → `POST /api/partners/${p.id}/report-link` → `setReportLink({ slug: p.slug, url: r.data.url })`; disabled when `!p.can_have_link` with title `"Report links work for partners with a live key, or with no keys at all. Switch one key out of sandbox first."`; disabled when archived.
- **Revoke report link** (when active) → `AlertDialog` → `DELETE`.
- **Show revenue** `Switch` → `PATCH /api/partners/${p.id} { report_show_revenue }` with the existing toasts.
- **Archive** → `AlertDialog` whose description is exactly:
  > Archiving **{p.name}** disables lead intake on all {p.keys.length} of its keys and kills its report link. Nothing is deleted; Restore re-enables both.
  → `POST /api/partners/${p.id}/archive`.
- **Restore** (when archived) → `POST …/restore` (no confirm).

Below the header: the partner's keys as `<PartnerKeyCard>`s; when none: `No keys yet — this partner delivers files only, or add a key.`

Top of page: **New partner** button → `FormDialog` with Name + Slug (`partnerSlugSchema` rules in the helper text: lowercase letters, digits, _ and -), `POST /api/partners`. The `reportLink` one-time `FormDialog` (lines 469–491) moves here unchanged (`CopyableId`, helper "Scoped to this partner only. Revoke it any time — the URL then 404s.").

If `unassigned.length > 0`, render a final card **Keys without a partner** listing them with `PartnerKeyCard` and the hint `Created before partners existed. Assign by creating the partner and re-creating the key; this list disappears once the follow-up migration makes the link required.`

- [ ] **Step 4: Page + nav copy**

`app/(protected)/settings/partners/page.tsx`: `metadata.title = "Partners"`, `<h1>Partners</h1>`, paragraph: `Partners that send us leads. Each partner owns its intake keys, its signed report link and whether that report shows revenue. New keys start in sandbox: their leads are stored and flagged, and are excluded from sending and reporting until you switch the key live.` Import `Partners` from `@/components/settings/partners`.
`components/protected/nav-config.ts`: `label: "Partners"`, icon `Handshake` (import from lucide-react; drop `KeyRound` if now unused).

- [ ] **Step 5: Lint, type-check, visual check**

Run: `npx eslint components/settings/partners.tsx components/settings/partner-key-card.tsx components/settings/partner-key-create-dialog.tsx "app/(protected)/settings/partners/page.tsx" components/protected/nav-config.ts` → 0 problems (in NEW files, do state resets in event handlers, not effects — `react-hooks/set-state-in-effect`).
Run: `npx tsc --noEmit -p tsconfig.json` → clean.
Visual: on the PR's `camman-*` preview, logged in as the throwaway owner from Task 4's script (keep it alive until this step), screenshot `/settings/partners` showing a partner card with nested keys, the archive confirm dialog, and the New key dialog without a slug field. Save to `c:/AFF/camman/.playwright-mcp/`, attach to card 869fem8bq, delete locally. ⚠️ Never `browser_snapshot` between filling credentials and submitting; end every `browser_run_code_unsafe` on `about:blank` (the result echoes the final URL).

- [ ] **Step 6: Commit**

```bash
git add components/settings/partners.tsx components/settings/partner-key-card.tsx components/settings/partner-key-create-dialog.tsx components/settings/partner-types.ts "app/(protected)/settings/partners/page.tsx" components/protected/nav-config.ts
git rm components/settings/partner-keys.tsx
git commit -m "feat(partners): Settings → Partners — partner cards with nested keys, link and revenue on the partner, archive/restore"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/03-data-model.md` — table row for `partners` next to the `partner_keys` row (currently line 479): PK, UNIQUE(`org_id`,`slug`), partial UNIQUE(`report_token_hash`), status CHECK, RLS SELECT-only; amend the `partner_keys` row: `partner_id` (nullable until the follow-up, C2), slug uniqueness **dropped** (0200), the four `report_*` columns now **dead copies**. ERD (lines ~216–218): add `organizations ||--o{ partners : "lead partners (0200)"` and `partners ||--o{ partner_keys : "intake keys"`.
- Modify: `docs/04-features/drip-partner-reporting.md` — §4 "Signed report links": the link lives on `partners` (one per partner), who may hold one (Q7 table: file-only yes / live key yes / sandbox-only no / archived no), **a disabled key no longer kills the link — archiving the partner does**; §4 endpoints: `POST/DELETE /api/partners/[partnerId]/report-link` (the key route is gone); §10: "Settings → Partners"; "Last updated" line.
- Modify: `docs/04-features/partner-lead-intake.md` — the Settings paragraph (line ~188: the component is now `components/settings/partners.tsx`), and the disabled-key paragraph (~194): add "an archived partner answers 403 `This partner is archived` on every key it owns".
- Modify: `docs/06-integrations.md` lines 134 and 204: "Settings → Partner intake keys" → "Settings → Partners".
- Modify: `docs/07-conventions.md` — new bullet near the partner-report bullets: **"The partner entity (0200) — additive led code (C2): `partner_keys.partner_id` shipped nullable + backfilled, code writes it always, `SET NOT NULL` is the first statement of the next migration batch once prod reads 0 NULLs. The signed link and the revenue flag live on `partners`; the copies on `partner_keys` are dead until a destructive migration drops them."** Update "Last updated".
- Modify: `docs/CHANGELOG.md` — one line, newest-first, CRLF.

- [ ] **Step 1: Make the edits** (CRLF files: edit with a script that preserves `\r\n`, as in PR #327).
- [ ] **Step 2: `npm run check:docs`** → passes.
- [ ] **Step 3: Commit**

```bash
git add docs/03-data-model.md docs/04-features/drip-partner-reporting.md docs/04-features/partner-lead-intake.md docs/06-integrations.md docs/07-conventions.md docs/CHANGELOG.md
git commit -m "docs(partners): partner entity, link on the partner, C2 additive-leads-code"
```

---

### Task 7: Ship — gated

- [ ] **Step 1: Green on the PR.** `tsc`, `eslint` on changed files, `npm run check:guards` (the three new DB scripts import `_require-preview-db`; `partners-phase1-exit-check.ts` is read-only and has no write token), `scripts/test-route-map-coverage.ts`, `scripts/test-operator-permission-matrix.ts` (no new permission ids — Q9), the Task 1/2/4 preview tests, `verify-migration-integrity.ts` on the preview. PR title: `feat(partners): partner entity above partner_keys (0200, Phase 1 of partner attribution)`. PR body lists all of the above and the rollback target (latest `Production – camman` deployment id + sha from `gh api`).

- [ ] **Step 2: STOP — prod migration proposal on card 869fem8bq.** Post: the 0200 SQL summary, "applied to camman-v2 on the PR preview, tests A1–A7/B1–B3 green", the revert script (`ALTER TABLE partner_keys DROP COLUMN partner_id; DROP TABLE partners; CREATE UNIQUE INDEX partner_keys_org_slug_uniq ON partner_keys (org_id, partner_slug);` — only valid while no key has been created under a partner), the window (**attended, any time before 12:00 UTC / 14:00 Warsaw** — F4), and that the merge waits for the apply. **Wait for the owner's explicit go.**

- [ ] **Step 3: Apply (owner's go; attended; before 12:00 UTC).** In this order, the same morning:
  1. Baseline with the OLD code (F1): Task 0 Step 2 — from the detached `partners-baseline` checkout of `origin/main`, `--capture`. Note the printed rate.
  2. From `partners-entity` (`.env.local` = prod): `npm run db:migrate` — the pending list must be exactly `0200_partners`; then `npx tsx scripts/verify-migration-integrity.ts` → `Migration integrity OK.`
  3. `SELECT count(*) FILTER (WHERE partner_id IS NULL) FROM partner_keys` → 0; `SELECT id, slug, status, (report_token_hash IS NOT NULL) AS link FROM partners ORDER BY id` → 4 rows (internal-test, pml, docs-curl-verify, bsd), pml with `link = true`.

- [ ] **Step 4: Merge and deploy.** `gh pr merge --squash`; confirm the `Production – camman` deployment for the merge sha reaches `success`; `git rev-parse origin/main` equals the deployed sha.

- [ ] **Step 5: Exit checks (prod, read-only), minutes after the capture, same morning.**
  - From `partners-entity`: `npx tsx --conditions=react-server scripts/partners-phase1-exit-check.ts --compare` → all PASS: Q10 rows identical, rate unchanged (printed either way), F2 scoped == filtered, F3 the resolver's exact WHERE with key 77's copied hash returns pml's partner. Then tear down the `partners-baseline` checkout.
  - **Owner step (F3):** the owner opens pml's live report link in a browser after the deploy and confirms it renders the same report. The plaintext is the partner's; nothing in this plan reads it.
  - `npx tsx --conditions=react-server scripts/partner-report-cost-proof.ts` → 12/12; `scripts/partner-report-activity-proof.ts` → all pass.
  - `npx tsx scripts/check-intake-hourly-invariant.ts` → passes (intake + digest unchanged).
  - Authenticated smoke: `GET /api/partners` → 200 with 4 partners (pml: `report_link_active true`, `report_show_revenue true`, 1 key); `GET /api/reports/partners?from=<today>&to=<today>` → 200 with `partner_name` on each row; `GET /api/partner-keys/77/report-link` → 404 (route gone).
  - Screenshot `/settings/partners` and `/reports/partners` (Partner column) on prod → card 869fem8bq.

- [ ] **Step 6: Report and stop.** Card comment + chat: what shipped, every check with its result, the rollback target, and "Phase 2 (0201 group link, 0202 appearance repair, auto-link, C4 marker) waits for an explicit go". Update memory `project_partner_group_attribution_recon`.

---

## Deferred to the next batch (not Phase 1)

- `ALTER TABLE partner_keys ALTER COLUMN partner_id SET NOT NULL` — first statement of Phase 2's migration batch (0201), preceded by the 0-NULLs check. Needs a shared fixture helper `scripts/_partner-fixture.ts` (create a partner, then a key) for the 11 scripts that insert `partner_keys` directly (`test-drip-enrichment-schema`, `test-drip-geo-exclude-mode`, `test-drip-lifecycle`, `test-drip-routing-schema`, `test-drip-sends-schema`, `test-drip-unengaged-close`, `test-intake-hourly-db`, `test-intake-schema`, `test-registered-lane-consumers`, `verify-drip-enrichment-production`, `verify-drip-routing-production`).
- Dropping the dead `report_*` columns and `name` from `partner_keys` — a later destructive migration.
- Everything in recon §9.5 phases 2–5.

## Self-review

- Spec coverage: §1.3 (table, backfill, hash copy, slug-uniqueness drop, reader cut-over) → Tasks 1–3; §8.2 (nav, cards, New partner, New key under a partner, archive = soft, link + revenue on the partner, APIs, permissions unchanged) → Tasks 4–5; §8.3 (route map, docs) → Tasks 4, 6; §9.5 phase-1 verifies → Tasks 0, 7; C2 → Task 1 (nullable) + Deferred; Q7 → Tasks 2, 4, 5; Q9 → unchanged permission ids everywhere; Q10 → Task 1 backfill + Task 0/7 exit check; Q11 → Task 3. `SET NOT NULL` and the 17-script fixture helper are explicitly deferred (C2), not forgotten.
- Placeholders: none — every step names files and shows the code or the exact command; the UI task moves existing JSX by line range and states every new string.
- Type consistency: `ResolvedReportToken.partnerId` (Task 2) is what `page.tsx` passes to `getPartnerReport(…, partnerId)` (Task 3); `PARTNER_CAN_HAVE_LINK` (Task 2) is what `PARTNER_ROW_SQL.can_have_link` (Task 4) and the Settings button (Task 5) use; `PartnerRow` / `PartnerKeyRow` are declared once (`partner-types.ts`) and match the `GET /api/partners` JSON.
