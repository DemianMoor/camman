# Drip Hourly Send Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-drip-campaign "Hourly send cap" (+ "Carry unsent leads to the next hour") that limits first sends per ET clock hour inside the daily cap, drops or queues leads that miss their hour, ships behind an org flag with zero behaviour change.

**Architecture:** All enforcement lives in the drip scheduler. Each journey carries `hour_start` / `hour_fresh` (its clock hour; NULL = waiting). Before the due query, a per-campaign maintenance pass assigns fresh leads, closes past hours (OFF: drop/demote; ON: keep as queue), reverts on stop controls, releases backlog into spare room, and returns the room left this hour. `selectDueJourneys` takes that room map (required) so a full hour takes no batch slots. Counts are derived from `drip_journeys.first_send_at` every run — no counter table. Routing, drain, compliance, follow-ups are untouched.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle (hand-authored migrations) · Postgres (Supabase) · shadcn/ui · tsx scripts against the preview DB (camman-v2).

**Spec:** [docs/superpowers/specs/2026-10-13-drip-hourly-send-cap-design.md](../specs/2026-10-13-drip-hourly-send-cap-design.md)

## Global Constraints

- Default = no change: `hourly_cap` NULL on every config, `hourly_carry` false, `org_settings.drip_hourly_cap_enabled` false. With those values every code path must select, order and send exactly as origin/main 24980a52.
- Hour key = `date_trunc('hour', <utc instant>)` / `hourStartOf()` — never a local-time truncation (DST fall-back).
- Hourly cap counts FIRST sends only (`drip_journeys.first_send_at`). Follow-ups (`lib/drip/followups.ts`) are never counted and never blocked (R6).
- Under OFF, released backlog (`hour_fresh = false`) is NEVER dropped; fresh leads are never dropped in favour of backlog (R1: demote newest `min(U, B)`).
- Drop write: `state='expired'`, `closed_at=now()`, `close_reason ∈ {missed_hour_cap, missed_hour_closed, missed_hour_blocked}`, `reason || {missed_hour:{…}}`. Contact rows are never written.
- §11b: every new selection input on an internal type is REQUIRED (no `?:`, no default). The PUT body keeps "omitted = keep stored value" (#338).
- Drizzle `sql` flattens JS arrays: pass id lists as ONE string param `${`{${ids.join(",")}}`}::uuid[]`.
- Migration is hand-authored: SQL + cloned snapshot (`id` new uuid, `prevId` = 0208's `id`) + `_journal.json` entry. Starts with `SET LOCAL lock_timeout = '5s'`. Number **0209**. No BOM in JSON (use the Write tool).
- `.env.local` points at PRODUCTION. Every DB test imports `./_env-preload` then `./_require-preview-db`, run via `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/<name>.ts`.
- Lint only changed files: `npx eslint <files>`. `npx tsc --noEmit -p .` must be clean.
- Docs are part of done: `docs/03-data-model.md` + ERD, `docs/04-features/drip-campaigns-routing.md`, `docs/05-flows.md` (scheduler sequence), `docs/07-conventions.md`, `docs/CHANGELOG.md`, "last updated" dates.
- Migration PR ⇒ STOP and ask the owner before prod `db:migrate` and before merging.
- UI copy, verbatim: label **"Hourly send cap"**, placeholder **"unlimited"**, helper **"First sends per ET clock hour, inside the daily cap. Follow-ups don't count."**; checkbox **"Carry unsent leads to the next hour"**, helper OFF-state **"Leads that miss their hour are dropped from this campaign (they stay normal contacts)."**

## File structure

| File | Responsibility |
|---|---|
| `lib/drip/hourly-cap.ts` (new) | PURE: hour key, window test, backlog room, hour-end plan, lead ordering, close-reason map |
| `scripts/test-drip-hourly-cap-pure.ts` (new) | Unit test of the above (no DB) |
| `db/migrations/0209_drip_hourly_cap.sql` + `meta/0209_snapshot.json` + `_journal.json` | Columns, CHECKs, indexes |
| `db/schema.ts` | Drizzle declarations |
| `scripts/test-drip-hourly-cap-schema.ts` (new) | Columns/CHECKs/indexes exist on preview |
| `lib/drip/hourly-maintenance.ts` (new) | DB: clear, assign, close hour, revert, release, counts, refusal record, `prepareHourly` orchestrator |
| `scripts/_drip-hourly-fixture.ts` (new) | Throwaway org/campaign/journey fixture + teardown |
| `scripts/test-drip-hourly-maintenance.ts` (new) | H2, H4–H6, H11, H12 at the maintenance boundary |
| `lib/drip/scheduler.ts` | Call clear + `prepareHourly`; `selectDueJourneys(…, hourly)`; room gate; refusal record |
| `scripts/test-drip-scheduler-fairness.ts` | Pass `hourly: new Map()`; add H1, H3, H9 |
| `lib/validators/drip-campaigns.ts`, `app/api/campaigns/[campaignId]/drip-config/route.ts`, `app/api/campaigns/[campaignId]/duplicate/route.ts`, `lib/drip/change-events.ts`, `components/campaigns/drip-config-panel.tsx` | Setting I/O, ON→OFF revert, UI |
| `scripts/test-drip-hourly-config.ts` (new) | H13 + keep-if-omitted |
| `lib/drip/funnel.ts`, `components/drip/hourly-cap-panel.tsx` (new), `components/drip/journey-funnel.tsx` | Outcome labels + hourly panel |
| `app/api/drip/why-not-routed/route.ts`, `components/drip/why-not-routed.tsx` | close_reason + missed-hour text |

---

### Task 1: Pure hourly-cap module

**Files:**
- Create: `lib/drip/hourly-cap.ts`
- Test: `scripts/test-drip-hourly-cap-pure.ts`

**Interfaces:**
- Consumes: `StageWindow`, `etMinutesOfDay` from `lib/drip/windows.ts`.
- Produces:
  - `HOUR_MS: number`
  - `hourStartOf(at: Date): Date`
  - `minutesIntoHour(at: Date): number`
  - `inAnyWindow(at: Date, windows: StageWindow[]): boolean`
  - `type MissedHourCause = "cap" | "closed" | "blocked"`
  - `MISSED_HOUR_CLOSE_REASON: Record<MissedHourCause, string>`
  - `interface HourCounts { sentInHour: number; freshUnsentInHour: number; backlogUnsentInHour: number; queuedUnsent: number }`
  - `backlogRoom(i: { cap: number; carry: boolean; counts: HourCounts; minutesIntoHour: number }): number`
  - `interface FreshUnsent { journeyId: string; routedAt: Date; blocked: boolean }`
  - `planHourEnd(i: { cap: number; sentInHour: number; backlogSentInHour: number; freshUnsent: FreshUnsent[] }): { demote: string[]; drop: { journeyId: string; cause: MissedHourCause }[] }`
  - `orderForHour<T extends { hour_start: string | Date | null; hour_fresh: boolean | null; routed_at: string | Date; journey_id: string }>(rows: T[], carry: boolean): T[]`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test-drip-hourly-cap-pure.ts
// Pure unit test — no DB.  npx tsx scripts/test-drip-hourly-cap-pure.ts
import {
  backlogRoom, hourStartOf, inAnyWindow, minutesIntoHour, MISSED_HOUR_CLOSE_REASON,
  orderForHour, planHourEnd,
} from "@/lib/drip/hourly-cap";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const at = (iso: string) => new Date(iso);

// hour key
bar("P1 hourStartOf truncates to the UTC hour",
  hourStartOf(at("2026-10-13T14:37:12.345Z")).toISOString() === "2026-10-13T14:00:00.000Z");
// 2026-11-01 fall-back: 01:30 EDT = 05:30Z, 01:30 EST = 06:30Z — two distinct hours
bar("P2 DST fall-back: the two 01:xx ET hours stay distinct",
  hourStartOf(at("2026-11-01T05:30:00Z")).getTime() !== hourStartOf(at("2026-11-01T06:30:00Z")).getTime());
bar("P3 minutesIntoHour", Math.abs(minutesIntoHour(at("2026-10-13T14:15:30Z")) - 15.5) < 1e-9);

// window test (ET; 2026-10-13 is EDT = UTC-4). Window 09:00–18:00 ET = 540–1080.
const w = [{ stage_id: 1, window_start_min: 540, window_end_min: 1080 }];
bar("P4 09:00 ET is inside (half-open start)", inAnyWindow(at("2026-10-13T13:00:00Z"), w));
bar("P5 18:00 ET is outside (half-open end)", !inAnyWindow(at("2026-10-13T22:00:00Z"), w));
bar("P6 08:59 ET is outside", !inAnyWindow(at("2026-10-13T12:59:00Z"), w));

// backlog room
const c = (s: number, f: number, b: number, q: number) =>
  ({ sentInHour: s, freshUnsentInHour: f, backlogUnsentInHour: b, queuedUnsent: q });
bar("P7 OFF at :30, cap 60, nothing yet ⇒ paced to 30",
  backlogRoom({ cap: 60, carry: false, counts: c(0, 0, 0, 0), minutesIntoHour: 30 }) === 30);
bar("P8 OFF fresh pending take room first",
  backlogRoom({ cap: 60, carry: false, counts: c(10, 45, 0, 0), minutesIntoHour: 59 }) === 5);
bar("P9 OFF released-but-unsent backlog counts against pacing",
  backlogRoom({ cap: 60, carry: false, counts: c(0, 0, 30, 0), minutesIntoHour: 30 }) === 0);
bar("P10 OFF at :00 still releases ceil(cap/60)",
  backlogRoom({ cap: 120, carry: false, counts: c(0, 0, 0, 0), minutesIntoHour: 0 }) === 2);
bar("P11 ON: cap − sent − everything assigned, no pacing",
  backlogRoom({ cap: 100, carry: true, counts: c(20, 10, 5, 30), minutesIntoHour: 1 }) === 35);
bar("P12 never negative",
  backlogRoom({ cap: 10, carry: true, counts: c(20, 0, 0, 0), minutesIntoHour: 1 }) === 0);

// hour-end plan
const f = (id: string, min: number, blocked = false) =>
  ({ journeyId: id, routedAt: at(`2026-10-13T14:${String(min).padStart(2, "0")}:00Z`), blocked });
const p1 = planHourEnd({ cap: 3, sentInHour: 3, backlogSentInHour: 2,
  freshUnsent: [f("a", 1), f("b", 2), f("c", 3), f("d", 4), f("x", 5, true)] });
bar("P13 newest min(U,B) demoted",
  JSON.stringify(p1.demote) === JSON.stringify(["c", "d"]), JSON.stringify(p1.demote));
bar("P14 oldest dropped as cap, blocked dropped as blocked",
  JSON.stringify(p1.drop) === JSON.stringify([
    { journeyId: "x", cause: "blocked" }, { journeyId: "a", cause: "cap" }, { journeyId: "b", cause: "cap" },
  ]), JSON.stringify(p1.drop));
const p2 = planHourEnd({ cap: 10, sentInHour: 4, backlogSentInHour: 0, freshUnsent: [f("a", 1)] });
bar("P15 below cap ⇒ cause closed", p2.drop.length === 1 && p2.drop[0].cause === "closed" && p2.demote.length === 0);
bar("P16 close reasons", MISSED_HOUR_CLOSE_REASON.cap === "missed_hour_cap" &&
  MISSED_HOUR_CLOSE_REASON.closed === "missed_hour_closed" &&
  MISSED_HOUR_CLOSE_REASON.blocked === "missed_hour_blocked");

// ordering
const r = (id: string, hour: string | null, fresh: boolean | null, routed: string) =>
  ({ journey_id: id, hour_start: hour, hour_fresh: fresh, routed_at: routed });
const rows = [
  r("fresh15", "2026-10-13T15:00:00Z", true, "2026-10-13T15:05:00Z"),
  r("back15", "2026-10-13T15:00:00Z", false, "2026-10-12T23:00:00Z"),
  r("queue14", "2026-10-13T14:00:00Z", true, "2026-10-13T14:30:00Z"),
];
bar("P17 ON: queue first (hour), then routed_at",
  orderForHour(rows, true).map((x) => x.journey_id).join() === "queue14,back15,fresh15");
bar("P18 OFF: fresh first, then backlog",
  orderForHour(rows.slice(0, 2), false).map((x) => x.journey_id).join() === "fresh15,back15");

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '@/lib/drip/hourly-cap'`)

Run: `npx tsx scripts/test-drip-hourly-cap-pure.ts`

- [ ] **Step 3: Implement**

```ts
// lib/drip/hourly-cap.ts
import { etMinutesOfDay, type StageWindow } from "./windows";

// Drip hourly send cap (spec 2026-10-13). PURE — no DB, so the maintenance
// pass, the scheduler and the tests share one definition of each rule.
//
// ⭐ THE HOUR KEY IS THE UTC HOUR. ET offsets are whole hours, so ET clock-hour
// boundaries ARE UTC hour boundaries — and truncating the UTC instant keeps the
// DST fall-back night's two 01:xx ET hours distinct, which a local-time
// truncation would merge into one capped hour.

export const HOUR_MS = 3_600_000;

export function hourStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

export function minutesIntoHour(at: Date): number {
  return (at.getTime() - hourStartOf(at).getTime()) / 60_000;
}

/** Half-open [start, end), the same rule as pickStage. */
export function inAnyWindow(at: Date, windows: StageWindow[]): boolean {
  const m = etMinutesOfDay(at);
  return windows.some((w) => m >= w.window_start_min && m < w.window_end_min);
}

export type MissedHourCause = "cap" | "closed" | "blocked";

export const MISSED_HOUR_CLOSE_REASON: Record<MissedHourCause, string> = {
  cap: "missed_hour_cap",
  closed: "missed_hour_closed",
  blocked: "missed_hour_blocked",
};

export interface HourCounts {
  /** First sends in the current hour (follow-ups never count). */
  sentInHour: number;
  freshUnsentInHour: number;
  backlogUnsentInHour: number;
  /** Assigned to an EARLIER hour, still unsent (ON only — OFF closes them). */
  queuedUnsent: number;
}

/**
 * How many waiting leads may be released into the current hour.
 * ON: whatever the hour has left after everything already assigned.
 * OFF (R1): fresh first — and backlog paced evenly over the hour, so a late
 * fresh burst still finds room. ceil(cap × max(m,1)/60) lets the first minute
 * release a little rather than nothing.
 */
export function backlogRoom(i: {
  cap: number; carry: boolean; counts: HourCounts; minutesIntoHour: number;
}): number {
  const { sentInHour, freshUnsentInHour, backlogUnsentInHour, queuedUnsent } = i.counts;
  if (i.carry) {
    return Math.max(0, i.cap - sentInHour - freshUnsentInHour - backlogUnsentInHour - queuedUnsent);
  }
  const room = i.cap - sentInHour - freshUnsentInHour - backlogUnsentInHour;
  const paced = Math.ceil((i.cap * Math.max(i.minutesIntoHour, 1)) / 60) - sentInHour - backlogUnsentInHour;
  return Math.max(0, Math.min(room, paced));
}

export interface FreshUnsent { journeyId: string; routedAt: Date; blocked: boolean }

/**
 * OFF, at the end of hour H. Blocked leads (a gate/mint refusal during H) drop
 * as `blocked`. Of the rest, the backlog took B slots of H, so the NEWEST
 * min(U, B) are demoted to waiting instead of dropped (R1: a fresh lead is never
 * dropped in favour of the backlog); the oldest drop as `cap` if H's first sends
 * reached the cap, else `closed` (window shut / daily cap first).
 */
export function planHourEnd(i: {
  cap: number; sentInHour: number; backlogSentInHour: number; freshUnsent: FreshUnsent[];
}): { demote: string[]; drop: { journeyId: string; cause: MissedHourCause }[] } {
  const blocked = i.freshUnsent.filter((f) => f.blocked);
  const rest = i.freshUnsent
    .filter((f) => !f.blocked)
    .sort((a, b) => a.routedAt.getTime() - b.routedAt.getTime() || a.journeyId.localeCompare(b.journeyId));
  const nDemote = Math.min(rest.length, i.backlogSentInHour);
  const cause: MissedHourCause = i.sentInHour >= i.cap ? "cap" : "closed";
  return {
    demote: rest.slice(rest.length - nDemote).map((f) => f.journeyId),
    drop: [
      ...blocked.map((f) => ({ journeyId: f.journeyId, cause: "blocked" as const })),
      ...rest.slice(0, rest.length - nDemote).map((f) => ({ journeyId: f.journeyId, cause })),
    ],
  };
}

const t = (v: string | Date | null) => (v == null ? 0 : new Date(v).getTime());

/** Send order inside one hourly-capped campaign. ON: queue first, oldest first.
 *  OFF: fresh first, backlog fills (R1). Ties: routed_at, then id. */
export function orderForHour<T extends {
  hour_start: string | Date | null; hour_fresh: boolean | null;
  routed_at: string | Date; journey_id: string;
}>(rows: T[], carry: boolean): T[] {
  return [...rows].sort((a, b) =>
    (carry ? t(a.hour_start) - t(b.hour_start) : Number(a.hour_fresh === false) - Number(b.hour_fresh === false)) ||
    t(a.routed_at) - t(b.routed_at) ||
    a.journey_id.localeCompare(b.journey_id));
}
```

- [ ] **Step 4: Run — expect `All checks passed.`**

Run: `npx tsx scripts/test-drip-hourly-cap-pure.ts`

- [ ] **Step 5: Lint + commit**

```bash
npx eslint lib/drip/hourly-cap.ts scripts/test-drip-hourly-cap-pure.ts
git add lib/drip/hourly-cap.ts scripts/test-drip-hourly-cap-pure.ts
git commit -m "feat(drip): pure hourly-cap rules (hour key, room, hour-end plan, order)"
```

---

### Task 2: Migration 0209 + schema

**Files:**
- Create: `db/migrations/0209_drip_hourly_cap.sql`, `db/migrations/meta/0209_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts` (`drip_campaign_configs` ~L5488, `drip_journeys` ~L5595, `org_settings` near `drip_scheduler_fair`)
- Test: `scripts/test-drip-hourly-cap-schema.ts`

**Interfaces:**
- Produces columns: `drip_campaign_configs.hourly_cap int NULL`, `drip_campaign_configs.hourly_carry bool NOT NULL DEFAULT false`, `drip_journeys.hour_start timestamptz NULL`, `drip_journeys.hour_fresh bool NULL`, `org_settings.drip_hourly_cap_enabled bool NOT NULL DEFAULT false`; Drizzle fields of the same names.

- [ ] **Step 1: Write the failing schema test**

```ts
// scripts/test-drip-hourly-cap-schema.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-cap-schema.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const cols = (await db.execute(sql`
    SELECT table_name || '.' || column_name AS c, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE (table_name, column_name) IN (('drip_campaign_configs','hourly_cap'),('drip_campaign_configs','hourly_carry'),
      ('drip_journeys','hour_start'),('drip_journeys','hour_fresh'),('org_settings','drip_hourly_cap_enabled'))
  `)) as unknown as { c: string; data_type: string; is_nullable: string; column_default: string | null }[];
  const by = new Map(cols.map((r) => [r.c, r]));
  bar("S1 hourly_cap int nullable", by.get("drip_campaign_configs.hourly_cap")?.data_type === "integer" && by.get("drip_campaign_configs.hourly_cap")?.is_nullable === "YES");
  bar("S2 hourly_carry bool default false", by.get("drip_campaign_configs.hourly_carry")?.column_default === "false" && by.get("drip_campaign_configs.hourly_carry")?.is_nullable === "NO");
  bar("S3 hour_start timestamptz", by.get("drip_journeys.hour_start")?.data_type === "timestamp with time zone");
  bar("S4 hour_fresh boolean", by.get("drip_journeys.hour_fresh")?.data_type === "boolean");
  bar("S5 org flag default false", by.get("org_settings.drip_hourly_cap_enabled")?.column_default === "false");

  const cons = (await db.execute(sql`
    SELECT conname FROM pg_constraint
    WHERE conname IN ('drip_campaign_configs_hourly_cap_check','drip_journeys_hour_pair_check')`)) as unknown as { conname: string }[];
  bar("S6 both CHECKs exist", cons.length === 2, cons.map((c) => c.conname).join(","));

  const idx = (await db.execute(sql`
    SELECT indexname FROM pg_indexes WHERE indexname IN
      ('drip_journeys_campaign_first_send_idx','drip_journeys_hourly_queue_idx','drip_journeys_missed_hour_idx')`)) as unknown as { indexname: string }[];
  bar("S7 three indexes exist", idx.length === 3, idx.map((i) => i.indexname).join(","));

  // CHECK behaviour, rolled back
  const rejects = async (q: ReturnType<typeof sql>) => {
    try { await db.transaction(async (tx) => { await tx.execute(q); throw new Error("ROLLBACK_OK"); }); return false; }
    catch (e) { return (e as Error).message !== "ROLLBACK_OK"; }
  };
  bar("S8 hourly_cap = 0 rejected", await rejects(sql`UPDATE drip_campaign_configs SET hourly_cap = 0 WHERE campaign_id = (SELECT campaign_id FROM drip_campaign_configs LIMIT 1)`));
  bar("S9 hour_start without hour_fresh rejected", await rejects(sql`UPDATE drip_journeys SET hour_start = now(), hour_fresh = NULL WHERE id = (SELECT id FROM drip_journeys WHERE state='routed' LIMIT 1)`));

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

⚠️ S8/S9 need at least one config row and one routed journey on preview; if absent, print "SKIP (no row)" and do not count as pass — check with a `SELECT count(*)` first and fail loudly rather than pass vacuously.

- [ ] **Step 2: Run on preview — expect FAIL (columns missing)**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-cap-schema.ts`

- [ ] **Step 3: Write the migration**

```sql
-- 0209: drip hourly send cap (spec 2026-10-13). Additive only; ships dark.
--   drip_campaign_configs.hourly_cap   — first sends per ET clock hour; NULL = no limit.
--   drip_campaign_configs.hourly_carry — unsent leads queue into later hours (true)
--                                        or are dropped at hour end (false, default).
--   drip_journeys.hour_start/hour_fresh — the clock hour a lead is on; NULL = waiting.
--   org_settings.drip_hourly_cap_enabled — kill switch; false = every hourly setting ignored.
-- Re-runnable. Constant defaults: no rewrite. CHECK on a new all-NULL column validates instantly.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.drip_campaign_configs
  ADD COLUMN IF NOT EXISTS hourly_cap integer,
  ADD COLUMN IF NOT EXISTS hourly_carry boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE public.drip_campaign_configs DROP CONSTRAINT IF EXISTS drip_campaign_configs_hourly_cap_check;--> statement-breakpoint
ALTER TABLE public.drip_campaign_configs
  ADD CONSTRAINT drip_campaign_configs_hourly_cap_check CHECK (hourly_cap IS NULL OR hourly_cap > 0);--> statement-breakpoint
ALTER TABLE public.drip_journeys
  ADD COLUMN IF NOT EXISTS hour_start timestamptz,
  ADD COLUMN IF NOT EXISTS hour_fresh boolean;--> statement-breakpoint
ALTER TABLE public.drip_journeys DROP CONSTRAINT IF EXISTS drip_journeys_hour_pair_check;--> statement-breakpoint
ALTER TABLE public.drip_journeys
  ADD CONSTRAINT drip_journeys_hour_pair_check CHECK ((hour_start IS NULL) = (hour_fresh IS NULL));--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_hourly_cap_enabled boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Hourly sent count. No state filter: a journey that opts out inside the hour still counts.
CREATE INDEX IF NOT EXISTS drip_journeys_campaign_first_send_idx
  ON public.drip_journeys (campaign_id, first_send_at) WHERE first_send_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS drip_journeys_hourly_queue_idx
  ON public.drip_journeys (campaign_id, hour_start, routed_at) WHERE state = 'routed' AND first_send_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS drip_journeys_missed_hour_idx
  ON public.drip_journeys (campaign_id, closed_at) WHERE close_reason LIKE 'missed_hour%';--> statement-breakpoint
COMMENT ON COLUMN public.drip_journeys.hour_start IS
  'Hourly cap (0209): UTC instant of the ET clock hour this unsent lead is on. NULL = waiting (outside a window, or reverted by a stop control).';--> statement-breakpoint
COMMENT ON COLUMN public.drip_journeys.hour_fresh IS
  'Hourly cap (0209): true = assigned by its own routing hour; false = released backlog (never dropped by the hourly rule).';--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_hourly_cap_enabled IS
  'Hourly cap kill switch (0209). false = the scheduler ignores every hourly setting and clears assignments.';
```

Before writing: `SELECT count(*) FROM drip_journeys` on prod (read-only) and note the size in the PR — the CHECK is on a NULL column so validation is a scan with no rewrite; the indexes are plain `CREATE INDEX` (the table is small enough for the 5 s lock budget; if count > 2M, switch to a separate `CONCURRENTLY` step outside the transaction and say so in the PR).

- [ ] **Step 4: Snapshot + journal**

Copy `db/migrations/meta/0208_snapshot.json` to `0209_snapshot.json` with the Write tool; set `"id"` to a fresh `crypto.randomUUID()`, `"prevId"` to 0208's `id`; add the five columns to the `public.drip_campaign_configs`, `public.drip_journeys`, `public.org_settings` objects (model on an existing nullable integer / boolean-default / timestamptz column in the same file), the two `checkConstraints`, and the three `indexes` (model on `drip_journeys_live_idx`). Append to `_journal.json`:

```json
{ "idx": <0208 idx + 1>, "version": "7", "when": <0208 when + 86400000>, "tag": "0209_drip_hourly_cap", "breakpoints": true }
```

- [ ] **Step 5: Drizzle schema**

In `drip_campaign_configs` after `carry_days`:

```ts
    // Hourly send cap (0209): FIRST sends per ET clock hour, inside daily_cap.
    // NULL = no hourly limit. Follow-ups never count. Ignored unless
    // org_settings.drip_hourly_cap_enabled.
    hourly_cap: integer("hourly_cap"),
    // true = unsent leads queue into later hours; false = dropped at hour end.
    hourly_carry: boolean("hourly_carry").notNull().default(false),
```

In `drip_journeys`:

```ts
    // Hourly cap (0209): the clock hour this unsent lead is on (UTC hour start);
    // NULL = waiting. hour_fresh: true = its own routing hour, false = released backlog.
    hour_start: timestamp("hour_start", { withTimezone: true }),
    hour_fresh: boolean("hour_fresh"),
```

In `org_settings` next to `drip_scheduler_fair`:

```ts
  drip_hourly_cap_enabled: boolean("drip_hourly_cap_enabled").notNull().default(false),
```

- [ ] **Step 6: Apply to PREVIEW only and run the test**

```bash
node scripts/with-preview-env.mjs npm run db:migrate
node scripts/with-preview-env.mjs npx tsx scripts/verify-migration-integrity.ts
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-cap-schema.ts
npx tsc --noEmit -p .
```

Expected: `Migration integrity OK.`, `All checks passed.`, tsc clean. ⚠️ Never run `db:migrate` without `with-preview-env` — `.env.local` is production.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0209_drip_hourly_cap.sql db/migrations/meta/0209_snapshot.json db/migrations/meta/_journal.json db/schema.ts scripts/test-drip-hourly-cap-schema.ts
git commit -m "feat(drip): migration 0209 hourly send cap columns (dark)"
```

---

### Task 3: Hourly maintenance (DB)

**Files:**
- Create: `lib/drip/hourly-maintenance.ts`, `scripts/_drip-hourly-fixture.ts`, `scripts/test-drip-hourly-maintenance.ts`

**Interfaces:**
- Consumes: Task 1 exports; `numbersWithHeadroom`, `pickNumber` (`lib/drip/numbers.ts`); `isDripSendingHalted` (`lib/sends/circuit-breakers.ts`); `pickStage`, `etMinutesOfDay`, `StageWindow` (`lib/drip/windows.ts`); `notifyOnTransition` (`lib/alerts/alert-state.ts`).
- Produces:
  - `type DripTx` (same shape as scheduler's)
  - `interface HourlyRoom { hourStart: Date; room: number; carry: boolean }`
  - `type HourlyRoomMap = Map<number, HourlyRoom>`
  - `clearIneligibleHourAssignments(dbc: DripTx): Promise<number>`
  - `prepareHourly(dbc: DripTx, i: { orgId: string; now: Date; notify: (alertKey: string, orgId: string, text: string) => Promise<void> }): Promise<{ rooms: HourlyRoomMap; dropped: Record<MissedHourCause, number>; demoted: number; released: number; reverted: number }>`
  - `recordSendRefusal(dbc: DripTx, i: { journeyId: string; kind: "mint" | "gate"; now: Date }): Promise<void>`
  - `revertQueuedPastHours(dbc: DripTx, i: { campaignId: number; now: Date }): Promise<number>` (used by Task 5's ON→OFF save)

- [ ] **Step 1: Fixture**

```ts
// scripts/_drip-hourly-fixture.ts — throwaway org for hourly-cap tests. Preview DB only.
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { createPartnerWithKey } from "./_partner-fixture";

export const MARKER = "__DRIP_HOURLY_TEST__";
const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

export async function makeFixture() {
  const sfx = String(Date.now()).slice(-7);
  const orgId = (await one<{ id: string }>(
    sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
  await db.execute(sql`
    INSERT INTO org_settings (org_id, drip_enabled, drip_paused, drip_hourly_cap_enabled)
    VALUES (${orgId}::uuid, true, false, true)
    ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false, drip_hourly_cap_enabled = true`);
  const keyId = (await createPartnerWithKey(db, { orgId, slug: "hc-" + sfx, name: "hc", token: "tokhc" + sfx })).keyId;
  let seq = 0;

  /** Active drip campaign with one first-send stage 09:00–18:00 ET. */
  async function campaign(tag: string, cap: number | null, carry: boolean) {
    const id = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${orgId}::uuid, ${`hc-${sfx}-${tag}`}, ${`HC ${tag}`}, 'active', 'drip', 'tracked') RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, hourly_cap, hourly_carry)
      VALUES (${id}, ${orgId}::uuid, ${"hc" + tag}, ${cap}, ${carry})`);
    await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, drip_active, window_start_min, window_end_min)
      VALUES (${orgId}::uuid, ${id}, 1, true, 540, 1080)`);
    return id;
  }

  /** n routed journeys at explicit instants (1 s apart from `at`). Returns ids oldest first. */
  async function journeys(campaignId: number, n: number, at: Date, extra: SQL = sql``): Promise<string[]> {
    const base = seq; seq += n;
    const rows = (await db.execute(sql`
      WITH c AS (
        INSERT INTO contacts (org_id, phone_number)
        SELECT ${orgId}::uuid, '+1997' || ${sfx} || lpad((${base} + g)::text, 4, '0') FROM generate_series(1, ${n}) g
        RETURNING id
      ), e AS (
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
        SELECT ${orgId}::uuid, c.id, ${keyId}, ${"hc-" + sfx}, ${at.toISOString()}::timestamptz FROM c
        RETURNING id, contact_id
      )
      INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at)
      SELECT ${orgId}::uuid, ${campaignId}, e.contact_id, e.id, 'routed',
             ${at.toISOString()}::timestamptz + make_interval(secs => row_number() OVER (ORDER BY e.id))
      FROM e
      RETURNING id, routed_at ${extra}`)) as unknown as { id: string; routed_at: string }[];
    return rows.sort((a, b) => +new Date(a.routed_at) - +new Date(b.routed_at)).map((r) => r.id);
  }

  /** Mark journeys as first-sent at `at` (no stage_sends needed for counting). */
  async function markSent(ids: string[], at: Date) {
    await db.execute(sql`
      UPDATE drip_journeys SET state = 'active', first_send_at = ${at.toISOString()}::timestamptz
      WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
  }

  async function states(ids: string[]) {
    return (await db.execute(sql`
      SELECT id, state, close_reason, hour_start, hour_fresh, reason
      FROM drip_journeys WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`)) as unknown as {
      id: string; state: string; close_reason: string | null; hour_start: string | null;
      hour_fresh: boolean | null; reason: Record<string, unknown> | null;
    }[];
  }

  async function teardown(): Promise<number> {
    const name = (await one<{ name: string } | undefined>(
      sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
    if (!name.includes(MARKER)) throw new Error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
    await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    const left = await one<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
            + (SELECT count(*) FROM drip_journeys WHERE org_id = ${orgId}::uuid)
            + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
    return Number(left.n);
  }

  return { orgId, campaign, journeys, markSent, states, teardown };
}
```

⚠️ Verify against the fairness test that `campaign_stages` accepts this minimal insert on preview (required columns); add whatever NOT NULL columns the insert reports — do not change the window.

- [ ] **Step 2: Write the failing DB test**

Fixed clock: `T = 2026-10-13T18:30:00Z` (14:30 ET, inside 09:00–18:00). `H = 18:00Z`, `H1 = 19:00Z`. `prepareHourly` reads number headroom; the fixture campaign has no numbers, so the test sets `able` by giving each campaign a number — instead, to keep the test on the maintenance rules, `prepareHourly` takes headroom via an injectable reader (see Step 3: `deps.hasHeadroom`). Test file:

```ts
// scripts/test-drip-hourly-maintenance.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { clearIneligibleHourAssignments, prepareHourly } from "@/lib/drip/hourly-maintenance";
import { makeFixture } from "./_drip-hourly-fixture";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const Z = (iso: string) => new Date(iso);

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const fx = await makeFixture();
  const alerts: string[] = [];
  const run = (now: Date, hasHeadroom = true) => prepareHourly(db, {
    orgId: fx.orgId, now,
    notify: async (key) => { alerts.push(key); },
    deps: { hasHeadroom: async () => hasHeadroom },
  });
  try {
    // H2 — OFF, cap 3: 9 fresh in 18:00Z hour, 3 sent, at 19:00Z 6 dropped as cap.
    const off = await fx.campaign("off", 3, false);
    const fresh = await fx.journeys(off, 9, Z("2026-10-13T18:05:00Z"));
    let r = await run(Z("2026-10-13T18:30:00Z"));
    bar("H2a fresh assigned to the routed hour", (await fx.states(fresh)).every((s) => s.hour_fresh === true && new Date(s.hour_start!).toISOString() === "2026-10-13T18:00:00.000Z"));
    bar("H2b room = cap", r.rooms.get(off)?.room === 3, JSON.stringify(r.rooms.get(off)));
    await fx.markSent(fresh.slice(0, 3), Z("2026-10-13T18:31:00Z"));
    r = await run(Z("2026-10-13T19:00:30Z"));
    const s2 = await fx.states(fresh.slice(3));
    bar("H2c 6 dropped missed_hour_cap", s2.every((s) => s.state === "expired" && s.close_reason === "missed_hour_cap"), JSON.stringify(r.dropped));
    bar("H2d reason.missed_hour recorded", s2.every((s) => (s.reason as { missed_hour?: { cause: string } })?.missed_hour?.cause === "cap"));
    const contacts = (await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${fx.orgId}::uuid`)) as unknown as { n: number }[];
    bar("H2e contacts untouched", contacts[0].n >= 9);

    // H4 — OFF, cap 60: 180 waiting routed overnight; window opens 13:00Z (09:00 ET).
    const eve = await fx.campaign("eve", 60, false);
    const back = await fx.journeys(eve, 180, Z("2026-10-13T00:30:00Z")); // 20:30 ET the evening before
    await run(Z("2026-10-13T12:30:00Z")); // 08:30 ET — window closed
    bar("H4a outside the window nothing is assigned", (await fx.states(back)).every((s) => s.hour_start === null));
    r = await run(Z("2026-10-13T13:00:30Z")); // 09:00:30 ET
    const rel1 = (await fx.states(back)).filter((s) => s.hour_start !== null).length;
    bar("H4b released paced (ceil(60*1/60) = 1)", rel1 === 1, `released ${rel1}`);
    r = await run(Z("2026-10-13T13:30:00Z"));
    const rel2 = (await fx.states(back)).filter((s) => s.hour_start !== null).length;
    bar("H4c paced to 30 by :30", rel2 === 30, `released ${rel2}`);
    r = await run(Z("2026-10-13T14:00:30Z")); // next hour, none sent
    const s4 = await fx.states(back);
    bar("H4d backlog never dropped", s4.every((s) => s.state === "routed"), JSON.stringify(r.dropped));

    // H5 — OFF, cap 4, hour 15:00Z: backlog sent 2, fresh 5 unsent ⇒ newest 2 demoted, oldest 3 dropped.
    const mix = await fx.campaign("mix", 4, false);
    const b5 = await fx.journeys(mix, 2, Z("2026-10-13T02:00:00Z"));
    await run(Z("2026-10-13T15:00:30Z")); // releases ≤ ceil(4/60)=1 …
    await run(Z("2026-10-13T15:20:00Z")); // … then up to 2
    await fx.markSent(b5, Z("2026-10-13T15:21:00Z"));
    const f5 = await fx.journeys(mix, 5, Z("2026-10-13T15:30:00Z"));
    await run(Z("2026-10-13T15:40:00Z"));
    await run(Z("2026-10-13T16:00:30Z"));
    const s5 = await fx.states(f5);
    const byId = new Map(s5.map((s) => [s.id, s]));
    bar("H5a oldest 3 dropped (closed: 2 sent < cap 4)", f5.slice(0, 3).every((id) => byId.get(id)?.close_reason === "missed_hour_closed"));
    // Demoted = waiting; the same run may already have re-released them as backlog (hour_fresh false).
    bar("H5b newest 2 demoted, not dropped", f5.slice(3).every((id) => {
      const s = byId.get(id);
      return s?.state === "routed" && (s.hour_start === null || s.hour_fresh === false);
    }));

    // H6 — pause mid-hour, resume next hour ⇒ zero drops.
    const pz = await fx.campaign("pz", 2, false);
    const p6 = await fx.journeys(pz, 5, Z("2026-10-13T17:10:00Z"));
    await run(Z("2026-10-13T17:15:00Z"));
    await db.execute(sql`UPDATE campaigns SET send_paused = true WHERE id = ${pz}`);
    await clearIneligibleHourAssignments(db);
    await db.execute(sql`UPDATE campaigns SET send_paused = false WHERE id = ${pz}`);
    await run(Z("2026-10-13T18:00:30Z"));
    bar("H6a pause reverts, nothing dropped", (await fx.states(p6)).every((s) => s.state === "routed"));
    // org-level pause
    await run(Z("2026-10-13T18:05:00Z"));
    const p6b = await fx.journeys(pz, 3, Z("2026-10-13T18:06:00Z"));
    await run(Z("2026-10-13T18:07:00Z"));
    await db.execute(sql`UPDATE org_settings SET drip_paused = true WHERE org_id = ${fx.orgId}::uuid`);
    await clearIneligibleHourAssignments(db);
    await db.execute(sql`UPDATE org_settings SET drip_paused = false WHERE org_id = ${fx.orgId}::uuid`);
    await run(Z("2026-10-13T19:00:30Z"));
    bar("H6b org drip_paused reverts, nothing dropped", (await fx.states(p6b)).every((s) => s.state === "routed"));
    // number exhaustion
    const p6c = await fx.journeys(pz, 2, Z("2026-10-13T19:10:00Z"));
    await run(Z("2026-10-13T19:11:00Z"), false);
    await run(Z("2026-10-13T20:00:30Z"));
    bar("H6c exhaustion reverts, nothing dropped", (await fx.states(p6c)).every((s) => s.state === "routed"));

    // H12 — gate/mint refusal inside the hour ⇒ missed_hour_blocked + one alert per hour.
    const bl = await fx.campaign("bl", 5, false);
    const j12 = await fx.journeys(bl, 2, Z("2026-10-13T20:10:00Z"));
    await run(Z("2026-10-13T20:11:00Z"));
    const { recordSendRefusal } = await import("@/lib/drip/hourly-maintenance");
    await recordSendRefusal(db, { journeyId: j12[0], kind: "mint", now: Z("2026-10-13T20:12:00Z") });
    alerts.length = 0;
    await run(Z("2026-10-13T21:00:30Z"));
    const s12 = new Map((await fx.states(j12)).map((s) => [s.id, s]));
    bar("H12a refused lead dropped as blocked", s12.get(j12[0])?.close_reason === "missed_hour_blocked");
    bar("H12b the other as closed (0 sent < cap)", s12.get(j12[1])?.close_reason === "missed_hour_closed");
    bar("H12c exactly one alert keyed to the hour", alerts.length === 1 && alerts[0].endsWith(":2026-10-13T20:00:00.000Z"), alerts.join());

    // H11 (maintenance half) — ON: past-hour unsent stay assigned (queue), nothing dropped.
    const on = await fx.campaign("on", 2, true);
    const j11 = await fx.journeys(on, 5, Z("2026-10-13T21:05:00Z"));
    await run(Z("2026-10-13T21:06:00Z"));
    await fx.markSent(j11.slice(0, 2), Z("2026-10-13T21:07:00Z"));
    r = await run(Z("2026-10-13T22:00:30Z"));
    const s11 = await fx.states(j11.slice(2));
    bar("H11a ON keeps the queue on its old hour", s11.every((s) => s.state === "routed" && new Date(s.hour_start!).toISOString() === "2026-10-13T21:00:00.000Z"));
    bar("H11b ON room this hour = cap", r.rooms.get(on)?.room === 2);
  } finally {
    const left = await fx.teardown();
    console.log(`\nTeardown: ${left} row(s) left`);
    if (left !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Note: `routed_at` instants are in October (EDT, UTC−4): 18:05Z = 14:05 ET (in window), 00:30Z = 20:30 ET (outside), 13:00:30Z = 09:00:30 ET.

- [ ] **Step 3: Run — expect FAIL (module missing)**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts`

- [ ] **Step 4: Implement**

```ts
// lib/drip/hourly-maintenance.ts
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { isDripSendingHalted } from "@/lib/sends/circuit-breakers";
import {
  backlogRoom, hourStartOf, HOUR_MS, minutesIntoHour, MISSED_HOUR_CLOSE_REASON,
  planHourEnd, type FreshUnsent, type HourCounts, type MissedHourCause,
} from "./hourly-cap";
import { numbersWithHeadroom, pickNumber } from "./numbers";
import { pickStage, etMinutesOfDay, type StageWindow } from "./windows";

// Drip hourly send cap — the per-run maintenance pass (spec 2026-10-13 §4).
// Runs inside the scheduler's single-flight lease, BEFORE the due query, so the
// room it returns is what selectDueJourneys may take this run.
//
// ⭐ NOTHING HERE SENDS. It only moves journeys between "waiting" (hour_start
// NULL), "on an hour", and — OFF only — the terminal expired/missed_hour_*.
// ⭐ A STOP CONTROL NEVER CAUSES A DROP. Pause / halt / flag off / no headroom
// revert assignments to waiting; only a campaign that could send drops leads.

export type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface HourlyRoom { hourStart: Date; room: number; carry: boolean }
export type HourlyRoomMap = Map<number, HourlyRoom>;

const uuidArr = (ids: string[]) => `{${ids.join(",")}}`;
const LIVE_UNSENT = sql`j.state = 'routed' AND j.first_send_at IS NULL`;

/** Step 0: every unsent assignment whose org/campaign can no longer use the cap → waiting. */
export async function clearIneligibleHourAssignments(dbc: DripTx): Promise<number> {
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    FROM campaigns c
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    LEFT JOIN org_settings os ON os.org_id = c.org_id
    WHERE j.campaign_id = c.id AND ${LIVE_UNSENT} AND j.hour_start IS NOT NULL
      AND (NOT COALESCE(os.drip_enabled, false) OR COALESCE(os.drip_paused, false)
           OR NOT COALESCE(os.drip_hourly_cap_enabled, false)
           OR c.status <> 'active' OR c.send_paused IS TRUE OR cfg.hourly_cap IS NULL)
    RETURNING j.id
  `)) as unknown as { id: string }[];
  return rows.length;
}

export async function revertCampaign(dbc: DripTx, campaignId: number): Promise<number> {
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NOT NULL
    RETURNING j.id`)) as unknown as { id: string }[];
  return rows.length;
}

/** Carry ON → OFF: the existing queue becomes backlog instead of a mass drop (spec §5). */
export async function revertQueuedPastHours(
  dbc: DripTx, { campaignId, now }: { campaignId: number; now: Date },
): Promise<number> {
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT}
      AND j.hour_start < ${hourStartOf(now).toISOString()}::timestamptz
    RETURNING j.id`)) as unknown as { id: string }[];
  return rows.length;
}

export async function recordSendRefusal(
  dbc: DripTx, { journeyId, kind, now }: { journeyId: string; kind: "mint" | "gate"; now: Date },
): Promise<void> {
  await dbc.execute(sql`
    UPDATE drip_journeys
    SET reason = COALESCE(reason, '{}'::jsonb)
               || jsonb_build_object('last_send_refusal',
                    jsonb_build_object('kind', ${kind}::text, 'at', ${now.toISOString()}::text))
    WHERE id = ${journeyId}::uuid AND state = 'routed' AND first_send_at IS NULL`);
}

async function assignFresh(dbc: DripTx, campaignId: number, hour: Date, windows: StageWindow[]) {
  if (windows.length === 0) return;
  const etMin = sql`(extract(hour FROM j.routed_at AT TIME ZONE 'America/New_York') * 60
                     + extract(minute FROM j.routed_at AT TIME ZONE 'America/New_York'))`;
  const inWindow = sql.join(
    windows.map((w) => sql`(${etMin} >= ${w.window_start_min} AND ${etMin} < ${w.window_end_min})`),
    sql` OR `,
  );
  await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = ${hour.toISOString()}::timestamptz, hour_fresh = true
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NULL
      AND j.routed_at >= ${hour.toISOString()}::timestamptz
      AND j.routed_at <  ${new Date(hour.getTime() + HOUR_MS).toISOString()}::timestamptz
      AND (${inWindow})`);
}

async function sentBetween(dbc: DripTx, campaignId: number, from: Date, backlogOnly: boolean) {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId}
      AND j.first_send_at >= ${from.toISOString()}::timestamptz
      AND j.first_send_at <  ${new Date(from.getTime() + HOUR_MS).toISOString()}::timestamptz
      ${backlogOnly ? sql`AND j.hour_fresh IS FALSE AND j.hour_start = ${from.toISOString()}::timestamptz` : sql``}
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

/** Step 2 (OFF): close every past hour. Returns per-cause drops and the hours with blocked drops. */
async function closePastHours(
  dbc: DripTx, campaignId: number, cap: number, hour: Date,
): Promise<{ dropped: Record<MissedHourCause, number>; demoted: number; blockedHours: Map<string, number> }> {
  const out = { dropped: { cap: 0, closed: 0, blocked: 0 }, demoted: 0, blockedHours: new Map<string, number>() };
  // Released backlog is never dropped (R1).
  await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT}
      AND j.hour_start < ${hour.toISOString()}::timestamptz AND j.hour_fresh IS FALSE`);
  const rows = (await dbc.execute(sql`
    SELECT j.id, j.hour_start, j.routed_at,
           (j.reason -> 'last_send_refusal' ->> 'at')::timestamptz AS refused_at
    FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT}
      AND j.hour_start < ${hour.toISOString()}::timestamptz AND j.hour_fresh IS TRUE
  `)) as unknown as { id: string; hour_start: string; routed_at: string; refused_at: string | null }[];
  const byHour = new Map<number, FreshUnsent[]>();
  for (const r of rows) {
    const h = new Date(r.hour_start).getTime();
    const refused = r.refused_at ? new Date(r.refused_at).getTime() : null;
    const list = byHour.get(h) ?? [];
    list.push({ journeyId: r.id, routedAt: new Date(r.routed_at), blocked: refused != null && refused >= h && refused < h + HOUR_MS });
    byHour.set(h, list);
  }
  for (const [h, freshUnsent] of byHour) {
    const H = new Date(h);
    const sentInHour = await sentBetween(dbc, campaignId, H, false);
    const backlogSentInHour = await sentBetween(dbc, campaignId, H, true);
    const plan = planHourEnd({ cap, sentInHour, backlogSentInHour, freshUnsent });
    if (plan.demote.length > 0) {
      await dbc.execute(sql`
        UPDATE drip_journeys SET hour_start = NULL, hour_fresh = NULL
        WHERE id = ANY(${uuidArr(plan.demote)}::uuid[]) AND state = 'routed' AND first_send_at IS NULL`);
      out.demoted += plan.demote.length;
    }
    for (const cause of ["cap", "closed", "blocked"] as const) {
      const ids = plan.drop.filter((d) => d.cause === cause).map((d) => d.journeyId);
      if (ids.length === 0) continue;
      await dbc.execute(sql`
        UPDATE drip_journeys
        SET state = 'expired', closed_at = now(), close_reason = ${MISSED_HOUR_CLOSE_REASON[cause]},
            reason = COALESCE(reason, '{}'::jsonb) || jsonb_build_object('missed_hour', jsonb_build_object(
              'hour_start', ${H.toISOString()}::text, 'cap', ${cap}::int, 'cause', ${cause}::text,
              'sent_in_hour', ${sentInHour}::int, 'backlog_sent_in_hour', ${backlogSentInHour}::int))
        WHERE id = ANY(${uuidArr(ids)}::uuid[]) AND state = 'routed' AND first_send_at IS NULL`);
      out.dropped[cause] += ids.length;
      if (cause === "blocked") out.blockedHours.set(H.toISOString(), ids.length);
    }
  }
  return out;
}

async function hourCounts(dbc: DripTx, campaignId: number, hour: Date): Promise<HourCounts> {
  const h = hour.toISOString();
  const r = (await dbc.execute(sql`
    SELECT
      count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz AND j.hour_fresh)::int     AS fresh,
      count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz AND NOT j.hour_fresh)::int AS backlog,
      count(*) FILTER (WHERE j.hour_start < ${h}::timestamptz)::int                      AS queued
    FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NOT NULL
  `)) as unknown as { fresh: number; backlog: number; queued: number }[];
  return {
    sentInHour: await sentBetween(dbc, campaignId, hour, false),
    freshUnsentInHour: Number(r[0]?.fresh ?? 0),
    backlogUnsentInHour: Number(r[0]?.backlog ?? 0),
    queuedUnsent: Number(r[0]?.queued ?? 0),
  };
}

async function releaseBacklog(dbc: DripTx, campaignId: number, hour: Date, n: number): Promise<number> {
  if (n <= 0) return 0;
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys SET hour_start = ${hour.toISOString()}::timestamptz, hour_fresh = false
    WHERE id IN (
      SELECT j.id FROM drip_journeys j
      WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NULL
      ORDER BY j.routed_at, j.id
      LIMIT ${n})
    RETURNING id`)) as unknown as { id: string }[];
  return rows.length;
}

export async function prepareHourly(
  dbc: DripTx,
  { orgId, now, notify, deps }: {
    orgId: string;
    now: Date;
    notify: (alertKey: string, orgId: string, text: string) => Promise<void>;
    /** Number headroom reader; the scheduler passes the real one. */
    deps: { hasHeadroom: (campaignId: number) => Promise<boolean> };
  },
): Promise<{ rooms: HourlyRoomMap; dropped: Record<MissedHourCause, number>; demoted: number; released: number; reverted: number }> {
  const res = { rooms: new Map() as HourlyRoomMap, dropped: { cap: 0, closed: 0, blocked: 0 }, demoted: 0, released: 0, reverted: 0 };
  const hour = hourStartOf(now);
  const camps = (await dbc.execute(sql`
    SELECT c.id, c.name, c.send_paused, cfg.hourly_cap, cfg.hourly_carry, cfg.campaign_cap,
           (SELECT count(*)::int FROM drip_journeys dj WHERE dj.campaign_id = c.id AND dj.first_send_at IS NOT NULL) AS lifetime
    FROM campaigns c
    JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    JOIN org_settings os ON os.org_id = c.org_id
    WHERE c.org_id = ${orgId}::uuid AND c.type = 'drip' AND c.status = 'active'
      AND cfg.hourly_cap IS NOT NULL AND os.drip_hourly_cap_enabled
  `)) as unknown as { id: number; name: string | null; send_paused: boolean | null; hourly_cap: number;
    hourly_carry: boolean; campaign_cap: number | null; lifetime: number }[];

  for (const c of camps) {
    const campaignId = Number(c.id);
    const cap = Number(c.hourly_cap);
    const windows = (await dbc.execute(sql`
      SELECT s.id AS stage_id, s.window_start_min, s.window_end_min FROM campaign_stages s
      WHERE s.campaign_id = ${campaignId} AND s.drip_active IS TRUE AND s.archived_at IS NULL
        AND s.parent_stage_id IS NULL AND s.window_start_min IS NOT NULL AND s.window_end_min IS NOT NULL
    `)) as unknown as StageWindow[];

    // Step 1 then step 2 — step 2 closes only hours a live campaign could send in.
    await assignFresh(dbc, campaignId, hour, windows);
    if (!c.hourly_carry) {
      const closed = await closePastHours(dbc, campaignId, cap, hour);
      for (const k of ["cap", "closed", "blocked"] as const) res.dropped[k] += closed.dropped[k];
      res.demoted += closed.demoted;
      for (const [h, n] of closed.blockedHours) {
        await notify(`drip:missed_hour_blocked:${campaignId}:${h}`, orgId,
          `⚠️ Drip campaign "${c.name ?? campaignId}": ${n} lead(s) dropped for hour ${h} because their send was ` +
          `refused (opt-out gate / link mint). This is a system fault, not lead staleness — check the stage's link and footer.`);
      }
    }

    // Step 3 — a campaign that cannot send right now reverts, so nothing is dropped for it.
    const able = !c.send_paused &&
      !(await isDripSendingHalted(dbc, campaignId)) &&
      !(c.campaign_cap != null && Number(c.lifetime) >= Number(c.campaign_cap)) &&
      (await deps.hasHeadroom(campaignId));
    if (!able) {
      res.reverted += await revertCampaign(dbc, campaignId);
      res.rooms.set(campaignId, { hourStart: hour, room: 0, carry: c.hourly_carry });
      continue;
    }

    // Step 4 — release waiting leads into spare room, only while a window is open.
    const pick = windows.length > 0 ? pickStage(windows, etMinutesOfDay(now)) : null;
    const windowOpen = pick != null && pick.opens_at_min === null;
    let counts = await hourCounts(dbc, campaignId, hour);
    if (windowOpen) {
      const n = backlogRoom({ cap, carry: c.hourly_carry, counts, minutesIntoHour: minutesIntoHour(now) });
      const released = await releaseBacklog(dbc, campaignId, hour, n);
      res.released += released;
      if (released > 0) counts = await hourCounts(dbc, campaignId, hour);
    }
    // Step 5 — room this run (the scheduler also applies the daily cap).
    res.rooms.set(campaignId, { hourStart: hour, room: Math.max(0, cap - counts.sentInHour), carry: c.hourly_carry });
  }
  return res;
}

/** The scheduler's headroom reader. */
export async function realHasHeadroom(campaignId: number, now: Date): Promise<boolean> {
  return pickNumber(await numbersWithHeadroom(db, { campaignId, now })) != null;
}
```

- [ ] **Step 5: Run — expect `All checks passed.`; fix only the code under test, never weaken a bar**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts`

- [ ] **Step 6: Lint, tsc, commit**

```bash
npx eslint lib/drip/hourly-maintenance.ts scripts/_drip-hourly-fixture.ts scripts/test-drip-hourly-maintenance.ts
npx tsc --noEmit -p .
git add lib/drip/hourly-maintenance.ts scripts/_drip-hourly-fixture.ts scripts/test-drip-hourly-maintenance.ts
git commit -m "feat(drip): hourly-cap maintenance pass (assign, close hour, revert, release)"
```

---

### Task 4: Scheduler integration

**Files:**
- Modify: `lib/drip/scheduler.ts` (`runDripSchedulerBatch` L103–396, `DueRow` L85, `selectDueJourneys` L402–457)
- Modify test: `scripts/test-drip-scheduler-fairness.ts`

**Interfaces:**
- Consumes: `clearIneligibleHourAssignments`, `prepareHourly`, `recordSendRefusal`, `realHasHeadroom`, `HourlyRoomMap` (Task 3); `orderForHour` (Task 1).
- Produces: `selectDueJourneys(dbc, { orgId, fair, batch, hourly }: { orgId: string; fair: boolean; batch: number; hourly: HourlyRoomMap })` — `hourly` REQUIRED. `DueRow` gains `hour_start: string | null; hour_fresh: boolean | null; routed_at: string`. `SchedulerResult` gains `hourlyCapBlocked: number; hourlyDropped: number`.

- [ ] **Step 1: Failing tests — extend the fairness test**

Change every existing call to pass `hourly: new Map()` (so F1–F6 keep proving the no-cap path), then add before teardown:

```ts
    // H1 — no cap: an empty map is byte-identical to the old order.
    const legacy = await selectDueJourneys(db, { orgId, fair: true, batch: 200, hourly: new Map() });
    bar("H1 empty hourly map = F2's batch exactly", legacy.map((r) => r.journey_id).join() === on.map((r) => r.journey_id).join());

    // H9 — A is hourly-capped and its hour is full: A contributes no rows; B gets all 5.
    const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await db.execute(sql`UPDATE drip_journeys SET hour_start = ${hourStart.toISOString()}::timestamptz, hour_fresh = true
                         WHERE campaign_id = ${A}`);
    const full = await selectDueJourneys(db, { orgId, fair: true, batch: 200,
      hourly: new Map([[A, { hourStart, room: 0, carry: false }]]) });
    bar("H9a a full hour takes no batch slots", count(full, A) === 0 && count(full, B) === 5, `A ${count(full, A)}, B ${count(full, B)}`);
    const some = await selectDueJourneys(db, { orgId, fair: true, batch: 200,
      hourly: new Map([[A, { hourStart, room: 7, carry: false }]]) });
    bar("H9b room 7 ⇒ exactly 7 of A", count(some, A) === 7, `A ${count(some, A)}`);
    const unassigned = await selectDueJourneys(db, { orgId, fair: false, batch: 200,
      hourly: new Map([[B, { hourStart, room: 50, carry: false }]]) });
    bar("H9c waiting (unassigned) journeys of a capped campaign are never due", count(unassigned, B) === 0);

    // H3 — ON order: a queued past-hour lead precedes a backlog lead released into this hour.
    const prev = new Date(hourStart.getTime() - 3_600_000);
    const aRows = (await db.execute(sql`SELECT id FROM drip_journeys WHERE campaign_id = ${A} ORDER BY routed_at LIMIT 2`)) as unknown as { id: string }[];
    await db.execute(sql`UPDATE drip_journeys SET hour_start = ${hourStart.toISOString()}::timestamptz, hour_fresh = false WHERE id = ${aRows[0].id}::uuid`);
    await db.execute(sql`UPDATE drip_journeys SET hour_start = ${prev.toISOString()}::timestamptz, hour_fresh = true WHERE id = ${aRows[1].id}::uuid`);
    const onOrder = await selectDueJourneys(db, { orgId, fair: true, batch: 200,
      hourly: new Map([[A, { hourStart, room: 2, carry: true }]]) });
    const aOnly = onOrder.filter((r) => Number(r.campaign_id) === A).map((r) => r.journey_id);
    bar("H3 ON: queued (earlier hour) first", aOnly[0] === aRows[1].id, JSON.stringify(aOnly));
```

- [ ] **Step 2: Run — expect tsc/arg errors and H-bars failing**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-scheduler-fairness.ts`

- [ ] **Step 3: Implement `selectDueJourneys`**

Change the signature to `{ orgId, fair, batch, hourly }: { orgId: string; fair: boolean; batch: number; hourly: HourlyRoomMap }`, keep the existing ⭐ PER-CAMPAIGN FAIRNESS comment, add this comment under it:

```ts
  // ⭐ HOURLY CAP (0209). `hourly` holds every hourly-capped campaign with its
  // current hour and the room it has left THIS run. For those campaigns only
  // journeys already on an hour are due (waiting ones are not accumulating), the
  // per-campaign rank follows the hour order, and rank > room never enters the
  // batch — a full hour takes no slots from other campaigns. An EMPTY map takes
  // the pre-0209 query text (plus three selected columns).
```

and replace the body with (the `!capped` branches are the old SQL verbatim, which is what makes H1 hold by construction):

```ts
  const recs = JSON.stringify([...hourly].map(([id, v]) => ({
    campaign_id: id, hour_start: v.hourStart.toISOString(), room: v.room, carry: v.carry,
  })));
  const hRecordset = sql`jsonb_to_recordset(${recs}::jsonb) AS h(campaign_id int, hour_start timestamptz, room int, carry boolean)`;
  const capped = hourly.size > 0;
  // Hourly-capped campaign ⇒ assigned journeys up to the current hour only.
  const dueFilter = (j: string) => sql.raw(
    `AND (h.campaign_id IS NULL OR (${j}.hour_start IS NOT NULL AND ${j}.hour_start <= h.hour_start AND h.room > 0))`);
  // ON: earlier hour first. OFF: fresh before backlog. Non-capped rows: both keys constant.
  const hourKeys = (j: string) => sql.raw(
    `CASE WHEN h.carry THEN ${j}.hour_start END ASC NULLS FIRST,
     CASE WHEN h.carry IS FALSE AND ${j}.hour_fresh IS FALSE THEN 1 ELSE 0 END,`);

  const pick = fair
    ? capped
      ? sql`
    FROM (
      SELECT r.id, r.fair_rank FROM (
        SELECT j0.id, h.room,
               row_number() OVER (PARTITION BY j0.campaign_id
                                  ORDER BY ${hourKeys("j0")} j0.routed_at, j0.id) AS fair_rank,
               j0.routed_at
        FROM drip_journeys j0
        JOIN campaigns c0 ON c0.id = j0.campaign_id
        LEFT JOIN ${hRecordset} ON h.campaign_id = j0.campaign_id
        WHERE j0.org_id = ${orgId}::uuid
          AND j0.state = 'routed'
          AND j0.first_send_at IS NULL
          AND c0.type = 'drip'
          AND c0.status = 'active'
          ${dueFilter("j0")}
      ) r
      WHERE r.room IS NULL OR r.fair_rank <= r.room
      ORDER BY r.fair_rank, r.routed_at, r.id
      LIMIT ${batch}
    ) f
    JOIN drip_journeys j ON j.id = f.id`
      : sql`
    FROM (
      SELECT j0.id,
             row_number() OVER (PARTITION BY j0.campaign_id ORDER BY j0.routed_at, j0.id) AS fair_rank
      FROM drip_journeys j0
      JOIN campaigns c0 ON c0.id = j0.campaign_id
      WHERE j0.org_id = ${orgId}::uuid
        AND j0.state = 'routed'
        AND j0.first_send_at IS NULL
        AND c0.type = 'drip'
        AND c0.status = 'active'
      ORDER BY fair_rank, j0.routed_at, j0.id
      LIMIT ${batch}
    ) f
    JOIN drip_journeys j ON j.id = f.id`
    : sql`
    FROM drip_journeys j`;
  const order = fair ? sql`ORDER BY f.fair_rank, j.routed_at, j.id` : sql`ORDER BY j.routed_at`;
  return (await dbc.execute(sql`
    SELECT j.id AS journey_id, j.org_id, j.campaign_id, j.contact_id,
           j.hour_start, j.hour_fresh, j.routed_at,
           c.name AS campaign_name, c.link_mode,
           (c.send_paused IS TRUE) AS campaign_paused,
           false AS drip_paused,
           ct.phone_number AS phone,
           b.name AS brand_name,
           c.brand_id, c.tracking_id AS campaign_tracking_id,
           b.landing_host AS brand_landing_host,
           cfg.daily_cap, cfg.campaign_cap
    ${pick}
    JOIN campaigns c  ON c.id = j.campaign_id
    JOIN contacts ct  ON ct.id = j.contact_id
    LEFT JOIN brands b ON b.id = c.brand_id
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    ${capped && !fair ? sql`LEFT JOIN ${hRecordset} ON h.campaign_id = j.campaign_id` : sql``}
    WHERE j.org_id = ${orgId}::uuid
      AND j.state = 'routed'
      AND j.first_send_at IS NULL
      AND c.type = 'drip'
      AND c.status = 'active'
      ${capped && !fair ? dueFilter("j") : sql``}
    ${order}
    LIMIT ${batch}
  `)) as unknown as DueRow[];
```

(`sql.raw` is safe here: `j` is a hard-coded alias, never input.) Add to `DueRow`: `hour_start: string | null; hour_fresh: boolean | null; routed_at: string;`. The only change on the no-cap path is three extra selected columns.

- [ ] **Step 4: Implement the scheduler run changes**

At the top of `runDripSchedulerBatch`, before the `orgs` query:

```ts
  // ⭐ HOURLY CAP step 0 (spec §4): org paused/off, flag off, campaign paused or
  // cap removed ⇒ assignments revert to waiting. Runs even when no org is live,
  // which is exactly when it matters (a paused org must not wake up to drops).
  await clearIneligibleHourAssignments(db);
```

Inside the org loop, replace `const due = await selectDueJourneys(db, { orgId, fair, batch: BATCH });` with:

```ts
    const hourly = await prepareHourly(db, {
      orgId, now,
      notify: async (alertKey, oid, text) => {
        const { notifyOnTransition } = await import("@/lib/alerts/alert-state");
        await notifyOnTransition(db, { alertKey, orgId: oid, text });
      },
      deps: { hasHeadroom: (campaignId) => realHasHeadroom(campaignId, now) },
    });
    res.hourlyDropped += hourly.dropped.cap + hourly.dropped.closed + hourly.dropped.blocked;
    const due = await selectDueJourneys(db, { orgId, fair, batch: BATCH, hourly: hourly.rooms });
```

In the per-campaign loop, after `const head = leads[0];`:

```ts
      const hourRoom = hourly.rooms.get(campaignId);
      if (hourRoom) leads.splice(0, leads.length, ...orderForHour(leads, hourRoom.carry));
      let hourSent = 0;
```

Inside the per-lead loop, next to the daily-cap check:

```ts
        if (hourRoom && hourSent >= hourRoom.room) {
          res.hourlyCapBlocked++;
          continue;
        }
```

After `res.inserted++; todayCount++;` add `hourSent++;`. In the `MintRefused` and `GateRefused` branches, before `continue`:

```ts
            if (hourRoom) await recordSendRefusal(db, { journeyId: lead.journey_id, kind: "mint", now });
```

(`kind: "gate"` in the gate branch). Initialise `hourlyCapBlocked: 0, hourlyDropped: 0` in `res` and add both to `SchedulerResult` with a one-line comment each. Imports: `clearIneligibleHourAssignments, prepareHourly, realHasHeadroom, recordSendRefusal, type HourlyRoomMap` from `./hourly-maintenance`; `orderForHour` from `./hourly-cap`.

- [ ] **Step 5: Run fairness + maintenance tests, tsc**

```bash
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-scheduler-fairness.ts
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts
npx tsc --noEmit -p .
```

Expected: both `All checks passed.`; tsc lists no errors. If tsc reports another `selectDueJourneys` caller, that is a §11b decision point — give it the real map, or `new Map()` with a comment saying why.

- [ ] **Step 6: Lint, commit**

```bash
npx eslint lib/drip/scheduler.ts scripts/test-drip-scheduler-fairness.ts
git add lib/drip/scheduler.ts scripts/test-drip-scheduler-fairness.ts
git commit -m "feat(drip): scheduler enforces the hourly cap; full hour takes no batch slots"
```

---

### Task 5: Setting I/O + UI

**Files:**
- Modify: `lib/validators/drip-campaigns.ts` (after `carry_days`), `app/api/campaigns/[campaignId]/drip-config/route.ts` (GET select, PUT upsert), `app/api/campaigns/[campaignId]/duplicate/route.ts:201-204`, `lib/drip/change-events.ts` (`DRIP_CONFIG_FIELDS`, `LABELS`), `components/campaigns/drip-config-panel.tsx` (state ~L106, load ~L128, PUT body ~L233, Caps box after "Daily send cap" ~L346)
- Test: `scripts/test-drip-hourly-config.ts`

**Interfaces:**
- Consumes: `revertQueuedPastHours` (Task 3).
- Produces: GET returns `hourly_cap`, `hourly_carry`, `hourly_cap_enabled` (org flag). PUT accepts `hourly_cap?: number | null`, `hourly_carry?: boolean` — omitted ⇒ keep. Extract the ON→OFF step as `applyHourlyCarryTransition(tx, { campaignId, before: boolean, after: boolean, now: Date })` exported from `lib/drip/hourly-maintenance.ts` so the test can call the exact function the route calls.

- [ ] **Step 1: Failing test**

```ts
// scripts/test-drip-hourly-config.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { db } from "@/db/client";
import { applyHourlyCarryTransition } from "@/lib/drip/hourly-maintenance";
import { dripConfigSchema } from "@/lib/validators/drip-campaigns";
import { makeFixture } from "./_drip-hourly-fixture";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  bar("V1 hourly_cap 0 rejected", !dripConfigSchema.safeParse({ interest_tag: "x", hourly_cap: 0 }).success);
  bar("V2 hourly_cap null accepted", dripConfigSchema.safeParse({ interest_tag: "x", hourly_cap: null }).success);
  bar("V3 hourly_carry boolean", dripConfigSchema.safeParse({ interest_tag: "x", hourly_carry: true }).success);

  const fx = await makeFixture();
  try {
    const on = await fx.campaign("cfg", 2, true);
    const ids = await fx.journeys(on, 3, new Date("2026-10-13T18:05:00Z"));
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`UPDATE drip_journeys SET hour_start = '2026-10-13T18:00:00Z', hour_fresh = true WHERE campaign_id = ${on}`);
    const n = await db.transaction((tx) => applyHourlyCarryTransition(tx, {
      campaignId: on, before: true, after: false, now: new Date("2026-10-13T19:10:00Z") }));
    const s = await fx.states(ids);
    bar("H13 carry ON→OFF reverts the queue to waiting, nothing dropped",
      n === 3 && s.every((x) => x.state === "routed" && x.hour_start === null), `reverted ${n}`);
    const m = await db.transaction((tx) => applyHourlyCarryTransition(tx, {
      campaignId: on, before: false, after: false, now: new Date("2026-10-13T19:10:00Z") }));
    bar("H13b no transition ⇒ no write", m === 0);
  } finally {
    const left = await fx.teardown();
    if (left !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-config.ts`

- [ ] **Step 3: Implement**

Validator (after `carry_days`):

```ts
    // Hourly send cap (0209): first sends per ET clock hour. NULL = no hourly
    // limit. OMITTED = keep (the campaign editor never sends it).
    hourly_cap: z.number().int().positive().max(100000).nullable().optional(),
    // OMITTED = keep.
    hourly_carry: z.boolean().optional(),
```

`lib/drip/hourly-maintenance.ts`:

```ts
/** Carry ON → OFF on save: the existing queue becomes backlog, never a mass drop (spec §5). */
export async function applyHourlyCarryTransition(
  dbc: DripTx,
  { campaignId, before, after, now }: { campaignId: number; before: boolean; after: boolean; now: Date },
): Promise<number> {
  if (!(before && !after)) return 0;
  return revertQueuedPastHours(dbc, { campaignId, now });
}
```

Route GET: add `cfg.hourly_cap, cfg.hourly_carry, (SELECT os.drip_hourly_cap_enabled FROM org_settings os WHERE os.org_id = c.org_id) AS hourly_cap_enabled,` after `org_carry_days`.

Route PUT: add `hourly_cap, hourly_carry` to the INSERT column list and `${input.hourly_cap ?? null}, ${input.hourly_carry ?? false}` to VALUES; in `DO UPDATE SET`:

```sql
        hourly_cap = CASE WHEN ${sent("hourly_cap")}
                          THEN EXCLUDED.hourly_cap
                          ELSE drip_campaign_configs.hourly_cap END,
        hourly_carry = CASE WHEN ${sent("hourly_carry")}
                            THEN EXCLUDED.hourly_carry
                            ELSE drip_campaign_configs.hourly_carry END,
```

Before the upsert, inside the transaction: `const carryBefore = ((await tx.execute(drizzleSql\`SELECT hourly_carry FROM drip_campaign_configs WHERE campaign_id = ${cid} FOR UPDATE\`)) as unknown as { hourly_carry: boolean }[])[0]?.hourly_carry ?? false;` After the upsert: `if (sent("hourly_carry")) await applyHourlyCarryTransition(tx, { campaignId: cid, before: carryBefore, after: input.hourly_carry === true, now: new Date() });`

Duplicate route: add `hourly_cap, hourly_carry` to both column lists at L201/L204 (copy the settings; `hour_start` is a journey column and is never copied).

`change-events.ts`: add `"hourly_cap", "hourly_carry"` to `DRIP_CONFIG_FIELDS` and labels `hourly_cap: "hourly send cap"`, `hourly_carry: "carry unsent leads to next hour"`. Ensure `readDripConfigSnapshot` selects them (follow how `carry_days` is read there).

Panel: state `const [hourlyCap, setHourlyCap] = useState(""); const [hourlyCarry, setHourlyCarry] = useState(false);` load `setHourlyCap(r.data.hourly_cap == null ? "" : String(r.data.hourly_cap)); setHourlyCarry(r.data.hourly_carry === true);`. PUT body: only when `cfg?.hourly_cap_enabled`, add `hourly_cap: num(hourlyCap), hourly_carry: hourlyCarry` (when the flag is off, OMIT both so a save never touches them). Add `hourly_cap: number | null; hourly_carry: boolean; hourly_cap_enabled: boolean;` to the panel's config type. After the "Daily send cap" `<div>`:

```tsx
              {cfg?.hourly_cap_enabled && (
                <div>
                  <Label htmlFor="cap-hourly" className="text-xs">
                    Hourly send cap <Badge variant="secondary">live</Badge>
                  </Label>
                  <Input
                    id="cap-hourly"
                    value={hourlyCap}
                    onChange={(e) => setHourlyCap(e.target.value)}
                    placeholder="unlimited"
                    disabled={!canEdit}
                  />
                  <p className="text-muted-foreground mt-1 text-xs">
                    First sends per ET clock hour, inside the daily cap. Follow-ups don&apos;t count.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={hourlyCarry}
                      onCheckedChange={(v) => setHourlyCarry(v === true)}
                      disabled={!canEdit || hourlyCap.trim() === ""}
                    />
                    Carry unsent leads to the next hour
                  </label>
                  {!hourlyCarry && hourlyCap.trim() !== "" && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Leads that miss their hour are dropped from this campaign (they stay normal contacts).
                    </p>
                  )}
                </div>
              )}
```

Import `Checkbox` from `@/components/ui/checkbox` (check it exists; if not, `npx shadcn@latest add checkbox`). If the Caps grid is `sm:grid-cols-3`, change it to `sm:grid-cols-4` only when the flag is on.

- [ ] **Step 4: Run test + tsc**

```bash
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-config.ts
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-change-events.ts
npx tsc --noEmit -p .
```

Expected: all pass (change-events test proves the new fields don't break the diff log).

- [ ] **Step 5: Lint, commit**

```bash
npx eslint lib/validators/drip-campaigns.ts "app/api/campaigns/[campaignId]/drip-config/route.ts" "app/api/campaigns/[campaignId]/duplicate/route.ts" lib/drip/change-events.ts lib/drip/hourly-maintenance.ts components/campaigns/drip-config-panel.tsx scripts/test-drip-hourly-config.ts
git add <the same files>
git commit -m "feat(drip): hourly send cap setting (API, duplicate, change log, panel behind flag)"
```

---

### Task 6: Funnel hourly panel + why-not-routed

**Files:**
- Modify: `lib/drip/funnel.ts` (`OUTCOME_LABELS` ~L90, `DripFunnel` ~L79, `getDripFunnel` return ~L282)
- Create: `components/drip/hourly-cap-panel.tsx`
- Modify: `components/drip/journey-funnel.tsx` (after the "How they ended" block)
- Modify: `app/api/drip/why-not-routed/route.ts:69`, `components/drip/why-not-routed.tsx:194`
- Test: extend `scripts/test-drip-hourly-maintenance.ts`

**Interfaces:**
- Produces: `DripFunnel.hourly: FunnelHourly | null` where

```ts
export interface FunnelHourly {
  cap: number;
  carry: boolean;
  hour_start: string;           // current hour (UTC ISO)
  sent_this_hour: number;
  assigned_unsent_this_hour: number;
  queued_from_earlier_hours: number;
  waiting: number;
  oldest_unsent_age_min: number | null; // queued or waiting, by routed_at
  drops_by_day: { day: string; cap: number; closed: number; blocked: number }[]; // last 7 ET days, newest first
}
```

- [ ] **Step 1: Failing bars** — in `test-drip-hourly-maintenance.ts`, after H12 and before teardown:

```ts
    const { getDripFunnel } = await import("@/lib/drip/funnel");
    const fun = await getDripFunnel(fx.orgId, off);
    bar("R1 funnel outcome row for missed_hour_cap with its label",
      fun.outcomes.some((o) => o.close_reason === "missed_hour_cap" && o.label === "Dropped — hourly cap full" && o.count === 6));
    bar("R2 funnel hourly panel present for a capped campaign", fun.hourly?.cap === 3);
    bar("R3 drops_by_day has the cap drops", (fun.hourly?.drops_by_day ?? []).reduce((s, d) => s + d.cap, 0) === 6);
    const plain = await fx.campaign("plain", null, false);
    bar("R4 no cap ⇒ hourly null", (await getDripFunnel(fx.orgId, plain)).hourly === null);
```

⚠️ `drops_by_day` covers the last 7 ET days relative to the REAL now; the fixture's drops have `closed_at = now()` (real time), so they count.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`OUTCOME_LABELS`:

```ts
  "expired|missed_hour_cap": "Dropped — hourly cap full",
  "expired|missed_hour_closed": "Dropped — window closed / daily cap before its turn",
  "expired|missed_hour_blocked": "Dropped — send blocked (gate/mint) ⚠️",
```

In `getDripFunnel`, before `return`:

```ts
  // ── hourly cap panel (0209) — only for a capped campaign with the org flag on ──
  const hcfg = (await dbc.execute(sql`
    SELECT cfg.hourly_cap, cfg.hourly_carry FROM drip_campaign_configs cfg
    JOIN org_settings os ON os.org_id = cfg.org_id
    WHERE cfg.campaign_id = ${campaignId} AND cfg.org_id = ${orgId}::uuid
      AND cfg.hourly_cap IS NOT NULL AND os.drip_hourly_cap_enabled
  `)) as unknown as { hourly_cap: number; hourly_carry: boolean }[];
  let hourly: FunnelHourly | null = null;
  if (hcfg[0]) {
    const now = new Date();
    const hour = hourStartOf(now);
    const hourEnd = new Date(hour.getTime() + HOUR_MS);
    const weekStart = etDayStartsBack(now, 6); // start of the ET day 6 days ago
    const hr = (await dbc.execute(sql`
      SELECT
        (SELECT count(*)::int FROM drip_journeys WHERE campaign_id = ${campaignId}
           AND first_send_at >= ${hour.toISOString()}::timestamptz AND first_send_at < ${hourEnd.toISOString()}::timestamptz) AS sent,
        count(*) FILTER (WHERE hour_start = ${hour.toISOString()}::timestamptz)::int AS assigned,
        count(*) FILTER (WHERE hour_start < ${hour.toISOString()}::timestamptz)::int AS queued,
        count(*) FILTER (WHERE hour_start IS NULL)::int AS waiting,
        (extract(epoch FROM (now() - min(routed_at) FILTER (WHERE hour_start IS NULL OR hour_start < ${hour.toISOString()}::timestamptz))) / 60)::int AS oldest_min
      FROM drip_journeys
      WHERE campaign_id = ${campaignId} AND state = 'routed' AND first_send_at IS NULL
    `)) as unknown as { sent: number; assigned: number; queued: number; waiting: number; oldest_min: number | null }[];
    const days = (await dbc.execute(sql`
      SELECT to_char((closed_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE close_reason = 'missed_hour_cap')::int AS cap,
             count(*) FILTER (WHERE close_reason = 'missed_hour_closed')::int AS closed,
             count(*) FILTER (WHERE close_reason = 'missed_hour_blocked')::int AS blocked
      FROM drip_journeys
      WHERE campaign_id = ${campaignId} AND close_reason LIKE 'missed_hour%'
        AND closed_at >= ${weekStart.toISOString()}::timestamptz
      GROUP BY 1 ORDER BY 1 DESC
    `)) as unknown as { day: string; cap: number; closed: number; blocked: number }[];
    hourly = {
      cap: Number(hcfg[0].hourly_cap), carry: hcfg[0].hourly_carry, hour_start: hour.toISOString(),
      sent_this_hour: Number(hr[0]?.sent ?? 0), assigned_unsent_this_hour: Number(hr[0]?.assigned ?? 0),
      queued_from_earlier_hours: Number(hr[0]?.queued ?? 0), waiting: Number(hr[0]?.waiting ?? 0),
      oldest_unsent_age_min: hr[0]?.oldest_min == null ? null : Number(hr[0].oldest_min),
      drops_by_day: days.map((d) => ({ day: d.day, cap: Number(d.cap), closed: Number(d.closed), blocked: Number(d.blocked) })),
    };
  }
```

Add `hourly` to the returned object and `hourly: FunnelHourly | null;` to `DripFunnel`. `etDayStartsBack`: add a small local helper using `campaignDayBoundsUtc` exactly like `etDayStartBack` in `lib/drip/admission-window.ts` (export that one instead of duplicating: `export function etDayStartBack` and import it). Imports: `hourStartOf, HOUR_MS` from `./hourly-cap`.

`components/drip/hourly-cap-panel.tsx`:

```tsx
"use client";

import { Badge } from "@/components/ui/badge";
import type { FunnelHourly } from "@/lib/drip/funnel";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";

// Hourly send cap panel (0209). Queue size + oldest age are the owner's v1
// substitute for a queue age limit (R2). Blocked drops are flagged: they mean a
// system fault (gate/mint), not stale leads (R4).
export function HourlyCapPanel({ hourly }: { hourly: FunnelHourly }) {
  const fmtAge = (m: number | null) =>
    m == null ? "—" : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium tracking-wide uppercase">Hourly cap</h4>
      <p className="text-muted-foreground mb-3 text-xs">
        {hourly.cap.toLocaleString()} first sends per hour ·{" "}
        {hourly.carry ? "unsent leads carry to the next hour" : "leads that miss their hour are dropped"} ·
        hour from {formatCampaignDateTime(hourly.hour_start)}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div><dt className="text-muted-foreground text-xs">Sent this hour</dt><dd className="tabular-nums">{hourly.sent_this_hour.toLocaleString()} / {hourly.cap.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Due this hour</dt><dd className="tabular-nums">{hourly.assigned_unsent_this_hour.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Queued from earlier hours</dt><dd className="tabular-nums">{hourly.queued_from_earlier_hours.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Waiting for a window / room</dt><dd className="tabular-nums">{hourly.waiting.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Oldest unsent</dt><dd className="tabular-nums">{fmtAge(hourly.oldest_unsent_age_min)}</dd></div>
      </dl>
      {hourly.drops_by_day.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border text-sm">
          <li className="text-muted-foreground grid grid-cols-4 gap-3 px-3 py-1 text-xs">
            <span>Day (ET)</span><span className="text-right">Cap full</span>
            <span className="text-right">Window/daily</span><span className="text-right">Blocked</span>
          </li>
          {hourly.drops_by_day.map((d) => (
            <li key={d.day} className="grid grid-cols-4 gap-3 px-3 py-1">
              <span>{d.day}</span>
              <span className="text-right tabular-nums">{d.cap.toLocaleString()}</span>
              <span className="text-right tabular-nums">{d.closed.toLocaleString()}</span>
              <span className="text-right tabular-nums">
                {d.blocked > 0 ? <Badge variant="destructive">{d.blocked.toLocaleString()}</Badge> : 0}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

In `journey-funnel.tsx`, after the "How they ended" `</div>`: `{funnel.hourly && <HourlyCapPanel hourly={funnel.hourly} />}` with the import.

Why-not-routed API L69: add `j.close_reason` to the select. Component L194: replace the journey text with:

```tsx
{e.journey_state
  ? ` · journey ${String(e.journey_state)}${
      typeof e.close_reason === "string" && e.close_reason.startsWith("missed_hour")
        ? ` — missed its hour (${String(e.close_reason).replace("missed_hour_", "")}` +
          `${(e.reason as { missed_hour?: { cap?: number; hour_start?: string } })?.missed_hour?.hour_start
              ? `, cap ${(e.reason as { missed_hour: { cap: number } }).missed_hour.cap}/h, hour ${formatCampaignDateTime(
                  (e.reason as { missed_hour: { hour_start: string } }).missed_hour.hour_start)}`
              : ""})`
        : ""
    }`
  : " · no journey"}
```

(Pull the cast into a small `missedHourText(e)` helper above the component if the JSX gets unreadable.)

- [ ] **Step 4: Run tests + tsc**

```bash
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts
node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-funnel-split.ts
npx tsc --noEmit -p .
```

- [ ] **Step 5: Lint, commit**

```bash
npx eslint lib/drip/funnel.ts lib/drip/admission-window.ts components/drip/hourly-cap-panel.tsx components/drip/journey-funnel.tsx app/api/drip/why-not-routed/route.ts components/drip/why-not-routed.tsx scripts/test-drip-hourly-maintenance.ts
git add <the same files>
git commit -m "feat(drip): hourly cap on the funnel (drops by cause per ET day, queue) + why-not-routed"
```

---

### Task 7: Docs

**Files:** `docs/03-data-model.md` (+ ERD: the 5 columns), `docs/04-features/drip-campaigns-routing.md` (new "Hourly send cap" section: setting, hour semantics, four-combination table, drop reasons, stop controls, follow-ups excluded — copy §3–§5 of the spec), `docs/05-flows.md` (scheduler sequence: add the maintenance pass before the due query), `docs/07-conventions.md` (hour key = UTC hour; first-sends-only counting; a stop control never drops; ON→OFF reverts the queue), `docs/CHANGELOG.md`, "last updated" on each.

- [ ] **Step 1: Write the doc changes** (real file paths, no secrets).
- [ ] **Step 2: CHANGELOG line**

```
2026-10-13 — Drip hourly send cap (0209, behind org_settings.drip_hourly_cap_enabled): per-campaign first sends per ET hour + carry/drop; missed_hour_{cap,closed,blocked} outcomes; funnel hourly panel — 03-data-model, 04-features/drip-campaigns-routing, 05-flows, 07-conventions
```

- [ ] **Step 3: Commit**

```bash
git add docs/03-data-model.md docs/04-features/drip-campaigns-routing.md docs/05-flows.md docs/07-conventions.md docs/CHANGELOG.md
git commit -m "docs(drip): hourly send cap"
```

---

### Task 8: Preview verification, PR, owner gate

- [ ] **Step 1: Full test sweep on preview** — every script touched above plus `test-drip-carry-over.ts`, `test-drip-regular-unaffected.ts`, `test-drip-poke-chain.ts`, `test-drip-stop-controls.ts`, `test-drip-windows.ts`. All `All checks passed.`
- [ ] **Step 2: Preview stack end-to-end** — on camman-v2 with `scripts/drip-p5-proof-setup.ts` (a sendable drip campaign on preview): flip the org flag on preview, set cap 2 / OFF, post 5 fresh leads in-window, watch: 2 `stage_sends`, then at the hour 3 `missed_hour_cap`; repeat with carry ON (3 sent next hour, oldest first). Record the numbers in the PR. Screenshot the panel + funnel (Playwright recipe in memory: creds via scratchpad).
- [ ] **Step 3: Prod read-only pre-checks** — `SELECT count(*) FROM drip_journeys` (index build time) and confirm prod ledger ends at 0208.
- [ ] **Step 4: Open the PR** (branch `feat/drip-hourly-cap`), body: spec link, rulings R1–R6, test evidence, "migration 0209 — owner gate".
- [ ] **Step 5: STOP. Ask the owner** before prod `db:migrate` and before merging. After approval: migrate, `verify-migration-integrity.ts`, merge, prove inert on prod (flag false; `SELECT count(*) FROM drip_journeys WHERE hour_start IS NOT NULL` = 0 after several scheduler ticks; scheduler logs show `hourlyDropped: 0`). Flag flip + first campaign cap = owner's call.

---

## Self-review notes

- Spec §1 setting → Task 5; §3 hour semantics → Tasks 1, 3; §4 steps 0–5 → Task 3 (+ step 0 call in Task 4); send order → Tasks 1, 4; drop write + refusal + alert → Task 3/4; §5 table → H2/H3/H4/H11 + carry-day independence (routing untouched; Task 8 step 1 runs `test-drip-carry-over.ts` too — add it to the sweep); ON→OFF → Task 5; §6 fairness/poke → Task 4 (H9), poke test in sweep; §7 reporting → Task 6; §8 data model → Task 2; §9 tests → H1–H13 across Tasks 2–6, H7/H8/H10 covered structurally (daily check unchanged in the loop; follow-ups never touch `first_send_at`; counts are DB-derived) and exercised end-to-end in Task 8 step 2.
