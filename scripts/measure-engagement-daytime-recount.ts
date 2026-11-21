import "./_env-preload";

// Engagement plan §9, owner-approved 2026-11-20: rehearse the SET-BASED daytime
// recount on PRODUCTION over the same window as the per-contact rehearsal
// (2026-11-17 15:00–15:45 UTC, ~19K touched contacts, measured 2026-11-20 at
// ~10 min: clicks 84–104 s, facts 339–385 s, offers 104–149 s).
//
// ⚠️ QUIET WINDOW ONLY: refuses to start outside 05:00–05:45 UTC (owner rule,
// manual analysis on prod only in 05:00–06:00 UTC).
// ⚠️ STOP RULE (owner, 2026-11-20): the first statement that times out ends the
// run. Each statement is capped at 240 s; nothing is retried.
//
// No durable write: refreshContactEngagement(dryRun: true) writes only session
// temp tables (ON COMMIT DROP), inside a transaction that ALWAYS rolls back. Not
// BEGIN READ ONLY, because Postgres refuses CREATE TEMP TABLE there. Dedicated
// session-mode connection (no session SET on the pooler).
//
//   npx tsx --conditions=react-server scripts/measure-engagement-daytime-recount.ts
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { toSessionModeUrl } from "@/lib/db/session-url";
import { refreshContactEngagement } from "@/lib/engagement/refresh";

class Rollback extends Error {
  constructor(public payload: unknown) {
    super("rollback");
  }
}

async function main() {
  const now = new Date();
  const inWindow = now.getUTCHours() === 5 && now.getUTCMinutes() <= 45;
  if (!inWindow) {
    console.error(`REFUSING: ${now.toISOString()} is outside 05:00–05:45 UTC.`);
    process.exit(2);
  }
  const client = postgres(toSessionModeUrl(process.env.DATABASE_URL!), { prepare: false, max: 1, connect_timeout: 15 });
  const db = drizzle(client);
  try {
    const [org] = (await db.execute(sql`
      SELECT org_id FROM lifecycle_settings WHERE engine_mode = 'write' LIMIT 1`)) as unknown as { org_id: string }[];
    console.log(`start ${new Date().toISOString()} org ${org.org_id}`);
    const t = Date.now();
    let res: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '240s'"));
        const r = await refreshContactEngagement(tx as never, org.org_id, {
          mode: "incremental",
          dryRun: true,
          since: new Date("2026-11-17T15:00:00Z"),
          daytimeSlice: { until: new Date("2026-11-17T15:45:00Z"), evaluateTimeDue: true, recount: "set" },
        });
        throw new Rollback(r);
      });
    } catch (e) {
      if (!(e instanceof Rollback)) {
        console.error(`STOPPED (no retry): ${e instanceof Error ? e.message : String(e)} after ${((Date.now() - t) / 1000).toFixed(1)} s`);
        process.exitCode = 1;
        return;
      }
      res = e.payload;
    }
    const r = res as { recounted: number; evaluated: number; phaseMs: Record<string, number>; durationMs: number; escalatedToFull?: boolean };
    console.log(JSON.stringify({
      recount: "set", window: "2026-11-17 15:00–15:45 UTC",
      recounted: r.recounted, evaluated: r.evaluated, escalated: r.escalatedToFull ?? false,
      durationMs: r.durationMs, msPerContact: r.recounted ? +(r.durationMs / r.recounted).toFixed(2) : null,
      phaseMs: r.phaseMs,
    }, null, 1));
    console.log(`end ${new Date().toISOString()} (rolled back; nothing written)`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
