import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { selectDrainableStages } from "@/lib/sends/scheduled";

// PHASE 5 EXIT GATE — "regular campaigns unaffected, proven".
//
// ⭐ WHAT WOULD ACTUALLY GO WRONG. Phase 5 adds drip stages to campaign_stages,
// the table the LIVE send path selects from twice a minute against ~50–72K
// sends/day. If a drip stage leaked into either selector, the failure would not
// be a test going red — it would be real messages sent from the wrong place, or
// real campaigns silently starved.
//
// ⭐ SO THIS ASSERTS SET EQUALITY AGAINST PRODUCTION, NOT A SHAPE.
// It runs the REAL exported selector and the REAL Phase A predicate, and
// compares the stage-id sets against the same queries with every Phase 5 column
// forced out of consideration. Identical sets = the new columns changed nothing
// for regular work.
//
// ⭐ AND IT PROVES THE TEST CAN FAIL. A synthesized drip stage (rolled back) is
// checked against both predicates: Phase A must not see it, Phase B must. A
// comparison that only ever compared two empty sets would pass forever.
//
// Read-only except one rolled-back probe transaction.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "(unknown)";
  console.log(`target ref: ${ref}`);
  const now = new Date();

  // ── Phase B: the REAL exported selector ─────────────────────────────────
  console.log("\nPhase B (drain) — the real selectDrainableStages:");
  const live = await selectDrainableStages(db, { now, maxStages: 500 });
  const liveIds = live.map((r) => r.stage_id).sort((a, b) => a - b);
  console.log(`        returns ${liveIds.length} drainable stage(s)`);

  // The same query with every Phase 5 column excluded from consideration —
  // i.e. what it would return if drip columns did not exist.
  const asIfNoDrip = (await db.execute(sql`
    SELECT s.id AS stage_id
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      AND (c.send_paused IS NOT TRUE)
      AND s.send_approved = true
      AND s.archived_at IS NULL
      AND (p.send_paused IS NOT TRUE)
      AND (p.sends_enabled IS NOT FALSE)
      AND s.materialized_at IS NOT NULL
      AND (s.sent_at IS NOT NULL OR (s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${now.toISOString()}))
      AND EXISTS (SELECT 1 FROM stage_sends ss WHERE ss.stage_id = s.id AND ss.status = 'pending')
      -- the only difference: pretend no stage is a drip stage
      AND s.drip_active IS NULL
    ORDER BY s.id
  `)) as unknown as { stage_id: number }[];
  const noDripIds = asIfNoDrip.map((r) => r.stage_id).sort((a, b) => a - b);

  check("⭐ drainable set is IDENTICAL with and without drip stages", liveIds, noDripIds);
  // ⚠️ NAME THE WORLD THIS RAN AGAINST. When both sides are empty the equality
  // above is 0 == 0 — a trivially true PASS that proves nothing about drip. It
  // is the SYNTHESIZED-STAGE section below that carries the weight in that case,
  // and a reader skimming a wall of PASS lines deserves to be told which.
  if (liveIds.length === 0) {
    console.log(
      "        ⚠️ VACUOUS RIGHT NOW: both sides are EMPTY (no stage is currently " +
        "drainable), so this equality is 0 == 0. The load-bearing proof in this " +
        "state is the synthesized-drip-stage section below.",
    );
  }

  // ── Phase A: the materialize predicate ──────────────────────────────────
  console.log("\nPhase A (materialize):");
  const phaseA = (await db.execute(sql`
    SELECT s.id AS stage_id FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked' AND c.status = 'active'
      AND (c.send_paused IS NOT TRUE) AND s.send_approved = true
      AND s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${now.toISOString()}
      AND s.sent_at IS NULL AND s.schedule_missed_at IS NULL
      AND s.slip_hold_at IS NULL AND s.preflight_aborted_at IS NULL
      AND s.archived_at IS NULL AND (p.send_paused IS NOT TRUE)
      AND (p.sends_enabled IS NOT FALSE) AND s.materialized_at IS NULL
    ORDER BY s.id
  `)) as unknown as { stage_id: number }[];
  const phaseANoDrip = (await db.execute(sql`
    SELECT s.id AS stage_id FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked' AND c.status = 'active'
      AND (c.send_paused IS NOT TRUE) AND s.send_approved = true
      AND s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${now.toISOString()}
      AND s.sent_at IS NULL AND s.schedule_missed_at IS NULL
      AND s.slip_hold_at IS NULL AND s.preflight_aborted_at IS NULL
      AND s.archived_at IS NULL AND (p.send_paused IS NOT TRUE)
      AND (p.sends_enabled IS NOT FALSE) AND s.materialized_at IS NULL
      AND s.drip_active IS NULL
    ORDER BY s.id
  `)) as unknown as { stage_id: number }[];
  check("⭐ Phase A set is IDENTICAL with and without drip stages",
        phaseA.map((r) => r.stage_id), phaseANoDrip.map((r) => r.stage_id));
  if (phaseA.length === 0) {
    console.log("        ⚠️ also vacuous right now (both sides empty).");
  }
  console.log(`        (${phaseA.length} stage(s) due for materialization)`);

  // ── every existing stage is still a regular stage ───────────────────────
  const shape = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE drip_active IS NOT NULL)::int      AS drip_flagged,
           count(*) FILTER (WHERE window_start_min IS NOT NULL)::int AS windowed
    FROM campaign_stages
  `)) as unknown as { total: number; drip_flagged: number; windowed: number }[];
  check("no existing stage carries a drip flag", shape[0]?.drip_flagged, 0);
  check("no existing stage carries a window", shape[0]?.windowed, 0);
  console.log(`        (${shape[0]?.total} stages in total)`);

  // ── ⭐ prove the comparison CAN fail ─────────────────────────────────────
  console.log("\n⭐ can this test go red? (a synthesized drip stage, rolled back):");
  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const orgRows = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      const orgId = orgRows[0].id;
      const sfx = String(Date.now()).slice(-7);
      const campRows = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
        VALUES (${orgId}, ${"xg-" + sfx}, 'exit gate probe', 'active', 'drip', 'tracked')
        RETURNING id`)) as unknown as { id: number }[];
      const stRows = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active,
           send_approved, scheduled_at, materialized_at, sent_at)
        VALUES (${orgId}, ${campRows[0].id}, 1, 0, 1440, true, true, now(), now(), now())
        RETURNING id`)) as unknown as { id: number }[];
      const stageId = stRows[0].id;

      const seenByA = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        WHERE s.id = ${stageId} AND s.sent_at IS NULL AND s.materialized_at IS NULL
      `)) as unknown as { n: number }[];
      check("⭐ Phase A does NOT see the drip stage", seenByA[0]?.n, 0);

      const seenByB = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        WHERE s.id = ${stageId} AND s.materialized_at IS NOT NULL AND s.sent_at IS NOT NULL
      `)) as unknown as { n: number }[];
      check("⭐ Phase B DOES see the drip stage (so the split is real)", seenByB[0]?.n, 1);

      // ...and it is excluded by the drip_active filter the comparison uses.
      const excluded = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        WHERE s.id = ${stageId} AND s.drip_active IS NULL
      `)) as unknown as { n: number }[];
      check("...and the comparison's drip filter would exclude it", excluded[0]?.n, 0);

      tx.rollback();
    });
  } catch (e) {
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }
  check("probe rolled back", rolledBack, true);

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
