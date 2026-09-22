// One-shot production backfill of stage_delivery_rollup (migration 0186,
// ClickUp 869f5q5au). Builds every cell from the first send ever to today, one
// ET month per transaction, through refreshDeliveryRollup — the job's own write
// path, so the backfill and the 10-minute refresh cannot compute differently.
//
//   npx tsx scripts/backfill-delivery-rollup.ts           # dry run: the plan only
//   npx tsx scripts/backfill-delivery-rollup.ts --apply   # write
//
// Idempotent: a re-run rewrites nothing that has not changed. Measured
// 2026-09-22 (read side only): the August chunk (2.0M sends → 762 cells) took
// 34.5 s; all history is ~5.2M sends → ~2.1K cells, ~2 min in 4 chunks. Each
// chunk's receipt scan is bounded below by the chunk start (the 1-hour margin
// included) and unbounded above — the live query's own bound.
//
// After --apply it FOOTS the table against stage_sends: per org, the sum of
// stored `sent` over every day before today must equal the count of
// status='sent' sends before today. A backfill that silently skipped a month
// would fail here, not in a report.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { addEtDays, refreshDeliveryRollup, type EtDayRange } from "@/lib/reporting/delivery-rollup";

function monthChunks(first: string, last: string): EtDayRange[] {
  const out: EtDayRange[] = [];
  let from = first;
  while (from <= last) {
    const [y, m] = from.split("-").map(Number);
    const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // 1st of next month
    const to = addEtDays(nextMonth, -1) < last ? addEtDays(nextMonth, -1) : last;
    out.push({ from, to });
    from = nextMonth;
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const orgs = (await db.execute(sql`SELECT id, name FROM organizations ORDER BY created_at`)) as unknown as {
    id: string;
    name: string;
  }[];
  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${orgs.length} org(s), through ${today} ET\n`);

  let failed = 0;
  for (const org of orgs) {
    const [first] = (await db.execute(sql`
      SELECT (min(sent_at) AT TIME ZONE 'America/New_York')::date::text AS day
      FROM stage_sends WHERE org_id = ${org.id}::uuid AND status = 'sent' AND sent_at IS NOT NULL
    `)) as unknown as { day: string | null }[];
    if (!first?.day) {
      console.log(`· ${org.name}: no sent messages — nothing to build`);
      continue;
    }
    const chunks = monthChunks(first.day, today);
    console.log(`${org.name} (${org.id}): ${chunks.length} chunk(s) from ${first.day}`);
    for (const c of chunks) {
      if (!apply) {
        console.log(`  would build ${c.from} … ${c.to}`);
        continue;
      }
      const t0 = Date.now();
      const r = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
        return refreshDeliveryRollup(tx, org.id, c);
      });
      console.log(`  ${c.from} … ${c.to}: ${r.cells} cells, ${r.written} written, ${r.deleted} deleted (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
    if (!apply) continue;

    // The foot: every sent message before today is in exactly one cell. Today is
    // excluded — messages still sending while this runs would mismatch for a
    // reason that says nothing about the backfill, and today belongs to the
    // 10-minute refresh anyway.
    const [f] = (await db.execute(sql`
      SELECT (SELECT coalesce(sum(sent), 0) FROM stage_delivery_rollup
               WHERE org_id = ${org.id}::uuid AND sent_date_et < ${today}::date)::bigint AS stored,
             (SELECT count(*) FROM stage_sends
               WHERE org_id = ${org.id}::uuid AND status = 'sent' AND sent_at IS NOT NULL
                 AND sent_at < (${today}::date::timestamp AT TIME ZONE 'America/New_York'))::bigint AS live,
             (SELECT count(*) FROM stage_delivery_rollup WHERE org_id = ${org.id}::uuid)::int AS cells
    `)) as unknown as { stored: string; live: string; cells: number }[];
    const ok = Number(f.stored) === Number(f.live);
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} foot (days before today): Σ stored sent ${Number(f.stored).toLocaleString()} vs ${Number(f.live).toLocaleString()} sent messages · ${f.cells} cells\n`);
  }
  if (!apply) console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
