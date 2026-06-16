// WS2 pre-flight validation: preflightStageSend reports the structural blockers
// (mirroring kickoff's refusals) WITHOUT materializing, plus the recipient count.
// Rolled-back tx, nothing persists. Run: npx tsx scripts/test-preflight.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { preflightStageSend } from "@/lib/sends/preflight";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0]?.id;
      if (!orgId) throw new Error("no organization");

      // Bare tracked campaign + stage with NO creative, NO provider → multiple blockers.
      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"pf-camp-" + sfx}, ${"pf"}, 'active', 'tracked') RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;
      const st = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
        VALUES (${orgId}, ${campaignId}, 1) RETURNING id
      `)) as unknown as { id: number }[];
      const stageId = st[0].id;

      const r1 = await preflightStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId });
      check("not ok when unconfigured", r1.ok === false, JSON.stringify(r1.blockers));
      check("flags no_creative", r1.blockers.includes("no_creative"));
      check("flags no_recipients (empty pool)", r1.blockers.includes("no_recipients"));
      check("flags no_provider", r1.blockers.includes("no_provider"));
      check("recipient_count 0", r1.recipient_count === 0, `got ${r1.recipient_count}`);
      check("checks array populated for readiness UI", r1.checks.length >= 4, `got ${r1.checks.length}`);

      // Attach a creative → that blocker clears, others remain.
      const cre = (await tx.execute(sql`
        INSERT INTO creatives (slug, org_id, text, status)
        VALUES (${"pf-cre-" + sfx}, ${orgId}, ${"hello"}, 'active') RETURNING id
      `)) as unknown as { id: number }[];
      await tx.execute(sql`UPDATE campaign_stages SET creative_id = ${cre[0].id} WHERE id = ${stageId}`);

      const r2 = await preflightStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId });
      check("creative blocker clears after attaching", !r2.blockers.includes("no_creative"), JSON.stringify(r2.blockers));
      check("still not ok (provider/recipients missing)", r2.ok === false);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nPre-flight validation verified (rolled back)." : `\nFAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
