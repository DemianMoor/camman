import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// DRIP STOP CONTROLS, MID-BURST, against the PREVIEW DB (card 869ency4b item 7).
//
// The drip scheduler and follow-ups only QUEUE pending stage_sends; the drain
// is what calls the provider. Before 2026-10-10 the drain never read the org
// drip switches, so "drip off" (drip_enabled=false) or "drip paused"
// (drip_paused=true) left already-queued drip rows going out. These bars run
// the REAL runStageDrain over a 200-row drip burst with an injected sender, flip
// each control after the 10th message, and assert the drain stops at the next
// batch boundary with the rest left pending.
//
// Everything runs inside transactions that are always rolled back, on a
// throwaway org that is deleted at the end.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-drip-stop-controls.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__DRIP_STOP_CONTROLS_TEST__";
const BURST = 200;
const BATCH = 50;
const FLIP_AFTER = 10;

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { runStageDrain } = await import("@/lib/sends/drain");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `dsc-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
    )).id;
    const org = sql`${orgId}::uuid`;
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused)
      VALUES (${org}, true, false)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false`);

    const brand = await one<{ id: number }>(
      sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
    );
    const prov = await one<{ id: number }>(sql`
      INSERT INTO sms_providers
        (sms_provider_id, org_id, name, adapter_code, supports_api_send, sends_enabled, send_paused,
         max_sends_per_minute, max_sends_per_24h,
         send_window_weekday_start, send_window_weekday_end,
         send_window_weekend_start, send_window_weekend_end)
      VALUES (${`p-${tag}`}, ${org}, ${`P ${tag}`}, 'txh', true, true, false,
              100000, 1000000, 0, 1439, 0, 1439) RETURNING id`);
    const phones = fictionalPhones(BURST + 2);
    await refuseIfPhonesInUse(db, phones);
    const pphone = await one<{ id: number }>(sql`
      INSERT INTO provider_phones (org_id, provider_id, phone_number, number_type, status)
      VALUES (${org}, ${prov.id}, ${phones[BURST]}, '10dlc', 'active') RETURNING id`);
    const cred = await one<{ id: number }>(sql`
      INSERT INTO provider_credentials (org_id, provider_id, api_key)
      VALUES (${org}, ${prov.id}, ${`k-${tag}`}) RETURNING id`);
    await db.execute(sql`UPDATE provider_phones SET credential_id = ${cred.id} WHERE id = ${pphone.id}`);

    const mkCampaignWithBurst = async (type: "drip" | "regular") => {
      const c = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode, brand_id)
        VALUES (${org}, ${`${type}-${tag}`}, ${`${type} ${tag}`}, 'active', ${type}, 'manual', ${brand.id})
        RETURNING id`);
      const s = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, stop_text, send_approved, sms_provider_id, provider_phone_id)
        VALUES (${org}, ${c.id}, 1, 'STOP', true, ${prov.id}, ${pphone.id}) RETURNING id`);
      return { campaignId: c.id, stageId: s.id };
    };
    const drip = await mkCampaignWithBurst("drip");
    const regular = await mkCampaignWithBurst("regular");

    for (const target of [drip, regular]) {
      for (let i = 0; i < BURST; i++) {
        const ct = await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, line_type)
          VALUES (${org}, ${phones[i]}, 'mobile')
          ON CONFLICT (org_id, phone_number) DO UPDATE SET line_type = 'mobile'
          RETURNING id`);
        await db.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
          VALUES (${org}, ${target.campaignId}, ${target.stageId}, ${ct.id}::uuid, ${phones[i]}, 'hi', 'pending')`);
      }
    }

    type Opts = Parameters<typeof runStageDrain>[1];
    type Sender = NonNullable<Opts["sendSms"]>;

    // One drain over the burst, rolled back. `flip` runs through the SAME
    // transaction after the FLIP_AFTER-th message — i.e. mid-batch, the worst
    // case: the rest of the claimed batch is already in flight.
    const drainBurst = async (
      stageId: number,
      flip: ((tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) | null,
      before?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>,
    ) => {
      let res: Awaited<ReturnType<typeof runStageDrain>> | null = null;
      let counts = { sent: 0, pending: 0 };
      await db.transaction(async (tx) => {
        if (before) await before(tx);
        let n = 0;
        const sender: Sender = async () => {
          n++;
          if (flip && n === FLIP_AFTER) await flip(tx);
          return {
            ok: true, messageId: `T-${n}`, response: "queued", providerStatus: null,
            suppressed: false, rawBody: '{"response":"queued"}', error: null,
            status: 200, timedOut: false,
          };
        };
        res = await runStageDrain(tx, {
          stageId, sendSms: sender, batchSize: BATCH, concurrency: 10, // the production default rate (10/s)
          isEnabled: () => true, isOrgEnabled: async () => true, isOrgPaused: async () => false,
        });
        counts = (await tx.execute(sql`
          SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
                 count(*) FILTER (WHERE status = 'pending')::int AS pending
          FROM stage_sends WHERE stage_id = ${stageId}`))[0] as unknown as typeof counts;
        throw new Error("__ROLLBACK__");
      }).catch((e) => {
        if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
      });
      return { res: res!, ...counts };
    };

    const stoppedAtBoundary = (r: { sent: number; pending: number }) =>
      r.sent >= FLIP_AFTER && r.sent <= BATCH && r.sent + r.pending === BURST;

    console.log(`burst of ${BURST} pending drip rows, batch ${BATCH}, control flipped after message ${FLIP_AFTER}\n`);

    const control = await drainBurst(drip.stageId, null);
    bar("S0 control: with nothing flipped the whole burst sends",
      control.sent === BURST && control.pending === 0,
      `sent ${control.sent}, pending ${control.pending}, stop ${JSON.stringify(control.res.stopReason ?? null)}`);

    const camp = await drainBurst(drip.stageId, (tx) =>
      tx.execute(sql`UPDATE campaigns SET send_paused = true WHERE id = ${drip.campaignId}`));
    bar("S1 campaign \"Pause sending\" mid-burst halts at the next batch boundary",
      stoppedAtBoundary(camp) && camp.res.stopReason === "paused",
      `sent ${camp.sent}, pending ${camp.pending}, stop ${JSON.stringify(camp.res.stopReason ?? null)}`);

    const off = await drainBurst(drip.stageId, (tx) =>
      tx.execute(sql`UPDATE org_settings SET drip_enabled = false WHERE org_id = ${org}`));
    bar("S2 ⭐ org drip posture OFF mid-burst halts at the next batch boundary",
      stoppedAtBoundary(off) && off.res.stopReason === "drip_halted",
      `sent ${off.sent}, pending ${off.pending}, stop ${JSON.stringify(off.res.stopReason ?? null)}`);

    const paused = await drainBurst(drip.stageId, (tx) =>
      tx.execute(sql`UPDATE org_settings SET drip_paused = true WHERE org_id = ${org}`));
    bar("S3 ⭐ org drip PAUSED mid-burst halts at the next batch boundary",
      stoppedAtBoundary(paused) && paused.res.stopReason === "drip_halted",
      `sent ${paused.sent}, pending ${paused.pending}, stop ${JSON.stringify(paused.res.stopReason ?? null)}`);

    const pre = await drainBurst(drip.stageId, null, (tx) =>
      tx.execute(sql`UPDATE org_settings SET drip_enabled = false WHERE org_id = ${org}`));
    bar("S4 drip already off before the run: refused, nothing claimed",
      !pre.res.ok && pre.res.reason === "drip_halted" && pre.sent === 0 && pre.pending === BURST,
      `ok ${pre.res.ok}, reason ${pre.res.reason}, sent ${pre.sent}`);

    const reg = await drainBurst(regular.stageId, (tx) =>
      tx.execute(sql`UPDATE org_settings SET drip_enabled = false, drip_paused = true WHERE org_id = ${org}`));
    bar("S5 a REGULAR campaign is untouched by the drip switches",
      reg.sent === BURST && reg.pending === 0,
      `sent ${reg.sent}, pending ${reg.pending}, stop ${JSON.stringify(reg.res.stopReason ?? null)}`);
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
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM sms_providers WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
