import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { NextRequest } from "next/server";

import { GET as cronGET } from "@/app/api/cron/partner-postbacks/route";
import { db } from "@/db/client";
import { anyPostbackKeyEnabled, runPostbackDelivery } from "@/lib/partners/postbacks/deliver";
import type { SendResult } from "@/lib/partners/postbacks/http";
import { createPartnerWithKey } from "./_partner-fixture";

// Partner postback delivery runner (D1-D13).
//
// Preview DB only. NOT one rolled-back transaction: the runner claims and writes
// on the pooled `db` (no transaction may be held across HTTP), so fixtures are
// COMMITTED in a throwaway org and deleted BY ID in `finally`, then the cleanup is
// proved by query. Every run passes `orgId` so the runner never claims or sends
// another org's rows on the shared preview DB.
//
// Telegram is unset so a failure alert cannot leave the process; the alert_state
// row is asserted instead.
//
// Run: node scripts/with-preview-env.mjs npx tsx --conditions=react-server --conditions=import scripts/test-postback-deliver-db.ts

delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];

const RUN = `pbd-${Date.now().toString(36)}`;
const SECRET = `SECRET${Date.now().toString(36)}`;
const TEMPLATE_V1 = "https://pb.example.com/v1?c={conversion_id}&token={tok}";
const TEMPLATE_V2 = "https://pb.example.com/v2?c={conversion_id}&token={tok}";
const res = (status: number | null, blocked = false): SendResult => ({
  status, error: status === null ? "blocked" : null, blocked, durationMs: 1,
});

// Fake transport: the response for a URL is picked by its `c` (conversion_id) param.
const calls: string[] = [];
const plan = new Map<string, SendResult>();
const throwFor = new Set<string>();
let sendDelayMs = 0;
async function fakeSend(url: string): Promise<SendResult> {
  calls.push(url);
  if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
  const c = new URL(url).searchParams.get("c") ?? "";
  if (throwFor.has(c)) throw new Error(`injected transport crash for ${c}`);
  return plan.get(new URL(url).searchParams.get("c") ?? "") ?? res(200);
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED = "true";

  const orgId = (await q<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${RUN}) RETURNING id::text AS id`))[0].id;
  const partnerIds: number[] = [];
  const keyIds: number[] = [];
  const postbackIds: number[] = [];
  const conversionIds: number[] = [];

  try {
    const mkKey = async (slug: string) => {
      const k = await createPartnerWithKey(db, { orgId, slug: `${RUN}-${slug}`, name: `${RUN} ${slug}`, sandbox: true });
      partnerIds.push(k.partnerId);
      keyIds.push(k.keyId);
      await db.execute(sql`
        UPDATE partner_keys SET postback_url_template = ${TEMPLATE_V1}, postback_enabled = true,
                                postback_include_payout = false
        WHERE id = ${k.keyId}::int`);
      return k.keyId;
    };
    const key = await mkKey("main");
    const keyOff = await mkKey("off");
    const keyTpl = await mkKey("tpl");
    const keyBad = await mkKey("bad");
    // A placeholder in the host: renders to a different host than the template's ⇒ renderPostbackUrl throws.
    await db.execute(sql`UPDATE partner_keys SET postback_url_template = 'https://{tok}.example.com/pb?c={conversion_id}'
                         WHERE id = ${keyBad}::int`);

    /** A due pending row; conversion_id doubles as the fake transport's routing key. */
    const mkRow = async (keyId: number, cid: string) => {
      const payload = {
        event: "purchase", status: "approved", conversion_id: cid, occurred_at: new Date().toISOString(),
        currency: "USD", payout: "1.0000", fields: { tok: SECRET },
      };
      const id = Number((await q<{ id: number }>(sql`
        INSERT INTO partner_postbacks (org_id, partner_key_id, payload, next_attempt_at)
        VALUES (${orgId}::uuid, ${keyId}::int, ${JSON.stringify(payload)}::jsonb, now() - interval '1 second')
        RETURNING id`))[0].id);
      postbackIds.push(id);
      return id;
    };
    const row = async (id: number) =>
      (await q<{
        status: string; attempts: number; delivered: boolean; code: number | null; err: string | null;
        masked: string | null; gap_s: number | null; due_in_s: number;
      }>(sql`
        SELECT status, attempts, delivered_at IS NOT NULL AS delivered, last_response_code AS code,
               last_error AS err, last_url_masked AS masked,
               extract(epoch FROM next_attempt_at - last_attempt_at)::float AS gap_s,
               extract(epoch FROM next_attempt_at - now())::float AS due_in_s
        FROM partner_postbacks WHERE id = ${id}::bigint`))[0];
    const makeDue = (id: number) =>
      db.execute(sql`UPDATE partner_postbacks SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}::bigint`);
    const run = (o: { limit?: number; deadlineMs?: number } = {}) => runPostbackDelivery({ ...o, send: fakeSend, orgId });
    const alert = async (k: number) =>
      (await q<{ state: string }>(sql`SELECT state FROM alert_state WHERE alert_key = ${`partner-postback-failed:${k}`}`))[0]?.state ?? null;

    /** The filter scope holds only fixture rows: nothing from another org can be claimed. */
    const assertScope = async (label: string) => {
      const inScope = (await q<{ id: number }>(sql`SELECT id FROM partner_postbacks WHERE org_id = ${orgId}::uuid`)).map((r) => Number(r.id));
      check(`scope (${label}): org filter holds only fixture rows`, inScope.every((id) => postbackIds.includes(id)), true);
    };

    // ── D1 200 ⇒ delivered ─────────────────────────────────────────────
    console.log("\nD1. 200 ⇒ delivered:");
    const d1 = await mkRow(key, "D1");
    await assertScope("D1");
    calls.length = 0;
    const r1 = await run();
    const s1 = await row(d1);
    check("result counts", [r1.claimed, r1.delivered, r1.skipped_kill_switch], [1, 1, false]);
    check("⭐ delivered, attempts 1, delivered_at set, code 200", [s1.status, s1.attempts, s1.delivered, s1.code], ["delivered", 1, true, 200]);
    check("sent once to the rendered URL", calls, [`https://pb.example.com/v1?c=D1&token=${SECRET}`]);
    check("alert cleared (ok row)", await alert(key), "ok");
    check("anyPostbackKeyEnabled sees the enabled fixture keys (watchdog gate input)", await anyPostbackKeyEnabled(), true);

    // ── D2 500 ⇒ retry ×6 ⇒ failed after attempt 7 ────────────────────
    console.log("\nD2. 500 ⇒ backoff, then failed after attempt 7:");
    const d2 = await mkRow(key, "D2");
    plan.set("D2", res(500));
    await run();
    const s2 = await row(d2);
    check("⭐ pending, attempts 1, code 500", [s2.status, s2.attempts, s2.code], ["pending", 1, 500]);
    check("⭐ next_attempt_at = last_attempt_at + 60 s", Math.round(s2.gap_s ?? -1), 60);
    check("...and ~60 s from now", s2.due_in_s > 50 && s2.due_in_s <= 60, true);
    const expectedGaps = [300, 1800, 7200, 21600, 86400];
    for (let attempt = 2; attempt <= 7; attempt++) {
      await makeDue(d2);
      await run();
      const s = await row(d2);
      if (attempt < 7) check(`attempt ${attempt}: pending, backoff ${expectedGaps[attempt - 2]} s`,
                             [s.status, s.attempts, Math.round(s.gap_s ?? -1)], ["pending", attempt, expectedGaps[attempt - 2]]);
      else check("⭐ attempt 7: failed", [s.status, s.attempts, s.code], ["failed", 7, 500]);
    }
    check("⭐ alert row firing", await alert(key), "firing");
    check("total sends for D2 = 7", calls.filter((u) => u.includes("c=D2")).length, 7);

    // ── D3 404 / 302 / blocked ⇒ failed immediately ────────────────────
    console.log("\nD3. 404 / 302 / blocked ⇒ failed:");
    const d3a = await mkRow(key, "D3a"); plan.set("D3a", res(404));
    const d3b = await mkRow(key, "D3b"); plan.set("D3b", res(302));
    const d3c = await mkRow(key, "D3c"); plan.set("D3c", res(null, true));
    await run();
    for (const [label, id, code] of [["404", d3a, 404], ["302", d3b, 302], ["blocked", d3c, null]] as const) {
      const s = await row(id);
      check(`⭐ ${label}: failed after 1 attempt`, [s.status, s.attempts, s.code], ["failed", 1, code]);
    }
    check("blocked row records the error", (await row(d3c)).err, "blocked");

    // ── D4 key disabled while pending ⇒ cancelled, never sent ──────────
    console.log("\nD4. key disabled while pending:");
    const d4 = await mkRow(keyOff, "D4");
    await db.execute(sql`UPDATE partner_keys SET postback_enabled = false WHERE id = ${keyOff}::int`);
    calls.length = 0;
    const r4 = await run();
    const s4 = await row(d4);
    check("⭐ cancelled, last_error postback_disabled, attempts 0", [s4.status, s4.err, s4.attempts], ["cancelled", "postback_disabled", 0]);
    check("⭐ send never called", calls.length, 0);
    check("result.cancelled", r4.cancelled, 1);

    // ── D5 kill switch off ⇒ nothing sent, rows unchanged ──────────────
    console.log("\nD5. kill switch off:");
    const d5 = await mkRow(key, "D5");
    const before = await q(sql`SELECT * FROM partner_postbacks WHERE id = ${d5}::bigint`);
    delete process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED;
    calls.length = 0;
    const r5 = await run();
    process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED = "true";
    check("⭐ skipped_kill_switch, nothing claimed", [r5.skipped_kill_switch, r5.claimed], [true, 0]);
    check("⭐ send never called", calls.length, 0);
    check("⭐ row unchanged", JSON.stringify(await q(sql`SELECT * FROM partner_postbacks WHERE id = ${d5}::bigint`)), JSON.stringify(before));
    await run(); // deliver it so it does not leak into D6's count

    // ── D6 two runners in parallel over 20 due rows ⇒ exactly 20 sends ─
    console.log("\nD6. two parallel runners over 20 rows:");
    const d6 = [];
    for (let i = 0; i < 20; i++) d6.push(await mkRow(key, `D6-${i}`));
    await assertScope("D6");
    calls.length = 0;
    sendDelayMs = 30;
    const [ra, rb] = await Promise.all([run(), run()]);
    sendDelayMs = 0;
    check("⭐ send called exactly 20 times", calls.length, 20);
    check("⭐ 20 distinct URLs", new Set(calls).size, 20);
    check("claimed 20 in total", ra.claimed + rb.claimed, 20);
    const delivered6 = (await q<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM partner_postbacks
      WHERE id = ANY(${`{${d6.join(",")}}`}::bigint[]) AND status = 'delivered' AND attempts = 1`))[0].n;
    check("all 20 delivered with attempts 1", delivered6, 20);

    // ── D7 template edited between attempts ⇒ attempt 2 uses the new URL ─
    console.log("\nD7. template edited between attempts:");
    const d7 = await mkRow(keyTpl, "D7");
    plan.set("D7", res(503));
    calls.length = 0;
    await run();
    check("attempt 1 on v1", calls, [`https://pb.example.com/v1?c=D7&token=${SECRET}`]);
    await db.execute(sql`UPDATE partner_keys SET postback_url_template = ${TEMPLATE_V2} WHERE id = ${keyTpl}::int`);
    plan.delete("D7");
    await makeDue(d7);
    calls.length = 0;
    await run();
    check("⭐ attempt 2 on v2", calls, [`https://pb.example.com/v2?c=D7&token=${SECRET}`]);
    const s7 = await row(d7);
    check("delivered on attempt 2", [s7.status, s7.attempts], ["delivered", 2]);

    // ── D8 last_url_masked never holds the token value ─────────────────
    console.log("\nD8. masked URL:");
    const masked = await q<{ id: number; masked: string | null }>(sql`
      SELECT id, last_url_masked AS masked FROM partner_postbacks WHERE org_id = ${orgId}::uuid AND last_url_masked IS NOT NULL`);
    check("rows with a masked URL exist", masked.length > 20, true);
    check("⭐ no last_url_masked contains the token value", masked.filter((r) => r.masked?.includes(SECRET)).length, 0);
    check("⭐ ...the token param is masked as ***", masked.every((r) => r.masked?.includes("token=***")), true);
    check("D1 masked URL exactly", (await row(d1)).masked, "https://pb.example.com/v1?c=D1&token=***");

    // ── D9 render throws ⇒ failed, last_error = the message, never sent ─
    console.log("\nD9. template renders to another host:");
    const d9 = await mkRow(keyBad, "D9");
    calls.length = 0;
    const r9 = await run();
    const s9 = await row(d9);
    check("⭐ failed, last_error is the thrown message, attempts 0",
          [s9.status, s9.err, s9.attempts], ["failed", "Rendered postback URL does not match the template host", 0]);
    check("⭐ send never called", calls.length, 0);
    check("result.failed", r9.failed, 1);
    check("alert firing for that key", await alert(keyBad), "firing");

    // ── D10 one row's send throws ⇒ the others still land; errors = 1 ──
    console.log("\nD10. per-row error isolation:");
    const d10 = [];
    for (let i = 0; i < 6; i++) d10.push(await mkRow(key, `D10-${i}`));
    throwFor.add("D10-2");
    calls.length = 0;
    const r10 = await run();
    throwFor.clear();
    check("⭐ run resolves: errors 1, delivered 5", [r10.errors, r10.delivered, r10.claimed], [1, 5, 6]);
    const others = await Promise.all(d10.filter((_, i) => i !== 2).map(row));
    check("⭐ the other 5 rows recorded delivered", others.map((s) => [s.status, s.attempts]), Array(5).fill(["delivered", 1]));
    const crashed = await row(d10[2]);
    check("⭐ the crashed row is left pending, attempts 0, on its 2-minute claim",
          [crashed.status, crashed.attempts, crashed.due_in_s > 100 && crashed.due_in_s <= 120], ["pending", 0, true]);

    // ── D11 run deadline ⇒ rows not started are deferred on their claim ─
    console.log("\nD11. run deadline:");
    const d11 = [];
    for (let i = 0; i < 10; i++) d11.push(await mkRow(key, `D11-${i}`));
    calls.length = 0;
    sendDelayMs = 1500;
    const r11 = await run({ deadlineMs: 1000 }); // the first wave of 5 starts before 1 s and ends after it
    sendDelayMs = 0;
    check("⭐ claimed 10, delivered 5, deferred 5, sent 5", [r11.claimed, r11.delivered, r11.deferred, calls.length], [10, 5, 5, 5]);
    const states11 = await Promise.all(d11.map(row));
    const deferred11 = states11.filter((s) => s.status === "pending");
    check("⭐ 5 deferred rows: pending, attempts 0, still on the claim",
          [deferred11.length, deferred11.every((s) => s.attempts === 0 && s.due_in_s > 100)], [5, true]);

    // ── D13 ledger moved off 'approved' while pending ⇒ cancelled, never sent ─
    console.log("\nD13. sale no longer approved at claim time:");
    const mkConversion = async (status: string) => {
      const id = Number((await q<{ id: number }>(sql`
        INSERT INTO conversion_events (org_id, keitaro_event_id, keitaro_status, keitaro_type, status, occurred_at)
        VALUES (${orgId}::uuid, ${`${RUN}-${conversionIds.length}`}, 'sale', 'sale', ${status}, now())
        RETURNING id`))[0].id);
      conversionIds.push(id);
      return id;
    };
    const ceRejected = await mkConversion("approved");
    const ceStill = await mkConversion("approved");
    const d13a = await mkRow(key, "D13a");
    const d13b = await mkRow(key, "D13b");
    await db.execute(sql`UPDATE partner_postbacks SET conversion_event_id = ${ceRejected}::bigint WHERE id = ${d13a}::bigint`);
    await db.execute(sql`UPDATE partner_postbacks SET conversion_event_id = ${ceStill}::bigint WHERE id = ${d13b}::bigint`);
    // Rejected after enqueue: the payload still says "approved".
    await db.execute(sql`UPDATE conversion_events SET status = 'rejected' WHERE id = ${ceRejected}::bigint`);
    calls.length = 0;
    const r13 = await run();
    const s13a = await row(d13a);
    const s13b = await row(d13b);
    check("⭐ rejected sale: cancelled, last_error no_longer_approved, attempts 0",
          [s13a.status, s13a.err, s13a.attempts], ["cancelled", "no_longer_approved", 0]);
    check("⭐ still-approved sale: delivered", [s13b.status, s13b.attempts], ["delivered", 1]);
    check("⭐ only the approved one was sent", calls, [`https://pb.example.com/v1?c=D13b&token=${SECRET}`]);
    check("result counts (claimed, cancelled, delivered)", [r13.claimed, r13.cancelled, r13.delivered], [2, 1, 1]);

    // ── D12 cron route: kill switch off ⇒ heartbeat stamped, nothing claimed ─
    console.log("\nD12. cron route heartbeat:");
    const HB = "partner-postbacks";
    const hbBefore = (await q<{ wm: string | null }>(sql`SELECT watermark::text AS wm FROM cron_locks WHERE job_name = ${HB}`))[0];
    const secret = `test-${RUN}`;
    process.env.CRON_SECRET = secret;
    try {
      const unauth = await cronGET(new NextRequest("http://localhost/api/cron/partner-postbacks"));
      check("no secret ⇒ 401", unauth.status, 401);
      delete process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED;
      const d12 = await mkRow(key, "D12");
      calls.length = 0;
      const resp = await cronGET(new NextRequest("http://localhost/api/cron/partner-postbacks",
                                                  { headers: { authorization: `Bearer ${secret}` } }));
      process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED = "true";
      check("⭐ kill switch off ⇒ 200 skipped_kill_switch", [resp.status, (await resp.json()).skipped_kill_switch], [200, true]);
      const hb = (await q<{ age_s: number }>(sql`
        SELECT extract(epoch FROM now() - watermark)::float AS age_s FROM cron_locks WHERE job_name = ${HB}`))[0];
      check("⭐ heartbeat stamped within the last 10 s", hb !== undefined && hb.age_s < 10, true);
      check("...and the due row was not touched", [(await row(d12)).status, (await row(d12)).attempts], ["pending", 0]);
    } finally {
      // Restore the heartbeat row exactly as found.
      if (hbBefore === undefined) await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${HB}`);
      else await db.execute(sql`UPDATE cron_locks SET watermark = ${hbBefore.wm}::timestamptz WHERE job_name = ${HB}`);
      const after = (await q<{ wm: string | null }>(sql`SELECT watermark::text AS wm FROM cron_locks WHERE job_name = ${HB}`))[0];
      check("heartbeat row restored to its prior state", after?.wm ?? "absent", hbBefore?.wm ?? "absent");
    }
  } finally {
    // Cleanup BY ID, FK-safe order: postbacks → alert rows → keys → partners → org.
    console.log("\ncleanup:");
    if (postbackIds.length) await db.execute(sql`DELETE FROM partner_postbacks WHERE id = ANY(${`{${postbackIds.join(",")}}`}::bigint[])`);
    if (conversionIds.length) await db.execute(sql`DELETE FROM conversion_events WHERE id = ANY(${`{${conversionIds.join(",")}}`}::bigint[])`);
    const alertKeys = keyIds.map((k) => `partner-postback-failed:${k}`);
    if (alertKeys.length) await db.execute(sql`DELETE FROM alert_state WHERE alert_key = ANY(${`{${alertKeys.join(",")}}`}::text[])`);
    if (keyIds.length) await db.execute(sql`DELETE FROM partner_keys WHERE id = ANY(${`{${keyIds.join(",")}}`}::int[])`);
    if (partnerIds.length) await db.execute(sql`DELETE FROM partners WHERE id = ANY(${`{${partnerIds.join(",")}}`}::int[])`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);

    const left = (await q<{ orgs: number; keys: number; partners: number; pbs: number; alerts: number; ces: number }>(sql`
      SELECT (SELECT count(*)::int FROM organizations WHERE id = ${orgId}::uuid) AS orgs,
             (SELECT count(*)::int FROM conversion_events WHERE org_id = ${orgId}::uuid
                OR id = ANY(${`{${conversionIds.join(",") || "0"}}`}::bigint[])) AS ces,
             (SELECT count(*)::int FROM partner_keys WHERE org_id = ${orgId}::uuid) AS keys,
             (SELECT count(*)::int FROM partners WHERE org_id = ${orgId}::uuid) AS partners,
             (SELECT count(*)::int FROM partner_postbacks WHERE org_id = ${orgId}::uuid
                OR id = ANY(${`{${postbackIds.join(",") || "0"}}`}::bigint[])) AS pbs,
             (SELECT count(*)::int FROM alert_state WHERE org_id = ${orgId}::uuid
                OR alert_key = ANY(${`{${keyIds.map((k) => `partner-postback-failed:${k}`).join(",")}}`}::text[])) AS alerts`))[0];
    console.log(`  left behind: ${JSON.stringify(left)}`);
    check("⭐ zero fixture rows remain", left, { orgs: 0, ces: 0, keys: 0, partners: 0, pbs: 0, alerts: 0 });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
