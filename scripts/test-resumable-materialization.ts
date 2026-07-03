// Verifies the windowed / resumable materialization (WS5) against an ISOLATED
// manual-mode test fixture, with full cleanup. Covers:
//   1. fresh materialize → complete=true, materialized_at stamped, N rows
//   2. idempotent re-run → complete=true, 0 new, no duplicate rows
//   3. RESUME: pre-insert a partial batch + null materialized_at, then kickoff →
//      it enumerates ONLY the remaining, completes, stamps materialized_at, and
//      never duplicates (ON CONFLICT + exclude-already-materialized)
//   4. no-early-send GATE: selectDrainableStages excludes a stage while
//      materialized_at IS NULL, includes it once set (via a tracked fixture)
//
// Run: npx tsx scripts/test-resumable-materialization.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { kickoffStageSend } from "@/lib/sends/kickoff";
import {
  enumerateStageRecipients,
  type StageRecipientFilters,
} from "@/lib/sends/recipients";
import { selectDrainableStages } from "@/lib/sends/scheduled";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

const TAG = "__wt-resumable-test__";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  // typed-enough handle for the kickoff (which only calls .execute/.transaction)
  const dbc = db as unknown as Parameters<typeof kickoffStageSend>[0];

  let campaignId: number | null = null;
  try {
    // ---- Fixture prerequisites: reuse existing org/brand/creative/contacts ----
    const seed = (
      await db.execute(sql`
        SELECT c.org_id, c.brand_id, cr.id AS creative_id
        FROM campaigns c
        JOIN creatives cr ON cr.org_id = c.org_id AND cr.text IS NOT NULL
        WHERE c.brand_id IS NOT NULL
        LIMIT 1`)
    )[0] as { org_id: string; brand_id: number; creative_id: number };
    const orgId = seed.org_id;
    const contacts = (await db.execute(sql`
      SELECT id, phone_number FROM contacts
      WHERE org_id = ${orgId} AND is_archived = false
        AND id NOT IN (SELECT contact_id FROM opt_outs WHERE org_id = ${orgId})
      LIMIT 6`)) as unknown as { id: string; phone_number: string }[];
    if (contacts.length < 6) throw new Error("need >=6 usable contacts");
    const N = contacts.length;

    // ---- Insert a MANUAL test campaign + approved, due stage ----
    campaignId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-" + Date.now()},
                  ${TAG}, 'active', 'manual')
          RETURNING id`)
      )[0].id,
    );
    const stageId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, short_url, stop_text,
             scheduled_at, send_approved, include_no_status, include_clickers, exclude_clickers)
          VALUES (${orgId}, ${campaignId}, 1, ${seed.creative_id},
                  'https://example.com/x', 'Reply STOP to opt out',
                  now() - interval '1 minute', true, true, false, false)
          RETURNING id`)
      )[0].id,
    );
    // Frozen pool: N contacts, all "no status" so include_no_status picks them.
    for (const c of contacts) {
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
        VALUES (${orgId}, ${campaignId}, ${c.id}, true, false)`);
    }
    console.log(`fixture: campaign ${campaignId}, stage ${stageId}, pool ${N}\n`);

    const filters: StageRecipientFilters = {
      includeNoStatus: true, includeClickers: true, excludeClickers: false,
      splitIndex: null, splitTotal: null, behavioralTier: null, parentStageId: null,
    };
    const rowCount = async () =>
      Number(
        (
          (await db.execute(sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stageId}`)) as unknown as {
            n: number;
          }[]
        )[0].n,
      );
    const matAt = async () =>
      (
        (await db.execute(sql`SELECT materialized_at FROM campaign_stages WHERE id = ${stageId}`)) as unknown as {
          materialized_at: string | null;
        }[]
      )[0].materialized_at;

    // ---- 1. Fresh materialize ----
    console.log("1) fresh materialize:");
    const r1 = await kickoffStageSend(dbc, { orgId, campaignId, stageId });
    check("ok + complete", r1.ok && r1.complete === true, JSON.stringify(r1));
    check(`materialized ${N}`, r1.ok && r1.materialized === N);
    check("materialized_at stamped", (await matAt()) != null);
    check(`${N} stage_sends rows`, (await rowCount()) === N);

    // ---- 2. Idempotent re-run ----
    console.log("2) idempotent re-run:");
    const r2 = await kickoffStageSend(dbc, { orgId, campaignId, stageId });
    check("ok + complete + 0 new", r2.ok && r2.complete === true && r2.materialized === 0, JSON.stringify(r2));
    check(`still ${N} rows (no duplicates)`, (await rowCount()) === N);

    // ---- 3. RESUME after a simulated partial batch ----
    console.log("3) resume after partial:");
    // Wipe, then pre-insert rows for only the FIRST 2 contacts + clear the flag,
    // simulating a prior window that committed 2 of N then was interrupted.
    await db.execute(sql`DELETE FROM stage_sends WHERE stage_id = ${stageId}`);
    await db.execute(sql`UPDATE campaign_stages SET materialized_at = NULL WHERE id = ${stageId}`);
    for (const c of contacts.slice(0, 2)) {
      await db.execute(sql`
        INSERT INTO stage_sends (id, org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, lead_id)
        VALUES (gen_random_uuid(), ${orgId}, ${campaignId}, ${stageId}, ${c.id}, ${c.phone_number}, 'x', 'pending', gen_random_uuid())`);
    }
    // enumerate-remaining should now exclude the 2 already-materialized.
    const remaining = await enumerateStageRecipients(dbc, {
      campaignId, orgId, filters, excludeMaterializedStageId: stageId,
    });
    check(`enumerate excludes materialized (${N - 2} remaining)`, remaining.length === N - 2, `got ${remaining.length}`);
    const r3 = await kickoffStageSend(dbc, { orgId, campaignId, stageId });
    check("resume completes", r3.ok && r3.complete === true, JSON.stringify(r3));
    check(`materialized ${N - 2} new`, r3.ok && r3.materialized === N - 2);
    check(`exactly ${N} rows total (no dup of the pre-inserted 2)`, (await rowCount()) === N);
    check("materialized_at stamped after resume", (await matAt()) != null);

    // ---- 4. no-early-send drain GATE (tracked fixture) ----
    console.log("4) drain gate (materialized_at):");
    // A tracked campaign+stage with pending rows but materialized_at NULL must NOT
    // be drainable; once materialized_at is set, it becomes drainable.
    const tCampaignId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-t-" + Date.now()}, ${TAG}, 'active', 'tracked')
          RETURNING id`)
      )[0].id,
    );
    const tStageId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, scheduled_at, send_approved,
             include_no_status, include_clickers, exclude_clickers)
          VALUES (${orgId}, ${tCampaignId}, 1, ${seed.creative_id}, now() - interval '1 minute', true, true, false, false)
          RETURNING id`)
      )[0].id,
    );
    await db.execute(sql`
      INSERT INTO stage_sends (id, org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, lead_id)
      VALUES (gen_random_uuid(), ${orgId}, ${tCampaignId}, ${tStageId}, ${contacts[0].id}, ${contacts[0].phone_number}, 'x', 'pending', gen_random_uuid())`);
    const inSet = async () =>
      (await selectDrainableStages(dbc, { now: new Date(), orgId, maxStages: 500 }))
        .some((r) => r.stage_id === tStageId);
    check("NOT drainable while materialized_at IS NULL", (await inSet()) === false);
    await db.execute(sql`UPDATE campaign_stages SET materialized_at = now() WHERE id = ${tStageId}`);
    check("drainable once materialized_at set", (await inSet()) === true);

    // cleanup the tracked fixture
    await db.execute(sql`DELETE FROM stage_sends WHERE campaign_id = ${tCampaignId}`);
    await db.execute(sql`DELETE FROM campaign_stages WHERE campaign_id = ${tCampaignId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id = ${tCampaignId}`);
  } finally {
    // ---- Cleanup the manual fixture (order respects FKs) ----
    if (campaignId != null) {
      await db.execute(sql`DELETE FROM stage_sends WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_audience_pool WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_stages WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    }
    await pg.end({ timeout: 5 });
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
