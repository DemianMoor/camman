// Verifies the automatic stage status moves (ClickUp 869evxbgb, migration 0179)
// against an ISOLATED manual-mode fixture on the PREVIEW database, with full
// cleanup. link_mode='manual' + send_approved=false is inert to both cron phases,
// so nothing is ever sent (same fixture pattern as test-cancel-rematerialize.ts).
//
//   1. budget hit mid-materialization → stays 'draft' (only COMPLETE moves it)
//   2. materialization completes (real kickoffStageSend) → 'pending',
//      previous_status 'draft', one system event (actor NULL, automatic)
//   3. re-Prepare of a complete stage → no second move, no second event
//   4. cancel (abort route's writes + autoMoveStageStatus) → back to 'draft'
//   5. hand-picked 'draft' → a complete materialization leaves it 'draft'
//   6. hand-picked 'pending' → a cancel leaves it 'pending'
//
// Needs migration 0179, so it refuses anything but the preview database:
//   npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-stage-auto-status.ts
import "./_env-preload";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { kickoffStageSend } from "@/lib/sends/kickoff";
import { autoMoveStageStatus } from "@/lib/stages/auto-status";

const PREVIEW_DB_REF = "fdzxzxayhknywvmrhjcj";
const TAG = "__wt-stage-auto-status-test__";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  if (!(process.env.DATABASE_URL ?? "").includes(PREVIEW_DB_REF)) {
    console.error(`Refusing to run: DATABASE_URL is not the preview database (${PREVIEW_DB_REF}).`);
    process.exit(1);
  }
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  const dbc = db as unknown as Parameters<typeof kickoffStageSend>[0];

  let campaignId: number | null = null;
  try {
    const seed = (
      await db.execute(sql`
        SELECT c.org_id, c.brand_id, cr.id AS creative_id
        FROM campaigns c
        JOIN creatives cr ON cr.org_id = c.org_id AND cr.text IS NOT NULL
        WHERE c.brand_id IS NOT NULL
        ORDER BY length(cr.text)
        LIMIT 1`)
    )[0] as { org_id: string; brand_id: number; creative_id: number };
    const orgId = seed.org_id;
    const contacts = (await db.execute(sql`
      SELECT id FROM contacts
      WHERE org_id = ${orgId} AND is_archived = false
        AND id NOT IN (SELECT contact_id FROM opt_outs WHERE org_id = ${orgId})
      LIMIT 5`)) as unknown as { id: string }[];
    if (contacts.length < 5) throw new Error("need >=5 usable contacts");

    const cid = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-" + Date.now()}, ${TAG}, 'active', 'manual')
          RETURNING id`)
      )[0].id,
    );
    campaignId = cid;
    const stageId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, short_url, stop_text,
             scheduled_at, send_approved, include_no_status, include_clickers, exclude_clickers)
          VALUES (${orgId}, ${cid}, 1, ${seed.creative_id},
                  'https://example.com/x', 'Reply STOP to opt out',
                  now() - interval '1 minute', false, true, false, false)
          RETURNING id`)
      )[0].id,
    );
    for (const c of contacts) {
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
        VALUES (${orgId}, ${cid}, ${c.id}, true, false)`);
    }
    console.log(`fixture: campaign ${cid}, stage ${stageId}, pool ${contacts.length}\n`);

    const stage = async () =>
      (
        (await db.execute(sql`
          SELECT status, previous_status, status_set_manually, materialized_at
          FROM campaign_stages WHERE id = ${stageId}`)) as unknown as {
          status: string;
          previous_status: string | null;
          status_set_manually: boolean;
          materialized_at: string | null;
        }[]
      )[0];
    const autoEvents = async () =>
      Number(
        (
          (await db.execute(sql`
            SELECT count(*)::int AS n FROM campaign_events
            WHERE stage_id = ${stageId} AND event_type = 'stage_status_changed'
              AND actor_user_id IS NULL AND metadata->>'automatic' = 'true'`)) as unknown as {
            n: number;
          }[]
        )[0].n,
      );
    // The abort route's writes, in its order (app/api/campaigns/[campaignId]/
    // stages/[stageId]/send/abort/route.ts).
    const cancel = () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE stage_sends SET status = 'rejected'
          WHERE stage_id = ${stageId} AND org_id = ${orgId} AND status = 'pending'`);
        await tx.execute(sql`
          UPDATE campaign_stages
          SET send_approved = false, schedule_missed_at = NULL, materialized_at = NULL
          WHERE id = ${stageId} AND org_id = ${orgId}`);
        await autoMoveStageStatus(tx as unknown as Parameters<typeof autoMoveStageStatus>[0], {
          orgId,
          campaignId: cid,
          stageId,
          from: "pending",
          to: "draft",
          reason: "send cancelled",
        });
      });
    // The status route's write (…/stages/[stageId]/status/route.ts).
    const setManually = (status: string) =>
      db.execute(sql`
        UPDATE campaign_stages
        SET status = ${status}, previous_status = status, status_changed_at = now(),
            status_set_manually = true
        WHERE id = ${stageId} AND org_id = ${orgId}`);

    const s0 = await stage();
    check("new stage starts 'draft', not manual", s0.status === "draft" && !s0.status_set_manually, JSON.stringify(s0));

    console.log("1) budget hit mid-materialization:");
    const r1 = await kickoffStageSend(dbc, { orgId, campaignId: cid, stageId, budgetMs: 0 });
    check("kickoff incomplete", r1.ok && r1.complete === false, JSON.stringify(r1));
    const s1 = await stage();
    check("materialized_at still NULL", s1.materialized_at == null);
    check("status still 'draft'", s1.status === "draft", s1.status);
    check("no automatic event", (await autoEvents()) === 0);

    console.log("2) materialization completes:");
    const r2 = await kickoffStageSend(dbc, { orgId, campaignId: cid, stageId });
    check("kickoff complete", r2.ok && r2.complete === true && r2.materialized > 0, JSON.stringify(r2));
    const s2 = await stage();
    check("materialized_at stamped", s2.materialized_at != null);
    check("status 'pending'", s2.status === "pending", s2.status);
    check("previous_status 'draft'", s2.previous_status === "draft", String(s2.previous_status));
    check("still not manual", s2.status_set_manually === false);
    check("1 automatic event (actor NULL)", (await autoEvents()) === 1, String(await autoEvents()));

    console.log("3) re-Prepare a complete stage:");
    const r3 = await kickoffStageSend(dbc, { orgId, campaignId: cid, stageId });
    check("kickoff no-op complete", r3.ok && r3.complete === true && r3.materialized === 0, JSON.stringify(r3));
    check("status still 'pending'", (await stage()).status === "pending");
    check("still 1 automatic event", (await autoEvents()) === 1, String(await autoEvents()));

    console.log("4) cancel the prepared send:");
    await cancel();
    const s4 = await stage();
    check("materialized_at reset", s4.materialized_at == null);
    check("status back to 'draft'", s4.status === "draft", s4.status);
    check("previous_status 'pending'", s4.previous_status === "pending", String(s4.previous_status));
    check("2 automatic events", (await autoEvents()) === 2, String(await autoEvents()));

    console.log("5) hand-picked 'draft', then Prepare:");
    await setManually("draft");
    const r5 = await kickoffStageSend(dbc, { orgId, campaignId: cid, stageId });
    check("kickoff complete", r5.ok && r5.complete === true && r5.materialized > 0, JSON.stringify(r5));
    const s5 = await stage();
    check("materialized_at stamped", s5.materialized_at != null);
    check("status stays 'draft' (manual wins)", s5.status === "draft", s5.status);
    check("no new automatic event", (await autoEvents()) === 2, String(await autoEvents()));

    console.log("6) hand-picked 'pending', then cancel:");
    await setManually("pending");
    await cancel();
    const s6 = await stage();
    check("materialized_at reset", s6.materialized_at == null);
    check("status stays 'pending' (manual wins)", s6.status === "pending", s6.status);
    check("no new automatic event", (await autoEvents()) === 2, String(await autoEvents()));
  } finally {
    if (campaignId != null) {
      await db.execute(sql`DELETE FROM campaign_events WHERE campaign_id = ${campaignId}`);
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
