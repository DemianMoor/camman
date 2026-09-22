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
import {
  refreshContactEngagement,
  type RefreshMode,
  type RefreshResult,
} from "@/lib/engagement/refresh";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import { recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Maintains contact_engagement (migration 0187) — see lib/engagement/refresh.ts.
//
//   every 15 min at :10/:25/:40/:55   incremental (after propagate-clickers at :08/:23/…,
//                                     so a click scored this tick is already human)
//   ?mode=full at 06:35 UTC           full recount (02:35 ET, outside the send windows)
//
// INERT BY DEFAULT. Only orgs with lifecycle_settings.engine_mode = 'write' are
// processed, so every tick is a no-op until the one-off backfill
// (scripts/engagement-backfill.ts --apply) flips the switch.
//
// An incremental run falls back to a full recount when the last success is
// missing or older than FULL_FALLBACK_HOURS: catching up through an enormous
// touched set would be slower than recounting the org, and a long outage is
// exactly when drift is likeliest.
//
// Heartbeats are stamped only when EVERY org succeeded, so a failing org ages
// the heartbeat and the watcher says so. Status is never computed in the send
// loop — the drain only ever READS contact_engagement.
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
  const requested: RefreshMode =
    req.nextUrl.searchParams.get("mode") === "full" ? "full" : "incremental";

  const outcome = await withCronLease(
    ENGAGEMENT_LEASE,
    async () => {
      const orgs = await orgsWithEngineOn(db);
      if (orgs.length === 0) {
        return { ok: true, engine: "off" as const, results: [] as OrgResult[] };
      }

      const hb = (await db.execute(sql`
        SELECT watermark FROM cron_locks WHERE job_name = ${ENGAGEMENT_JOB}
      `)) as unknown as { watermark: string | null }[];
      const last = hb[0]?.watermark ? new Date(hb[0].watermark) : null;
      const staleWatermark =
        last == null || Date.now() - last.getTime() > FULL_FALLBACK_HOURS * 3_600_000;
      const mode: RefreshMode = requested === "full" || staleWatermark ? "full" : "incremental";
      const since = last
        ? new Date(last.getTime() - INCREMENTAL_OVERLAP_MINUTES * 60_000)
        : undefined;

      const results: OrgResult[] = [];
      for (const org_id of orgs) {
        // One org's failure must not stop the rest; it withholds the heartbeat.
        try {
          const r = await db.transaction(async (tx) => {
            await tx.execute(
              sql.raw(`SET LOCAL statement_timeout = '${mode === "full" ? "270s" : "100s"}'`),
            );
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
      // Watch the nightly recount from the frequent job, never from itself.
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
