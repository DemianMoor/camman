import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Migration 0184: campaign_stages.behavioral_tier may now hold 3 (the Registered
// lane). 4 must STAY rejected — the purchased tier is an EXIT, not a lane.
//
// PREVIEW DB ONLY, inside a transaction that ALWAYS rolls back:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-registered-lane-tier-db.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}

async function main() {
  const isPreview = (process.env.DATABASE_URL ?? "").includes("fdzxzxayhknywvmrhjcj");
  console.log(`Target DB: ${isPreview ? "camman-v2 (preview)" : "UNKNOWN"}\n`);
  if (!isPreview) {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`
          SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1
        `)) as unknown as { id: string }[]
      )[0]?.id;
      if (!orgId) throw new Error("no organization on the preview DB");

      const sfx = String(Date.now()).slice(-7);
      const campId = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode)
          VALUES (${orgId}::uuid, ${"p4-" + sfx}, 'phase4 tier check', 'active', 'tracked')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const parentId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
          VALUES (${orgId}::uuid, ${campId}::int, 1) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;

      // The constraint text itself — the thing the migration changed.
      const def = (
        (await tx.execute(sql`
          SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'campaign_stages_behavioral_lane_check'`)) as unknown as { def: string }[]
      )[0]?.def ?? "";
      check("C1 the lane CHECK mentions 3", /\b3\b/.test(def), def);
      check("C2 the lane CHECK does NOT mention 4", !/\b4\b/.test(def), def);

      async function insertLane(tier: number | null, withParent: boolean): Promise<string | null> {
        try {
          await tx.execute(sql`
            SAVEPOINT s;
            `);
          await tx.execute(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, stage_number, behavioral_tier, parent_stage_id)
            VALUES (${orgId}::uuid, ${campId}::int, ${1000 + (tier ?? 99)}, ${tier},
                    ${withParent ? parentId : null})`);
          await tx.execute(sql`RELEASE SAVEPOINT s`);
          return null;
        } catch (e) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT s`);
          // postgres-js wraps the real PG error as DrizzleQueryError.cause; the
          // outer .message is just "Failed query: ..." and never mentions the
          // constraint name, so the checks below must read .cause.message.
          const err = e as Error & { cause?: { message?: string } };
          return err.cause?.message ?? err.message;
        }
      }

      check("C3 tier 0 + parent still inserts", (await insertLane(0, true)) === null);
      check("C4 tier 2 + parent still inserts", (await insertLane(2, true)) === null);
      check("C5 ⭐ tier 3 + parent NOW inserts (the Registered lane)", (await insertLane(3, true)) === null);
      const four = await insertLane(4, true);
      check("C6 ⭐ tier 4 + parent is still REFUSED (the exit is not a lane)",
        four !== null && /behavioral_lane_check/.test(four), four ?? "inserted");
      const half = await insertLane(3, false);
      check("C7 tier 3 with NO parent is still REFUSED (half-configured)",
        half !== null && /behavioral_lane_check/.test(half), half ?? "inserted");

      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) rolledBack = true;
    else throw e;
  }
  check("C8 the probe transaction rolled back", rolledBack);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pgConn.end();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
