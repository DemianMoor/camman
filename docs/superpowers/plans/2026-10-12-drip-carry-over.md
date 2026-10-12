# Drip Carry-Over ("Send leads") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-campaign "Send leads" setting (with an account default) that keeps drip leads not admitted on their arrival ET day eligible for admission on the next 1–7 days, ships OFF, and splits the journey funnel into same-day vs carried.

**Architecture:** Carry-over is purely an ADMISSION (routing) change: a wider freshness window in `lib/drip/routing-eval.ts`, a scan floor in `lib/drip/routing.ts` gated by a trigger-maintained `admission_widened_at` so nothing that already expired can ever re-enter, fresh-first candidate ordering plus a yesterday-based reserve against the daily admission cap, and a `carried_days` stamp on each journey. Scheduler, drain, stages and compliance are untouched.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle (hand-authored migrations) · Postgres (Supabase) · date-fns-tz · shadcn/ui · tsx scripts against the preview DB (camman-v2).

**Spec:** [docs/superpowers/specs/2026-10-12-drip-carry-over-design.md](../specs/2026-10-12-drip-carry-over-design.md)

## Global Constraints

- Default everywhere = "Same day only": `carry_days` NULL on every config, org `drip_carry_days` 0, `widened_at` NULL. With those values every code path must behave exactly as origin/main 58d6ee16.
- N is 0–7 (`MAX_CARRY_DAYS = 7`), DB CHECK + Zod.
- A lead that arrived before the campaign's effective `widened_at` (GREATEST of campaign and org) gets window 0 — the end of its arrival ET day, no carry, no cutoff.
- Leads below the scan floor are never selected. The Oct-10/11 leads must never be evaluated under any setting value.
- Carried = `carried_days > 0` = admitted on a later ET day than arrival. Evening same-day admissions stay 0.
- Fresh lead cap rule unchanged (`today < cap`); carried lead: `today + reserve < cap`; cap NULL ⇒ no reserve.
- Migration is hand-authored (`db:generate` does not work here): SQL + cloned snapshot with bumped `id`/`prevId` + journal entry. Starts with `SET LOCAL lock_timeout = '5s'`. Number **0204**, after 0203 (#342) is merged; rebase onto origin/main first.
- `.env.local` points at PRODUCTION. Every DB test script imports `./_env-preload` then `./_require-preview-db` and is run via `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/<name>.ts`.
- Lint only changed files: `npx eslint <files>`. `npx tsc --noEmit -p .` must be clean.
- Docs are part of done (CLAUDE.md "Documentation maintenance"): data-model + ERD, routing feature doc, partner-reporting/funnel doc, conventions, CHANGELOG, "last updated" dates.
- Merge policy: this PR contains a migration ⇒ STOP and ask the owner before `db:migrate` on prod and before merging.
- UI copy, verbatim: label **"Send leads"**; options **"Same day only"**, **"Also 1 day later"**, **"Also up to N days later"**; helper **"Leads not messaged on their arrival day are dropped from this campaign, or kept and messaged on the following day(s)."**

## File structure

| File | Responsibility |
|---|---|
| `lib/drip/admission-window.ts` (new) | Pure functions: window, widened-at, closes-at, scan floor, is-carried. No DB. Single source of the §4.1 formula |
| `scripts/test-drip-admission-window.ts` (new) | Unit test of the above (no DB) |
| `db/migrations/0204_drip_carry_over.sql` + meta | Columns, CHECKs, two triggers |
| `db/schema.ts` | Drizzle declarations of the new columns |
| `scripts/test-drip-carry-over-trigger.ts` (new) | Trigger behaviour on preview, rolled back |
| `lib/drip/routing-eval.ts` | Freshness via the module; reserve in counts + cap rule |
| `lib/drip/routing.ts` | Floor via the module; fresh-first ORDER BY; `carried_days` on insert |
| `scripts/test-drip-carry-over.ts` (new) | Routing end-to-end on preview (throwaway org) |
| `lib/validators/drip-campaigns.ts`, `app/api/campaigns/[campaignId]/drip-config/route.ts`, `app/api/campaigns/[campaignId]/duplicate/route.ts`, `components/campaigns/drip-config-panel.tsx` | Setting I/O + UI |
| `lib/drip/funnel.ts`, `components/drip/journey-funnel.tsx`, `scripts/test-drip-funnel-split.ts` (new) | Same-day vs carried split |

---

### Task 1: Admission-window module (pure)

**Files:**
- Create: `lib/drip/admission-window.ts`
- Test: `scripts/test-drip-admission-window.ts`

**Interfaces:**
- Consumes: `campaignDayBoundsUtc(now?: Date): { start: Date; end: Date }` from `@/lib/campaign-timezone`
- Produces:
  - `MAX_CARRY_DAYS = 7`
  - `interface AdmissionSettings { cfgCarryDays: number | null; cfgCutoffMinutes: number | null; cfgWidenedAt: Date | string | null; orgCarryDays: number | null; orgCutoffMinutes: number | null; orgWidenedAt: Date | string | null }`
  - `effectiveWidenedAt(s: AdmissionSettings): Date | null`
  - `interface AdmissionClose { closesAt: Date; carryDays: number; cutoffMinutes: number; preWidening: boolean; widenedAt: Date | null }`
  - `admissionCloses(receivedAt: Date | string, s: AdmissionSettings): AdmissionClose`
  - `scanFloor(now: Date, s: AdmissionSettings): Date`
  - `isCarried(receivedAt: Date | string, now: Date): boolean`

- [ ] **Step 1: Write the failing test**

`scripts/test-drip-admission-window.ts`:
```ts
import { fromZonedTime } from "date-fns-tz";

import {
  admissionCloses,
  effectiveWidenedAt,
  isCarried,
  scanFloor,
  type AdmissionSettings,
} from "@/lib/drip/admission-window";

// Pure — no DB. Run: npx tsx scripts/test-drip-admission-window.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const et = (s: string) => fromZonedTime(s, "America/New_York");
const S = (o: Partial<AdmissionSettings> = {}): AdmissionSettings => ({
  cfgCarryDays: null, cfgCutoffMinutes: null, cfgWidenedAt: null,
  orgCarryDays: 0, orgCutoffMinutes: 0, orgWidenedAt: null, ...o,
});
const iso = (d: Date) => d.toISOString();

// W1 — carry 0, never widened == today's rule (end of arrival ET day + cutoff)
for (const [rec, cutoff, want] of [
  ["2026-10-11T10:00:00", 0, "2026-10-12T00:00:00"],
  ["2026-10-11T23:59:00", 0, "2026-10-12T00:00:00"],
  ["2026-10-11T10:00:00", 90, "2026-10-12T01:30:00"],
  ["2026-11-01T10:00:00", 0, "2026-11-02T00:00:00"], // DST end day (25 h)
  ["2026-03-08T10:00:00", 0, "2026-03-09T00:00:00"], // DST start day (23 h)
] as const) {
  const got = admissionCloses(et(rec), S({ cfgCutoffMinutes: cutoff })).closesAt;
  bar(`W1 carry 0 ${rec} cutoff ${cutoff}`, iso(got) === iso(et(want)), iso(got));
}

// W2 — carry N extends by N ET days (DST-safe), then the cutoff
const c1 = admissionCloses(et("2026-10-11T10:00:00"), S({ cfgCarryDays: 1 })).closesAt;
bar("W2 carry 1 → end of next ET day", iso(c1) === iso(et("2026-10-13T00:00:00")), iso(c1));
const c7 = admissionCloses(et("2026-10-31T10:00:00"), S({ cfgCarryDays: 7, cfgCutoffMinutes: 30 })).closesAt;
bar("W2 carry 7 across DST + 30 min", iso(c7) === iso(et("2026-11-08T00:30:00")), iso(c7));

// W3 — campaign override vs org default (NULL inherits)
const inh = admissionCloses(et("2026-10-11T10:00:00"), S({ orgCarryDays: 2 })).closesAt;
bar("W3 NULL carry inherits org 2", iso(inh) === iso(et("2026-10-14T00:00:00")), iso(inh));
const ovr = admissionCloses(et("2026-10-11T10:00:00"), S({ orgCarryDays: 2, cfgCarryDays: 0 })).closesAt;
bar("W3 campaign 0 overrides org 2", iso(ovr) === iso(et("2026-10-12T00:00:00")), iso(ovr));

// W4 — a lead that arrived before the widening gets window 0 (no carry, no cutoff)
const w = et("2026-10-11T15:00:00");
const pre = admissionCloses(et("2026-10-11T10:00:00"), S({ cfgCarryDays: 3, cfgCutoffMinutes: 60, cfgWidenedAt: w }));
bar("W4 pre-widening → midnight of arrival day", pre.preWidening && iso(pre.closesAt) === iso(et("2026-10-12T00:00:00")), iso(pre.closesAt));
const post = admissionCloses(et("2026-10-11T16:00:00"), S({ cfgCarryDays: 3, cfgWidenedAt: w }));
bar("W4 post-widening → full window", !post.preWidening && iso(post.closesAt) === iso(et("2026-10-15T00:00:00")), iso(post.closesAt));

// W5 — effective widened = GREATEST(campaign, org), NULLs ignored
const g = effectiveWidenedAt(S({ cfgWidenedAt: et("2026-10-10T00:00:00"), orgWidenedAt: et("2026-10-11T00:00:00") }));
bar("W5 greatest of campaign/org", g !== null && iso(g) === iso(et("2026-10-11T00:00:00")));
bar("W5 both NULL → null", effectiveWidenedAt(S()) === null);

// W6 — scan floor
const now = et("2026-10-12T09:00:00");
bar("W6 carry 0 → today's midnight", iso(scanFloor(now, S())) === iso(et("2026-10-12T00:00:00")));
bar("W6 cutoff 600 at 09:00 → yesterday's midnight", iso(scanFloor(now, S({ cfgCutoffMinutes: 600 }))) === iso(et("2026-10-11T00:00:00")));
bar("W6 carry 7, never widened → 7 days back", iso(scanFloor(now, S({ cfgCarryDays: 7 }))) === iso(et("2026-10-05T00:00:00")));
bar("W6 ⭐ carry 7 widened yesterday 15:00 → floor = widened_at",
  iso(scanFloor(now, S({ cfgCarryDays: 7, cfgWidenedAt: et("2026-10-11T15:00:00") }))) === iso(et("2026-10-11T15:00:00")));
bar("W6 ⭐ carry 7 widened today 08:00 → today's midnight",
  iso(scanFloor(now, S({ cfgCarryDays: 7, cfgWidenedAt: et("2026-10-12T08:00:00") }))) === iso(et("2026-10-12T00:00:00")));
bar("W6 ⭐ Oct-10 backlog below every floor (carry 7, widened 10-12 08:00)",
  et("2026-10-10T12:00:00") < scanFloor(now, S({ cfgCarryDays: 7, cfgWidenedAt: et("2026-10-12T08:00:00") })));

// W7 — carried = later ET day
bar("W7 same ET day → not carried", !isCarried(et("2026-10-12T00:00:01"), now));
bar("W7 yesterday 23:59 → carried", isCarried(et("2026-10-11T23:59:00"), now));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx tsx scripts/test-drip-admission-window.ts`
Expected: FAIL — `Cannot find module '@/lib/drip/admission-window'`.

- [ ] **Step 3: Implement**

`lib/drip/admission-window.ts`:
```ts
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";

// Drip admission window (carry-over, spec 2026-10-12 §4.1). PURE — no DB, so
// the routing evaluator, the worker's scan floor and the tests share one formula.
//
//   admission closes = end of (arrival ET day + carry days) + cutoff minutes
//
// ⭐ A lead that arrived BEFORE the effective widened_at gets window 0 — the end
// of its arrival day, no carry, no cutoff. Window 0 is the smallest window that
// has ever existed, so a lead that expired under ANY earlier setting is still
// expired: widening the setting can drop pending carries, never revive anything.
// widened_at is stamped by DB triggers (migration 0204), not by callers.

export const MAX_CARRY_DAYS = 7;

export interface AdmissionSettings {
  cfgCarryDays: number | null;
  cfgCutoffMinutes: number | null;
  cfgWidenedAt: Date | string | null;
  orgCarryDays: number | null;
  orgCutoffMinutes: number | null;
  orgWidenedAt: Date | string | null;
}

export interface AdmissionClose {
  closesAt: Date;
  carryDays: number;
  cutoffMinutes: number;
  preWidening: boolean;
  widenedAt: Date | null;
}

const ms = (v: Date | string | null) => (v == null ? null : new Date(v).getTime());

/** GREATEST(campaign, org) — an org-default raise also resets an overriding campaign (drops only). */
export function effectiveWidenedAt(s: AdmissionSettings): Date | null {
  const a = ms(s.cfgWidenedAt);
  const b = ms(s.orgWidenedAt);
  if (a == null && b == null) return null;
  return new Date(Math.max(a ?? -Infinity, b ?? -Infinity));
}

function carryOf(s: AdmissionSettings) {
  return s.cfgCarryDays ?? s.orgCarryDays ?? 0;
}
function cutoffOf(s: AdmissionSettings) {
  return s.cfgCutoffMinutes ?? s.orgCutoffMinutes ?? 0;
}

/** Start of the ET day `days` before the ET day containing `d` (DST-safe). */
function etDayStartBack(d: Date, days: number): Date {
  let start = campaignDayBoundsUtc(d).start;
  for (let i = 0; i < days; i++) start = campaignDayBoundsUtc(new Date(start.getTime() - 1)).start;
  return start;
}

export function admissionCloses(receivedAt: Date | string, s: AdmissionSettings): AdmissionClose {
  const rec = new Date(receivedAt);
  const widenedAt = effectiveWidenedAt(s);
  const preWidening = widenedAt != null && rec.getTime() < widenedAt.getTime();
  const carryDays = preWidening ? 0 : carryOf(s);
  const cutoffMinutes = preWidening ? 0 : cutoffOf(s);
  let end = campaignDayBoundsUtc(rec).end;
  for (let i = 0; i < carryDays; i++) end = campaignDayBoundsUtc(end).end;
  return {
    closesAt: new Date(end.getTime() + cutoffMinutes * 60_000),
    carryDays, cutoffMinutes, preWidening, widenedAt,
  };
}

/**
 * The earliest received_at this campaign could still admit at `now`. With carry
 * 0 and no widening it is today's floor: dayStart(now − cutoff). Leads before
 * widened_at only have their arrival day, so the floor never goes below
 * min(widened_at, today's midnight).
 */
export function scanFloor(now: Date, s: AdmissionSettings): Date {
  const floor = etDayStartBack(new Date(now.getTime() - cutoffOf(s) * 60_000), carryOf(s));
  const widenedAt = effectiveWidenedAt(s);
  if (widenedAt == null) return floor;
  const today = campaignDayBoundsUtc(now).start;
  return new Date(Math.max(floor.getTime(), Math.min(widenedAt.getTime(), today.getTime())));
}

/** Admitted on a later ET day than the lead arrived. */
export function isCarried(receivedAt: Date | string, now: Date): boolean {
  return campaignDayBoundsUtc(new Date(receivedAt)).start.getTime() < campaignDayBoundsUtc(now).start.getTime();
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx tsx scripts/test-drip-admission-window.ts`
Expected: every line `✓`, final `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**
```bash
git add lib/drip/admission-window.ts scripts/test-drip-admission-window.ts
git commit -m "feat(drip): admission-window module for carry-over (pure, tested)"
```

---

### Task 2: Migration 0204 — columns, CHECKs, widened-at triggers

**Files:**
- Create: `db/migrations/0204_drip_carry_over.sql`, `db/migrations/meta/0204_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts` (org_settings ~line 3526, drip_campaign_configs ~line 5498 + checks, drip_journeys ~line 5565)
- Test: `scripts/test-drip-carry-over-trigger.ts`

**Interfaces:**
- Produces (DB): `org_settings.drip_carry_days int NOT NULL DEFAULT 0`, `org_settings.drip_admission_widened_at timestamptz`, `drip_campaign_configs.carry_days int`, `drip_campaign_configs.admission_widened_at timestamptz`, `drip_journeys.carried_days smallint NOT NULL DEFAULT 0`. Triggers `org_settings_drip_admission_widened`, `drip_campaign_configs_admission_widened`.

- [ ] **Step 0: Rebase** — `git fetch origin && git rebase origin/main`. Confirm `db/migrations/0203_drip_admission_cutoff_cap.sql` exists and the journal's last entry is idx 203. If #342 is not merged yet, stop and wait.

- [ ] **Step 1: Write the failing trigger test**

`scripts/test-drip-carry-over-trigger.ts`:
```ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";

// Migration 0204 triggers, on the PREVIEW DB, inside one transaction that is
// rolled back (no residue).
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-carry-over-trigger.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
class Rollback extends Error {}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: SQL) => ((await tx.execute(q)) as unknown as T[])[0];
      const orgId = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES ('__CARRY_TRIGGER_TEST__') RETURNING id`)).id;
      await tx.execute(sql`INSERT INTO org_settings (org_id) VALUES (${orgId}::uuid)
                           ON CONFLICT (org_id) DO NOTHING`);
      const camp = async (carry: number | null, cutoff: number | null) => {
        const id = (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type)
          VALUES (${orgId}::uuid, ${"ct-" + Math.random().toString(36).slice(2, 9)}, 'CT', 'active', 'drip')
          RETURNING id`)).id;
        await tx.execute(sql`
          INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, carry_days, admission_cutoff_minutes)
          VALUES (${id}, ${orgId}::uuid, 'ct', ${carry}, ${cutoff})`);
        return id;
      };
      const stamp = async (id: number) =>
        (await one<{ w: string | null }>(sql`
          SELECT admission_widened_at AS w FROM drip_campaign_configs WHERE campaign_id = ${id}`)).w;
      const orgStamp = async () =>
        (await one<{ w: string | null }>(sql`
          SELECT drip_admission_widened_at AS w FROM org_settings WHERE org_id = ${orgId}::uuid`)).w;
      const clear = (id: number) => tx.execute(sql`
        UPDATE drip_campaign_configs SET admission_widened_at = NULL WHERE campaign_id = ${id}`);

      const a = await camp(null, null);
      bar("T1 INSERT with window 0 → no stamp", (await stamp(a)) === null);
      const b = await camp(1, null);
      bar("T2 INSERT with carry 1 → stamped", (await stamp(b)) !== null);

      await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = 2 WHERE campaign_id = ${a}`);
      bar("T3 raise carry 0→2 → stamped", (await stamp(a)) !== null);
      await clear(a);
      await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = 1 WHERE campaign_id = ${a}`);
      bar("T4 lower carry 2→1 → NOT stamped", (await stamp(a)) === null);
      await tx.execute(sql`UPDATE drip_campaign_configs SET admission_cutoff_minutes = 30 WHERE campaign_id = ${a}`);
      bar("T5 raise cutoff → stamped", (await stamp(a)) !== null);
      await clear(a);
      await tx.execute(sql`UPDATE drip_campaign_configs SET priority = 5 WHERE campaign_id = ${a}`);
      bar("T6 unrelated column → NOT stamped", (await stamp(a)) === null);

      // Upsert path used by PUT /drip-config: INSERT … ON CONFLICT DO UPDATE
      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, carry_days)
        VALUES (${a}, ${orgId}::uuid, 'ct', 3)
        ON CONFLICT (campaign_id) DO UPDATE SET carry_days = EXCLUDED.carry_days`);
      bar("T7 upsert raise 1→3 → stamped", (await stamp(a)) !== null);

      bar("T8 org INSERT default → no stamp", (await orgStamp()) === null);
      await tx.execute(sql`UPDATE org_settings SET drip_carry_days = 1 WHERE org_id = ${orgId}::uuid`);
      bar("T9 org raise → org stamped", (await orgStamp()) !== null);

      let rejected = false;
      try {
        await tx.execute(sql`SAVEPOINT s8`);
        await tx.execute(sql`UPDATE drip_campaign_configs SET carry_days = 8 WHERE campaign_id = ${a}`);
      } catch { rejected = true; await tx.execute(sql`ROLLBACK TO SAVEPOINT s8`); }
      bar("T10 carry_days 8 rejected by CHECK", rejected);

      const cd = (await one<{ d: number }>(sql`
        SELECT column_default AS d FROM information_schema.columns
        WHERE table_name = 'drip_journeys' AND column_name = 'carried_days'`)).d;
      bar("T11 drip_journeys.carried_days default 0", String(cd) === "0", String(cd));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL PASS (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it — expect failure**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-carry-over-trigger.ts`
Expected: error `column "carry_days" of relation "drip_campaign_configs" does not exist`.

- [ ] **Step 3: Write the migration**

`db/migrations/0204_drip_carry_over.sql`:
```sql
-- 0204: drip carry-over ("Send leads"). Additive. Leads the code that reads it.
-- Spec: docs/superpowers/specs/2026-10-12-drip-carry-over-design.md
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "drip_carry_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "drip_admission_widened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_drip_carry_days_check";--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_drip_carry_days_check"
  CHECK ("drip_carry_days" >= 0 AND "drip_carry_days" <= 7);--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD COLUMN IF NOT EXISTS "carry_days" integer;--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD COLUMN IF NOT EXISTS "admission_widened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" DROP CONSTRAINT IF EXISTS "drip_campaign_configs_carry_days_check";--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD CONSTRAINT "drip_campaign_configs_carry_days_check"
  CHECK ("carry_days" IS NULL OR ("carry_days" >= 0 AND "carry_days" <= 7));--> statement-breakpoint
-- Constant default ⇒ metadata-only on PG ≥ 11: drip_journeys is not rewritten.
ALTER TABLE "drip_journeys" ADD COLUMN IF NOT EXISTS "carried_days" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drip_journeys" DROP CONSTRAINT IF EXISTS "drip_journeys_carried_days_check";--> statement-breakpoint
ALTER TABLE "drip_journeys" ADD CONSTRAINT "drip_journeys_carried_days_check" CHECK ("carried_days" >= 0);--> statement-breakpoint
-- ⭐ widened_at is stamped HERE, for every writer (API, SQL, duplicate route),
-- whenever the effective admission window gets LONGER. Leads that arrived
-- before it are same-day only — that is what keeps already-skipped leads out.
CREATE OR REPLACE FUNCTION drip_org_admission_widened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.drip_carry_days * 1440 + NEW.drip_admission_cutoff_minutes > 0 THEN
      NEW.drip_admission_widened_at := now();
    END IF;
  ELSIF NEW.drip_carry_days * 1440 + NEW.drip_admission_cutoff_minutes
      > OLD.drip_carry_days * 1440 + OLD.drip_admission_cutoff_minutes THEN
    NEW.drip_admission_widened_at := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "org_settings_drip_admission_widened" ON "org_settings";--> statement-breakpoint
CREATE TRIGGER "org_settings_drip_admission_widened"
  BEFORE INSERT OR UPDATE OF "drip_carry_days", "drip_admission_cutoff_minutes" ON "org_settings"
  FOR EACH ROW EXECUTE FUNCTION drip_org_admission_widened();--> statement-breakpoint
CREATE OR REPLACE FUNCTION drip_cfg_admission_widened() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o_carry integer := 0;
  o_cut integer := 0;
  new_w integer;
  old_w integer := 0;
BEGIN
  SELECT os.drip_carry_days, os.drip_admission_cutoff_minutes INTO o_carry, o_cut
  FROM org_settings os WHERE os.org_id = NEW.org_id;
  o_carry := COALESCE(o_carry, 0);
  o_cut := COALESCE(o_cut, 0);
  new_w := COALESCE(NEW.carry_days, o_carry) * 1440 + COALESCE(NEW.admission_cutoff_minutes, o_cut);
  IF TG_OP = 'UPDATE' THEN
    old_w := COALESCE(OLD.carry_days, o_carry) * 1440 + COALESCE(OLD.admission_cutoff_minutes, o_cut);
  END IF;
  IF new_w > old_w THEN
    NEW.admission_widened_at := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "drip_campaign_configs_admission_widened" ON "drip_campaign_configs";--> statement-breakpoint
CREATE TRIGGER "drip_campaign_configs_admission_widened"
  BEFORE INSERT OR UPDATE OF "carry_days", "admission_cutoff_minutes" ON "drip_campaign_configs"
  FOR EACH ROW EXECUTE FUNCTION drip_cfg_admission_widened();
```

Snapshot + journal (Node, no BOM):
```bash
node -e '
const fs=require("fs");const p="db/migrations/meta/";
const s=JSON.parse(fs.readFileSync(p+"0203_snapshot.json","utf8"));
s.prevId=s.id; s.id="0204a000-0204-4204-8204-000000000204";
const col=(name,type,notNull,def)=>{const c={name,type,primaryKey:false,notNull};if(def!==undefined)c.default=def;return c;};
const os=s.tables["public.org_settings"], cfg=s.tables["public.drip_campaign_configs"], j=s.tables["public.drip_journeys"];
os.columns.drip_carry_days=col("drip_carry_days","integer",true,0);
os.columns.drip_admission_widened_at=col("drip_admission_widened_at","timestamp with time zone",false);
cfg.columns.carry_days=col("carry_days","integer",false);
cfg.columns.admission_widened_at=col("admission_widened_at","timestamp with time zone",false);
cfg.checkConstraints.drip_campaign_configs_carry_days_check={name:"drip_campaign_configs_carry_days_check",value:"\"drip_campaign_configs\".\"carry_days\" IS NULL OR (\"drip_campaign_configs\".\"carry_days\" >= 0 AND \"drip_campaign_configs\".\"carry_days\" <= 7)"};
j.columns.carried_days=col("carried_days","smallint",true,0);
fs.writeFileSync(p+"0204_snapshot.json",JSON.stringify(s,null,2)+"\n");
const jr=JSON.parse(fs.readFileSync(p+"_journal.json","utf8"));
const last=jr.entries[jr.entries.length-1];
jr.entries.push({idx:204,version:"7",when:last.when+86400000,tag:"0204_drip_carry_over",breakpoints:true});
fs.writeFileSync(p+"_journal.json",JSON.stringify(jr,null,2)+"\n");'
diff db/migrations/meta/0203_snapshot.json db/migrations/meta/0204_snapshot.json | head -40
```
Expected diff: id/prevId bump plus the five added columns and one check — nothing else.

`db/schema.ts` — in `org_settings` after `drip_admission_cutoff_minutes`:
```ts
  // Carry-over (0204): drip admission stays open this many extra ET days.
  // 0 = same day only. CHECK 0..7. Per-campaign override: drip_campaign_configs.carry_days.
  drip_carry_days: integer("drip_carry_days").notNull().default(0),
  // Stamped by trigger org_settings_drip_admission_widened whenever the org's
  // window (carry×1440 + cutoff) grows. Leads that arrived earlier are same day only.
  drip_admission_widened_at: timestamp("drip_admission_widened_at", { withTimezone: true }),
```
In `drip_campaign_configs` after `admission_cutoff_minutes`:
```ts
    // Carry-over (0204): NULL = the org default (org_settings.drip_carry_days).
    carry_days: integer("carry_days"),
    // Stamped by trigger drip_campaign_configs_admission_widened when this
    // campaign's effective window grows (never by application code).
    admission_widened_at: timestamp("admission_widened_at", { withTimezone: true }),
```
and in its check list:
```ts
    check(
      "drip_campaign_configs_carry_days_check",
      sql`${table.carry_days} IS NULL OR (${table.carry_days} >= 0 AND ${table.carry_days} <= 7)`,
    ),
```
In `drip_journeys` after `first_send_at`:
```ts
    // Carry-over (0204): ET days between the lead's arrival and its admission.
    // 0 = same day (incl. an evening admission texted next morning). > 0 = carried.
    carried_days: smallint("carried_days").notNull().default(0),
```
(add `smallint` to the `drizzle-orm/pg-core` import if absent).

- [ ] **Step 4: Apply to the PREVIEW DB and run the test**

Push the branch and open a draft PR (`gh pr create --draft`) — the preview deploy auto-migrates camman-v2. When the `Vercel – camman-v2` check passes:
Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-carry-over-trigger.ts`
Expected: T1–T11 `✓`, `ALL PASS (rolled back)`.

- [ ] **Step 5: tsc + commit**
```bash
npx tsc --noEmit -p .
git add db/migrations/0204_drip_carry_over.sql db/migrations/meta/0204_snapshot.json db/migrations/meta/_journal.json db/schema.ts scripts/test-drip-carry-over-trigger.ts
git commit -m "feat(drip): migration 0204 — carry_days, admission_widened_at triggers, journeys.carried_days"
```

---

### Task 3: Evaluator — carry-aware freshness + reserve

**Files:**
- Modify: `lib/drip/routing-eval.ts` (RawRow ~84-125, `CampaignJourneyCounts`/`loadCampaignJourneyCounts` ~139-165, SELECT ~213-236, freshness ~348-358, caps ~478-490)

**Interfaces:**
- Consumes: Task 1 `admissionCloses`, `isCarried`, `AdmissionSettings`
- Produces: `CampaignJourneyCounts = Map<number, { total: number; today: number; reserve: number }>` (Task 4 increments `total`/`today`, leaves `reserve`). Freshness detail for carry 0 is byte-identical to today's.

- [ ] **Step 1: RawRow + SELECT.** Add to `interface RawRow`:
```ts
  org_carry_days: number | null;
  org_widened_at: string | null;
  cfg_carry_days: number | null;
  cfg_widened_at: string | null;
  journeys_reserve: number;
```
In the SELECT, after `AS org_cutoff_minutes,`:
```sql
      (SELECT os.drip_carry_days FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_carry_days,
      (SELECT os.drip_admission_widened_at FROM org_settings os
        WHERE os.org_id = ${orgId}::uuid) AS org_widened_at,
```
after `cfg.admission_cutoff_minutes AS cfg_cutoff_minutes,`:
```sql
      cfg.carry_days AS cfg_carry_days, cfg.admission_widened_at AS cfg_widened_at,
```
In the `counts ? … : …` block, replace the `counts` branch with `sql\`0 AS journeys_total, 0 AS journeys_today, 0 AS journeys_reserve,\`` and append to the non-counts branch, after `AS journeys_today,`:
```sql
      COALESCE((SELECT count(*)::int FROM drip_journeys j4
                WHERE j4.campaign_id = c.id AND j4.state <> 'unroutable' AND j4.carried_days = 0
                  AND j4.routed_at >= ${now.toISOString()}::timestamptz - interval '24 hours'
                  AND j4.routed_at < date_trunc('day', ${now.toISOString()}::timestamptz
                        AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'), 0)
        AS journeys_reserve,
```

- [ ] **Step 2: Counts.** Replace the type and loader body:
```ts
/** Journeys per campaign (excluding 'unroutable'): all-time, current ET day, and
 *  the carry-over RESERVE — same-day journeys routed yesterday from this time of
 *  day to midnight, i.e. the fresh volume today's afternoon is expected to bring. */
export type CampaignJourneyCounts = Map<number, { total: number; today: number; reserve: number }>;
```
```ts
  const rows = (await dbc.execute(sql`
    SELECT j.campaign_id,
           count(*)::int AS total,
           count(*) FILTER (
             WHERE j.routed_at >= date_trunc('day', ${now.toISOString()}::timestamptz
                     AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')::int AS today,
           count(*) FILTER (
             WHERE j.carried_days = 0
               AND j.routed_at >= ${now.toISOString()}::timestamptz - interval '24 hours'
               AND j.routed_at < date_trunc('day', ${now.toISOString()}::timestamptz
                     AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')::int AS reserve
    FROM drip_journeys j
    JOIN campaigns c ON c.id = j.campaign_id
    WHERE j.org_id = ${orgId}::uuid AND j.state <> 'unroutable'
      AND c.type = 'drip' AND c.status IN ('active', 'paused')
    GROUP BY j.campaign_id
  `)) as unknown as { campaign_id: number; total: number; today: number; reserve: number }[];
  return new Map(rows.map((r) => [Number(r.campaign_id), { total: r.total, today: r.today, reserve: r.reserve }]));
```

- [ ] **Step 3: Freshness.** Replace the block from `const cutoffMin = …` through the closing `}` of `if (rules.freshness !== "pass")` with:
```ts
    const adm = admissionCloses(head.received_at, {
      cfgCarryDays: r.cfg_carry_days, cfgCutoffMinutes: r.cfg_cutoff_minutes, cfgWidenedAt: r.cfg_widened_at,
      orgCarryDays: head.org_carry_days, orgCutoffMinutes: head.org_cutoff_minutes, orgWidenedAt: head.org_widened_at,
    });
    rules.freshness = now.getTime() < adm.closesAt.getTime() ? "pass" : "mismatch";
    if (rules.freshness !== "pass") {
      detail.freshness = adm.preWidening
        ? `lead arrived ${head.received_at}, before this campaign's admission window was widened ` +
          `(${adm.widenedAt!.toISOString()}) — same day only; admission closed ${adm.closesAt.toISOString()}`
        : `lead arrived ${head.received_at}; admission closed ${adm.closesAt.toISOString()} ` +
          (adm.carryDays === 0
            ? `(end of arrival ET day + ${adm.cutoffMinutes} min)`
            : `(end of arrival ET day + ${adm.carryDays} day(s) + ${adm.cutoffMinutes} min)`);
    }
```
Add `import { admissionCloses, isCarried } from "./admission-window";`. The SQL `arrival_day_end` column stays (other readers may use it; remove only if `git grep arrival_day_end` shows no other reader, and then from both RawRow and SELECT).

- [ ] **Step 4: Cap rule.** Replace the `cached`/`admOk` lines:
```ts
    const cached = counts ? (counts.get(Number(r.campaign_id)) ?? { total: 0, today: 0, reserve: 0 }) : null;
    const journeysTotal = cached ? cached.total : r.journeys_total;
    const journeysToday = cached ? cached.today : r.journeys_today;
    // ⭐ Fresh leads first (carry-over D1): a CARRIED lead may only use the cap
    // left after holding back yesterday's same-time-onward fresh volume. A fresh
    // lead ignores the reserve, so with carry off nothing here changes.
    const carried = isCarried(head.received_at, now);
    const reserve = carried ? (cached ? cached.reserve : Number(r.journeys_reserve ?? 0)) : 0;
```
and:
```ts
    const admOk = r.cfg_admission_cap == null || journeysToday + reserve < r.cfg_admission_cap;
    rules.routing_daily_admission = admOk ? "pass" : "blocked";
    if (!admOk) {
      detail.routing_daily_admission = carried && journeysToday < r.cfg_admission_cap!
        ? `carried lead held back for today's fresh arrivals: ${journeysToday} routed today + ` +
          `reserve ${reserve} >= cap ${r.cfg_admission_cap}`
        : `today's routing admission cap ${r.cfg_admission_cap} reached ` +
          `(${journeysToday} routed today) — this is NOT the send-time daily cap`;
    }
```

- [ ] **Step 5: Typecheck** — `npx tsc --noEmit -p .` Expected: errors only in `lib/drip/routing.ts` where `counts.set` lacks `reserve` (fixed in Task 4). Do not commit yet; Task 4 completes the compile.

---

### Task 4: Worker — floor, fresh-first order, carried_days; routing test

**Files:**
- Modify: `lib/drip/routing.ts` (header comment ~37-48, floor ~92-104, candidate query ~108-118, insert ~138-152)
- Test: `scripts/test-drip-carry-over.ts`

**Interfaces:**
- Consumes: Task 1 `scanFloor`, `AdmissionSettings`; Task 3 counts shape
- Produces: `drip_journeys.carried_days` populated on every routed insert

- [ ] **Step 1: Write the failing routing test**

`scripts/test-drip-carry-over.ts` — copy the org/partner/campaign/lead helpers verbatim from `scripts/test-drip-routing-queue.ts` lines 1-80 (MARKER `"__DRIP_CARRY_OVER_TEST__"`, phone prefix `+1995`), with `mkCampaign` extended:
```ts
    const mkCampaign = async (tag: string, cfg: { admissionCap?: number; carry?: number | null } = {}) => {
      const id = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}::uuid, ${`co-${sfx}-${tag}`}, ${`CO ${tag}`}, 'active', 'drip') RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, routing_daily_admission_cap, carry_days)
        VALUES (${id}, ${orgId}::uuid, ${tag}, ${cfg.admissionCap ?? null}, ${cfg.carry ?? null})`);
      return id;
    };
    const setWidened = (id: number, at: Date) => db.execute(sql`
      UPDATE drip_campaign_configs SET admission_widened_at = ${at.toISOString()}::timestamptz WHERE campaign_id = ${id}`);
    const tick = () => runDripRoutingBatch(new Date(), { onlyOrgId: orgId });
    const journey = (leadId: string) => one<{ state: string; carried_days: number } | undefined>(sql`
      SELECT state, carried_days FROM drip_journeys WHERE lead_event_id = ${leadId}::uuid`);
    const evaluated = (leadId: string) => one<{ n: number }>(sql`
      SELECT (drip_recheck_at IS NOT NULL OR EXISTS (SELECT 1 FROM drip_journeys j WHERE j.lead_event_id = e.id))::int AS n
      FROM lead_events e WHERE e.id = ${leadId}::uuid`);
```
Scenarios (each campaign has its own tag so they don't interfere; `now = new Date()`, `today = campaignDayBoundsUtc(now).start`, `yStart = campaignDayBoundsUtc(new Date(today.getTime() - 1)).start`):
```ts
    const now = new Date();
    const today = campaignDayBoundsUtc(now).start;
    const yStart = campaignDayBoundsUtc(new Date(today.getTime() - 1)).start;
    const T = new Date(yStart.getTime() + 15 * 3600_000);           // yesterday 15:00 ET
    const freshAt = new Date(Math.min(today.getTime() + 1000, now.getTime()));

    // C1 carry 0 — only today's lead is admitted, carried_days 0
    const c0 = await mkCampaign("c0");
    const c0Old = await mkLead("c0", new Date(yStart.getTime() + 20 * 3600_000));
    const c0New = await mkLead("c0", freshAt);
    // C2 carry 1 widened at T — before T never evaluated, after T admitted carried
    const c1 = await mkCampaign("c1", { carry: 1 });
    await setWidened(c1, T);
    const c1Pre = await mkLead("c1", new Date(T.getTime() - 3600_000));
    const c1Post = await mkLead("c1", new Date(T.getTime() + 3600_000));
    // C3 backlog: 50 leads two days ago, campaign carry 7 widened at T
    const c7 = await mkCampaign("c7", { carry: 7 });
    await setWidened(c7, T);
    const backlog = [];
    for (let i = 0; i < 50; i++) backlog.push(await mkLead("c7", new Date(yStart.getTime() - 12 * 3600_000 - i * 1000)));

    await tick();

    bar("C1 carry 0: yesterday's lead not admitted", (await journey(c0Old.id)) === undefined);
    const j0 = await journey(c0New.id);
    bar("C1 carry 0: today's lead admitted, carried_days 0", j0?.state === "routed" && j0.carried_days === 0, JSON.stringify(j0));
    bar("C2 ⭐ pre-widening lead NEVER evaluated", (await evaluated(c1Pre.id)).n === 0);
    const j1 = await journey(c1Post.id);
    bar("C2 post-widening lead admitted with carried_days 1", j1?.state === "routed" && j1.carried_days === 1, JSON.stringify(j1));
    let backlogTouched = 0;
    for (const b of backlog) backlogTouched += (await evaluated(b.id)).n;
    bar("C3 ⭐ backlog never evaluated under carry 7", backlogTouched === 0, `${backlogTouched}/50`);

    // C4 priority + reserve. cap 10; 8 fresh + 5 carried; reserve seeded as
    // same-day journeys routed yesterday 1 min before midnight.
    const seedReserve = async (campaignId: number, tag: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const l = await mkLead(tag, new Date(today.getTime() - 120_000));
        await db.execute(sql`
          INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
          VALUES (${orgId}::uuid, ${campaignId}, ${l.contactId}::uuid, ${l.id}::uuid, 'routed',
                  ${new Date(today.getTime() - 60_000).toISOString()}::timestamptz, '{}'::jsonb, 0)`);
      }
    };
    const scenario = async (tag: string, reserve: number, fresh: number, carriedN: number) => {
      const id = await mkCampaign(tag, { admissionCap: 10, carry: 1 });
      await setWidened(id, T);
      await seedReserve(id, tag, reserve);
      const cs = []; for (let i = 0; i < carriedN; i++) cs.push(await mkLead(tag, new Date(T.getTime() + 60_000 + i * 1000)));
      const fs = []; for (let i = 0; i < fresh; i++) fs.push(await mkLead(tag, new Date(freshAt.getTime() - i)));
      await tick();
      const routed = async (ls: { id: string }[]) => {
        let n = 0; for (const l of ls) if ((await journey(l.id))?.state === "routed") n++; return n;
      };
      return { fresh: await routed(fs), carried: await routed(cs) };
    };
    const r0 = await scenario("r0", 0, 8, 5);
    bar("C4 ⭐ reserve 0: 8 fresh + 2 carried (fresh first)", r0.fresh === 8 && r0.carried === 2, JSON.stringify(r0));
    const r3 = await scenario("r3", 3, 8, 5);
    bar("C5 reserve 3: 8 fresh + 0 carried", r3.fresh === 8 && r3.carried === 0, JSON.stringify(r3));
    const r9 = await scenario("r9", 9, 8, 0);
    bar("C6 fresh leads ignore the reserve: 8 of 8", r9.fresh === 8, JSON.stringify(r9));

    // C7 lowering to 0 stops carries on the next tick
    const low = await mkCampaign("lo", { carry: 1 });
    await setWidened(low, T);
    await db.execute(sql`UPDATE drip_campaign_configs SET carry_days = 0 WHERE campaign_id = ${low}`);
    const lowLead = await mkLead("lo", new Date(T.getTime() + 3600_000));
    await tick();
    bar("C7 carry lowered to 0: carried lead not admitted", (await journey(lowLead.id)) === undefined);
```
Teardown: copy the `finally` org-cascade delete from `test-drip-routing-queue.ts`, and add `DELETE FROM drip_journeys WHERE org_id = …` before contacts if the FK requires it (follow that script's order). Exit 1 on any failure.

Note C4 relies on the batch evaluating all 13 leads in one tick (batch 600) with fresh ones ordered first — this is the ordering assertion. If the test is run between 00:00 and 00:02 ET, `freshAt` collapses; rerun.

- [ ] **Step 2: Run it — expect failure**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-carry-over.ts`
Expected: tsc-level failure from Task 3 or C2/C3/C4 `✗` (old floor/order, `carried_days` always 0).

- [ ] **Step 3: Floor.** Replace the `cut` query, `maxCutoffMin` and `floor` lines with:
```ts
    // The earliest arrival any live/paused campaign (or the org default) could
    // still admit. ⭐ scanFloor never goes below a campaign's widened_at (except
    // today's own arrivals), so leads that expired before a widening — the
    // Oct-10/11 backlog, anything freshness already skipped — never re-enter.
    const settingRows = (await db.execute(sql`
      SELECT cfg.carry_days, cfg.admission_cutoff_minutes, cfg.admission_widened_at,
             os.drip_carry_days, os.drip_admission_cutoff_minutes, os.drip_admission_widened_at
      FROM org_settings os
      LEFT JOIN campaigns c ON c.org_id = os.org_id AND c.type = 'drip' AND c.status IN ('active', 'paused')
      LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
      WHERE os.org_id = ${orgId}::uuid
    `)) as unknown as {
      carry_days: number | null; admission_cutoff_minutes: number | null; admission_widened_at: string | null;
      drip_carry_days: number; drip_admission_cutoff_minutes: number; drip_admission_widened_at: string | null;
    }[];
    const settingsOf = (r: (typeof settingRows)[number], orgOnly: boolean): AdmissionSettings => ({
      cfgCarryDays: orgOnly ? null : r.carry_days,
      cfgCutoffMinutes: orgOnly ? null : r.admission_cutoff_minutes,
      cfgWidenedAt: orgOnly ? null : r.admission_widened_at,
      orgCarryDays: r.drip_carry_days, orgCutoffMinutes: r.drip_admission_cutoff_minutes,
      orgWidenedAt: r.drip_admission_widened_at,
    });
    const floorMs = Math.min(
      // the org default too, as the old GREATEST(org, max(cfg)) did
      ...(settingRows.length > 0 ? [scanFloor(now, settingsOf(settingRows[0], true)).getTime()] : []),
      ...settingRows.map((r) => scanFloor(now, settingsOf(r, false)).getTime()),
      campaignDayBoundsUtc(now).start.getTime(),
    );
    const floor = new Date(floorMs);
    const todayStart = campaignDayBoundsUtc(now).start;
```
Import `scanFloor`, `type AdmissionSettings` from `./admission-window`.

- [ ] **Step 4: Candidate order.** Replace the `ORDER BY` line:
```sql
      -- ⭐ Fresh leads first (carry-over D1): today's arrivals, never-evaluated
      -- before re-checks, oldest first (#335, unchanged); then carried leads,
      -- never-evaluated before re-checks, NEWEST first (day 1 before day 2).
      ORDER BY (e.received_at < ${todayStart.toISOString()}::timestamptz),
               (e.drip_recheck_at IS NOT NULL),
               CASE WHEN e.received_at < ${todayStart.toISOString()}::timestamptz
                    THEN -extract(epoch FROM e.received_at)
                    ELSE extract(epoch FROM e.received_at) END
```

- [ ] **Step 5: Insert + counts.** In the routed `INSERT INTO drip_journeys`, add `carried_days` to the column list and to VALUES:
```sql
            INSERT INTO drip_journeys
              (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
            VALUES (${orgId}::uuid, ${verdict.winner.campaign_id}, ${verdict.contact_id}::uuid,
                    ${verdict.lead_event_id}::uuid, 'routed', ${now.toISOString()}::timestamptz,
                    ${JSON.stringify(reason)}::jsonb,
                    GREATEST(0, (${now.toISOString()}::timestamptz AT TIME ZONE 'America/New_York')::date
                              - (${verdict.received_at}::timestamptz AT TIME ZONE 'America/New_York')::date))
```
and the in-tick increment:
```ts
          const c = counts.get(verdict.winner.campaign_id) ?? { total: 0, today: 0, reserve: 0 };
          counts.set(verdict.winner.campaign_id, { total: c.total + 1, today: c.today + 1, reserve: c.reserve });
```
Update the header comment's FRESHNESS paragraph:
```ts
// ⭐ FRESHNESS + CARRY-OVER (drip only). A lead is admitted only until the end
// of (its ARRIVAL ET DAY + carry days) + a cutoff — lib/drip/admission-window.ts.
// Carry defaults to 0 (same day only). The candidate query never looks below
// the earliest arrival any campaign could still admit, and that floor never
// goes below a widening, so leads freshness already skipped are never
// evaluated or written to again. Today's arrivals are evaluated before carried
// ones, and a carried lead only uses cap left after a reserve (routing-eval.ts).
```

- [ ] **Step 6: Run the new test and every regression**
```bash
npx tsc --noEmit -p .
npx tsx scripts/test-drip-admission-window.ts
P="node scripts/with-preview-env.mjs npx tsx --conditions=react-server"
$P scripts/test-drip-carry-over.ts
$P scripts/test-drip-routing-queue.ts
$P scripts/test-drip-stop-controls.ts
$P scripts/test-drip-regular-unaffected.ts
$P scripts/test-drip-geo-exclude-mode.ts
$P scripts/test-drip-enrichment-throughput.ts
$P scripts/test-drip-item6-queues.ts
```
Expected: all `ALL PASS` / zero `✗`. `test-drip-routing-queue` Q8/Q9 must pass unchanged (carry 0 ⇒ same floor and same freshness detail).

- [ ] **Step 7: Production plan check (read-only, Supabase MCP on `rtdarhkkjwcetlmruftl`).** `EXPLAIN` (no ANALYZE) the new candidate query text with the org id from `SELECT org_id FROM org_settings WHERE drip_enabled` and the floor literal set to 2 ET days back; confirm it uses `lead_events_drip_candidates_idx` and a top-N sort, not a seq scan. Record the plan in the PR.

- [ ] **Step 8: Commit**
```bash
npx eslint lib/drip/routing.ts lib/drip/routing-eval.ts lib/drip/admission-window.ts
git add lib/drip/routing.ts lib/drip/routing-eval.ts scripts/test-drip-carry-over.ts
git commit -m "feat(drip): carry-over routing — widened-at floor, fresh-first order, reserve, carried_days"
```

---

### Task 5: Setting I/O — validator, API, duplicate, panel

**Files:**
- Modify: `lib/validators/drip-campaigns.ts` (~67), `app/api/campaigns/[campaignId]/drip-config/route.ts` (GET ~38-50, PUT ~105-140), `app/api/campaigns/[campaignId]/duplicate/route.ts` (~199-206), `components/campaigns/drip-config-panel.tsx` (type ~40-52, state ~95-125, save ~200-215, Freshness box ~341-362)

**Interfaces:**
- Consumes: `MAX_CARRY_DAYS` (Task 1)
- Produces: API field `carry_days: number | null` (0–7; omitted = keep; null = account default); GET adds `carry_days`, `org_carry_days`

- [ ] **Step 1: Validator.** After `admission_cutoff_minutes`:
```ts
    // Carry-over (0204): extra ET days a lead stays admissible. NULL = account
    // default. OMITTED = keep (the campaign editor never sends it).
    carry_days: z.number().int().min(0).max(MAX_CARRY_DAYS).nullable().optional(),
```
Import `MAX_CARRY_DAYS` from `@/lib/drip/admission-window`.

- [ ] **Step 2: API.** GET select: add `cfg.carry_days,` and
```sql
           (SELECT os.drip_carry_days FROM org_settings os
             WHERE os.org_id = c.org_id) AS org_carry_days,
```
PUT INSERT: add `carry_days` to the column list and `${input.carry_days ?? null}` to VALUES (after `admission_cutoff_minutes`). ON CONFLICT SET, after the cutoff CASE:
```sql
        carry_days = CASE WHEN ${sent("carry_days")}
                          THEN EXCLUDED.carry_days
                          ELSE drip_campaign_configs.carry_days END,
```
Check `sent()` reads keys from the raw body (it does since #338); confirm `"carry_days"` needs no list registration — `git grep -n "function sent\|const sent" app/api/campaigns/\[campaignId\]/drip-config/route.ts`.

- [ ] **Step 3: Duplicate route.** Add `carry_days` to both the column list and the SELECT list of the drip_campaign_configs copy, next to `admission_cutoff_minutes`. Do NOT copy `admission_widened_at` — the trigger stamps it on INSERT when the window is > 0. Run `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-campaign-duplicate-type.ts` — expected pass.

- [ ] **Step 4: Panel.** Type: add `carry_days: number | null; org_carry_days: number | null;`. State + load:
```ts
  // "" = account default; "0" | "1" = fixed; "n" = up to N (carryN holds 2..7)
  const [carryMode, setCarryMode] = useState("");
  const [carryN, setCarryN] = useState("2");
```
```ts
        const cd = r.data.carry_days;
        setCarryMode(cd == null ? "" : cd <= 1 ? String(cd) : "n");
        setCarryN(cd != null && cd >= 2 ? String(cd) : "2");
```
Save body, after `admission_cutoff_minutes`:
```ts
        carry_days: carryMode === "" ? null : carryMode === "n" ? Number(carryN) : Number(carryMode),
```
In the Freshness box grid, after the cutoff `<div>`:
```tsx
              <div>
                <Label htmlFor="drip-carry" className="text-xs">Send leads</Label>
                <Select
                  value={carryMode === "" ? "default" : carryMode}
                  onValueChange={(v) => setCarryMode(v === "default" ? "" : v)}
                  disabled={!canEdit}
                >
                  <SelectTrigger id="drip-carry" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      Account default ({carryLabel(cfg?.org_carry_days ?? 0)})
                    </SelectItem>
                    <SelectItem value="0">Same day only</SelectItem>
                    <SelectItem value="1">Also 1 day later</SelectItem>
                    <SelectItem value="n">Also up to N days later</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {carryMode === "n" && (
                <div>
                  <Label htmlFor="drip-carry-n" className="text-xs">N (days, 2–{MAX_CARRY_DAYS})</Label>
                  <Input
                    id="drip-carry-n"
                    inputMode="numeric"
                    value={carryN}
                    onChange={(e) => setCarryN(e.target.value)}
                    disabled={!canEdit}
                  />
                </div>
              )}
```
Below the existing helper `<p>`, add the owner's helper verbatim:
```tsx
            <p className="text-muted-foreground text-xs">
              Leads not messaged on their arrival day are dropped from this campaign, or kept and
              messaged on the following day(s).
            </p>
```
Module-level helper:
```ts
const carryLabel = (d: number) =>
  d === 0 ? "Same day only" : d === 1 ? "Also 1 day later" : `Also up to ${d} days later`;
```
Imports: `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` from `@/components/ui/select`; `MAX_CARRY_DAYS` from `@/lib/drip/admission-window`. (Plain `<Select>`: ≤10 options, CLAUDE.md §9.) If `carryMode === "n"` and `carryN` is not an integer 2–7, the server's Zod rejects it and `toastApiError` shows the message — no client-side duplicate validation.

- [ ] **Step 5: Verify on the PR preview** — open the campaign page on the preview deploy (`reference_preview_operator_verify_recipe` / Playwright recipe in memory), set "Also up to N days later" N=3, save, reload: the select shows N=3; set "Account default", save, reload: GET returns `carry_days: null`. Then confirm a panel save without touching the select keeps `carry_days` (campaign editor path: `PUT` without the key leaves it).

- [ ] **Step 6: Commit**
```bash
npx tsc --noEmit -p .
npx eslint lib/validators/drip-campaigns.ts "app/api/campaigns/[campaignId]/drip-config/route.ts" "app/api/campaigns/[campaignId]/duplicate/route.ts" components/campaigns/drip-config-panel.tsx
git add lib/validators/drip-campaigns.ts "app/api/campaigns/[campaignId]/drip-config/route.ts" "app/api/campaigns/[campaignId]/duplicate/route.ts" components/campaigns/drip-config-panel.tsx
git commit -m "feat(drip): Send leads setting in drip settings (API, duplicate, panel)"
```

---

### Task 6: Journey funnel — same-day vs carried split

**Files:**
- Modify: `lib/drip/funnel.ts` (types ~44-80, `getDripFunnel` ~114-247), `components/drip/journey-funnel.tsx` (after the "How far they got" block)
- Test: `scripts/test-drip-funnel-split.ts`

**Interfaces:**
- Produces:
```ts
export interface FunnelSplitRow { routed: number; sent: number; clicked: number; sales: number }
export interface FunnelSplit { same_day: FunnelSplitRow; carried: FunnelSplitRow; unmatched_sales: number }
// DripFunnel gains:  split: FunnelSplit | null   (null ⇔ no carried journey in this campaign)
export async function getDripFunnel(orgId: string, campaignId: number, dbc?: DbOrTx): Promise<DripFunnel>
```

- [ ] **Step 1: Write the failing test**

`scripts/test-drip-funnel-split.ts`: follow `scripts/test-drip-lifecycle.ts`'s pattern — one `db.transaction`, first org on preview (`SELECT id FROM organizations ORDER BY created_at LIMIT 1`), throw a `Rollback` at the end. Inside: create a drip campaign; 6 contacts; journeys: 4 with `carried_days 0` (3 with `first_send_at = now()`), 2 with `carried_days 1` (2 sent); seed purchases with `seedConversionEvent(tx, { orgId, eventKey: "purchase", contactId, campaignId, occurredAt })` — 2 on same-day contacts, 1 on a carried contact (occurred after its routed_at), 1 on a contact with NO journey (unmatched). Then:
```ts
      const f = await getDripFunnel(orgId, campId, tx);
      bar("S1 split present", f.split !== null);
      const s = f.split!;
      bar("S2 routed halves sum", s.same_day.routed + s.carried.routed === f.progression.routed, JSON.stringify(s));
      bar("S3 sent halves sum", s.same_day.sent + s.carried.sent === f.progression.sent);
      bar("S4 clicked halves sum", s.same_day.clicked + s.carried.clicked === f.progression.clicked);
      bar("S5 sales + unmatched = converted",
        s.same_day.sales + s.carried.sales + s.unmatched_sales === f.progression.converted);
      bar("S6 exact: same-day 4/3 sent/2 sales; carried 2/2/1; unmatched 1",
        s.same_day.routed === 4 && s.same_day.sent === 3 && s.same_day.sales === 2 &&
        s.carried.routed === 2 && s.carried.sent === 2 && s.carried.sales === 1 && s.unmatched_sales === 1);
      // S7: with no carried journeys the split is null
      await tx.execute(sql`UPDATE drip_journeys SET carried_days = 0 WHERE campaign_id = ${campId}`);
      bar("S7 no carried journeys → split null", (await getDripFunnel(orgId, campId, tx)).split === null);
```
Required journey columns: copy the INSERT shape used for journeys in `test-drip-lifecycle.ts` (it satisfies the closed_at/close_reason CHECKs), adding `carried_days`.

- [ ] **Step 2: Run — expect failure** (`getDripFunnel` takes 2 args / `split` undefined).
Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-funnel-split.ts`

- [ ] **Step 3: Implement.** Add the `dbc` parameter (`type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];`) and replace every `db.execute` in `getDripFunnel` with `dbc.execute`. Before the `return`:
```ts
  // ── same-day vs carried (carry-over spec §8). Total only; Today stays
  // event-based and unsplit. Sales go to the contact's journey in this campaign
  // routed most recently at or before the sale; a sale with none is shown as
  // unmatched rather than dropped, so the halves + unmatched = converted.
  const splitRows = (await dbc.execute(sql`
    WITH jj AS (
      SELECT j.contact_id, j.routed_at, j.first_send_at, (j.carried_days > 0) AS carried,
             COALESCE(t.tier, 0) AS tier
      FROM drip_journeys j
      LEFT JOIN (${campaignTierExpr(campaignId, orgId)}) t ON t.contact_id = j.contact_id
      WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
    ), sales AS (
      SELECT (SELECT x.carried FROM jj x
               WHERE x.contact_id = ce.contact_id AND x.routed_at <= ce.occurred_at
               ORDER BY x.routed_at DESC LIMIT 1) AS carried
      FROM conversion_events ce
      WHERE ce.org_id = ${orgId}::uuid AND ce.campaign_id = ${campaignId} AND ${purchasedClause()}
    )
    SELECT
      (SELECT count(*) FROM jj WHERE carried)::int                                AS carried_journeys,
      (SELECT count(*) FROM jj WHERE NOT carried)::int                            AS sd_routed,
      (SELECT count(*) FROM jj WHERE NOT carried AND first_send_at IS NOT NULL)::int AS sd_sent,
      (SELECT count(*) FROM jj WHERE NOT carried AND tier >= 1)::int             AS sd_clicked,
      (SELECT count(*) FROM jj WHERE carried)::int                                AS co_routed,
      (SELECT count(*) FROM jj WHERE carried AND first_send_at IS NOT NULL)::int AS co_sent,
      (SELECT count(*) FROM jj WHERE carried AND tier >= 1)::int                 AS co_clicked,
      (SELECT count(*) FROM sales WHERE carried IS FALSE)::int                    AS sd_sales,
      (SELECT count(*) FROM sales WHERE carried IS TRUE)::int                     AS co_sales,
      (SELECT count(*) FROM sales WHERE carried IS NULL)::int                     AS unmatched_sales
  `)) as unknown as Record<string, number>[];
  const sp = splitRows[0] ?? {};
  const split: FunnelSplit | null = Number(sp.carried_journeys ?? 0) === 0 ? null : {
    same_day: { routed: Number(sp.sd_routed), sent: Number(sp.sd_sent), clicked: Number(sp.sd_clicked), sales: Number(sp.sd_sales) },
    carried: { routed: Number(sp.co_routed), sent: Number(sp.co_sent), clicked: Number(sp.co_clicked), sales: Number(sp.co_sales) },
    unmatched_sales: Number(sp.unmatched_sales),
  };
```
and add `split,` to the returned object. (Progression's `clicked` counts `tier >= 1` over the same join, so the halves sum exactly.)

- [ ] **Step 4: UI.** In `journey-funnel.tsx`, after the "How far they got" `<div>`:
```tsx
      {funnel.split && <CarrySplit split={funnel.split} />}
```
```tsx
function CarrySplit({ split }: { split: FunnelSplit }) {
  const rows: [string, FunnelSplitRow][] = [["Same day", split.same_day], ["Carried", split.carried]];
  const ctr = (r: FunnelSplitRow) => (r.sent > 0 ? `${((r.clicked / r.sent) * 100).toFixed(1)}%` : "—");
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium tracking-wide uppercase">Same day vs carried</h4>
      <p className="text-muted-foreground mb-3 text-xs">
        Carried = admitted on a later day than the lead arrived. All-time counts.
        {split.unmatched_sales > 0 && ` ${split.unmatched_sales.toLocaleString()} sale(s) matched no journey.`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th className="text-left font-normal" />
              <th className="text-right font-normal">Routed</th>
              <th className="text-right font-normal">Sent</th>
              <th className="text-right font-normal">Clicked</th>
              <th className="text-right font-normal">CTR</th>
              <th className="text-right font-normal">Sales</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, r]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="text-right">{r.routed.toLocaleString()}</td>
                <td className="text-right">{r.sent.toLocaleString()}</td>
                <td className="text-right">{r.clicked.toLocaleString()}</td>
                <td className="text-right">{ctr(r)}</td>
                <td className="text-right">{r.sales.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```
Import `FunnelSplit, FunnelSplitRow` types from `@/lib/drip/funnel`.

- [ ] **Step 5: Run test → pass; regressions**
```bash
P="node scripts/with-preview-env.mjs npx tsx --conditions=react-server"
$P scripts/test-drip-funnel-split.ts
$P scripts/test-drip-lifecycle.ts
npx tsc --noEmit -p .
npx eslint lib/drip/funnel.ts components/drip/journey-funnel.tsx
```
Expected: all pass. `git grep -n "getDripFunnel(" -- app lib components` — every existing caller still compiles with the defaulted third arg.

- [ ] **Step 6: Commit**
```bash
git add lib/drip/funnel.ts components/drip/journey-funnel.tsx scripts/test-drip-funnel-split.ts
git commit -m "feat(drip): journey funnel same-day vs carried split"
```

---

### Task 7: Docs, PR, ship gate

**Files:**
- Modify: `docs/03-data-model.md` (rows for the 5 columns + both triggers; Mermaid ERD: add `carried_days` to `drip_journeys`, `carry_days`/`admission_widened_at` to `drip_campaign_configs`), `docs/04-features/drip-campaigns-routing.md` (new section "Carry-over — Send leads" replacing the 0203 "full guard ships with carry-over" sentence: formula, widened-at rule, floor, order, reserve, carried_days, UI), `docs/04-features/drip-partner-reporting.md` (funnel split), `docs/05-flows.md` (routing sequence: floor/order/reserve if the diagram shows candidate selection), `docs/07-conventions.md` (⭐ "widened_at is trigger-stamped; never re-admit pre-widening leads; a raise drops, never revives"), `docs/CHANGELOG.md` (one line), "last updated" on each.

- [ ] **Step 1: Write the docs** (above). Every claim names a real file path.
- [ ] **Step 2: Full verification**
```bash
npx tsc --noEmit -p .
npx eslint lib/drip/admission-window.ts lib/drip/routing.ts lib/drip/routing-eval.ts lib/drip/funnel.ts lib/validators/drip-campaigns.ts "app/api/campaigns/[campaignId]/drip-config/route.ts" "app/api/campaigns/[campaignId]/duplicate/route.ts" components/campaigns/drip-config-panel.tsx components/drip/journey-funnel.tsx
npm run check:guards
npx tsx scripts/test-drip-admission-window.ts
P="node scripts/with-preview-env.mjs npx tsx --conditions=react-server"
for s in test-drip-carry-over-trigger test-drip-carry-over test-drip-funnel-split test-drip-routing-queue test-drip-stop-controls test-drip-regular-unaffected test-drip-geo-exclude-mode test-drip-enrichment-throughput test-drip-item6-queues test-campaign-duplicate-type test-drip-lifecycle; do echo "== $s"; $P scripts/$s.ts || echo "FAILED $s"; done
```
Expected: no `FAILED`, no `✗`. New prod-writing scripts: none (all use `requirePreviewDb`); if `check:guards` flags one, fix the script, don't add an exclusion.
- [ ] **Step 3: PR** — mark ready; body lists every bar above with result, the prod EXPLAIN from Task 4 Step 7, and the rollback target (current prod deployment id from `vercel ls camman --prod` / `gh api …deployments?environment=Production%20%E2%80%93%20camman`).
- [ ] **Step 4: ⛔ STOP — owner gate (migration).** Ask the owner for go on: `npm run db:migrate` against prod, `npx tsx scripts/verify-migration-integrity.ts` (must end "Migration integrity OK."), then merge.
- [ ] **Step 5: After the go** — migrate, verify integrity, merge, confirm prod deployment sha == merge commit and `state: success`, then read-only prod checks:
```sql
SELECT count(*) FILTER (WHERE carry_days IS NOT NULL) AS overrides,
       count(*) FILTER (WHERE admission_widened_at IS NOT NULL) AS widened FROM drip_campaign_configs;  -- 0, 0
SELECT drip_carry_days, drip_admission_widened_at FROM org_settings;                                      -- 0, NULL
SELECT count(*) FILTER (WHERE carried_days > 0) FROM drip_journeys WHERE routed_at > now() - interval '1 hour'; -- 0
```
plus the drip-routing cron summary lines for the hour after deploy vs the hour before (routed/expired comparable), and the 1606 campaign page shows no "Same day vs carried" section. Update memory + the card.
