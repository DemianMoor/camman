import "./_env-preload";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// READ-ONLY WATCHER. Emits one line per state change so a Monitor can wake the
// session when a send batch starts and, more importantly, when it FINISHES —
// the point at which DLR is worth sampling.
//
//   npx tsx scripts/probe-texthub-send-watch.ts [baselineIsoUtc]
//
// Events (stdout, one line each — these are the notifications):
//   SENDS STARTED  ...   first new send seen past the baseline
//   SENDS COMPLETE ...   no new send for IDLE_MIN minutes -> batch settled
//   WATCH GIVING UP ...  deadline passed with nothing sent
//
// Reconnects per poll rather than holding a pooler slot open for hours (the
// transaction pooler caps ~15 clients). Transient DB errors are swallowed and
// retried — one blip must not kill a multi-hour watch.
//
// PRECISION: baselines carry microseconds (.US). A baseline truncated to whole
// seconds makes the previous batch's own sub-second tail (sent_at 15:01:58.4 >
// 15:01:58.0) look like a brand-new batch — which then goes idle and fires a
// bogus SENDS COMPLETE, ending the watch before the real send ever starts.

const POLL_MS = 180_000;      // 3 min — sends are minutes-long, not seconds
const IDLE_MIN = 10;          // no new send for this long => batch complete
const DEADLINE_HOURS = 10;    // give up rather than watch forever

type Snap = { n: number; last: string | null };

async function snapshot(baseline: string): Promise<Snap> {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(pg);
  try {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n,
             to_char(max(ss.sent_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN sms_providers   p  ON p.id  = cs.sms_provider_id
      WHERE p.sms_provider_id IN ('txh','txh2')
        AND ss.sent_at > ${baseline}::timestamptz
    `)) as unknown as { n: number; last: string | null }[];
    return { n: rows[0]?.n ?? 0, last: rows[0]?.last ?? null };
  } finally {
    await pg.end({ timeout: 5 });
  }
}

async function main() {
  let baseline = process.argv[2] ?? null;
  if (!baseline) {
    const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
    const db = drizzle(pg);
    const rows = (await db.execute(sql`
      SELECT to_char(coalesce(max(ss.sent_at), now()) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN sms_providers   p  ON p.id  = cs.sms_provider_id
      WHERE p.sms_provider_id IN ('txh','txh2')
    `)) as unknown as { last: string }[];
    baseline = rows[0].last;
    await pg.end({ timeout: 5 });
  }
  console.log(`WATCH ARMED baseline=${baseline} poll=${POLL_MS / 1000}s idle=${IDLE_MIN}m`);

  const deadline = Date.now() + DEADLINE_HOURS * 3600_000;
  let started = false;
  let lastSeen: string | null = null;
  let lastChangeMs = Date.now();

  for (;;) {
    if (Date.now() > deadline) {
      console.log(`WATCH GIVING UP — no completed batch within ${DEADLINE_HOURS}h of ${baseline}`);
      return;
    }
    await new Promise((ok) => setTimeout(ok, POLL_MS));

    let snap: Snap;
    try {
      snap = await snapshot(baseline);
    } catch {
      continue; // transient — try again next tick
    }
    if (snap.n === 0) continue;

    if (!started) {
      started = true;
      console.log(`SENDS STARTED — ${snap.n} message(s) since ${baseline}, latest ${snap.last}`);
    }
    if (snap.last !== lastSeen) {
      lastSeen = snap.last;
      lastChangeMs = Date.now();
      continue;
    }
    const idleMin = (Date.now() - lastChangeMs) / 60_000;
    if (idleMin >= IDLE_MIN) {
      console.log(
        `SENDS COMPLETE — ${snap.n} message(s) total, last at ${snap.last}, ` +
        `idle ${Math.round(idleMin)}m. Safe to sample DLR.`,
      );
      return;
    }
  }
}

main().catch((e) => {
  console.log(`WATCH ERROR — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
