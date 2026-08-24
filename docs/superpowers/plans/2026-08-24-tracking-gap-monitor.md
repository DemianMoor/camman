# Keitaro Tracking-Gap Monitor + Overview Click Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alert on Telegram when a sent stage has CamMan clicks but zero Keitaro landing-page visits, and make the Overview tab render CamMan's click count (marked) wherever the Keitaro visit count is missing.

**Architecture:** Two independent halves sharing no code. Part A is a new query module plus a new hourly Vercel cron that latches per stage through the existing `alert_state` table. Part B is a read-time substitution inside the Overview API route only — no database write, no migration, no change to the shared `stage-funnel` layer that the other four report tabs use.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle (raw `sql` template) · Postgres (Supabase) · Vercel Cron · `tsx` scripts for tests

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-24-tracking-gap-monitor-design.md`. Read it before Task 1.
- Worktree `C:\AFF\camman\.claude\worktrees\tgap`, branch `feat/tracking-gap-monitor`, based on `origin/main` @ `ce93ba1`. **Never** work in `C:\AFF\camman` directly — it is shared and another session can move HEAD between two commands.
- **No migration. No new table. No write to `keitaro_stage_results`.** `alert_state` already exists in prod.
- Every query filters by `org_id` where the table carries one (multi-tenancy rule, CLAUDE.md §3).
- Timestamps render through `formatCampaignDateTime()` from `lib/campaign-timezone.ts` — never bare `date-fns` `format()`.
- `notifyTelegram()` sends **plain text** (no `parse_mode`). Do not put HTML tags in the alert body; they render literally.
- There is no test runner in this repo. "Test" means a `tsx` script under `scripts/`, run with `npx tsx scripts/<name>.ts`.
- Lint changed files only: `npx eslint <file>` — a repo-wide run exits 1 on other branches' pre-existing problems.
- **Visits test uses both columns explicitly** (`visit_clicks_raw = 0 AND visit_clicks_clean = 0`). **Reported redirects use `redirect_clicks_clean` only** — raw ⊇ clean, so summing them double-counts (152 vs the correct 51 on stage 3029).
- The `clicks` scan is bounded by `clicked_at >= now() - 8 days` (window + 1 day of slack). This uses `clicks_clicked_at_idx` and takes the measured query from 3.49 s to 1.59 s. Without it the planner seq-scans 1.38 M click rows.

---

### Task 1: Thresholds and the pure breach rule

The decision rule lives apart from the query so it is testable with no database — the same split `lib/sends/tells-monitors.ts` uses, and for the same reason: these are the rules that get a monitor muted when they are wrong.

**Files:**
- Create: `lib/reporting/tracking-gap.ts`
- Create: `scripts/test-tracking-gap.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TRACKING_GAP_MIN_HUMAN_CLICKS: number`, `TRACKING_GAP_MATURITY_HOURS: number`, `TRACKING_GAP_WINDOW_DAYS: number`, `trackingGapBreached(humanClicks: number, visits: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-tracking-gap.ts`:

```ts
// Unit checks for the Keitaro tracking-gap decision rule — pure functions only,
// no DB. Run: npx tsx scripts/test-tracking-gap.ts
//
// Both failure modes are pinned deliberately, because both end with the channel
// muted:
//   - firing when nothing is wrong (a quiet stage, a stage Keitaro DOES see)
//   - NOT firing when something is wrong (the tracking blackout we exist to catch)
import {
  trackingGapBreached,
  TRACKING_GAP_MIN_HUMAN_CLICKS,
  TRACKING_GAP_MATURITY_HOURS,
  TRACKING_GAP_WINDOW_DAYS,
} from "@/lib/reporting/tracking-gap";

let pass = 0,
  fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

// ── the rule ────────────────────────────────────────────────────────────────
ok(
  trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS, 0),
  "⭐ at the click floor with zero visits -> BREACH",
);
ok(
  trackingGapBreached(315, 0),
  "⭐ stage 3029's real numbers (315 human clicks, 0 visits) -> BREACH",
);
ok(
  !trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS - 1, 0),
  "below the click floor -> no breach (a handful of clicks is noise, not evidence)",
);
ok(!trackingGapBreached(0, 0), "no clicks and no visits -> no breach (a quiet stage)");
ok(
  !trackingGapBreached(1000, 1),
  "⭐ ONE visit is enough to prove the script fires -> no breach at any click volume",
);
ok(
  !trackingGapBreached(315, 21860),
  "a healthy guidekn-scale stage -> no breach",
);

// Visits are the ONLY Keitaro signal in the rule. Redirects are reported in the
// alert but must never gate it — requiring redirects=0 too would skip 3 of the
// 5 stages that qualify today, all of them the same defect.
ok(
  trackingGapBreached(315, 0),
  "⭐ breaches with visits=0 regardless of redirects (redirects are context, not a gate)",
);

// ── the thresholds themselves ───────────────────────────────────────────────
eq(TRACKING_GAP_MIN_HUMAN_CLICKS, 25, "click floor is 25 HUMAN clicks");
eq(TRACKING_GAP_MATURITY_HOURS, 6, "maturity is 6h");
eq(TRACKING_GAP_WINDOW_DAYS, 7, "window is 7 days");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsx scripts/test-tracking-gap.ts
```

Expected: FAIL — `Cannot find module '@/lib/reporting/tracking-gap'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/reporting/tracking-gap.ts`:

```ts
import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// =============================================================================
// KEITARO TRACKING-GAP MONITOR
//
// CamMan mints a tracked short link per recipient and records every tap in
// `clicks`. Keitaro records a landing-page VISIT only if the LP carries its
// visit script. When that script is missing — or the LP is dead — CamMan keeps
// recording taps while `keitaro_stage_results.visit_clicks_*` stay at zero, and
// NOTHING ELSE NOTICES: sends succeed, DLRs arrive, and the Overview tab renders
// "Clickers 0" as though nobody clicked.
//
// Measured 2026-08-24 over 14 days of tracked stages, split by landing-page host:
//   www.guidekn.com  284 stages  26,933 human clicks  21,860 visits   0 gaps
//   www.lumzen.co      6 stages     881 human clicks       0 visits   5 gaps
//   www.fitsyou.net    1 stage       11 human clicks       0 visits   0 gaps
// The split is total. guidekn carries the script; the two newer hosts do not.
//
// ⚠️ THE POINT OF THIS MONITOR IS THE NEXT HOST, NOT THIS ONE. Today's gap is a
// one-line fix on the LP. What has no other detection layer is the next landing
// page that ships without the script — which is why the guard in
// scripts/verify-tracking-gap.ts must keep working after today's gap closes.
// =============================================================================

// How many CamMan HUMAN clicks a stage needs before zero Keitaro visits counts
// as evidence rather than a quiet stage.
//
// CALIBRATED 2026-08-24 on HUMAN-classified clicks, NOT raw taps. Human clicks
// run ~7.7% of all taps (the datacenter-ASN check excludes the rest — see
// lib/reporting/epc-monitors.ts), so 25 human clicks is roughly a 3.5K-recipient
// send. Over the trailing 7 days, 25 and 100 select the SAME stages, so the
// lower bar costs no noise today while staying sensitive to medium sends: at
// 100, a 10K send producing ~77 human clicks would stay silent.
//
// Applying this floor to TOTAL taps instead would pull in the "Test Text
// Request" stage (152 taps / 21 human) — a test campaign, i.e. exactly the noise
// that gets a monitor muted.
export const TRACKING_GAP_MIN_HUMAN_CLICKS = 25;

// Stages younger than this are excluded. The Keitaro poll runs every 5 minutes,
// so 6h is far past any ingestion lag: zero at 6h is evidence, not latency.
export const TRACKING_GAP_MATURITY_HOURS = 6;

// Bounds the scan and stops long-dead stages re-alerting forever.
export const TRACKING_GAP_WINDOW_DAYS = 7;

// The rule, extracted so it is testable without a database.
//
// ⚠️ VISITS ARE THE ONLY KEITARO SIGNAL. Redirects are reported in the alert for
// context but MUST NOT gate it. Requiring redirects = 0 as well (the original
// brief) would skip 3 of the 5 stages that qualify today — campaign 924 (0
// visits, 51 redirects) and both stages of campaign 926 — all of which are the
// same defect. A redirect is fired downstream of the LP and can land even when
// the visit script never runs.
export function trackingGapBreached(humanClicks: number, visits: number): boolean {
  return visits === 0 && humanClicks >= TRACKING_GAP_MIN_HUMAN_CLICKS;
}
```

- [ ] **Step 4: Run the test and make sure it passes**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsx scripts/test-tracking-gap.ts
```

Expected: `PASS — 12 passed, 0 failed`

- [ ] **Step 5: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx eslint lib/reporting/tracking-gap.ts scripts/test-tracking-gap.ts
git add lib/reporting/tracking-gap.ts scripts/test-tracking-gap.ts
git commit -m "feat(monitors): tracking-gap thresholds and pure breach rule

Calibrated on HUMAN-classified clicks, not raw taps: 25 human clicks is
~a 3.5K send. Visits gate the rule; redirects are context only.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The query — `runTrackingGapMonitor`

**Files:**
- Modify: `lib/reporting/tracking-gap.ts` (append)
- Create: `scripts/probe-tracking-gap.ts`

**Interfaces:**
- Consumes: `trackingGapBreached`, the three constants (Task 1).
- Produces:
  - `interface TrackingGapBreach { stage_id: number; org_id: string; tracking_id: string | null; campaign_name: string; human_clicks: number; redirects: number; sent_at: string; destination_url: string | null }`
  - `interface TrackingGapReport { window_days: number; maturity_hours: number; min_human_clicks: number; stages_evaluated: number; breaches: TrackingGapBreach[]; clean_stage_ids: number[] }`
  - `runTrackingGapMonitor(dbc: DbOrTx): Promise<TrackingGapReport>`

`clean_stage_ids` carries the stages that were evaluated and did **not** breach. Task 3 needs it to clear their latches; without it a fixed stage could never alert again.

- [ ] **Step 1: Write the failing probe**

Create `scripts/probe-tracking-gap.ts`:

```ts
// Read-only probe: runs the tracking-gap monitor against the configured database
// and prints what it would alert on. Sends NOTHING. Safe to run anytime.
// Run: npx tsx scripts/probe-tracking-gap.ts
import "./_env-preload";

import { db } from "@/db/client";
import { runTrackingGapMonitor } from "@/lib/reporting/tracking-gap";

const started = Date.now();
const report = await runTrackingGapMonitor(db);
const ms = Date.now() - started;

console.log(
  `evaluated ${report.stages_evaluated} stage(s) in ${ms}ms — ` +
    `${report.breaches.length} breach(es), ${report.clean_stage_ids.length} clean`,
);
console.log(
  `thresholds: >=${report.min_human_clicks} human clicks, ` +
    `sent ${report.maturity_hours}h-${report.window_days}d ago\n`,
);
for (const b of report.breaches) {
  console.log(
    `  stage ${b.stage_id}  ${b.tracking_id}  ${b.human_clicks} human clicks  ` +
      `${b.redirects} redirects\n    ${b.campaign_name}\n    ${b.destination_url}`,
  );
}
process.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsx scripts/probe-tracking-gap.ts
```

Expected: FAIL — `runTrackingGapMonitor` is not an exported member of `@/lib/reporting/tracking-gap`.

- [ ] **Step 3: Implement the query**

Append to `lib/reporting/tracking-gap.ts`:

```ts
export interface TrackingGapBreach {
  stage_id: number;
  org_id: string;
  tracking_id: string | null;
  campaign_name: string;
  /** HUMAN-classified click rows, the figure the alert quotes. */
  human_clicks: number;
  /** redirect_clicks_clean — the "Offer Redirect" figure the UI shows. */
  redirects: number;
  /** ISO string; render through formatCampaignDateTime for display. */
  sent_at: string;
  destination_url: string | null;
}

export interface TrackingGapReport {
  window_days: number;
  maturity_hours: number;
  min_human_clicks: number;
  stages_evaluated: number;
  breaches: TrackingGapBreach[];
  /** Evaluated and NOT breaching — the caller clears these stages' latches. */
  clean_stage_ids: number[];
}

interface GapRow {
  stage_id: number;
  org_id: string;
  tracking_id: string | null;
  campaign_name: string | null;
  sent_at: string;
  visits: number;
  redirects: number;
  human_clicks: number;
  destination_url: string | null;
}

// One statement. Measured 1.59 s against prod (143 candidate stages, 8 days of
// clicks), down from 3.49 s before the clicked_at bound was added.
//
// ⚠️ THE `clicked_at` BOUND IS LOAD-BEARING, not tidiness. Without it the planner
// seq-scans all 1.38 M rows of `clicks` to apply `classification = 'human'`
// (measured: 1,273,284 rows discarded, 1.95 s). Bounded, it uses
// clicks_clicked_at_idx. The bound is WINDOW + 1 day: a click on a stage sent
// within the window cannot predate that send, so a day of slack is strictly more
// than correctness requires.
//
// ⚠️ VISITS ARE TESTED ON BOTH COLUMNS EXPLICITLY, and redirects are REPORTED
// from `redirect_clicks_clean` ALONE. raw ⊇ clean — they overlap — so summing
// them for the reported figure double-counts (152 instead of the correct 51 on
// stage 3029). The sum is only safe as a zero-test, and even there the explicit
// form says what it means.
export async function runTrackingGapMonitor(dbc: DbOrTx): Promise<TrackingGapReport> {
  const rows = (await dbc.execute(sql`
    WITH candidates AS (
      SELECT cs.id AS stage_id, cs.org_id, cs.tracking_id, cs.sent_at,
             c.name AS campaign_name
      FROM campaign_stages cs
      JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.sent_at IS NOT NULL
        AND cs.sent_at <  now() - make_interval(hours => ${TRACKING_GAP_MATURITY_HOURS})
        AND cs.sent_at >= now() - make_interval(days  => ${TRACKING_GAP_WINDOW_DAYS})
        AND cs.archived_at IS NULL
        AND c.link_mode = 'tracked'
    ),
    keitaro AS (
      SELECT k.stage_id,
             sum(k.visit_clicks_raw)::int    AS visits_raw,
             sum(k.visit_clicks_clean)::int  AS visits_clean,
             sum(k.redirect_clicks_clean)::int AS redirects
      FROM keitaro_stage_results k
      JOIN candidates ca ON ca.stage_id = k.stage_id
      GROUP BY 1
    ),
    camman AS (
      SELECT l.stage_id, count(*)::int AS human_clicks
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN candidates ca ON ca.stage_id = l.stage_id
      WHERE ck.classification = 'human'
        AND ck.clicked_at >= now() - make_interval(days => ${TRACKING_GAP_WINDOW_DAYS + 1})
      GROUP BY 1
    )
    SELECT ca.stage_id,
           ca.org_id::text AS org_id,
           ca.tracking_id,
           ca.campaign_name,
           ca.sent_at::text AS sent_at,
           (coalesce(k.visits_raw, 0) + coalesce(k.visits_clean, 0)) AS visits,
           coalesce(k.redirects, 0) AS redirects,
           coalesce(cm.human_clicks, 0) AS human_clicks,
           CASE WHEN coalesce(k.visits_raw, 0) = 0
                 AND coalesce(k.visits_clean, 0) = 0
                 AND coalesce(cm.human_clicks, 0) >= ${TRACKING_GAP_MIN_HUMAN_CLICKS}
                THEN (SELECT ld.url
                        FROM links l2
                        JOIN link_destinations ld ON ld.id = l2.destination_id
                       WHERE l2.stage_id = ca.stage_id
                       ORDER BY l2.id DESC
                       LIMIT 1)
                ELSE NULL
           END AS destination_url
    FROM candidates ca
    LEFT JOIN keitaro k  ON k.stage_id  = ca.stage_id
    LEFT JOIN camman  cm ON cm.stage_id = ca.stage_id
    ORDER BY coalesce(cm.human_clicks, 0) DESC
  `)) as unknown as GapRow[];

  const breaches: TrackingGapBreach[] = [];
  const clean_stage_ids: number[] = [];

  for (const r of rows) {
    const humanClicks = Number(r.human_clicks ?? 0);
    const visits = Number(r.visits ?? 0);
    if (trackingGapBreached(humanClicks, visits)) {
      breaches.push({
        stage_id: Number(r.stage_id),
        org_id: r.org_id,
        tracking_id: r.tracking_id,
        campaign_name: r.campaign_name ?? "(unnamed)",
        human_clicks: humanClicks,
        redirects: Number(r.redirects ?? 0),
        sent_at: r.sent_at,
        destination_url: r.destination_url,
      });
    } else {
      clean_stage_ids.push(Number(r.stage_id));
    }
  }

  return {
    window_days: TRACKING_GAP_WINDOW_DAYS,
    maturity_hours: TRACKING_GAP_MATURITY_HOURS,
    min_human_clicks: TRACKING_GAP_MIN_HUMAN_CLICKS,
    stages_evaluated: rows.length,
    breaches,
    clean_stage_ids,
  };
}
```

Note the destination sub-select is gated by the same breach condition in SQL, so it runs only for breaching stages. Fetching it for all 143 candidates costs a 34 MB on-disk sort (measured 1.2 s); gated, it is a handful of index lookups.

- [ ] **Step 4: Run the probe and verify the output**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsx scripts/probe-tracking-gap.ts
```

Expected: `evaluated 143 stage(s) in ~1600ms — 5 breach(es), 138 clean`, listing stages 3029 (315 clicks, 51 redirects), 3044 (145, 0), 3040 (141, 4), 3041 (137, 7), 3045 (122, 0), all with `https://www.lumzen.co/...` destinations.

If the counts differ, the live data has moved on — that is expected over time. What must hold: every listed stage has `0` visits, `>= 25` human clicks, and a non-null destination.

- [ ] **Step 5: Lint and commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx eslint lib/reporting/tracking-gap.ts scripts/probe-tracking-gap.ts
git add lib/reporting/tracking-gap.ts scripts/probe-tracking-gap.ts
git commit -m "feat(monitors): tracking-gap query + read-only probe

Bounded by clicked_at (8d) so the clicks scan uses its index: 3.49s -> 1.59s.
Destination lookup gated to breaching stages, avoiding a 34MB disk sort.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The cron route, the per-stage latch, and the alert

**Files:**
- Create: `app/api/cron/tracking-monitors/route.ts`
- Modify: `vercel.json` (add one cron entry)
- Modify: `lib/reporting/cron-heartbeat.ts` (add one `HEARTBEAT_JOBS` entry)

**Interfaces:**
- Consumes: `runTrackingGapMonitor`, `TrackingGapBreach`, `trackingGapAlertKey`, `formatTrackingGapAlert` (Tasks 2 + this task's Step 0); `notifyOnTransition`, `clearAlert` from `lib/alerts/alert-state.ts`; `recordHeartbeat` from `lib/reporting/cron-heartbeat.ts`; `requireApiMembership` from `lib/api/helpers.ts`; `can` from `lib/permissions.ts`.
- Produces: the cron route. Nothing imports from it.

> **Why the two helpers live in the lib module, not the route.** Next.js 16
> type-checks `route.ts` exports against a fixed set (`GET`, `POST`, `dynamic`,
> `maxDuration`, …); an extra export fails `next build`. Confirmed against this
> repo: no existing `route.ts` exports anything non-standard. Task 4's guard also
> needs `formatTrackingGapAlert`, and importing it from a route module would be
> both fragile and against the local convention.

- [ ] **Step 0: Add the alert key and formatter to the lib module**

Append to `lib/reporting/tracking-gap.ts` (and add `import { formatCampaignDateTime } from "@/lib/campaign-timezone";` to its imports):

```ts
// One latch per stage. Keyed by stage, not by campaign or host, deliberately:
// a second bad landing page must not hide behind the first one's latch.
export function trackingGapAlertKey(stageId: number): string {
  return `tracking_gap:stage:${stageId}`;
}

// ⚠️ PLAIN TEXT. notifyTelegram() sends without parse_mode, so HTML tags would
// render literally in the channel. Do not add markup here.
export function formatTrackingGapAlert(b: TrackingGapBreach): string {
  return [
    "⚠️ Keitaro tracking gap",
    `Stage ${b.tracking_id ?? b.stage_id} — ${b.campaign_name}`,
    `CamMan recorded ${b.human_clicks.toLocaleString()} clicks, but Keitaro shows ` +
      `0 visits and ${b.redirects.toLocaleString()} redirects since send ` +
      `(${formatCampaignDateTime(b.sent_at)}).`,
    `LP: ${b.destination_url ?? "(no destination recorded)"}`,
    "Likely cause: LP is missing the Keitaro visit script, or the LP is dead/404. " +
      "Open the LP and check both.",
  ].join("\n");
}
```

- [ ] **Step 1: Add the heartbeat entry**

In `lib/reporting/cron-heartbeat.ts`, inside the `HEARTBEAT_JOBS` object, after the `epcMonitors` entry:

```ts
  // The hourly Keitaro tracking-gap monitor. Watched by nobody yet — it is the
  // newest job and there is no natural partner on an hourly cadence. Recording
  // its heartbeat now means a future watcher needs no change here.
  trackingMonitors: {
    job_name: "tracking-monitors",
    max_age_hours: 3, // hourly cadence, ~2 missed runs
    label: "Keitaro tracking-gap monitor (hourly)",
  },
```

- [ ] **Step 2: Write the route**

Create `app/api/cron/tracking-monitors/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  formatTrackingGapAlert,
  runTrackingGapMonitor,
  trackingGapAlertKey,
} from "@/lib/reporting/tracking-gap";

// Keitaro tracking-gap monitor.
//
// A landing page missing its Keitaro visit script produces NO other symptom:
// sends succeed, DLRs arrive, redirects may even keep landing, and the Overview
// tab renders "Clickers 0" as though nobody clicked. This job is the only thing
// that notices.
//
// Breach-only, latched per stage: a periodic all-clear trains people to ignore
// the channel, and an unlatched threshold check would page every hour for as
// long as the condition held. Auth mirrors /api/cron/tells-monitors.
// ⚠️ ONLY the exports Next.js allows in a route module. The alert key and the
// message formatter live in lib/reporting/tracking-gap.ts — an extra export here
// fails `next build`.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const report = await runTrackingGapMonitor(db);

  // Only the scheduler notifies. A human hitting this route gets the findings in
  // the response body without spraying the channel.
  if (bearerMatches) {
    for (const b of report.breaches) {
      // notifyOnTransition is best-effort by contract and swallows its own
      // errors, so one bad stage cannot stop the rest from being evaluated.
      await notifyOnTransition(db, {
        alertKey: trackingGapAlertKey(b.stage_id),
        orgId: b.org_id,
        text: formatTrackingGapAlert(b),
      });
    }
    // Re-arm stages that recovered, so a stage that regresses after a fix can
    // alert again. Without this the latch is a one-shot for the life of the row.
    for (const stageId of report.clean_stage_ids) {
      await clearAlert(db, { alertKey: trackingGapAlertKey(stageId) });
    }
    // Stamp AFTER the work, so a run that threw does not look healthy.
    await recordHeartbeat(db, HEARTBEAT_JOBS.trackingMonitors.job_name);
  }

  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
```

- [ ] **Step 3: Add the cron entry**

In `vercel.json`, add to the `crons` array (minute 37 is unused by every existing entry):

```json
    {
      "path": "/api/cron/tracking-monitors",
      "schedule": "37 * * * *"
    }
```

- [ ] **Step 4: Verify it compiles and the route responds**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx tsc --noEmit
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')).crons.forEach(c=>console.log(c.schedule,c.path))" | grep tracking
```

Expected: `tsc` clean; the grep prints `37 * * * * /api/cron/tracking-monitors`.

- [ ] **Step 5: Commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx eslint app/api/cron/tracking-monitors/route.ts lib/reporting/cron-heartbeat.ts
git add app/api/cron/tracking-monitors/route.ts vercel.json lib/reporting/cron-heartbeat.ts
git commit -m "feat(monitors): hourly tracking-gap cron with per-stage alert latch

Latched per stage so a second bad landing page cannot hide behind the
first one's latch. Recovered stages are re-armed via clearAlert.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The durability guard

The probe from Task 2 asserts against today's world state, which expires the moment the landing page is fixed. This guard proves the rule can still go **red** afterwards, by synthesizing both cases inside a transaction that is rolled back.

This is the failure mode that has bitten this codebase repeatedly: guards asserting "ships empty" or "nobody has set one" go green forever and then go red on the day the feature is first used correctly.

**Files:**
- Create: `scripts/verify-tracking-gap.ts`

**Interfaces:**
- Consumes: `runTrackingGapMonitor`, the constants (Tasks 1–2); `formatTrackingGapAlert` (Task 3).
- Produces: nothing (an executable check).

- [ ] **Step 1: Write the guard**

Create `scripts/verify-tracking-gap.ts`:

```ts
// Durability guard for the Keitaro tracking-gap monitor.
// Run: npx tsx scripts/verify-tracking-gap.ts
//
// ⚠️ WHY THIS EXISTS. The obvious check — "does it find the 5 lumzen.co stages?"
// — is a countdown, not a guard. The moment the landing page gets its visit
// script back, that assertion goes green-by-absence and stops testing anything.
// So this script does BOTH:
//
//   PART 1 reports the live picture (informational, never fails).
//   PART 2 asserts the DURABLE INVARIANT by synthesizing a gap stage and a
//          healthy stage inside a transaction that is ROLLED BACK, proving the
//          rule can still go red after today's gap closes.
//
// Everything runs inside one rolled-back transaction. Nothing is written.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  formatTrackingGapAlert,
  runTrackingGapMonitor,
  trackingGapBreached,
  TRACKING_GAP_MIN_HUMAN_CLICKS,
} from "@/lib/reporting/tracking-gap";

let fail = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}

// ── PART 1 — the live picture. Reported, never asserted. ────────────────────
console.log("\nPART 1 — live findings (informational)\n");
const live = await runTrackingGapMonitor(db);
console.log(
  `  evaluated ${live.stages_evaluated} stage(s): ` +
    `${live.breaches.length} breaching, ${live.clean_stage_ids.length} clean`,
);
for (const b of live.breaches) {
  console.log(
    `    stage ${b.stage_id} (${b.tracking_id}) — ${b.human_clicks} human clicks, ` +
      `${b.redirects} redirects, LP ${b.destination_url}`,
  );
}
if (live.breaches.length === 0) {
  console.log("    none — either the landing pages are healthy or nothing sent recently.");
}

// Sample alert text, so a formatting regression is visible in the output.
if (live.breaches.length > 0) {
  console.log("\n  sample alert body:\n");
  console.log(
    formatTrackingGapAlert(live.breaches[0])
      .split("\n")
      .map((l) => `    | ${l}`)
      .join("\n"),
  );
}

// ── PART 2 — the durable invariant. Synthesized, asserted, rolled back. ─────
console.log("\nPART 2 — durable invariant (synthesized, rolled back)\n");

// The pure rule, first — it needs no fixtures and can never rot.
ok(
  trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS, 0),
  "a stage at the click floor with ZERO visits is reported",
);
ok(
  !trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS, 1),
  "the SAME stage with ONE visit is NOT reported",
);
ok(
  !trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS - 1, 0),
  "below the click floor is NOT reported",
);

// Now the SQL path, against synthesized rows. This is what catches a query that
// stops matching the rule — a WHERE clause edited, a join dropped, a column
// renamed by a migration.
try {
  await db.transaction(async (tx) => {
    // Pick any real tracked campaign + org so FKs are satisfiable.
    const seed = (await tx.execute(sql`
      SELECT c.id AS campaign_id, c.org_id
      FROM campaigns c
      WHERE c.link_mode = 'tracked'
      ORDER BY c.id DESC
      LIMIT 1
    `)) as unknown as { campaign_id: number; org_id: string }[];
    if (seed.length === 0) throw new Error("no tracked campaign to seed from");
    const { campaign_id, org_id } = seed[0];

    const before = await runTrackingGapMonitor(tx);
    const beforeIds = new Set(before.breaches.map((b) => b.stage_id));

    // Two synthetic stages, both sent 24h ago (inside the window, past maturity).
    const stages = (await tx.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at)
      VALUES
        (${org_id}::uuid, ${campaign_id}, 901, 'VERIFY_GAP_STAGE',     now() - interval '24 hours'),
        (${org_id}::uuid, ${campaign_id}, 902, 'VERIFY_HEALTHY_STAGE', now() - interval '24 hours')
      RETURNING id, tracking_id
    `)) as unknown as { id: number; tracking_id: string }[];
    const gapStage = stages.find((s) => s.tracking_id === "VERIFY_GAP_STAGE")!.id;
    const healthyStage = stages.find((s) => s.tracking_id === "VERIFY_HEALTHY_STAGE")!.id;

    // The healthy stage gets Keitaro visits; the gap stage gets a row with ZERO
    // visits (proving the monitor keys off the value, not off a missing row).
    await tx.execute(sql`
      INSERT INTO keitaro_stage_results
        (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
         visit_clicks_raw, visit_clicks_clean, redirect_clicks_clean)
      VALUES
        (${org_id}::uuid, ${campaign_id}, ${gapStage},     'VERIFY_GAP_STAGE',     current_date, 0,  0, 7),
        (${org_id}::uuid, ${campaign_id}, ${healthyStage}, 'VERIFY_HEALTHY_STAGE', current_date, 40, 30, 5)
    `);

    // Both stages get the SAME number of human clicks — so the only thing that
    // can distinguish them is the visit count.
    const n = TRACKING_GAP_MIN_HUMAN_CLICKS + 5;
    const dest = (await tx.execute(sql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${org_id}::uuid, 'https://verify.example/lp', 'verify-tracking-gap-hash')
      RETURNING id
    `)) as unknown as { id: number }[];

    for (const stageId of [gapStage, healthyStage]) {
      await tx.execute(sql`
        WITH new_links AS (
          INSERT INTO links (org_id, campaign_id, stage_id, destination_id, code, send_token)
          SELECT ${org_id}::uuid, ${campaign_id}, ${stageId}, ${dest[0].id},
                 'vfy' || ${stageId} || '_' || g, g
          FROM generate_series(1, ${n}) g
          RETURNING id
        )
        INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at)
        SELECT ${org_id}::uuid, id, now() - interval '1 hour', 'human', now()
        FROM new_links
      `);
    }

    const after = await runTrackingGapMonitor(tx);
    const gap = after.breaches.find((b) => b.stage_id === gapStage);
    const healthy = after.breaches.find((b) => b.stage_id === healthyStage);

    ok(gap !== undefined, "⭐ SQL path: the synthesized ZERO-VISIT stage IS reported");
    ok(
      healthy === undefined,
      "⭐ SQL path: the synthesized stage WITH visits is NOT reported (same click count)",
    );
    ok(
      gap?.human_clicks === n,
      `SQL path: reports the human-click count (${gap?.human_clicks} === ${n})`,
    );
    ok(
      gap?.redirects === 7,
      `⭐ SQL path: reports redirect_clicks_CLEAN (${gap?.redirects} === 7), not raw+clean`,
    );
    ok(
      gap?.destination_url === "https://verify.example/lp",
      "SQL path: resolves the landing-page URL for a breaching stage",
    );
    ok(
      after.clean_stage_ids.includes(healthyStage),
      "SQL path: the healthy stage is returned as clean, so its latch gets re-armed",
    );
    ok(
      before.stages_evaluated + 2 === after.stages_evaluated,
      "SQL path: both synthesized stages entered the candidate set",
    );
    ok(
      !beforeIds.has(gapStage),
      "sanity: the synthesized gap stage did not exist before this transaction",
    );

    if (gap) {
      const body = formatTrackingGapAlert(gap);
      ok(
        body.startsWith("⚠️ Keitaro tracking gap\n"),
        "alert body opens with the exact briefed heading",
      );
      ok(
        body.includes("Likely cause: LP is missing the Keitaro visit script"),
        "alert body carries the briefed remediation line",
      );
      ok(!/<[a-z/]/i.test(body), "⭐ alert body contains NO markup (notifyTelegram is plain text)");
    }

    // Nothing above is meant to persist.
    throw new Error("__ROLLBACK__");
  });
} catch (err) {
  if (!(err instanceof Error) || err.message !== "__ROLLBACK__") throw err;
  console.log("\n  (transaction rolled back — nothing written)");
}

// Prove the rollback actually happened.
const residue = (await db.execute(sql`
  SELECT count(*)::int AS n FROM campaign_stages
  WHERE tracking_id IN ('VERIFY_GAP_STAGE', 'VERIFY_HEALTHY_STAGE')
`)) as unknown as { n: number }[];
ok(Number(residue[0].n) === 0, "⭐ residue check: no synthesized rows survived");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsx scripts/verify-tracking-gap.ts
```

Expected: `PASS — 0 failed check(s)`, with PART 1 listing today's live breaches and PART 2 showing all checks ✓.

If an `INSERT` fails on a NOT NULL column this plan did not anticipate, read the failure, add the missing column with a sensible value, and re-run. Do **not** weaken an assertion to make it pass.

- [ ] **Step 3: Prove the guard can fail**

Temporarily change the seeded healthy row's `visit_clicks_raw` from `40` to `0` and `visit_clicks_clean` from `30` to `0`, then re-run.

Expected: FAIL on "the synthesized stage WITH visits is NOT reported". **Revert the edit** and confirm PASS again. A guard never proven to go red is not a guard.

- [ ] **Step 4: Commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx eslint scripts/verify-tracking-gap.ts
git add scripts/verify-tracking-gap.ts
git commit -m "test(monitors): durability guard for the tracking-gap rule

Asserts the invariant against synthesized rows in a rolled-back transaction,
so it keeps testing something after the live lumzen.co gap is fixed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Part B — the read-time fallback in the Overview API

**Files:**
- Modify: `app/api/keitaro/reports/route.ts` (after line 121)
- Create: `scripts/verify-clickers-fallback.ts`

**Interfaces:**
- Consumes: `getStageMetricsInRange` (existing), `ClickerDenominators.periodByStage` (existing).
- Produces: a `clickers_is_fallback: boolean` field on every row of the `/api/keitaro/reports` response, plus `clickers_is_fallback` on the `totals` object.

- [ ] **Step 1: Capture the pre-change baseline**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsx scripts/verify-clickers-fallback.ts --baseline
```

This fails — the script does not exist yet. Write it in Step 2 first, run the baseline, then implement.

- [ ] **Step 2: Write the verification script**

Create `scripts/verify-clickers-fallback.ts`:

```ts
// Verifies the Overview clickers fallback: campaign 924's stage renders CamMan's
// counted clickers, a healthy guidekn stage is untouched, and NOTHING that feeds
// EPC moves.
//
// Run:  npx tsx scripts/verify-clickers-fallback.ts --baseline   (before the change)
//       npx tsx scripts/verify-clickers-fallback.ts              (after)
//
// The baseline is written to .tracking-gap-baseline.json (gitignored scratch).
import "./_env-preload";

import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";

const BASELINE = ".tracking-gap-baseline.json";
const isBaseline = process.argv.includes("--baseline");

// The two reference stages. 3029 is the gap (0 visits, 282 counted clickers);
// the guidekn control is resolved live so it stays valid as data ages.
const GAP_STAGE = 3029;

const control = (await db.execute(sql`
  SELECT k.stage_id, sum(k.visit_clicks_clean)::int AS visits_clean
  FROM keitaro_stage_results k
  JOIN links l ON l.stage_id = k.stage_id
  JOIN link_destinations ld ON ld.id = l.destination_id
  WHERE ld.url LIKE 'https://www.guidekn.com/%'
  GROUP BY 1 HAVING sum(k.visit_clicks_clean) > 0
  ORDER BY 2 DESC LIMIT 1
`)) as unknown as { stage_id: number; visits_clean: number }[];

const CONTROL_STAGE = Number(control[0].stage_id);
console.log(`gap stage ${GAP_STAGE}, guidekn control stage ${CONTROL_STAGE}`);

const rows = (await db.execute(sql`
  SELECT k.stage_id,
         sum(k.visit_clicks_clean)::int AS visits_clean,
         (SELECT count(*)::int FROM counted_clickers cc WHERE cc.stage_id = k.stage_id) AS counted
  FROM keitaro_stage_results k
  WHERE k.stage_id IN (${GAP_STAGE}, ${CONTROL_STAGE})
  GROUP BY 1
`)) as unknown as { stage_id: number; visits_clean: number; counted: number }[];

const snapshot = Object.fromEntries(
  rows.map((r) => [
    r.stage_id,
    { visits_clean: Number(r.visits_clean), counted: Number(r.counted) },
  ]),
);

if (isBaseline) {
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2));
  console.log(`baseline written to ${BASELINE}:`);
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

let fail = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}

const base = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof snapshot;

// The SOURCE data must be identical — the fallback is display-time only.
ok(
  JSON.stringify(base) === JSON.stringify(snapshot),
  "⭐ keitaro_stage_results and counted_clickers are UNCHANGED (no data write)",
);
ok(snapshot[GAP_STAGE].visits_clean === 0, `gap stage ${GAP_STAGE} still has 0 Keitaro visits`);
ok(snapshot[GAP_STAGE].counted > 0, `gap stage ${GAP_STAGE} has CamMan counted clickers to fall back to`);
ok(
  snapshot[CONTROL_STAGE].visits_clean > 0,
  `control stage ${CONTROL_STAGE} has Keitaro visits, so it must NOT fall back`,
);

console.log(
  `\n  expected on screen: stage ${GAP_STAGE} -> ${snapshot[GAP_STAGE].counted}* ` +
    `(was 0), stage ${CONTROL_STAGE} -> ${snapshot[CONTROL_STAGE].visits_clean} (unmarked)`,
);
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the baseline, then verify it currently reports the gap**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
echo ".tracking-gap-baseline.json" >> .git/info/exclude
npx tsx scripts/verify-clickers-fallback.ts --baseline
npx tsx scripts/verify-clickers-fallback.ts
```

Expected: baseline written, then `PASS` — stage 3029 has `visits_clean: 0` and `counted: 282`.

- [ ] **Step 4: Implement the fallback**

In `app/api/keitaro/reports/route.ts`, immediately after the `linkModeByCampaign` line (currently line 121), insert:

```ts
  // ── READ-TIME CLICKERS FALLBACK ──────────────────────────────────────────
  //
  // When a landing page loses its Keitaro visit script, `visit_clicks_clean`
  // reads 0 while CamMan keeps recording every tap — so the Clickers column
  // reports "nobody clicked" for a stage that got thousands of taps. The
  // /api/cron/tracking-monitors job alerts on it; this makes the number on
  // screen honest in the meantime, and for every past period at once.
  //
  // ⚠️ DISPLAY-TIME ONLY. Writing CamMan counts into keitaro_stage_results would
  // poison the sync source and the next poll would fight it. Nothing here
  // persists; the substitution self-retires the moment visits resume.
  //
  // ⚠️ THE SUBSTITUTE IS counted_clickers, NOT raw taps. Measured over the 284
  // healthy guidekn stages: counted_clickers = 1.35x visit_clicks_clean, while
  // distinct contacts across ALL clicks = 11.0x. Rendering the unfiltered figure
  // would put an 11x-inflated number beside counted_clickers in the same row.
  //
  // ⚠️ STAGE GRAIN, DELIBERATELY. The Keitaro column is itself assembled by
  // summing per-stage rows, so summing stage-grain counted_clickers matches how
  // the number it replaces is built. periodByCampaign is deduplicated at
  // campaign grain and would make a fallback row systematically smaller.
  //
  // Gated to link_mode 'tracked': manual campaigns mint no links, so they have
  // no CamMan clicks, and denominatorFor() still reads the real Keitaro value
  // for them. The gate makes that structural rather than coincidental.
  const clickersFallbackStageIds = new Set<number>();
  for (const s of stages) {
    if (s.link_mode !== "tracked") continue;
    if (s.tally.visit_clicks_clean !== 0) continue;
    const cammanClickers = clickers.periodByStage.get(s.stage_id) ?? 0;
    if (cammanClickers <= 0) continue;
    s.tally.visit_clicks_clean = cammanClickers;
    // `grand` was accumulated inside getStageMetricsInRange BEFORE this patch,
    // so it does not see the mutation above and must be topped up by hand.
    // Gap stages contributed 0 to the Keitaro side, so this cannot double-count.
    grand.visit_clicks_clean += cammanClickers;
    clickersFallbackStageIds.add(s.stage_id);
  }
```

Then add `clickers_is_fallback: boolean;` to the `OutRow` type (after `clickers: number` is produced by `withFunnelDerived`, so declare it alongside `click_rate`):

```ts
    click_rate: number;
    // True when `clickers` is CamMan's counted-clicker count standing in for a
    // missing Keitaro visit count. The UI marks the value and suppresses the
    // rates that divide by it.
    clickers_is_fallback: boolean;
```

In the **campaign** row builder, add after `click_rate:`:

```ts
      clickers_is_fallback: stages.some(
        (s) => s.campaign_id === c.campaign_id && clickersFallbackStageIds.has(s.stage_id),
      ),
```

In the **stage** row builder, add after `click_rate:`:

```ts
        clickers_is_fallback: clickersFallbackStageIds.has(acc.stage_id),
```

Finally, on the `totals` object (around line 328), add:

```ts
      clickers_is_fallback: clickersFallbackStageIds.size > 0,
```

- [ ] **Step 5: Verify nothing that feeds EPC moved**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx tsc --noEmit
npx tsx scripts/verify-clickers-fallback.ts
```

Expected: `tsc` clean; `PASS` — the source tables are byte-identical to the baseline, proving the change wrote nothing.

- [ ] **Step 6: Commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx eslint app/api/keitaro/reports/route.ts scripts/verify-clickers-fallback.ts
git add app/api/keitaro/reports/route.ts scripts/verify-clickers-fallback.ts
git commit -m "feat(reports): read-time CamMan clickers fallback on the Overview tab

Substitutes counted_clickers when Keitaro visits read 0 on a tracked stage.
Stage grain, matching how the Keitaro column is itself assembled. EPC and
counted_clickers resolve via denominatorFor and are untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Part B — the marker, the suppressed rates, and the legend

**Files:**
- Modify: `components/reports/keitaro-report.tsx`

**Interfaces:**
- Consumes: `clickers_is_fallback` on each row and on `totals` (Task 5).
- Produces: nothing downstream.

- [ ] **Step 1: Add the field to the row type**

In the `ReportRow` type (around line 35), after `click_rate: number;`:

```ts
  // True when `clickers` is CamMan's count standing in for a missing Keitaro
  // visit count. Marks the value and blanks the rates that divide by it.
  clickers_is_fallback: boolean;
```

And on the totals type (search for `counted_clickers: number;` inside the totals shape), add:

```ts
  clickers_is_fallback: boolean;
```

- [ ] **Step 2: Mark the Clickers cell**

Replace the `clickers` column cell (currently line 369-374):

```tsx
      {
        id: "clickers",
        header: "Clickers",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            title={
              row.original.clickers_is_fallback
                ? "CamMan clicks — Keitaro visits unavailable"
                : undefined
            }
          >
            {fmtInt(row.original.clickers)}
            {row.original.clickers_is_fallback ? (
              <sup className="text-muted-foreground">*</sup>
            ) : null}
          </span>
        ),
      },
```

- [ ] **Step 3: Suppress the two rates that divide by the missing denominator**

Replace the `click_rate` cell:

```tsx
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.clickers_is_fallback ? "—" : fmtPct(row.original.click_rate)}
          </span>
        ),
```

Replace the `redirect_rate` cell:

```tsx
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.clickers_is_fallback ? "—" : fmtPct(row.original.redirect_rate)}
          </span>
        ),
```

Both rates divide by `visit_clicks_clean`. Recomputing them against the CamMan denominator would produce a hybrid — a Keitaro numerator over a CamMan denominator, biased ~26% low given the measured 1.35 ratio — and no legend can honestly explain a hybrid rate. `—` says the denominator is missing.

- [ ] **Step 4: Mark the StatCard and add the legend**

Replace the Clickers StatCard (line 595):

```tsx
          <StatCard
            label="Clickers"
            value={`${fmtInt(totals.clickers)}${totals.clickers_is_fallback ? "*" : ""}`}
          />
```

Directly after the closing `</div>` of the StatCard grid, add:

```tsx
        {totals.clickers_is_fallback ? (
          <p className="mt-2 text-xs text-muted-foreground">
            * CamMan clicks — Keitaro visits unavailable for this period. Rates that
            divide by Keitaro visits show —.
          </p>
        ) : null}
```

- [ ] **Step 5: Verify in the running app**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap && npx tsc --noEmit && npm run dev
```

Open `/reports`, set the range to cover 2026-08-22, group by stage, and search `8_115_082126_4_s1_c581`.

Expected: Clickers shows `282*` with the tooltip on hover; `CR, %` and `Offer Redirect %` both show `—`; the legend line appears under the stat cards. Then search a `guidekn` stage and confirm its Clickers value carries **no** asterisk and its rates render normally.

**Open the page and look.** A source-level grep proves a file contains the markup, not that the screen renders it — this codebase has already shipped UI copy into a dead render path that a source guard passed.

- [ ] **Step 6: Commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx eslint components/reports/keitaro-report.tsx
git add components/reports/keitaro-report.tsx
git commit -m "feat(reports): mark fallback clickers and blank the rates that divide by visits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

Docs are a single task because the change touches four doc files and the CHANGELOG line describes the whole branch. CLAUDE.md requires docs to ship with the change; the branch is the change.

**Files:**
- Modify: `docs/04-features/tracking-attribution.md`
- Modify: `docs/06-integrations.md`
- Modify: `docs/07-conventions.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Document the fallback and the monitor**

In `docs/04-features/tracking-attribution.md`, add a section:

```markdown
## Keitaro tracking gap — detection and display fallback

A landing page missing its Keitaro visit script records no visits while CamMan
keeps recording every tap. `keitaro_stage_results.visit_clicks_raw/clean` read 0,
the Overview tab renders "Clickers 0", and nothing else in the system notices —
sends succeed, DLRs arrive, and redirects may keep landing.

**Detection.** `/api/cron/tracking-monitors` (hourly) reports any tracked stage
sent 6h–7d ago with zero Keitaro visits and ≥25 CamMan human clicks. Latched per
stage through `alert_state`, so it alerts once per stage and re-arms if the stage
recovers. Rule and thresholds: [lib/reporting/tracking-gap.ts](../../lib/reporting/tracking-gap.ts).

Visits gate the alert; redirects are reported for context but never gate it — a
redirect fires downstream of the landing page and can land even when the visit
script never runs.

**Display fallback.** The Overview tab substitutes CamMan's `counted_clickers`
for a tracked stage whose `visit_clicks_clean` is 0, marks it with `*`, and
renders `—` for the rates that divide by the missing denominator. Read-time only
— nothing is written to `keitaro_stage_results`, so the next Keitaro poll cannot
fight it and the substitution self-retires when visits resume. Applied in
[app/api/keitaro/reports/route.ts](../../app/api/keitaro/reports/route.ts) at
stage grain, before the campaign rollup.

**Scope:** Overview only. The By Number / Offer / Sequence / Group tabs are
excluded — their rows aggregate many stages, and `counted_clickers` is not
additive across a dimension.
```

- [ ] **Step 2: Document the cron**

In `docs/06-integrations.md`, in the Vercel Cron table, add:

```markdown
| `/api/cron/tracking-monitors` | `37 * * * *` | Alerts when a sent stage has CamMan clicks but zero Keitaro landing-page visits. Latched per stage via `alert_state`. |
```

- [ ] **Step 3: Record the column mapping**

In `docs/07-conventions.md`, add:

```markdown
### Keitaro visit columns and their CamMan equivalents

Only `visit_clicks_clean` is ever rendered (as "Clickers"); `visit_clicks_raw` is
read into the funnel tally but reaches no screen.

When substituting a CamMan figure for a Keitaro visit count, scope it to
**human-classified** clicks. Measured 2026-08-24 over 284 healthy `guidekn.com`
stages:

| Keitaro column | CamMan equivalent | ratio |
|---|---|---|
| `visit_clicks_raw` | human click rows | 1.23x |
| `visit_clicks_clean` | `counted_clickers` | 1.35x |
| `visit_clicks_clean` | distinct contacts, any classification | **11.0x — wrong** |

The unfiltered distinct-contact count is ~11x the column it would replace,
because ~92% of taps are SMS scanners that never execute the landing page's
script. Using it would place an 11x-inflated number beside `counted_clickers` in
the same row.
```

- [ ] **Step 4: Append the changelog line**

Add to `docs/CHANGELOG.md`:

```markdown
2026-08-24 — Keitaro tracking-gap monitor (hourly cron, per-stage latch) + read-time CamMan clickers fallback on the Overview tab — docs/04-features/tracking-attribution.md, docs/06-integrations.md, docs/07-conventions.md
```

- [ ] **Step 5: Update the "last updated" dates**

Set the `last updated` line to `2026-08-24` on each of the three docs touched.

- [ ] **Step 6: Commit**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
git add docs/
git commit -m "docs: tracking-gap monitor, clickers fallback, and the column mapping

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Pre-merge overlap check and PR

**Files:** none modified unless the overlap check finds a conflict.

- [ ] **Step 1: Run every check one final time**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
npx tsc --noEmit
npx tsx scripts/test-tracking-gap.ts
npx tsx scripts/verify-tracking-gap.ts
npx tsx scripts/verify-clickers-fallback.ts
npx eslint $(git diff --name-only origin/main...HEAD | grep -E '\.tsx?$' | tr '\n' ' ')
```

Expected: all PASS, `tsc` and `eslint` clean.

- [ ] **Step 1b: Prove the other four report tabs cannot have moved**

Spec §5 check 4 requires the By Number / Offer / Sequence / Group tabs to be
byte-identical. They read through the shared layer, so the check is structural:

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
git diff --name-only origin/main...HEAD | grep -E \
  'lib/reporting/(stage-funnel|performance-report|counted-clickers)\.ts|lib/keitaro/funnel\.ts|components/reports/performance-report\.tsx'
```

Expected: **no output**. Those five files are the only path the other four tabs
read; if any appears, the fallback has leaked out of the Overview route and those
tabs must be re-verified against a captured baseline before merging.

- [ ] **Step 2: Diff every touched file against the drip branch**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
git fetch origin --quiet
for f in $(git diff --name-only origin/main...HEAD); do
  echo "=== $f"
  git diff --stat origin/main...origin/feat/drip-campaigns -- "$f" 2>/dev/null | tail -1
done
```

Any file with a non-empty diff on **both** branches is an overlap. If one appears, rebase onto the drip branch's changes and re-run Step 1 — never overwrite parallel work. `lib/reporting/cron-heartbeat.ts` and `vercel.json` are the likely candidates, since the drip work added entries to both.

- [ ] **Step 3: Confirm no migration was introduced**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
git diff --name-only origin/main...HEAD | grep -c "^db/migrations/"
```

Expected: `0`. This change requires no schema work; a migration appearing here means something went wrong.

- [ ] **Step 4: Open the PR**

```bash
cd /c/AFF/camman/.claude/worktrees/tgap
git push -u origin feat/tracking-gap-monitor
```

PR body must state: what was verified (the four check commands and their output), that no migration is included, the previous prod deployment ID as a rollback target, and that the monitor fires on 5 stages at merge time so the first hourly run will send 5 Telegram messages and then latch silent.

- [ ] **Step 5: Merge and confirm**

Per standing policy: verify green, merge, confirm the Vercel prod deployment reaches READY, then smoke-check `/api/cron/tracking-monitors` with the membership auth path (no `CRON_SECRET` bearer, so it reports without sending) and confirm the Overview tab renders `282*` on campaign 924.

---

## Notes for the implementer

**The thing most likely to go wrong.** Task 5 mutates `s.tally.visit_clicks_clean` in place. `grand` was already accumulated inside `getStageMetricsInRange` before that mutation, so it does **not** follow — which is why the loop tops `grand` up by hand. If you refactor the loop, keep that top-up or the totals card will disagree with the sum of its own rows.

**What must not move.** `epc`, `counted_clickers`, `lifetime_epc`, `lifetime_clickers` all resolve through `denominatorFor()`, which for tracked campaigns reads the counted-clickers cache and never touches the tally. If any of them changes, the `link_mode === "tracked"` gate has been dropped.

**Why the guard matters more than the probe.** Today's five breaching stages are one landing page away from vanishing. `scripts/probe-tracking-gap.ts` will then print zero breaches and prove nothing. `scripts/verify-tracking-gap.ts` synthesizes its own red case and keeps testing the rule — that is the one to run before merging anything that touches this code.
