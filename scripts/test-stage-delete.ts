// deleteStage core test against a throwaway org.
// TEST-DATA SAFETY: same marker/teardown/drift pattern as test-behavioral-split.ts.
// Run: npx tsx scripts/test-stage-delete.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { deleteStage } from "@/lib/stages/delete-stage";

const ORG_MARKER = "__STAGEDEL_TEST__";
const COUNTED_TABLES = ["organizations", "campaigns", "campaign_stages", "stage_manual_sales"] as const;

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
  async function stage(campaignId: number, n: number, opts: { splitIndex?: number | null; splitTotal?: number | null; status?: string; sentAt?: string | null } = {}): Promise<number> {
    const r = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, split_index, split_total, status, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${n},
              ${opts.splitIndex ?? null}, ${opts.splitTotal ?? null},
              ${opts.status ?? "draft"}, ${opts.sentAt ?? null})
      RETURNING id
    `)) as unknown as { id: number }[];
    return r[0].id;
  }
  async function exists(id: number): Promise<boolean> {
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM campaign_stages WHERE id = ${id}`)) as unknown as { n: number }[];
    return Number(r[0].n) === 1;
  }

  const before = await tableCounts();
  try {
    const orgRows = (await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`}) RETURNING id::text AS id`)) as unknown as { id: string }[];
    orgId = orgRows[0].id;
    const campRows = (await db.execute(sql`INSERT INTO campaigns (org_id, slug, name) VALUES (${orgId}::uuid, ${`sd-${unique}`}, ${"SD"}) RETURNING id`)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;

    // --- Case 1: plain draft stage deletes. ---
    const s1 = await stage(campaignId, 1);
    const r1 = await deleteStage({ orgId, campaignId, stageId: s1 });
    check("draft stage deletes ok", r1.ok, JSON.stringify(r1));
    check("row is gone", !(await exists(s1)));

    // --- Case 2: sent stage is BLOCKED (archive-only). ---
    const s2 = await stage(campaignId, 2, { status: "success", sentAt: "2026-07-06 14:00:00+00" });
    const r2 = await deleteStage({ orgId, campaignId, stageId: s2 });
    check("sent stage blocked with 409 has_send_data", !r2.ok && r2.status === 409 && (r2 as { code: string }).code === "stage_has_send_data", JSON.stringify(r2));
    check("sent stage still exists", await exists(s2));

    // --- Case 3: stage with a manual-sales row is BLOCKED (has result data). ---
    const s3 = await stage(campaignId, 3);
    await db.execute(sql`INSERT INTO stage_manual_sales (org_id, campaign_id, stage_id, delta) VALUES (${orgId}::uuid, ${campaignId}::int, ${s3}::int, 1)`);
    const r3 = await deleteStage({ orgId, campaignId, stageId: s3 });
    check("stage with manual sales blocked", !r3.ok && r3.status === 409, JSON.stringify(r3));
    check("that stage still exists", await exists(s3));

    // --- Case 4: A/B split-reset. A(1/3),B(2/3),C(3/3) all draft; delete B then C; A reverts. ---
    const a = await stage(campaignId, 4, { splitIndex: 1, splitTotal: 3 });
    const b = await stage(campaignId, 5, { splitIndex: 2, splitTotal: 3 });
    const c = await stage(campaignId, 6, { splitIndex: 3, splitTotal: 3 });
    const rb = await deleteStage({ orgId, campaignId, stageId: b });
    check("delete B ok, no reset yet (A & C remain)", rb.ok && (rb as { split_reset_stage_id: number | null }).split_reset_stage_id === null, JSON.stringify(rb));
    const rc = await deleteStage({ orgId, campaignId, stageId: c });
    check("delete C ok, resets lone survivor A", rc.ok && (rc as { split_reset_stage_id: number | null }).split_reset_stage_id === a, JSON.stringify(rc));
    const aFields = (await db.execute(sql`SELECT split_index, split_total FROM campaign_stages WHERE id = ${a}`)) as unknown as { split_index: number | null; split_total: number | null }[];
    check("A reverted to normal (split fields null)", aFields[0].split_index === null && aFields[0].split_total === null);

    // --- Case 5: 404 for a foreign / missing stage. ---
    const r5 = await deleteStage({ orgId, campaignId, stageId: 999999999 });
    check("missing stage → 404", !r5.ok && r5.status === 404, JSON.stringify(r5));
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
