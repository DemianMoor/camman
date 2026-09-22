// The pre-cutover gate for stage_delivery_rollup (migration 0186, ClickUp
// 869f5q5au): rollup vs the LIVE delivery query, every (stage, number) row.
//
//   npx tsx scripts/verify-delivery-rollup.ts              # snapshot gate (default)
//   npx tsx scripts/verify-delivery-rollup.ts --persisted  # stored cells, frozen windows
//
// SNAPSHOT (default). Inside ONE REPEATABLE READ transaction: run the job's
// refresh for each window, read it back through the report's read path, run the
// live query, diff — then ROLL BACK. Nothing persists. Exact by construction of
// the snapshot, so any difference is a defect in the rollup's write or read
// path, never timing. Windows: yesterday, the 7 and 14 days ending yesterday,
// and 2026-08-15..21 (the only week with tls + ahi + txr all live).
//
// PERSISTED. What is actually stored, against the live query, in one read-only
// snapshot. Strict on FROZEN windows (older than the 7-day settle horizon —
// exactly what the nightly reconciliation checks). Recent windows are printed
// for information only: receipts land between the refresh and this read.
//
// ⚠️ It PRINTS ITS INPUT SCOPE, and a window with zero rows FAILS.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { queryDeliveryByStage, type DeliveryStageRow } from "@/lib/reporting/delivery";
import {
  addEtDays,
  diffDeliveryRows,
  etDayBounds,
  readDeliveryRollup,
  reconcileRange,
  refreshDeliveryRollup,
  SETTLE_DAYS,
  type EtDayRange,
} from "@/lib/reporting/delivery-rollup";

const ROLLBACK = "__verify_delivery_rollup_rollback__";
const sum = (rows: DeliveryStageRow[], k: keyof DeliveryStageRow) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);

async function main() {
  const persisted = process.argv.includes("--persisted");
  const [{ id: orgId, name }] = (await db.execute(sql`
    SELECT id, name FROM organizations ORDER BY created_at LIMIT 1
  `)) as unknown as { id: string; name: string }[];
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const yesterday = addEtDays(today, -1);
  const frozenBefore = addEtDays(today, -(SETTLE_DAYS - 1)); // cells older than this are final

  const windows: { label: string; range: EtDayRange }[] = [
    { label: "1d", range: { from: yesterday, to: yesterday } },
    { label: "7d", range: { from: addEtDays(yesterday, -6), to: yesterday } },
    { label: "14d", range: { from: addEtDays(yesterday, -13), to: yesterday } },
    { label: "7d tls+ahi+txr", range: { from: "2026-08-15", to: "2026-08-21" } },
  ];
  if (persisted) windows.push({ label: "nightly reconcile window", range: reconcileRange(new Date()) });

  console.log("=".repeat(78));
  console.log(`INPUT SCOPE — ${persisted ? "PERSISTED (stored cells)" : "SNAPSHOT (refresh + compare, rolled back)"}`);
  console.log("=".repeat(78));
  console.log(`org        ${name} (${orgId})`);
  console.log(`today ET   ${today}; cells before ${frozenBefore} are frozen`);

  let failed = 0;
  const lines: string[] = [];
  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '900s'`);
    for (const w of windows) {
      const frozen = w.range.to < frozenBefore;
      const strict = !persisted || frozen;
      let refreshNote = "";
      if (!persisted) {
        const r = await refreshDeliveryRollup(tx, orgId, w.range);
        refreshNote = ` · refresh ${r.cells} cells in ${r.durationMs} ms`;
      }
      const stored = await readDeliveryRollup(tx, orgId, w.range);
      const live = await queryDeliveryByStage(tx, orgId, etDayBounds(w.range));
      const diffs = diffDeliveryRows(stored, live);
      const empty = live.length === 0;
      const pass = diffs.length === 0 && !empty;
      if (strict && !pass) failed++;
      const mark = pass ? "✓" : strict ? "✗" : "·";
      lines.push(
        `${mark} ${w.label.padEnd(24)} ${w.range.from} … ${w.range.to}${strict ? "" : "  (recent — informational)"}\n` +
          `    rows ${stored.length} stored vs ${live.length} live · sent ${sum(live, "sent")} · ` +
          `delivered ${sum(stored, "delivered")} vs ${sum(live, "delivered")} · undelivered ${sum(stored, "undelivered")} vs ${sum(live, "undelivered")} · ` +
          `no_receipt ${sum(stored, "no_receipt")} vs ${sum(live, "no_receipt")}${refreshNote}` +
          (empty ? "\n    ⚠️  ZERO rows in scope — this window proves nothing." : "") +
          (diffs.length ? `\n    ${diffs.length} differing row(s), first: ${JSON.stringify(diffs.slice(0, 3))}` : ""),
      );
    }
  };

  if (persisted) {
    await db.transaction(run, { isolationLevel: "repeatable read", accessMode: "read only" });
  } else {
    await db
      .transaction(async (tx) => {
        await run(tx);
        throw new Error(ROLLBACK); // nothing the refresh wrote survives
      }, { isolationLevel: "repeatable read" })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || !e.message.includes(ROLLBACK)) throw e;
      });
  }
  console.log("\n" + lines.join("\n"));
  console.log(`\n${failed === 0 ? "✓ rollup == live query on every strict window" : `✗ ${failed} window(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
