import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { withCronLease } from "@/lib/cron/lease";
import { checkHeartbeats, HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  BASES,
  diffDripDailyRollup,
  DRIP_DAILY_ROLLUP_JOB,
  DRIP_DAILY_ROLLUP_RECONCILE_JOB,
  DRIP_DAILY_ROLLUP_SETTLE_JOB,
  nightlyDue,
  reconcileRange,
  refreshDripDailyRollup,
  rollupScope,
  type RefreshResult,
} from "@/lib/reporting/drip-daily-rollup";

// Refreshes drip_daily_rollup (migration 0208) — the ONLY writer besides the
// one-off backfill. See lib/reporting/drip-daily-rollup.ts.
//
// Every run (every 15 min, :01/:16/:31/:46 — clear of the heavy :29 audience-pools
// job) recomputes
// today + yesterday (ET), both bases. Once a night, from 05:00 UTC (~01:00 ET,
// after the send window, before the owner's day), the run widens to the last
// 14 ET days and then reconciles the FROZEN days 15–21 back: stored cells vs a
// fresh computation in one REPEATABLE READ snapshot. Any difference is a latched
// Telegram alert — it means 14 days stopped being enough.
//
// Heartbeats are stamped only when every org refreshed cleanly. This job is
// watched by /api/cron/drip-monitors; it watches its own nightly stamps.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000;
const DRIFT_ALERT = "drip-daily-rollup-drift";
const NIGHTLY_STALE_ALERT = "drip-daily-rollup-nightly-stale";

type OrgResult = { org_id: string; error?: string; refreshed?: RefreshResult[]; drift?: number; frozen_cells?: number };

async function watermark(job: string): Promise<Date | null> {
  const rows = (await db.execute(sql`SELECT watermark FROM cron_locks WHERE job_name = ${job}`)) as unknown as {
    watermark: string | null;
  }[];
  return rows[0]?.watermark ? new Date(rows[0].watermark) : null;
}

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
      const now = new Date();
      const scope = rollupScope(now, await watermark(DRIP_DAILY_ROLLUP_SETTLE_JOB));
      const reconcile = scope.settle && nightlyDue(now, await watermark(DRIP_DAILY_ROLLUP_RECONCILE_JOB));
      const frozen = reconcileRange(now);

      const orgs = (await db.execute(
        sql`SELECT DISTINCT org_id FROM campaigns WHERE type = 'drip'`,
      )) as unknown as { org_id: string }[];
      const results: OrgResult[] = [];
      for (const { org_id } of orgs) {
        // One org's failure must not stop the rest; it withholds the heartbeat.
        try {
          const refreshed: RefreshResult[] = [];
          for (const basis of BASES) {
            refreshed.push(
              await db.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
                return refreshDripDailyRollup(tx, org_id, basis, scope.range);
              }),
            );
          }
          const r: OrgResult = { org_id, refreshed };
          if (reconcile) {
            let drift = 0;
            let cells = 0;
            for (const basis of BASES) {
              const d = await db.transaction(
                async (tx) => {
                  await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
                  return diffDripDailyRollup(tx, org_id, basis, frozen);
                },
                { isolationLevel: "repeatable read" },
              );
              drift += d.diffs.length;
              cells += d.cells;
              if (d.diffs.length > 0) {
                console.error("[drip-daily-rollup] DRIFT in frozen cells", {
                  org_id, basis, frozen, sample: d.diffs.slice(0, 5),
                });
              }
            }
            r.drift = drift;
            r.frozen_cells = cells;
          }
          results.push(r);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error("[drip-daily-rollup] refresh failed", { org_id, error });
          results.push({ org_id, error });
        }
      }

      const ok = results.every((r) => !r.error);
      if (ok) {
        await recordHeartbeat(db, DRIP_DAILY_ROLLUP_JOB);
        if (scope.settle) await recordHeartbeat(db, DRIP_DAILY_ROLLUP_SETTLE_JOB);
        if (reconcile) {
          await recordHeartbeat(db, DRIP_DAILY_ROLLUP_RECONCILE_JOB);
          const drift = results.reduce((a, r) => a + (r.drift ?? 0), 0);
          if (drift > 0) {
            await notifyOnTransition(db, {
              alertKey: DRIFT_ALERT,
              text:
                `⚠️ Drip Daily results rollup: ${drift} FROZEN cell(s) in ${frozen.from}..${frozen.to} ` +
                `no longer match a fresh computation. Something changed a cell's source more than ` +
                `14 days after the fact — the 14-day settle window is too short for it. ` +
                `Vercel logs: [drip-daily-rollup] DRIFT.`,
            });
          } else {
            await clearAlert(db, { alertKey: DRIFT_ALERT });
          }
        }
      }

      // Watch the nightly settle + reconciliation. Latched: one message per transition.
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

      return { scope, reconcile: reconcile ? frozen : null, ok, results };
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
