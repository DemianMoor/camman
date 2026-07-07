// Tests the A/B split-membership helpers against a throwaway org.
// TEST-DATA SAFETY: see scripts/test-behavioral-split.ts — same marker/teardown/drift pattern.
// Run: npx tsx scripts/test-split-membership.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  liveSplitPartnerCount,
  resetLoneSplitSurvivor,
} from "@/lib/stages/split-membership";

const ORG_MARKER = "__SPLITMEM_TEST__";
const COUNTED_TABLES = ["organizations", "campaigns", "campaign_stages"] as const;

async function main() {
  let passed = 0, failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name + (cond || !detail ? "" : ` — ${detail}`));
    cond ? passed++ : failed++;
  }
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`)) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }
  const unique = Date.now();
  let orgId = "";
  // Insert a stage with explicit split fields + status. Returns its id.
  async function stage(campaignId: number, n: number, splitIndex: number | null, splitTotal: number | null, status = "draft"): Promise<number> {
    const r = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, split_index, split_total, status)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${n}, ${splitIndex}, ${splitTotal}, ${status})
      RETURNING id
    `)) as unknown as { id: number }[];
    return r[0].id;
  }

  const before = await tableCounts();
  try {
    const orgRows = (await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`}) RETURNING id::text AS id`)) as unknown as { id: string }[];
    orgId = orgRows[0].id;
    const campRows = (await db.execute(sql`INSERT INTO campaigns (org_id, slug, name) VALUES (${orgId}::uuid, ${`sm-${unique}`}, ${"SM"}) RETURNING id`)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;

    // 3-way split: A(1/3) live, B(2/3) live, C(3/3) live.
    const a = await stage(campaignId, 1, 1, 3, "draft");
    const b = await stage(campaignId, 2, 2, 3, "draft");
    const c = await stage(campaignId, 3, 3, 3, "draft");

    check("A has 2 live partners (B,C)", (await liveSplitPartnerCount(db, { orgId, campaignId, stageId: a })) === 2);

    // Archive B and C → A stands alone.
    await db.execute(sql`UPDATE campaign_stages SET status = 'archived' WHERE id IN (${b}, ${c})`);
    check("A has 0 live partners once B,C archived", (await liveSplitPartnerCount(db, { orgId, campaignId, stageId: a })) === 0);

    // resetLoneSplitSurvivor: one live split member (A) remains → it gets reset.
    const resetId = await resetLoneSplitSurvivor(db, { orgId, campaignId });
    check("reset returns A's id", resetId === a, `got ${resetId}`);
    const aAfter = (await db.execute(sql`SELECT split_index, split_total FROM campaign_stages WHERE id = ${a}`)) as unknown as { split_index: number | null; split_total: number | null }[];
    check("A's split fields cleared", aAfter[0].split_index === null && aAfter[0].split_total === null);

    // With NO live split members left (A now reset), reset is a no-op.
    check("reset no-ops when no live split members", (await resetLoneSplitSurvivor(db, { orgId, campaignId })) === null);
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const nameRows = (await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[];
        if (!(nameRows[0]?.name ?? "").startsWith(ORG_MARKER)) throw new Error(`Refusing teardown: org ${orgId} is not the test marker.`);
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED_TABLES) if (before[t] !== after[t]) { drift = true; console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: ${before[t]}→${after[t]}`); }
      check("real-data table counts unchanged after teardown", !drift);
      await pgConn.end({ timeout: 5 });
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
