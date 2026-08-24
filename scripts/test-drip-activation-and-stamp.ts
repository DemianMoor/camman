import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { stampDripStageDrainable } from "@/lib/drip/scheduler";
import { campaignCreateSchema } from "@/lib/validators/campaigns";

// Drip Phase 5 — the three fixes that made drip campaigns actually runnable.
//
// A  a drip campaign may activate with no contact group; a REGULAR one may not
// B  the stage POST stores the window columns it accepts (round-trip)
// C  the drainable stamp is idempotent and can never touch a regular stage
//
// ⭐ WHY C IS DRIVEN THROUGH THE REAL EXPORTED FUNCTION, INSIDE ONE TRANSACTION.
// The property under test is "the second pass changes nothing", which is only
// meaningful on ONE connection: an assertion that reads back through the global
// pool can land on a different connection and see a state the write never
// reached, turning a broken guard into a confident PASS. So the probe opens a
// transaction, calls the same function the scheduler calls, reads back through
// that same `tx`, and rolls the whole thing back.
//
// Writes only inside a rolled-back probe transaction — the pattern
// test-drip-regular-unaffected.ts already uses against production.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Does the create schema demand a contact group for this input? */
function demandsGroup(input: Record<string, unknown>): boolean {
  const r = campaignCreateSchema.safeParse(input);
  if (r.success) return false;
  return r.error.issues.some((i) => i.path.join(".") === "audience_contact_group_ids");
}

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target ref: ${ref}`);

  // ── A. the launch gate's DIRECTION (pure schema, no DB) ──────────────────
  console.log("\nA. contact-group requirement — only a positive 'drip' read is exempt:");
  const base = { name: "x", brand_id: 1, offer_id: 1 };
  check("a REGULAR campaign with no group is still REFUSED",
        demandsGroup({ ...base, type: "regular" }), true);
  check("⭐ ...and so is one with NO type at all (the default path)",
        demandsGroup({ ...base }), true);
  check("a DRIP campaign with no group is allowed",
        demandsGroup({ ...base, type: "drip" }), false);
  check("a regular campaign WITH a group is allowed (control)",
        demandsGroup({ ...base, type: "regular", audience_contact_group_ids: [1] }), false);
  // The enum rejects an unknown type outright, which is the same fail-closed
  // direction: it can never reach the exemption branch.
  check("⭐ an unrecognised type never reaches the exemption",
        campaignCreateSchema.safeParse({ ...base, type: "future_type" }).success, false);

  // ── B + C. against real schema, rolled back ─────────────────────────────
  console.log("\nB+C. probe transaction (rolled back — nothing is kept):");
  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const sfx = String(Date.now()).slice(-7);

      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
        VALUES (${orgId}, ${"p5c-" + sfx}, 'p5 stamp probe', 'active', 'drip', 'tracked')
        RETURNING id`)) as unknown as { id: number }[];
      const campId = camp[0].id;

      // A drip stage as the FIXED POST route now stores it: window + drip_active
      // set, and nothing else stamped yet.
      const st = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
        VALUES (${orgId}, ${campId}, 1, 540, 1020, true)
        RETURNING id`)) as unknown as { id: number }[];
      const stageId = st[0].id;

      // A regular stage on the same campaign — the safety control.
      const reg = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
        VALUES (${orgId}, ${campId}, 2)
        RETURNING id`)) as unknown as { id: number }[];
      const regularStageId = reg[0].id;

      const readStage = async (id: number) => {
        const r = (await tx.execute(sql`
          SELECT send_approved, materialized_at, sent_at, window_start_min,
                 window_end_min, drip_active
          FROM campaign_stages WHERE id = ${id}
        `)) as unknown as Record<string, unknown>[];
        return r[0];
      };

      // B — the columns survive a write/read round trip at all.
      console.log("\n  B. window columns round-trip:");
      const fresh = await readStage(stageId);
      check("window_start_min stored", fresh.window_start_min, 540);
      check("window_end_min stored", fresh.window_end_min, 1020);
      check("drip_active stored", fresh.drip_active, true);
      check("a stage created without them stays NULL (control)",
            (await readStage(regularStageId)).drip_active, null);

      // C — the stamp.
      console.log("\n  C. the drainable stamp:");
      check("before: not drainable", [fresh.send_approved, fresh.materialized_at, fresh.sent_at],
            [false, null, null]);

      await stampDripStageDrainable(tx, { stageId, orgId });
      const first = await readStage(stageId);
      check("after one pass: send_approved", first.send_approved, true);
      check("after one pass: materialized_at set", first.materialized_at !== null, true);
      check("after one pass: sent_at set", first.sent_at !== null, true);

      // ⭐ the requested pin: a second pass must not re-stamp.
      await stampDripStageDrainable(tx, { stageId, orgId });
      const second = await readStage(stageId);
      check("⭐ second pass does NOT move materialized_at",
            String(second.materialized_at), String(first.materialized_at));
      check("⭐ second pass does NOT move sent_at",
            String(second.sent_at), String(first.sent_at));

      // ⭐ the safety property: this statement can never approve a regular stage.
      await stampDripStageDrainable(tx, { stageId: regularStageId, orgId });
      const regAfter = await readStage(regularStageId);
      check("⭐ a stage with drip_active NULL is NEVER approved",
            [regAfter.send_approved, regAfter.materialized_at, regAfter.sent_at],
            [false, null, null]);

      // ⭐ prove sent_at is filled, never overwritten — the two-writer hazard.
      const other = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, window_start_min, window_end_min,
           drip_active, sent_at)
        VALUES (${orgId}, ${campId}, 3, 1021, 1200, true, '2020-01-01T00:00:00Z')
        RETURNING id`)) as unknown as { id: number }[];
      await stampDripStageDrainable(tx, { stageId: other[0].id, orgId });
      const kept = await readStage(other[0].id);
      check("⭐ an existing sent_at is PRESERVED, not overwritten",
            String(kept.sent_at).startsWith("2020-01-01"), true);
      check("...while the rest of the stamp still applies", kept.send_approved, true);

      rolledBack = true;
      throw new Error("ROLLBACK");
    });
  } catch (e) {
    if ((e as Error).message !== "ROLLBACK") throw e;
  }
  check("probe rolled back", rolledBack, true);

  const leftovers = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaigns WHERE name = 'p5 stamp probe'
  `)) as unknown as { n: number }[];
  check("nothing left behind", leftovers[0]?.n, 0);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
