// Cross-stage per-run pacing-budget verification for the scheduled-send cron.
//
// max_sends_per_run is a per-PROVIDER pacing cap for the WHOLE tick, not per
// stage. This proves that when ONE cron tick fires several stages on the same
// provider, the sum of rows processed across those stages never exceeds the
// provider's cap — and that a stage whose provider budget is already exhausted
// is HELD (skipped this tick, its pending rows untouched so phase B re-drains it
// next tick), while a different provider gets its own fresh budget. The budget
// is enforced in the resumable phase-B drain; these stages are pre-seeded with
// pending stage_sends, so phase A considers none of them.
//
// Everything runs inside a single transaction that is ALWAYS rolled back, so no
// fixture data persists. The drain is injected (a deterministic fake) — no real
// TextHub call, and SEND_ENABLED is irrelevant (isEnabled is forced true only
// for the injected path; nothing live is ever sent).
//
// Run: npx tsx scripts/test-scheduled-budget.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DrainResult } from "@/lib/sends/drain";
import { runScheduledSends } from "@/lib/sends/scheduled";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const CAP = 5; // both providers' max_sends_per_run
const PENDING_PER_STAGE = 4; // every stage has this many pending rows
// A weekday noon-ET instant (June ⇒ EDT, UTC-4 ⇒ 16:00Z = 12:00 ET), squarely
// inside the default 08:00–21:00 ET window so every stage decides "fire".
const BASE = Date.parse("2026-06-15T16:00:00Z");
const NOW = new Date("2026-06-15T16:05:00Z");

const ROLLBACK = Symbol("rollback");

async function main() {
  // Records the maxRows budget each stage's drain was handed, in call order.
  const drainCalls: { stageId: number; maxRows: number }[] = [];

  // Injected drain: behaves like a real per-stage drain bounded by its budget —
  // processes min(maxRows, pending) rows. Does NOT touch the DB (claim/hold is
  // what we're asserting, via campaign_stages.sent_at).
  const fakeDrain = async (stageId: number, maxRows: number): Promise<DrainResult> => {
    drainCalls.push({ stageId, maxRows });
    const processed = Math.min(maxRows, PENDING_PER_STAGE);
    return {
      ok: true,
      sent: processed,
      failed: 0,
      processed,
      halted: false,
      stuck: 0,
      remaining: PENDING_PER_STAGE - processed,
      stopReason: null,
      pausedNow: false,
    };
  };

  let stageA1 = 0,
    stageA2 = 0,
    stageA3 = 0,
    stageB1 = 0;
  let providerA = 0;

  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9); // collision-safe unique suffix
      const orgRows = (await tx.execute(
        sql`SELECT id FROM organizations LIMIT 1`,
      )) as unknown as { id: string }[];
      const orgId = orgRows[0]?.id;
      if (!orgId) throw new Error("no organization in DB to anchor fixtures");

      // Two providers, same cap. Provider B proves per-provider independence.
      const provA = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, max_sends_per_run, supports_api_send)
        VALUES (${"budget-A-" + sfx}, ${orgId}, ${"budget-test-A"}, ${CAP}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      const provB = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, max_sends_per_run, supports_api_send)
        VALUES (${"budget-B-" + sfx}, ${orgId}, ${"budget-test-B"}, ${CAP}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      providerA = provA[0].id;
      const providerB = provB[0].id;

      const cre = (await tx.execute(sql`
        INSERT INTO creatives (slug, org_id, text, status)
        VALUES (${"budget-cre-" + sfx}, ${orgId}, ${"Budget test creative"}, 'active')
        RETURNING id
      `)) as unknown as { id: number }[];
      const creativeId = cre[0].id;

      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"budget-camp-" + sfx}, ${"budget-test"}, 'active', 'tracked')
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;

      // Four contacts, reused across stages (the active-send unique index is on
      // (stage_id, contact_id), so the same contact may appear in every stage).
      const contactIds: string[] = [];
      for (let i = 0; i < PENDING_PER_STAGE; i++) {
        const c = (await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${"+1555" + sfx + i})
          RETURNING id
        `)) as unknown as { id: string }[];
        contactIds.push(c[0].id);
      }

      // Stages: A1/A2/A3 on provider A (share its budget), B1 on provider B.
      // Distinct scheduled_at (1s apart) gives the ORDER BY scheduled_at a
      // deterministic order: A1, A2, A3, B1.
      async function mkStage(num: number, providerId: number, offsetSec: number) {
        const at = new Date(BASE + offsetSec * 1000).toISOString();
        const r = (await tx.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, sms_provider_id,
             send_approved, scheduled_at)
          VALUES (${orgId}, ${campaignId}, ${num}, ${creativeId}, ${providerId},
             true, ${at})
          RETURNING id
        `)) as unknown as { id: number }[];
        const stageId = r[0].id;
        for (const contactId of contactIds) {
          await tx.execute(sql`
            INSERT INTO stage_sends
              (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
            VALUES (${orgId}, ${campaignId}, ${stageId}, ${contactId},
              ${"+1555000"}, ${"Budget test"}, 'pending')
          `);
        }
        return stageId;
      }
      stageA1 = await mkStage(1, providerA, 0);
      stageA2 = await mkStage(2, providerA, 1);
      stageA3 = await mkStage(3, providerA, 2);
      stageB1 = await mkStage(4, providerB, 3);

      // ── Run ONE tick ────────────────────────────────────────────────────
      const result = await runScheduledSends(tx as unknown as typeof db, {
        now: NOW,
        orgId,
        isEnabled: () => true,
        runDrain: fakeDrain,
        maxStages: 50,
      });

      // ── Assertions ──────────────────────────────────────────────────────
      // The stages are pre-seeded with pending stage_sends, so they're already
      // materialized — phase A considers none of them; the budget lives in the
      // phase-B drain.
      check("considered 0 (all pre-materialized)", result.considered === 0, `got ${result.considered}`);
      check("drained 3 stages (A1, A2, B1)", result.drained === 3, `got ${result.drained}`);
      check("held 1 stage on budget (A3)", result.budget_held === 1, `got ${result.budget_held}`);

      // Drain budgets handed out, in order. A1 gets full cap (5); A2 gets the
      // remainder (cap − A1.processed = 5 − 4 = 1); A3 never drains (held); B1
      // gets provider B's own fresh cap (5).
      const byStage = new Map(drainCalls.map((c) => [c.stageId, c.maxRows]));
      check("A1 drained with full budget 5", byStage.get(stageA1) === CAP, `got ${byStage.get(stageA1)}`);
      check(
        "A2 drained with remaining budget 1",
        byStage.get(stageA2) === 1,
        `got ${byStage.get(stageA2)}`,
      );
      check("A3 NOT drained (budget exhausted)", !byStage.has(stageA3));
      check(
        "B1 drained with its own fresh budget 5",
        byStage.get(stageB1) === CAP,
        `got ${byStage.get(stageB1)}`,
      );

      // THE guarantee: total rows processed for provider A across the whole tick
      // ≤ provider A's cap. A1 processed 4 + A2 processed 1 = 5 = CAP.
      const provAprocessed =
        Math.min(byStage.get(stageA1) ?? 0, PENDING_PER_STAGE) +
        Math.min(byStage.get(stageA2) ?? 0, PENDING_PER_STAGE);
      check(
        `provider A processed ${provAprocessed} ≤ cap ${CAP} across the tick`,
        provAprocessed <= CAP,
        `processed ${provAprocessed}`,
      );

      // Phase B never stamps sent_at (only phase-A materialization does), and a
      // budget-held stage keeps all its pending rows so the next tick re-drains
      // it. Assert the held stage A3 was never drained and still has its 4
      // pending rows, while the drained stages were handed to the fake drain.
      check("A3 never entered the drain", !drainCalls.some((c) => c.stageId === stageA3));
      const a3pending = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM stage_sends
        WHERE stage_id = ${stageA3} AND status = 'pending'
      `)) as unknown as { n: number }[];
      check(
        "A3 still has all 4 pending rows (re-drains next tick)",
        Number(a3pending[0]?.n) === PENDING_PER_STAGE,
        `got ${a3pending[0]?.n}`,
      );

      throw ROLLBACK; // never persist fixtures
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  await pgConn.end({ timeout: 5 });
  console.log(
    failed === 0
      ? "\nCross-stage per-run budget verified (rolled back, no data persisted)."
      : `\nFAILED: ${failed} check(s).`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Budget test crashed:", err);
  process.exit(1);
});
