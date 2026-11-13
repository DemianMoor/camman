import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { BASES, type RefreshResult } from "@/lib/reporting/drip-daily-rollup";
import { runFreshTier, YESTERDAY_STAMP_PREFIX, yesterdayDue } from "@/lib/reporting/drip-daily-rollup-fresh";

// Tier A cadence of the drip Daily results rollup (lib/reporting/drip-daily-rollup-fresh.ts)
// on the PREVIEW DB: today every run; yesterday when its last refresh is ≥ 60 min
// old and always on the first run after ET midnight; a failed refresh is retried.
// The refresh is injected (records its range) — the cells themselves are bars I1/I2
// in scripts/test-drip-daily-rollup.ts. Fixture: the yesterday stamp rows in
// cron_locks, saved and restored around the run.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-daily-rollup-cadence.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const at = (iso: string) => new Date(iso);

function pure() {
  console.log("Pure:");
  const now = at("2026-11-13T21:01:00Z");
  const ago = (min: number, sec = 0) => new Date(now.getTime() - (min * 60 + sec) * 1000);
  bar("P1 never refreshed as yesterday (the ET rollover) → due", yesterdayDue(now, null));
  bar("P2 15 / 45 min ago → not due", !yesterdayDue(now, ago(15)) && !yesterdayDue(now, ago(45)));
  bar("P3 60 min ago → due; 59:58 (cron start jitter) → still due", yesterdayDue(now, ago(60)) && yesterdayDue(now, ago(59, 58)));
}

async function dbBars() {
  console.log(`\nDB (${requirePreviewDb().label}):`);
  const saved = (await db.execute(sql`
    SELECT job_name, watermark::text AS w FROM cron_locks WHERE job_name LIKE ${`${YESTERDAY_STAMP_PREFIX}%`}`)) as unknown as {
    job_name: string;
    w: string | null;
  }[];
  const org = randomUUID(); // never a real org — the refresh is injected
  let failNext = false;
  const tick = async (iso: string) => {
    const calls: string[] = [];
    const res = await runFreshTier({
      db, orgIds: [org], now: at(iso),
      refresh: async (_o, basis, range): Promise<RefreshResult> => {
        if (failNext) throw new Error("injected refresh failure");
        calls.push(`${basis}:${range.from}..${range.to}`);
        return { basis, cells: 0, written: 0, deleted: 0, durationMs: 0 };
      },
    });
    return { res, calls: calls.join(" ") };
  };
  const both = (from: string, to: string) => BASES.map((b) => `${b}:${from}..${to}`).join(" ");
  const TODAY = both("2026-11-13", "2026-11-13");
  try {
    await db.execute(sql`DELETE FROM cron_locks WHERE job_name LIKE ${`${YESTERDAY_STAMP_PREFIX}%`}`);
    let t = await tick("2026-11-13T20:01:00Z");
    bar("W1 15:01 ET, yesterday never refreshed: the old two-day call", t.calls === both("2026-11-12", "2026-11-13") && t.res.yesterday_refreshed, t.calls);
    for (const iso of ["2026-11-13T20:16:00Z", "2026-11-13T20:31:00Z", "2026-11-13T20:46:00Z"]) {
      t = await tick(iso);
      bar(`W2 ${iso.slice(11, 16)} UTC: today only`, t.calls === TODAY && !t.res.yesterday_refreshed, t.calls);
    }
    t = await tick("2026-11-13T21:00:58Z"); // the 16:01 tick, started 2 s early
    bar("W3 an hour later (start jitter −2 s): yesterday again", t.calls === both("2026-11-12", "2026-11-13"), t.calls);
    t = await tick("2026-11-14T04:46:00Z");
    bar("W4 23:46 ET: yesterday (last refreshed hours ago)", t.calls === both("2026-11-12", "2026-11-13"), t.calls);
    t = await tick("2026-11-14T05:01:00Z");
    bar("W5 00:01 ET rollover, 15 min after the last yesterday refresh: yesterday (11-13) anyway",
      t.calls === both("2026-11-13", "2026-11-14"), t.calls);
    t = await tick("2026-11-14T05:16:00Z");
    bar("W6 00:16 ET: today only", t.calls === both("2026-11-14", "2026-11-14"), t.calls);
    failNext = true;
    t = await tick("2026-11-14T06:01:00Z");
    failNext = false;
    bar("W7 a failed refresh is an org error (withholds the heartbeat)", !!t.res.orgs[0].error, t.res.orgs[0].error);
    t = await tick("2026-11-14T06:16:00Z");
    bar("W8 …and left yesterday unstamped: the next tick retries it", t.calls === both("2026-11-13", "2026-11-14"), t.calls);
    t = await tick("2026-11-14T06:31:00Z");
    bar("W9 then today only again", t.calls === both("2026-11-14", "2026-11-14"), t.calls);
    const rows = (await db.execute(sql`
      SELECT job_name FROM cron_locks WHERE job_name LIKE ${`${YESTERDAY_STAMP_PREFIX}%`}`)) as unknown as { job_name: string }[];
    bar("W10 one stamp row, for the current yesterday", rows.length === 1 && rows[0].job_name === `${YESTERDAY_STAMP_PREFIX}2026-11-13`,
      JSON.stringify(rows.map((r) => r.job_name)));
  } finally {
    await db.execute(sql`DELETE FROM cron_locks WHERE job_name LIKE ${`${YESTERDAY_STAMP_PREFIX}%`}`);
    for (const r of saved)
      await db.execute(sql`INSERT INTO cron_locks (job_name, watermark) VALUES (${r.job_name}, ${r.w}::timestamptz)`);
  }
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM cron_locks WHERE job_name LIKE ${`${YESTERDAY_STAMP_PREFIX}%`}`)) as unknown as { n: number }[];
  bar("Z stamp rows restored", left[0]?.n === saved.length, `${left[0]?.n} / ${saved.length}`);
}

async function main() {
  pure();
  await dbBars();
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
