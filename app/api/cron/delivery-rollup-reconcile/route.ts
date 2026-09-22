import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { withCronLease } from "@/lib/cron/lease";
import { checkHeartbeats, HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { queryDeliveryByStage } from "@/lib/reporting/delivery";
import {
  DELIVERY_ROLLUP_RECONCILE_JOB,
  diffDeliveryRows,
  etDayBounds,
  readDeliveryRollup,
  reconcileRange,
} from "@/lib/reporting/delivery-rollup";

// Nightly reconciliation of stage_delivery_rollup against the LIVE delivery
// query (migration 0186). Any drift pages Telegram (latched).
//
// ⚠️ WHY A FROZEN WINDOW. It checks the 7 ET days ending 7 days ago — cells the
// refresh no longer recomputes. There the stored rollup and the live query must
// agree EXACTLY, so any difference is a real defect: a refresh bug, a lost
// write, or a receipt that arrived later than the freeze assumes (0 of 2.64M
// ever did, max 5 d 00:02). Recent days cannot be reconciled exactly: receipts
// land and get matched between the refresh's snapshot and this one, so a diff
// there would mostly measure timing. The pre-cutover gate
// (scripts/verify-delivery-rollup.ts) covers recent windows by refreshing and
// comparing inside ONE snapshot instead.
//
// Both sides are read in ONE REPEATABLE READ snapshot. The live side is the
// query the rollup replaced, bounded the same way (received_at ≥ window − 1 h),
// so it scans every receipt received since the window opened — ~20 s nightly.
//
// Also watches both refresh tiers' heartbeats (never its own), and stamps its
// own only when the comparison completed for every org — drift or not.
// 07:44 UTC (03:44 ET, 02:44 ET in winter): after the night's last sends, and
// :44 is the one minute no other cron in vercel.json uses.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000;
const DRIFT_ALERT = "delivery-rollup-drift";
const REFRESH_STALE_ALERT = "delivery-rollup-refresh-stale";

type OrgResult = {
  org_id: string;
  stored_rows: number;
  live_rows: number;
  live_sends: number;
  diffs: number;
  sample: unknown[];
  error?: string;
};

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withCronLease(
    "delivery-rollup-reconcile-run",
    async () => {
      const range = reconcileRange(new Date());
      const bounds = etDayBounds(range);
      const orgs = (await db.execute(
        sql`SELECT id AS org_id FROM public.organizations`,
      )) as unknown as { org_id: string }[];

      const results: OrgResult[] = [];
      for (const { org_id } of orgs) {
        try {
          const r = await db.transaction(
            async (tx) => {
              await tx.execute(sql`SET LOCAL statement_timeout = '280s'`);
              const stored = await readDeliveryRollup(tx, org_id, range);
              const live = await queryDeliveryByStage(tx, org_id, bounds);
              return { stored, live };
            },
            { isolationLevel: "repeatable read", accessMode: "read only" },
          );
          const diffs = diffDeliveryRows(r.stored, r.live);
          results.push({
            org_id,
            stored_rows: r.stored.length,
            live_rows: r.live.length,
            live_sends: r.live.reduce((n, x) => n + x.sent, 0),
            diffs: diffs.length,
            sample: diffs.slice(0, 5),
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error("[delivery-rollup-reconcile] failed", { org_id, error });
          results.push({ org_id, stored_rows: 0, live_rows: 0, live_sends: 0, diffs: 0, sample: [], error });
        }
      }

      const drifted = results.filter((r) => r.diffs > 0);
      if (drifted.length > 0) {
        const lines = drifted.map(
          (r) =>
            `org ${r.org_id}: ${r.diffs} (stage, number) row(s) differ — ` +
            `stored ${r.stored_rows} rows vs live ${r.live_rows} (${r.live_sends} sends)`,
        );
        await notifyOnTransition(db, {
          alertKey: DRIFT_ALERT,
          text:
            `⚠️ Delivered % rollup DRIFT on the frozen window ${range.from} … ${range.to} ET:\n` +
            `${lines.join("\n")}\n` +
            `The Overview / delivery report are showing numbers that differ from the live query. ` +
            `Investigate with scripts/verify-delivery-rollup.ts --persisted.`,
        });
      } else if (results.every((r) => !r.error)) {
        await clearAlert(db, { alertKey: DRIFT_ALERT });
      }

      const tiers = await checkHeartbeats(db, [
        HEARTBEAT_JOBS.deliveryRollup,
        HEARTBEAT_JOBS.deliveryRollupSettle,
      ]);
      const stale = tiers.filter((t) => t.stale);
      if (stale.length > 0) {
        await notifyOnTransition(db, {
          alertKey: REFRESH_STALE_ALERT,
          text:
            `⚠️ Delivered % rollup is not refreshing: ` +
            stale
              .map((t) => `${t.label} last ran ${t.age_hours == null ? "never" : `${t.age_hours} h ago`} (limit ${t.max_age_hours} h)`)
              .join("; ") +
            `. The Overview's Delivered % is going stale. Check /api/cron/delivery-rollup in Vercel.`,
        });
      } else {
        await clearAlert(db, { alertKey: REFRESH_STALE_ALERT });
      }

      const completed = results.every((r) => !r.error);
      if (completed) await recordHeartbeat(db, DELIVERY_ROLLUP_RECONCILE_JOB);
      return { range, completed, drift: drifted.length > 0, results, refresh_heartbeats: tiers };
    },
    LEASE_MS,
  );
  if (!outcome.ran) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const r = outcome.result;
  return NextResponse.json(
    { ...r, ts: new Date().toISOString() },
    { status: r.completed ? 200 : 500 },
  );
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
