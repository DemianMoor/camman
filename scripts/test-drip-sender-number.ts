import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// DRIP SENDS FROM THE NUMBER THE SCHEDULER PICKED, against the PREVIEW DB.
//
// The drip scheduler picks a number per message from the campaign's "Sending
// numbers" pool and stamps it on stage_sends.provider_phone_id. Until 2026-11-10
// the drain ignored that stamp and sent every row from the STAGE's number
// (prod: ~112K drip sends recorded under a number that never sent them — Text
// Request's own record showed dashboard_phone = the stage's number). These bars
// drive the real selector and the real drain with an injected sender and assert
// which number, and which account, each row goes out from.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-drip-sender-number.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__DRIP_SENDER_NUMBER_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { runStageDrain, runStageDrainAllScopes, drainScopesForStage } = await import("@/lib/sends/drain");
  const { selectDrainableStages } = await import("@/lib/sends/scheduled");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];

  const tag = `dsn-${Date.now()}`;
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused) VALUES (${org}, true, false)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false`);
    const brand = await one<{ id: number }>(
      sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);

    const phones = fictionalPhones(14);
    await refuseIfPhonesInUse(db, phones);
    const mkProvider = async (k: string) => {
      const p = await one<{ id: number }>(sql`
        INSERT INTO sms_providers
          (sms_provider_id, org_id, name, adapter_code, supports_api_send, sends_enabled, send_paused,
           max_sends_per_minute, max_sends_per_24h,
           send_window_weekday_start, send_window_weekday_end, send_window_weekend_start, send_window_weekend_end)
        VALUES (${`${k}-${tag}`}, ${org}, ${`${k} ${tag}`}, 'txh', true, true, false,
                100000, 1000000, 0, 1439, 0, 1439) RETURNING id`);
      const c = await one<{ id: number }>(sql`
        INSERT INTO provider_credentials (org_id, provider_id, api_key)
        VALUES (${org}, ${p.id}, ${`key-${k}-${tag}`}) RETURNING id`);
      return { id: p.id, credId: c.id, key: `key-${k}-${tag}` };
    };
    const p1 = await mkProvider("p1");
    const p2 = await mkProvider("p2"); // a SECOND account — a pool number may sit on one
    const mkPhone = async (prov: { id: number; credId: number }, num: string) =>
      (await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, number_type, status, credential_id)
        VALUES (${org}, ${prov.id}, ${num}, 'toll_free', 'active', ${prov.credId}) RETURNING id`)).id;
    // A = the stage's number (the old, wrong sender). B, C = pool numbers on the
    // same account; D = a pool number on another account.
    const num = { A: phones[10], B: phones[11], C: phones[12], D: phones[13] };
    const A = await mkPhone(p1, num.A);
    const B = await mkPhone(p1, num.B);
    const C = await mkPhone(p1, num.C);
    const Dp = await mkPhone(p2, num.D);

    const mkStage = async (type: "drip" | "regular") => {
      const c = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode, brand_id)
        VALUES (${org}, ${`${type}-${tag}`}, ${`${type} ${tag}`}, 'active', ${type}, 'tracked', ${brand.id})
        RETURNING id`);
      const s = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, stop_text, send_approved, sms_provider_id, provider_phone_id,
           materialized_at, sent_at, drip_active)
        VALUES (${org}, ${c.id}, 1, 'STOP', true, ${p1.id}, ${A}, now(), now() - interval '10 minutes',
                ${type === "drip" ? true : null}) RETURNING id`);
      return { campaignId: c.id, stageId: s.id };
    };
    let i = 0;
    const queue = async (t: { campaignId: number; stageId: number }, phoneId: number | null) => {
      const to = phones[i++];
      const ct = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type) VALUES (${org}, ${to}, 'mobile') RETURNING id`);
      await db.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, provider_phone_id)
        VALUES (${org}, ${t.campaignId}, ${t.stageId}, ${ct.id}::uuid, ${to}, 'hi STOP', 'pending', ${phoneId})`);
      return to;
    };

    const drip = await mkStage("drip");
    // recipient → the number it must go out from
    const expect = new Map<string, string>();
    for (const [pid, from] of [[B, num.B], [B, num.B], [B, num.B], [C, num.C], [C, num.C], [Dp, num.D]] as const)
      expect.set(await queue(drip, pid), from);
    expect.set(await queue(drip, null), num.A); // unstamped row ⇒ the stage's own number

    const regular = await mkStage("regular");
    const regularTo = [await queue(regular, B), await queue(regular, null)];

    // ── selector ───────────────────────────────────────────────────────────
    const units = await selectDrainableStages(db, { now: new Date(), maxStages: 50, orgId });
    const dripUnits = units.filter((u) => Number(u.stage_id) === drip.stageId);
    const regUnits = units.filter((u) => Number(u.stage_id) === regular.stageId);
    const scopes = dripUnits.map((u) => Number(u.phone_scope)).sort((a, b) => a - b);
    bar("U1 ⭐ a drip stage yields one drain unit per number on its pending rows",
      JSON.stringify(scopes) === JSON.stringify([A, B, C, Dp].sort((a, b) => a - b)), JSON.stringify(scopes));
    bar("U2 each drip unit's phone (the lease key) and provider are the NUMBER's",
      dripUnits.every((u) => Number(u.provider_phone_id) === Number(u.phone_scope)) &&
        Number(dripUnits.find((u) => Number(u.phone_scope) === Dp)?.provider_id) === p2.id &&
        Number(dripUnits.find((u) => Number(u.phone_scope) === B)?.provider_id) === p1.id,
      JSON.stringify(dripUnits.map((u) => [u.phone_scope, u.provider_phone_id, u.provider_id])));
    bar("U3 a regular stage stays ONE unscoped unit on its own number",
      regUnits.length === 1 && regUnits[0].phone_scope == null && Number(regUnits[0].provider_phone_id) === A,
      JSON.stringify(regUnits.map((u) => [u.phone_scope, u.provider_phone_id])));
    const s2 = await drainScopesForStage(db, drip.stageId);
    bar("U4 the manual-route scopes match the selector's",
      JSON.stringify([...s2].sort((a, b) => Number(a) - Number(b))) === JSON.stringify(scopes), JSON.stringify(s2));
    bar("U5 a regular stage's manual-route scope is [null]",
      JSON.stringify(await drainScopesForStage(db, regular.stageId)) === "[null]");

    // ── drain ──────────────────────────────────────────────────────────────
    const sent: { to: string; from: string | null | undefined; key: string }[] = [];
    let n = 0;
    const sender: NonNullable<Parameters<typeof runStageDrain>[1]["sendSms"]> = async (p) => {
      sent.push({ to: p.number, from: p.senderNumber, key: p.apiKey });
      n++;
      return {
        ok: true, messageId: `T-${n}`, response: "queued", providerStatus: null, suppressed: false,
        rawBody: '{"response":"queued"}', error: null, status: 200, timedOut: false,
      };
    };
    const gates = { isEnabled: () => true, isOrgEnabled: async () => true, isOrgPaused: async () => false };

    const bad = await runStageDrain(db, { stageId: drip.stageId, sendSms: sender, ...gates, phoneScope: 2147480000 });
    bar("D0 a scope that is not one of the org's numbers is refused, nothing sent",
      !bad.ok && bad.reason === "no_provider" && sent.length === 0, `ok ${bad.ok}, reason ${bad.reason}`);

    const r = await runStageDrainAllScopes(db, { stageId: drip.stageId, sendSms: sender, ...gates, concurrency: 1 });
    const wrong = [...expect].filter(([to, from]) => sent.find((s) => s.to === to)?.from !== from);
    bar("D1 ⭐ every drip row goes out from the number stamped on it (unstamped ⇒ stage's number)",
      sent.length === expect.size && wrong.length === 0,
      `sent ${sent.length}/${expect.size}, wrong ${JSON.stringify(wrong)}, got ${JSON.stringify(sent.map((s) => [s.to.slice(-4), s.from?.slice(-4)]))}`);
    const dTo = [...expect].find(([, from]) => from === num.D)![0];
    bar("D2 the other-account number sends with ITS account's key",
      sent.find((s) => s.to === dTo)?.key === p2.key &&
        sent.filter((s) => s.to !== dTo).every((s) => s.key === p1.key));
    bar("D3 summed result: ok, all processed, nothing left pending",
      r.ok && r.sent === expect.size && r.processed === expect.size && r.remaining === 0,
      JSON.stringify({ ok: r.ok, sent: r.sent, processed: r.processed, remaining: r.remaining }));
    const stamped = await all<{ phone: string; provider_phone_id: number | null; status: string }>(sql`
      SELECT phone, provider_phone_id, status FROM stage_sends WHERE stage_id = ${drip.stageId}`);
    bar("D4 rows stay stamped with the number that sent them",
      stamped.every((s) => s.status === "sent") &&
        stamped.filter((s) => s.provider_phone_id === B).length === 3 &&
        stamped.filter((s) => s.provider_phone_id === Dp).length === 1);

    sent.length = 0;
    const rr = await runStageDrainAllScopes(db, { stageId: regular.stageId, sendSms: sender, ...gates, concurrency: 1 });
    bar("R1 a REGULAR stage is unchanged: every row from the stage's number, whatever is stamped",
      rr.ok && sent.length === 2 && sent.every((s) => s.from === num.A) &&
        regularTo.every((to) => sent.some((s) => s.to === to)),
      JSON.stringify(sent.map((s) => [s.to.slice(-4), s.from?.slice(-4)])));
  } finally {
    if (orgId) {
      const name = (await all<{ name: string }>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker (${JSON.stringify(name)})`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM provider_phones WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "All checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
