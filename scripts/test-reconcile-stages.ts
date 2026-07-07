// Fix C+D test: reconcileStuckStages heals stranded stages (mark stale 'sending'
// -> 'failed', stamp sent_at, recompute cost) WITHOUT touching fresh/live rows.
// Throwaway org; scoped teardown; drift check. Run: npx tsx scripts/test-reconcile-stages.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { reconcileStuckStages } from "@/lib/sends/reconcile-stages";

const ORG_MARKER = "__RECONCILE_TEST__";
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
  const unique = Date.now();
  let orgId = "";
  let campaignId = 0, phoneId = 0, contactSeq = 0;
  async function newContact(): Promise<string> {
    contactSeq++;
    return ((await db.execute(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1${unique}${contactSeq}`}) RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;
  }
  // Create an approved, materialized, tracked+active stage with sent_at NULL.
  async function newStage(n: number): Promise<number> {
    return ((await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, provider_phone_id, send_approved, materialized_at, sms_count, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${n}, ${phoneId}::int, true, now(), 0, NULL) RETURNING id
    `)) as unknown as { id: number }[])[0].id;
  }
  // Insert a stage_send with explicit status + age (minutes ago).
  async function addSend(stageId: number, status: string, minsAgo: number): Promise<void> {
    const cid = await newContact();
    const sentAt = status === "sent" ? sql`now() - make_interval(mins => ${minsAgo})` : sql`NULL`;
    await db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, created_at, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${cid}::uuid, ${`+1${unique}${contactSeq}`}, ${"hi"}, ${status},
              now() - make_interval(mins => ${minsAgo}), ${sentAt})
    `);
  }
  async function stageRow(id: number) {
    return ((await db.execute(sql`SELECT sent_at, total_cost FROM campaign_stages WHERE id = ${id}`)) as unknown as { sent_at: string | null; total_cost: string }[])[0];
  }
  async function statusCounts(id: number): Promise<Record<string, number>> {
    const rows = (await db.execute(sql`SELECT status, count(*)::int AS n FROM stage_sends WHERE stage_id = ${id} GROUP BY status`)) as unknown as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  const before = await tableCounts();
  try {
    orgId = ((await db.execute(sql`INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`}) RETURNING id::text AS id`)) as unknown as { id: string }[])[0].id;
    const providerId = ((await db.execute(sql`INSERT INTO sms_providers (org_id, name, sms_provider_id) VALUES (${orgId}::uuid, ${"T"}, ${`t-${unique}`}) RETURNING id`)) as unknown as { id: number }[])[0].id;
    phoneId = ((await db.execute(sql`INSERT INTO provider_phones (org_id, provider_id, phone_number, cost_per_sms) VALUES (${orgId}::uuid, ${providerId}::int, ${`+1${unique}`.slice(0, 15)}, ${"0.0100"}) RETURNING id`)) as unknown as { id: number }[])[0].id;
    campaignId = ((await db.execute(sql`INSERT INTO campaigns (org_id, slug, name, status, link_mode) VALUES (${orgId}::uuid, ${`cg-${unique}`}, ${"CG"}, ${"active"}, ${"tracked"}) RETURNING id`)) as unknown as { id: number }[])[0].id;

    // STRANDED stage (mirrors 740): 2 sent (20 min ago) + 1 sending (20 min ago), sent_at NULL.
    const stranded = await newStage(1);
    await addSend(stranded, "sent", 20);
    await addSend(stranded, "sent", 20);
    await addSend(stranded, "sending", 20);

    // FRESH stage: 1 sending created NOW (a live drain could be holding it) — must be left alone.
    const fresh = await newStage(2);
    await addSend(fresh, "sending", 0);

    // FINALIZED stage: all sent, sent_at already set — must be a no-op.
    const finalized = await newStage(3);
    await addSend(finalized, "sent", 30);
    await db.execute(sql`UPDATE campaign_stages SET sent_at = now() - make_interval(mins => 30) WHERE id = ${finalized}`);

    const result = await reconcileStuckStages(db, { orgId, staleMinutes: 15 });

    // Stranded: sending -> failed, sent_at stamped, cost = 0.01 * 2 sent = 0.02.
    const sc = await statusCounts(stranded);
    check("stranded: 0 sending, 1 failed, 2 sent", (sc.sending ?? 0) === 0 && sc.failed === 1 && sc.sent === 2, JSON.stringify(sc));
    const srow = await stageRow(stranded);
    check("stranded: sent_at now stamped", srow.sent_at !== null);
    check("stranded: cost = 0.02 (2 sent × 0.01)", Math.abs(Number(srow.total_cost) - 0.02) < 1e-9, srow.total_cost);
    const errRow = (await db.execute(sql`SELECT last_error FROM stage_sends WHERE stage_id = ${stranded} AND status = 'failed'`)) as unknown as { last_error: string }[];
    check("stranded: failed row carries a stranded last_error", /stranded/i.test(errRow[0]?.last_error ?? ""), errRow[0]?.last_error);

    // Fresh: untouched — still 1 sending, sent_at still NULL.
    const fc = await statusCounts(fresh);
    check("fresh (recent 'sending') left untouched — still 1 sending", (fc.sending ?? 0) === 1 && !fc.failed, JSON.stringify(fc));
    check("fresh: sent_at still NULL", (await stageRow(fresh)).sent_at === null);

    // Finalized: no-op (still all sent, sent_at unchanged).
    const finc = await statusCounts(finalized);
    check("finalized stage untouched — 1 sent, 0 failed", finc.sent === 1 && !finc.failed, JSON.stringify(finc));

    // Result counters reflect exactly the one stranded stage.
    check("result: 1 scanned, 1 reclaimed, 1 stampedSentAt", result.scanned === 1 && result.reclaimed === 1 && result.stampedSentAt === 1, JSON.stringify(result));
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
