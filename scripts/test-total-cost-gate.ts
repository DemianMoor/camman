// Fix A test: cost is computed from actual 'sent' rows, independent of the
// stage-level sent_at fire-lock. Throwaway org; scoped teardown; drift check.
// Run: npx tsx scripts/test-total-cost-gate.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

const ORG_MARKER = "__COSTGATE_TEST__";
const COUNTED = ["organizations", "campaigns", "campaign_stages", "stage_sends", "sms_providers", "provider_phones", "contacts"] as const;

async function main() {
  let passed = 0, failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name + (cond || !detail ? "" : ` — ${detail}`));
    if (cond) passed++; else failed++;
  }
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED) {
      const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`)) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }
  async function costOf(stageId: number): Promise<number> {
    const r = (await db.execute(sql`SELECT total_cost FROM campaign_stages WHERE id = ${stageId}`)) as unknown as { total_cost: string }[];
    return Number(r[0].total_cost);
  }
  const unique = Date.now();
  let orgId = "";
  const before = await tableCounts();
  try {
    orgId = ((await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`}) RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;
    const providerId = ((await db.execute(sql`
      INSERT INTO sms_providers (org_id, name, sms_provider_id) VALUES (${orgId}::uuid, ${"T"}, ${`t-${unique}`}) RETURNING id
    `)) as unknown as { id: number }[])[0].id;
    const phoneId = ((await db.execute(sql`
      INSERT INTO provider_phones (org_id, provider_id, phone_number, cost_per_sms)
      VALUES (${orgId}::uuid, ${providerId}::int, ${`+1${unique}`.slice(0, 15)}, ${"0.0100"}) RETURNING id
    `)) as unknown as { id: number }[])[0].id;
    const campaignId = ((await db.execute(sql`INSERT INTO campaigns (org_id, slug, name) VALUES (${orgId}::uuid, ${`cg-${unique}`}, ${"CG"}) RETURNING id`)) as unknown as { id: number }[])[0].id;
    const contactId = ((await db.execute(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1${unique}`.slice(0, 15)}) RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;

    // Stage with a provider phone, sms_count 0, sent_at NULL (the bug condition).
    const stageId = ((await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, provider_phone_id, sms_count, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, 1, ${phoneId}::int, 0, NULL) RETURNING id
    `)) as unknown as { id: number }[])[0].id;
    // 2 'sent' + 1 'failed' recipient rows.
    for (const st of ["sent", "sent", "failed"]) {
      await db.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${contactId}::uuid, ${`+1${st}${Math.random()}`.slice(0, 15)}, ${"hi"}, ${st})
      `);
    }

    await recomputeStageTotalCost(db, stageId);
    // Expected: 0.01 * (2 sent + 0 opt_out) = 0.02 — even though sent_at IS NULL.
    check("cost billed from 'sent' rows despite sent_at NULL (= 0.02)", Math.abs(await costOf(stageId) - 0.02) < 1e-9, String(await costOf(stageId)));

    // A stage with NO sent rows and sms_count 0 stays 0.
    const emptyStageId = ((await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, provider_phone_id, sms_count, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, 2, ${phoneId}::int, 0, NULL) RETURNING id
    `)) as unknown as { id: number }[])[0].id;
    await recomputeStageTotalCost(db, emptyStageId);
    check("stage with zero sent + zero sms_count stays 0", (await costOf(emptyStageId)) === 0);
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const name = ((await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) throw new Error(`Refusing teardown: org ${orgId} is not the test marker.`);
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM provider_phones WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM sms_providers WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED) if (before[t] !== after[t]) { drift = true; console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: ${before[t]}→${after[t]}`); }
      check("real-data table counts unchanged after teardown", !drift);
      await pgConn.end({ timeout: 5 });
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
