// Reproduces + guards the SPLIT-RESUME LEAK (incident: campaign 8_62_070326_1).
//
// A stage split (split_index/split_total) must partition the audience into
// DISJOINT buckets that stay stable across a resumed (windowed) materialization.
// The original bug applied the "exclude already-materialized" filter BEFORE the
// row_number() that drives the split modulo, so a resume re-numbered the shrunken
// remaining set and pulled the sibling stage's contacts into this stage.
//
// This test:
//   1. Cleanly materializes stage 1 and stage 2 (split 1/2 + 2/2) → records each
//      stage's rightful bucket, asserts they are DISJOINT and cover the pool.
//   2. Simulates a RESUME of stage 1: pre-insert HALF of its bucket, null
//      materialized_at, kickoff again. Asserts stage 1 ends as EXACTLY its bucket
//      with ZERO contacts leaked from stage 2's bucket.
//
// Run: npx tsx scripts/test-split-resume-leak.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { kickoffStageSend } from "@/lib/sends/kickoff";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

const TAG = "__wt-split-leak-test__";
const N = 8; // pool size; split 2 → 4 per bucket

async function main() {
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
        LIMIT 1`)
    )[0] as { org_id: string; brand_id: number; creative_id: number };
    const orgId = seed.org_id;
    const contacts = (await db.execute(sql`
      SELECT id, phone_number FROM contacts
      WHERE org_id = ${orgId} AND is_archived = false
        AND id NOT IN (SELECT contact_id FROM opt_outs WHERE org_id = ${orgId})
      LIMIT ${N}`)) as unknown as { id: string; phone_number: string }[];
    if (contacts.length < N) throw new Error(`need >=${N} usable contacts`);

    campaignId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-" + Date.now()}, ${TAG}, 'active', 'manual')
          RETURNING id`)
      )[0].id,
    );
    const mkStage = async (stageNumber: number, splitIndex: number) =>
      Number(
        (
          await db.execute(sql`
            INSERT INTO campaign_stages
              (org_id, campaign_id, stage_number, creative_id, short_url, stop_text,
               scheduled_at, send_approved, include_no_status, include_clickers,
               exclude_clickers, split_index, split_total)
            VALUES (${orgId}, ${campaignId}, ${stageNumber}, ${seed.creative_id},
                    'https://example.com/x', 'Reply STOP to opt out',
                    now() - interval '1 minute', true, true, true, false, ${splitIndex}, 2)
            RETURNING id`)
        )[0].id,
      );
    const stage1 = await mkStage(1, 1);
    const stage2 = await mkStage(2, 2);
    for (const c of contacts) {
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
        VALUES (${orgId}, ${campaignId}, ${c.id}, true, false)`);
    }
    console.log(`fixture: campaign ${campaignId}, stages ${stage1}/${stage2}, pool ${N}\n`);

    const contactsOf = async (stageId: number): Promise<Set<string>> => {
      const rows = (await db.execute(
        sql`SELECT contact_id FROM stage_sends WHERE stage_id = ${stageId}`,
      )) as unknown as { contact_id: string }[];
      return new Set(rows.map((r) => r.contact_id));
    };
    const inter = (a: Set<string>, b: Set<string>) =>
      [...a].filter((x) => b.has(x));

    // ---- 1. clean single-pass materialize of both split stages ----
    console.log("1) clean split materialize:");
    await kickoffStageSend(dbc, { orgId, campaignId, stageId: stage1 });
    await kickoffStageSend(dbc, { orgId, campaignId, stageId: stage2 });
    const h1 = await contactsOf(stage1);
    const h2 = await contactsOf(stage2);
    check(`stage1 + stage2 cover the pool (${h1.size}+${h2.size}=${N})`, h1.size + h2.size === N);
    check("clean split is DISJOINT", inter(h1, h2).length === 0, `overlap ${inter(h1, h2).length}`);

    // ---- 2. RESUME stage 1 after a partial window: must not leak stage2's half ----
    console.log("2) resume stage1 (partial) must not leak:");
    const h1Arr = [...h1];
    const partial = h1Arr.slice(0, Math.floor(h1Arr.length / 2)); // pre-insert half of stage1's bucket
    await db.execute(sql`DELETE FROM stage_sends WHERE stage_id = ${stage1}`);
    await db.execute(sql`UPDATE campaign_stages SET materialized_at = NULL WHERE id = ${stage1}`);
    for (const cid of partial) {
      const phone = contacts.find((c) => c.id === cid)!.phone_number;
      await db.execute(sql`
        INSERT INTO stage_sends (id, org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, lead_id)
        VALUES (gen_random_uuid(), ${orgId}, ${campaignId}, ${stage1}, ${cid}, ${phone}, 'x', 'pending', gen_random_uuid())`);
    }
    await kickoffStageSend(dbc, { orgId, campaignId, stageId: stage1 });
    const h1r = await contactsOf(stage1);
    const leaked = inter(h1r, h2);
    check("ZERO contacts leaked from stage2's bucket", leaked.length === 0, `leaked ${leaked.length}`);
    check(`stage1 resumes to exactly its bucket (${h1r.size}==${h1.size})`, h1r.size === h1.size);
    check(
      "stage1 bucket identity unchanged across resume",
      [...h1].every((x) => h1r.has(x)) && [...h1r].every((x) => h1.has(x)),
    );
  } finally {
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
