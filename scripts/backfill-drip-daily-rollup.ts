// One-shot production backfill of drip_daily_rollup (migration 0208). Builds
// every cell of every drip campaign — the test campaigns too (owner ruling Q6) —
// from the first drip journey or send to today, through refreshDripDailyRollup: the cron's own write path, so the
// backfill and the 15-minute refresh cannot compute differently.
//
//   npx tsx --conditions=react-server scripts/backfill-drip-daily-rollup.ts           # dry run: cells per chunk, rolled back
//   npx tsx --conditions=react-server scripts/backfill-drip-daily-rollup.ts --apply   # write
//
// Idempotent: a re-run rewrites nothing that has not changed.
//
// ⚠️ ONE RANGE PER BASIS BY DEFAULT, not weekly chunks. Each chunk's receipt side
// (terminalCte) is bounded below by the chunk start and UNBOUNDED above, so N
// chunks re-scan textrequest_dlr_events (2 GB heap, 4.2M rows on 2026-10-12)
// N times. All history in one range is 2 scans (+2 for the re-diff), ~6 GB cold
// — still > 1 GB, so run it in the 05:00–06:00 UTC quiet slot. `--chunk-days N`
// exists only for a range too big for one statement.
//
// After --apply it re-reads every chunk against a fresh computation
// (diffDripDailyRollup, one REPEATABLE READ snapshot per chunk) and fails on any
// difference, then FOOTS the activity cells against stage_sends: per org, the
// stored first + follow-up sends before today must equal the drip sends with
// status 'sent' before today. A chunk that silently wrote nothing fails here.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { addEtDays, type EtDayRange } from "@/lib/reporting/delivery-rollup";
import { BASES, diffDripDailyRollup, refreshDripDailyRollup } from "@/lib/reporting/drip-daily-rollup";

class DryRun extends Error {}

function chunks(first: string, last: string, days: number): EtDayRange[] {
  const out: EtDayRange[] = [];
  for (let from = first; from <= last; from = addEtDays(from, days)) {
    const to = addEtDays(from, days - 1);
    out.push({ from, to: to < last ? to : last });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const ci = process.argv.indexOf("--chunk-days");
  const chunkDays = ci > 0 ? Number(process.argv[ci + 1]) : 100_000;
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const orgs = (await db.execute(sql`
    SELECT c.org_id,
           to_char(LEAST(
             (SELECT min(j.routed_at) FROM drip_journeys j WHERE j.org_id = c.org_id AND j.campaign_id IS NOT NULL),
             (SELECT min(ss.created_at) FROM stage_sends ss JOIN campaigns c2 ON c2.id = ss.campaign_id
               WHERE c2.org_id = c.org_id AND c2.type = 'drip')
           ) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS first_day,
           count(*)::int AS campaigns
    FROM campaigns c WHERE c.type = 'drip' GROUP BY c.org_id`)) as unknown as {
    org_id: string; first_day: string | null; campaigns: number;
  }[];
  console.log(`${apply ? "APPLY" : "DRY RUN"} — target ${new URL(process.env.DATABASE_URL!).hostname}, today ${today} ET`);
  let failures = 0;

  for (const o of orgs) {
    if (!o.first_day) { console.log(`org ${o.org_id}: ${o.campaigns} drip campaigns, no activity — skipped`); continue; }
    const plan = chunks(o.first_day, today, chunkDays);
    console.log(`org ${o.org_id}: ${o.campaigns} drip campaigns, ${o.first_day}..${today}, ${plan.length} chunk(s)`);
    for (const range of plan) {
      for (const basis of BASES) {
        try {
          const r = await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '280s'`);
            const res = await refreshDripDailyRollup(tx, o.org_id, basis, range);
            if (!apply) throw Object.assign(new DryRun(), { res });
            return res;
          });
          console.log(`  ${range.from}..${range.to} ${basis.padEnd(8)} cells ${r.cells} written ${r.written} deleted ${r.deleted} (${r.durationMs} ms)`);
        } catch (e) {
          if (!(e instanceof DryRun)) throw e;
          const res = (e as DryRun & { res: { cells: number; durationMs: number } }).res;
          console.log(`  ${range.from}..${range.to} ${basis.padEnd(8)} would hold ${res.cells} cells (${res.durationMs} ms, rolled back)`);
        }
      }
    }
    if (!apply) continue;

    // Re-check every chunk against a fresh computation, one snapshot each.
    for (const range of plan) {
      for (const basis of BASES) {
        const d = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '280s'`);
          return diffDripDailyRollup(tx, o.org_id, basis, range);
        }, { isolationLevel: "repeatable read" });
        if (d.diffs.length > 0) {
          failures++;
          console.log(`  ✗ ${range.from}..${range.to} ${basis}: ${d.diffs.length} diffs, e.g. ${JSON.stringify(d.diffs[0])}`);
        }
      }
    }

    // Foot the activity sends against stage_sends, every day before today.
    const foot = (await db.execute(sql`
      SELECT
        (SELECT COALESCE(sum(first_sends + followup_sends), 0)::int FROM drip_daily_rollup
          WHERE org_id = ${o.org_id}::uuid AND basis = 'activity' AND day_et < ${today}::date) AS stored,
        (SELECT count(*)::int FROM stage_sends ss JOIN campaigns c ON c.id = ss.campaign_id AND c.type = 'drip'
          WHERE ss.org_id = ${o.org_id}::uuid AND ss.status = 'sent'
            AND ss.sent_at < (${today}::date::timestamp AT TIME ZONE 'America/New_York')) AS live
    `)) as unknown as { stored: number; live: number }[];
    const ok = foot[0].stored === foot[0].live;
    if (!ok) failures++;
    console.log(`  ${ok ? "✓" : "✗"} foot: stored sends before today ${foot[0].stored} vs stage_sends ${foot[0].live}`);
  }
  console.log(failures === 0 ? (apply ? "\nBACKFILL OK" : "\nDRY RUN DONE") : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
