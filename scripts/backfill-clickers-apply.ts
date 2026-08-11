import "./_env-preload";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import { propagateTrackedClickers } from "@/lib/links/propagate-clickers";
import { getClickerReconciliation } from "@/lib/reporting/epc-monitors";

// PRODUCTION WRITE. Runs the watermark-independent propagate rebuild once, to
// repair the 3,022 (contact, brand, offer) combos stranded behind the cursor by
// the 2026-08-11 rescore backfill.
//
// ACTIVATION GATE — checked IMMEDIATELY before the write, not minutes prior.
// `campaign_audience_pool.was_clicker_at_snapshot` is frozen at activation and
// audience immutability means it can never be corrected afterwards. A pool
// captured mid-backfill would bake in a PARTIAL clicker set — permanently. Same
// shape as the drain-idle gate.
//
// Run: npx tsx --conditions=react-server scripts/backfill-clickers-apply.ts
// Add --force ONLY with a deliberate reason; it bypasses the gate.

const FORCE = process.argv.includes("--force");
const EXPECTED_INSERTS = 3022;

function assert(c: boolean, m: string) {
  if (!c) throw new Error(`ASSERTION FAILED: ${m}`);
  console.log(`  ✓ ${m}`);
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
  const d = drizzle(c);
  const q = async (x: ReturnType<typeof sql>) =>
    (await d.execute(x)) as unknown as Record<string, unknown>[];

  // ── GATE ────────────────────────────────────────────────────────────────
  const gate = async () =>
    (
      await q(sql`
        SELECT
          (SELECT count(*)::int FROM campaigns
            WHERE status = 'active' AND status_changed_at > now() - interval '2 minutes')
            AS activated_just_now,
          -- IN-FLIGHT ONLY. The naive forms of these two predicates measure
          -- HISTORY, not current work, and were verified to do so before being
          -- narrowed (not narrowed for convenience):
          --   * 58 stages have sent_at set with materialized_at NULL, but the
          --     newest is 2026-07-16 — they predate the materialized_at column
          --     (migration 0089) or were abandoned. In-flight in the last 30
          --     minutes: 0.
          --   * 53 stages are "scheduled within 3 minutes", but ALL are overdue
          --     by more than an hour (earliest 2026-05-18) — abandoned, not
          --     imminent.
          -- A gate that can never read clear would either block forever or get
          -- routinely force-bypassed, which is worse than no gate at all.
          (SELECT count(*)::int FROM campaign_stages
            WHERE sent_at IS NOT NULL AND materialized_at IS NULL AND archived_at IS NULL
              AND sent_at > now() - interval '30 minutes')
            AS mid_materialization,
          (SELECT count(*)::int FROM campaign_stages
            WHERE sent_at IS NULL AND archived_at IS NULL
              AND scheduled_at IS NOT NULL
              AND scheduled_at BETWEEN now() - interval '5 minutes' AND now() + interval '3 minutes')
            AS firing_within_3min,
          (SELECT max(status_changed_at)::text FROM campaigns WHERE status = 'active')
            AS last_activation
      `)
    )[0];

  console.log("=== ACTIVATION GATE (immediately before the write) ===");
  const before = await gate();
  console.table([before]);

  const blocked =
    Number(before.activated_just_now) > 0 ||
    Number(before.mid_materialization) > 0 ||
    Number(before.firing_within_3min) > 0;

  if (blocked && !FORCE) {
    console.error(
      "\nABORTED — a campaign is activating, materializing, or about to fire.\n" +
        "was_clicker_at_snapshot freezes at activation and cannot be corrected\n" +
        "afterwards, so a pool captured mid-backfill would bake in a PARTIAL\n" +
        "clicker set permanently. Re-run when idle.",
    );
    await c.end();
    process.exit(2);
  }
  console.log(blocked ? "\n⚠ GATE BYPASSED via --force" : "\n✓ gate clear — no activation, materialization or imminent fire");

  // ── STATE BEFORE ────────────────────────────────────────────────────────
  const rowsBefore = Number(
    (await q(sql`SELECT count(*)::int AS n FROM clickers`))[0].n,
  );
  const wmBefore =
    (await q(sql`SELECT watermark::text AS w FROM cron_locks WHERE job_name='propagate-clickers'`))[0]
      ?.w ?? null;
  const reconBefore = await getClickerReconciliation(d);
  console.log(`\nbefore: clickers=${rowsBefore} watermark=${wmBefore} probe_missing=${reconBefore.missing}`);

  // ── WRITE ───────────────────────────────────────────────────────────────
  console.log("\n=== APPLYING REBUILD ===");
  const started = Date.now();
  const result = await propagateTrackedClickers(d, { mode: "rebuild" });
  console.log(`mode=${result.mode} scope="${result.scope}" inserted=${result.inserted} in ${Date.now() - started}ms`);

  // ── GATE RE-CHECK ───────────────────────────────────────────────────────
  // Did anything activate DURING the write? The pool would be immutable, so
  // this must surface rather than pass silently.
  const after = await gate();
  const activatedDuring =
    String(after.last_activation ?? "") !== String(before.last_activation ?? "");
  console.log(`\ngate re-check — activation during the write: ${activatedDuring ? "⚠ YES" : "no"}`);
  if (activatedDuring) {
    console.error(
      `  last_activation moved ${before.last_activation} -> ${after.last_activation}. ` +
        `That campaign's pool may hold a partial clicker set and CANNOT be corrected.`,
    );
  }

  // ── VERIFY ──────────────────────────────────────────────────────────────
  console.log("\n=== VERIFICATION ===");
  const rowsAfter = Number((await q(sql`SELECT count(*)::int AS n FROM clickers`))[0].n);
  const delta = rowsAfter - rowsBefore;
  const wmAfter =
    (await q(sql`SELECT watermark::text AS w FROM cron_locks WHERE job_name='propagate-clickers'`))[0]
      ?.w ?? null;
  const reconAfter = await getClickerReconciliation(d);

  console.log(`  clickers ${rowsBefore} -> ${rowsAfter} (delta ${delta})`);
  console.log(`  watermark ${wmBefore} -> ${wmAfter}`);
  console.log(`  probe ${reconBefore.missing} -> ${reconAfter.missing}\n`);

  assert(result.inserted === delta, `inserted (${result.inserted}) matches the row delta (${delta})`);
  assert(
    Math.abs(delta - EXPECTED_INSERTS) <= 40,
    `row delta ${delta} matches the dry-run prediction of ${EXPECTED_INSERTS} (±40 for live traffic)`,
  );
  assert(reconAfter.missing <= reconAfter.tolerance, `probe now within tolerance: ${reconAfter.missing} <= ${reconAfter.tolerance}`);
  assert(!reconAfter.breached, "reconciliation probe no longer breached");
  assert(wmAfter === wmBefore, `rebuild did NOT advance the watermark (${wmAfter}) — the two passes stay independent`);

  // Idempotency
  const second = await propagateTrackedClickers(d, { mode: "rebuild" });
  assert(second.inserted === 0, `second rebuild inserts 0 (idempotent), got ${second.inserted}`);

  // The incremental pass must still work normally afterwards.
  const inc = await propagateTrackedClickers(d, { mode: "incremental" });
  const wmFinal =
    (await q(sql`SELECT watermark::text AS w FROM cron_locks WHERE job_name='propagate-clickers'`))[0]
      ?.w ?? null;
  console.log(`\n  incremental after rebuild: inserted=${inc.inserted} scope="${inc.scope}"`);
  assert(wmFinal !== wmBefore, `incremental DID advance the watermark (${wmBefore} -> ${wmFinal}) — normal operation resumed`);

  console.log("\nbackfill-clickers-apply OK.");
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
