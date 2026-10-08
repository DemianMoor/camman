// getCalibratedLookupRate() against the PREVIEW database, inside ONE
// transaction that is rolled back — nothing survives.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-lookup-rate-calibration.ts
//
// Proves (C1, 2026-10-08): the rate is calibrated ONLY from bulk batches
// (trigger upload / backfill). drip_intake batches are 1–2 lookups each and
// their balance deltas are noise — on prod 190 of 200 read <= 0 and the rest
// sum to $1.52 over 14,237 lookups ($0.000108, 1/14 of the real price). Left
// in the window they drag the rate down; left ALONE in the window (after the
// bulk batches age out) they would keep the rate "ledger" at a 14x discount.
//
//   1. upload + drip_intake rows in the window → the rate is the upload
//      delta / upload processed, and the drip rows change nothing.
//   2. only drip_intake rows in the window → source "flat", rate $0.0015,
//      never "ledger".
//   3. a backfill batch qualifies like an upload one.
//   4. a bulk batch with a non-positive delta (a top-up landed) → flat.
//   5. no batches at all → flat.
//
// The window is account-global (no org), so the transaction first clears every
// lookup_batches row inside it; the rollback puts them back.
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { FLAT_RATE_USD, getCalibratedLookupRate } from "@/lib/reporting/lookup-rate";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function main() {
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;

      // Isolate the window. Rolled back with everything else.
      const cleared = (await tx.execute(sql`
        DELETE FROM lookup_batches WHERE created_at >= now() - interval '90 days' RETURNING id
      `)) as unknown as unknown[];
      console.log(`(cleared ${cleared.length} preview batch rows inside the rolled-back transaction)`);

      const batch = async (trigger: string, processed: number, before: number | null, after: number | null) => {
        await tx.execute(sql`
          INSERT INTO lookup_batches (org_id, trigger, total_numbers, processed, status,
                                      balance_before_usd, balance_after_usd)
          VALUES (${orgId}::uuid, ${trigger}, ${processed}, ${processed}, 'complete',
                  ${before}, ${after})
        `);
      };
      const clear = () => tx.execute(sql`DELETE FROM lookup_batches`);

      // 5. nothing in the window
      {
        const r = await getCalibratedLookupRate(90, tx);
        check("5. empty window → flat $0.0015, 0 batches",
          r.source === "flat" && near(r.rate, FLAT_RATE_USD) && r.batches === 0, JSON.stringify(r));
      }

      // 2. drip_intake only: positive but worthless deltas must NOT make a ledger rate
      await batch("drip_intake", 1, 10.0, 9.9999);
      await batch("drip_intake", 2, 9.9999, 9.9999);
      await batch("drip_intake", 1, 9.9999, 10.0001); // top-up landed mid-batch
      {
        const r = await getCalibratedLookupRate(90, tx);
        check("2. drip_intake only → flat, never ledger",
          r.source === "flat" && near(r.rate, FLAT_RATE_USD), JSON.stringify(r));
        check("2. and the drip rows are not even counted as batches", r.batches === 0, JSON.stringify(r));
      }

      // 1. upload + drip_intake: the upload sets the rate, the drip rows change nothing
      await batch("upload", 1000, 20.0, 18.5); // $1.50 / 1000 = $0.0015 exactly
      {
        const r = await getCalibratedLookupRate(90, tx);
        check("1. upload + drip rows → ledger rate = upload delta / upload processed",
          r.source === "ledger" && near(r.rate, 1.5 / 1000), JSON.stringify(r));
        check("1. inputs exclude the drip rows: delta $1.50, 1,000 lookups, 1 batch",
          near(r.ledgerDeltaUsd ?? -1, 1.5) && r.lookupsProcessed === 1000 && r.batches === 1, JSON.stringify(r));
      }

      // 3. backfill qualifies too
      await clear();
      await batch("backfill", 500, 5.0, 4.2); // $0.80 / 500 = $0.0016
      await batch("drip_intake", 1, 4.2, 4.2);
      {
        const r = await getCalibratedLookupRate(90, tx);
        check("3. backfill batch calibrates like upload ($0.0016)",
          r.source === "ledger" && near(r.rate, 0.8 / 500) && r.batches === 1, JSON.stringify(r));
      }

      // 4. a bulk batch whose delta is non-positive (top-up) → flat, not zero, not negative
      await clear();
      await batch("upload", 1000, 5.0, 30.0);
      {
        const r = await getCalibratedLookupRate(90, tx);
        check("4. bulk batch with a top-up inside → flat $0.0015",
          r.source === "flat" && near(r.rate, FLAT_RATE_USD), JSON.stringify(r));
      }

      // A batch missing either balance snapshot never qualifies, whatever its trigger.
      await clear();
      await batch("upload", 1000, null, null);
      {
        const r = await getCalibratedLookupRate(90, tx);
        check("bulk batch without ledger snapshots → flat", r.source === "flat", JSON.stringify(r));
      }

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM lookup_batches WHERE org_id IS NOT NULL
  `)) as unknown as { n: number }[];
  console.log(`\n(rolled back; preview lookup_batches rows now: ${left[0].n})`);

  console.log(failed === 0 ? "\nALL GREEN" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
