// Fix C+D test: reconcileStuckStages heals stranded stages (mark stale 'sending'
// -> 'failed', stamp sent_at, recompute cost) WITHOUT touching fresh/live rows.
// Throwaway org; scoped teardown; drift check. Run: npx tsx scripts/test-reconcile-stages.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { reconcileStuckStages } from "@/lib/sends/reconcile-stages";

const ORG_MARKER = "__RECONCILE_TEST__";
const COUNTED = ["organizations", "campaigns", "campaign_stages", "stage_sends", "send_attempts", "sms_providers", "provider_phones", "contacts"] as const;

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
  // Insert a stage_send with explicit status + age (minutes ago). Returns its id.
  async function addSend(stageId: number, status: string, minsAgo: number): Promise<string> {
    const cid = await newContact();
    const sentAt = status === "sent" ? sql`now() - make_interval(mins => ${minsAgo})` : sql`NULL`;
    return ((await db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, created_at, sent_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${cid}::uuid, ${`+1${unique}${contactSeq}`}, ${"hi"}, ${status},
              now() - make_interval(mins => ${minsAgo}), ${sentAt})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[])[0].id;
  }
  // Record a drain attempt on a stage_send `minsAgo` minutes ago (the drain-
  // liveness clock the reconcile guard reads).
  async function addAttempt(stageSendId: string, minsAgo: number): Promise<void> {
    await db.execute(sql`
      INSERT INTO send_attempts (org_id, stage_send_id, attempt_number, http_status, ok, classification, created_at)
      VALUES (${orgId}::uuid, ${stageSendId}::uuid, 1, 200, true, ${"accepted"}, now() - make_interval(mins => ${minsAgo}))
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

    // LIVE-DRAIN stage: old materialization (20 min) BUT a RECENT send_attempt
    // (2 min ago) — a drain is actively working it, so reconcile must NOT touch
    // its 'sending' rows (the send_attempts liveness guard, not created_at).
    const liveDrain = await newStage(4);
    await addSend(liveDrain, "sent", 20);
    const liveSendingId = await addSend(liveDrain, "sending", 20);
    await addAttempt(liveSendingId, 2);

    // ZERO-SENT stranded: only 'sending' rows (20 min old), nothing ever sent,
    // no attempts → reconcile marks them failed, does NOT stamp sent_at, cost 0.
    const zeroSent = await newStage(5);
    await addSend(zeroSent, "sending", 20);

    // Org-scoping: a run scoped to a DIFFERENT org heals nothing here.
    const bogus = await reconcileStuckStages(db, { orgId: "00000000-0000-0000-0000-000000000000", staleMinutes: 15 });
    check("scoped to another org → nothing scanned here", bogus.scanned === 0, JSON.stringify(bogus));
    check("org-scoping: our stranded 'sending' still intact after foreign-org run", ((await statusCounts(stranded)).sending ?? 0) === 1);

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

    // Live-drain: a recent send_attempt protects it — 'sending' left untouched.
    const lc = await statusCounts(liveDrain);
    check("live-drain (recent send_attempt) NOT reclaimed — still 1 sending", (lc.sending ?? 0) === 1 && !lc.failed, JSON.stringify(lc));
    check("live-drain: sent_at still NULL (not finalized under an active drain)", (await stageRow(liveDrain)).sent_at === null);

    // Zero-sent stranded: sending -> failed, sent_at NOT stamped, cost 0.
    const zc = await statusCounts(zeroSent);
    check("zero-sent stranded: 1 failed, 0 sending", (zc.sending ?? 0) === 0 && zc.failed === 1, JSON.stringify(zc));
    const zrow = await stageRow(zeroSent);
    check("zero-sent: sent_at NOT stamped (nothing sent)", zrow.sent_at === null);
    check("zero-sent: cost stays 0", Number(zrow.total_cost) === 0);

    // Result counters: stranded + zeroSent scanned/reclaimed; only stranded stamped.
    check("result: 2 scanned, 2 reclaimed, 1 stampedSentAt", result.scanned === 2 && result.reclaimed === 2 && result.stampedSentAt === 1, JSON.stringify(result));
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const name = ((await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) throw new Error(`Refusing teardown: org ${orgId} is not the test marker.`);
        await db.execute(sql`DELETE FROM send_attempts WHERE org_id = ${orgId}::uuid`);
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
