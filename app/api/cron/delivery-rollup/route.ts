import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { withCronLease } from "@/lib/cron/lease";
import { checkHeartbeats, HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  DELIVERY_ROLLUP_JOB,
  DELIVERY_ROLLUP_SETTLE_JOB,
  refreshDeliveryRollup,
  rollupScope,
  type RefreshResult,
} from "@/lib/reporting/delivery-rollup";

// Refreshes stage_delivery_rollup (migration 0186) — the ONLY writer besides the
// one-off backfill. See lib/reporting/delivery-rollup.ts.
//
// Every run recomputes today + yesterday (ET); at most every 3 h the run widens
// to the last 7 ET days to fold in late receipts. Older cells are final.
// Measured on prod 2026-09-22: ~0.6 s warm / 2.2 s cold for one day of stages,
// ~10 s for six.
//
// Every 10 min at :03/:13/… — off the */5 minute marks the send and Keitaro poll
// crons use. The lease outlives maxDuration so a slow 7-day run can never overlap the
// next tick (a killed function's SQL keeps running server-side).
//
// Heartbeats are stamped only when EVERY org refreshed cleanly, so a failing run
// ages its heartbeat and the nightly reconciliation (which watches it) says so.
// This job in turn watches the reconciliation — neither vouches for itself.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const LEASE_MS = 4 * 60 * 1000;
const RECONCILE_STALE_ALERT = "delivery-rollup-reconcile-stale";

type OrgResult = { org_id: string; error?: string } & Partial<RefreshResult>;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withCronLease(
    "delivery-rollup-run",
    async () => {
      const settleRow = (await db.execute(sql`
        SELECT watermark FROM cron_locks WHERE job_name = ${DELIVERY_ROLLUP_SETTLE_JOB}
      `)) as unknown as { watermark: string | null }[];
      const lastSettle = settleRow[0]?.watermark ? new Date(settleRow[0].watermark) : null;
      const scope = rollupScope(new Date(), lastSettle);

      const orgs = (await db.execute(
        sql`SELECT id AS org_id FROM public.organizations`,
      )) as unknown as { org_id: string }[];
      const results: OrgResult[] = [];
      for (const { org_id } of orgs) {
        // One org's failure must not stop the rest; it withholds the heartbeat.
        try {
          const r = await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '100s'`);
            return refreshDeliveryRollup(tx, org_id, scope.range);
          });
          results.push({ org_id, ...r });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error("[delivery-rollup] refresh failed", { org_id, error });
          results.push({ org_id, error });
        }
      }

      const ok = results.every((r) => !r.error);
      if (ok) {
        await recordHeartbeat(db, DELIVERY_ROLLUP_JOB);
        if (scope.settle) await recordHeartbeat(db, DELIVERY_ROLLUP_SETTLE_JOB);
      }

      // Watch the nightly reconciliation. Latched: one message per transition.
      const [reconcile] = await checkHeartbeats(db, [HEARTBEAT_JOBS.deliveryRollupReconcile]);
      if (reconcile.stale) {
        await notifyOnTransition(db, {
          alertKey: RECONCILE_STALE_ALERT,
          text:
            `⚠️ Delivered % rollup: the nightly reconciliation has not run for ` +
            `${reconcile.age_hours == null ? "ever (no heartbeat)" : `${reconcile.age_hours} h`} ` +
            `(limit ${reconcile.max_age_hours} h). The rollup keeps refreshing, but nothing is ` +
            `checking it against the live query. Check /api/cron/delivery-rollup-reconcile in Vercel.`,
        });
      } else {
        await clearAlert(db, { alertKey: RECONCILE_STALE_ALERT });
      }

      return { scope, ok, results, reconcile_heartbeat: reconcile };
    },
    LEASE_MS,
  );
  if (!outcome.ran) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const r = outcome.result;
  return NextResponse.json(
    { ...r, ts: new Date().toISOString() },
    { status: r.ok ? 200 : 500 },
  );
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
