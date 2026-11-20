import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import {
  ENGAGEMENT_DAY_ROLLUP_JOB,
  ENGAGEMENT_FULL_JOB,
  ENGAGEMENT_GROUP_ROLLUP_JOB,
  groupLifecycleRollupDue,
  ENGAGEMENT_JOB,
  ENGAGEMENT_LEASE,
  ENGAGEMENT_REEVAL_JOB,
  FULL_FALLBACK_HOURS,
  INCREMENTAL_OVERLAP_MINUTES,
  DAYTIME_RECOUNT,
  engagementCursorJob,
} from "@/lib/engagement/constants";
import { isCampaignDaytime } from "@/lib/campaign-timezone";
import { reportEngagementLag, runDaytimeSlices } from "@/lib/engagement/daytime-slices";
import { watchEngagementHeartbeat } from "@/lib/engagement/monitor";
import {
  reevaluationDue,
  refreshContactEngagement,
  type RefreshMode,
  type RefreshResult,
} from "@/lib/engagement/refresh";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import { recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { refreshGroupLifecycleRollup } from "@/lib/reporting/group-lifecycle-store";
import { refreshLifecycleDayRollup } from "@/lib/reporting/lifecycle-rollup";

// Maintains contact_engagement (migration 0187) — see lib/engagement/refresh.ts.
//
//   every 15 min at :10/:25/:40/:55   incremental (after propagate-clickers at :08/:23/…,
//                                     so a click scored this tick is already human)
//                                     + HOURLY (the :10 tick only, since 2026-11-17)
//                                     the Group x Lifecycle table (0193), which
//                                     the report reads instead of computing it
//   08:00–22:00 ET (since 2026-11-17) the incremental tick NEVER recounts the whole
//                                     org: lib/engagement/daytime-slices.ts cuts its
//                                     window into slices of <= DAYTIME_SLICE_MAX_TOUCHED
//                                     contacts, one transaction each, each advancing a
//                                     per-org cursor. A burst is worked off over ticks;
//                                     lag > 60 min pages. Outside those hours: unchanged.
//   ?mode=full at 06:35 UTC           full recount (02:35 ET, outside the send windows)
//                                     + the Lifecycle day rollup (migration 0192),
//                                     a 14-day rolling recompute so late clicks,
//                                     conversions and opt-outs still land
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
// Three steps, three heartbeats, each stamped the moment its step succeeded
// for EVERY org (a failing org ages that step's heartbeat and the watcher names
// it): the recount (contact-engagement / -full / -reeval), then the Group x
// Lifecycle rollup, then — nightly — the Lifecycle day rollup. Until 2026-10-21
// the recount heartbeats were stamped after BOTH rollups, so the nightly run
// killed at the old 300 s limit inside the day rollup (Oct 20 + 21) reported
// the recount — which had committed — as 50 h stale. Status is never computed
// in the send loop — the drain only ever READS contact_engagement.
export const dynamic = "force-dynamic";
// 800 s = the Pro + Fluid compute ceiling (confirmed 2026-10-21). The nightly
// run measured ~245 s recount + ~10 s group + ~41 s day rollup ≈ 297 s on
// 10-19 and then outgrew 300 s. A stopgap: the planned fix splits the steps
// into separate routes and batches the recount.
export const maxDuration = 800;

const LEASE_MS = 14 * 60 * 1000; // > maxDuration: a killed function's SQL keeps running

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
  const tickAt = new Date(); // the cron tick, before the recount's own duration

  const outcome = await withCronLease(
    ENGAGEMENT_LEASE,
    async () => {
      const orgs = await orgsWithEngineOn(db);
      if (orgs.length === 0) {
        return { ok: true, engine: "off" as const, results: [] as OrgResult[] };
      }

      // Where each org's window starts: its own cursor (written by every
      // successful recount, per slice in the daytime path), else - the first
      // tick after this deploy - the job heartbeat that served as the
      // watermark before 2026-11-17.
      const hb = (await db.execute(sql`
        SELECT job_name, watermark FROM cron_locks
         WHERE job_name = ${ENGAGEMENT_JOB} OR job_name LIKE 'contact-engagement-cursor:%'
      `)) as unknown as { job_name: string; watermark: string | null }[];
      const legacy = hb.find((r) => r.job_name === ENGAGEMENT_JOB)?.watermark ?? null;
      const cursorOf = (orgId: string): Date | null => {
        const w = hb.find((r) => r.job_name === engagementCursorJob(orgId))?.watermark ?? legacy;
        return w ? new Date(w) : null;
      };
      // ⚠️ No org-wide recount in the ET working day - not by request, not by
      // escalation, not by the stale fallback (owner, 2026-11-17). The nightly
      // ?mode=full run (06:35 UTC = 01:35/02:35 ET) is outside it by schedule.
      const daytime = requested === "incremental" && isCampaignDaytime(tickAt);

      // A threshold edit moves neither the touched set nor time_due_at, so it
      // would otherwise reach a contact only when its next message or click
      // arrived. The settings save stamps reevaluate_requested_at; this run
      // honours it by evaluating every stored row (no recount — the facts are
      // already stored) and then records that it did.
      const [reeval] = (await db.execute(sql`
        SELECT (SELECT max(reevaluate_requested_at) FROM lifecycle_settings WHERE engine_mode = 'write') AS requested_at,
               (SELECT watermark FROM cron_locks WHERE job_name = ${ENGAGEMENT_REEVAL_JOB}) AS last_at
      `)) as unknown as { requested_at: string | null; last_at: string | null }[];
      const evaluateAll = reevaluationDue(
        reeval?.requested_at ? new Date(reeval.requested_at) : null,
        reeval?.last_at ? new Date(reeval.last_at) : null,
      );

      const results: OrgResult[] = [];
      let mode: RefreshMode = requested;
      let caughtUp = true;
      for (const org_id of orgs) {
        // One org's failure must not stop the rest; it withholds the heartbeat.
        const started = Date.now();
        const last = cursorOf(org_id);
        if (daytime && last != null) {
          try {
            const d = await runDaytimeSlices({
              orgId: org_id,
              cursor: last,
              overlapMinutes: INCREMENTAL_OVERLAP_MINUTES,
              evaluateAll,
              recount: DAYTIME_RECOUNT,
            });
            console.info("[contact-engagement] daytime slices", {
              org_id,
              slices: d.slices,
              slicesPlanned: d.slicesPlanned,
              caughtUp: d.caughtUp,
              lag_minutes: d.lagMinutes,
              recounted: d.recounted,
              maxSliceRecounted: d.maxSliceRecounted,
              durationMs: Date.now() - started,
            });
            await reportEngagementLag(db, org_id, d.lagMinutes);
            if (!d.caughtUp) caughtUp = false;
            results.push({ org_id, mode: "incremental", recounted: d.recounted });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error("[contact-engagement] daytime slice failed", { org_id, error });
            // The committed slices moved the cursor; the lag is measured from it.
            const [c] = (await db.execute(sql`
              SELECT watermark FROM cron_locks WHERE job_name = ${engagementCursorJob(org_id)}
            `)) as unknown as { watermark: string | null }[];
            const at = c?.watermark ? new Date(c.watermark) : last;
            await reportEngagementLag(db, org_id, Math.round((Date.now() - at.getTime()) / 60_000));
            results.push({ org_id, error });
          }
          continue;
        }
        const staleWatermark =
          last == null || Date.now() - last.getTime() > FULL_FALLBACK_HOURS * 3_600_000;
        const orgMode: RefreshMode = requested === "full" || staleWatermark ? "full" : "incremental";
        if (orgMode === "full") mode = "full";
        const since = last
          ? new Date(last.getTime() - INCREMENTAL_OVERLAP_MINUTES * 60_000)
          : undefined;
        try {
          const r = await db.transaction(async (tx) => {
            // One budget for both modes: an incremental run ESCALATES to a full
            // recount when the touched set is too big (lib/engagement/refresh.ts),
            // and a 100 s ceiling would kill exactly the runs that needed to
            // escalate. The lease, not the timeout, is what stops overlap.
            // 600 s: the full recount alone reached ~245 s against the old 270 s.
            await tx.execute(sql.raw("SET LOCAL statement_timeout = '600s'"));
            const res = await refreshContactEngagement(tx, org_id, {
              mode: orgMode,
              dryRun: false,
              since,
              evaluateAll,
              // Outside the working day (or the very first run): today's single
              // window, escalation allowed.
              daytimeSlice: null,
            });
            // now() is the transaction start - at or before every row this run
            // read, so the next window (minus the overlap) cannot skip one.
            await tx.execute(sql`
              INSERT INTO cron_locks (job_name, watermark) VALUES (${engagementCursorJob(org_id)}, now())
              ON CONFLICT (job_name) DO UPDATE SET watermark = EXCLUDED.watermark`);
            return res;
          });
          await reportEngagementLag(db, org_id, 0);
          console.info("[contact-engagement] recount", {
            org_id,
            mode: r.mode,
            escalatedToFull: r.escalatedToFull ?? false,
            recounted: r.recounted,
            durationMs: Date.now() - started,
          });
          results.push({ org_id, ...r });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error("[contact-engagement] refresh failed", { org_id, mode, error });
          results.push({ org_id, error });
        }
      }

      // Stamp the recount heartbeats NOW, before either rollup: the statuses the
      // send path reads are committed, and a rollup that fails or runs the
      // function out of time must not make them look stale.
      const ok = results.every((r) => !r.error);
      // The recount heartbeat means "statuses are current": a daytime tick that
      // ended behind does NOT stamp it (the lag alert speaks for that case).
      if (ok && caughtUp) {
        await recordHeartbeat(db, ENGAGEMENT_JOB);
        if (mode === "full") await recordHeartbeat(db, ENGAGEMENT_FULL_JOB);
        // A full recount evaluates everyone too, so it satisfies any pending request.
        if (evaluateAll || mode === "full") await recordHeartbeat(db, ENGAGEMENT_REEVAL_JOB);
      }

      // Rollups run only for orgs whose recount committed, and each stamps its
      // own heartbeat only when it succeeded for every org — so an org whose
      // recount failed withholds the rollup heartbeats too.
      const recounted = results.filter((r) => !r.error).map((r) => r.org_id);
      const groupDue = groupLifecycleRollupDue(tickAt, mode);
      let groupOk = ok && groupDue;
      let dayOk = ok && mode === "full";
      for (const org_id of recounted) {
        // The Group x Lifecycle table (migration 0193), HOURLY (the :10 tick) and
        // nightly — see groupLifecycleRollupDue for why it is no longer every
        // tick. It is what the report reads instead of computing 15-36s of joins
        // on page load. Outside the refresh transaction: a reporting query must
        // never be able to roll back contact_engagement, which the send path reads.
        if (groupDue) {
          try {
            const gl = await refreshGroupLifecycleRollup(db, { orgId: org_id });
            console.info("[contact-engagement] group lifecycle rollup", gl);
          } catch (err) {
            groupOk = false;
            console.error("[contact-engagement] group lifecycle rollup failed", {
              org_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // ⚠️ NIGHTLY ONLY, and OUTSIDE the refresh transaction, for the same
        // reason. A failure withholds only this rollup's own heartbeat.
        if (mode === "full") {
          try {
            const roll = await refreshLifecycleDayRollup(db, { orgId: org_id });
            console.info("[contact-engagement] lifecycle rollup", roll);
          } catch (err) {
            dayOk = false;
            console.error("[contact-engagement] lifecycle rollup failed", {
              org_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      if (groupOk) await recordHeartbeat(db, ENGAGEMENT_GROUP_ROLLUP_JOB);
      if (dayOk) await recordHeartbeat(db, ENGAGEMENT_DAY_ROLLUP_JOB);
      // Watch the nightly recount from the frequent job, never from itself.
      if (mode === "incremental") await watchEngagementHeartbeat(db, "full");
      return { ok, engine: "on" as const, mode, evaluateAll, groupRollupOk: groupOk, dayRollupOk: dayOk, results };
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
