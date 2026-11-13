import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { withCronLease } from "@/lib/cron/lease";
import { checkHeartbeats, HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  diffDripDailyRollup,
  DRIP_DAILY_ROLLUP_JOB,
  freshRange,
  refreshDripDailyRollup,
} from "@/lib/reporting/drip-daily-rollup";
import { runFreshTier } from "@/lib/reporting/drip-daily-rollup-fresh";
import { runNightly } from "@/lib/reporting/drip-daily-rollup-nightly";

// Refreshes drip_daily_rollup (migration 0208) — the ONLY writer besides the
// one-off backfill. See lib/reporting/drip-daily-rollup.ts.
//
// Every run (every 15 min, :01/:16/:31/:46 — clear of the heavy :29 audience-pools
// job):
//   1. Tier A — today (every run) + yesterday (when its last refresh is ≥ 60 min
//      old, and always on the first run after ET midnight), both bases, every org
//      (lib/reporting/drip-daily-rollup-fresh.ts, 2026-11-13). Its heartbeat is
//      stamped whenever tier A succeeds, whatever the nightly part does.
//   2. The nightly settle (days 2–13 back) and reconcile (frozen days 14–20 back)
//      as small units, only inside [05:00, 09:00) UTC, until the run's budget is
//      spent. See lib/reporting/drip-daily-rollup-nightly.ts for why (2026-11-11:
//      the old all-or-nothing pass looped all working day and slowed the app).
//
// Watched by /api/cron/drip-monitors; it watches its own nightly stamps.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000;
const NIGHTLY_STALE_ALERT = "drip-daily-rollup-nightly-stale";

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withCronLease(
    "drip-daily-rollup-run",
    async () => {
      const runStartedMs = Date.now();
      const now = new Date();
      const range = freshRange(now);
      const orgIds = (
        (await db.execute(sql`SELECT DISTINCT org_id FROM campaigns WHERE type = 'drip'`)) as unknown as {
          org_id: string;
        }[]
      ).map((r) => r.org_id);

      // 1. Tier A. One org's failure must not stop the rest; it withholds the heartbeat.
      const { yesterday_refreshed, orgs: fresh } = await runFreshTier({
        db,
        orgIds,
        now,
        refresh: (orgId, basis, unitRange) =>
          db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
            return refreshDripDailyRollup(tx, orgId, basis, unitRange);
          }),
      });
      const freshOk = fresh.every((r) => !r.error);
      if (freshOk) await recordHeartbeat(db, DRIP_DAILY_ROLLUP_JOB);

      // 2. Nightly units (no-op outside the window).
      const nightly = await runNightly({
        db,
        orgIds,
        now: () => new Date(),
        runStartedMs,
        settle: async (orgId, unit) => {
          await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
            await refreshDripDailyRollup(tx, orgId, unit.basis, unit.range);
          });
        },
        reconcile: async (orgId, unit) =>
          (
            await db.transaction(
              async (tx) => {
                await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
                return diffDripDailyRollup(tx, orgId, unit.basis, unit.range);
              },
              { isolationLevel: "repeatable read" },
            )
          ).diffs.length,
        notify: (alertKey, text) => notifyOnTransition(db, { alertKey, text }),
        clear: (alertKey) => clearAlert(db, { alertKey }),
      });

      // Backstop: the nightly stamps themselves going stale (~2 missed nights). Latched.
      const stale = (
        await checkHeartbeats(db, [HEARTBEAT_JOBS.dripDailyRollupSettle, HEARTBEAT_JOBS.dripDailyRollupReconcile])
      ).filter((h) => h.stale);
      if (stale.length > 0) {
        await notifyOnTransition(db, {
          alertKey: NIGHTLY_STALE_ALERT,
          text:
            `⚠️ Drip Daily results rollup: the nightly ${stale.map((h) => h.label).join(" and ")} ` +
            `has not run for ${stale.map((h) => (h.age_hours == null ? "ever" : `${h.age_hours} h`)).join(" / ")}. ` +
            `Cells older than 2 days are not being settled or checked. Check /api/cron/drip-daily-rollup in Vercel.`,
        });
      } else {
        await clearAlert(db, { alertKey: NIGHTLY_STALE_ALERT });
      }

      const ok = freshOk && nightly.failed.length === 0;
      return { range, yesterday_refreshed, ok, fresh, nightly, ms: Date.now() - runStartedMs };
    },
    LEASE_MS,
  );
  if (!outcome.ran) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const r = outcome.result;
  return NextResponse.json({ ...r, ts: new Date().toISOString() }, { status: r.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
