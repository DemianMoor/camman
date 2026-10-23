import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The one-shot quiet-window backfill (lib/engagement/lifecycle-backfill-oneshot)
// against a throwaway org on the PREVIEW DB, with an injected clock and a
// captured notifier (no real Telegram message is sent).
//
// Fixture: one drip send with NO stamp (the recon target) and one regular send
// stamped warm with NULL last_click_at after a human click (the lastclick
// target), both on day D.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-backfill-oneshot.ts

import { fromZonedTime } from "date-fns-tz";
import { sql, type SQL } from "drizzle-orm";

const MARKER = "__LC_ONESHOT_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { ONESHOT, plannedUnits, runLifecycleBackfillTick } = await import(
    "@/lib/engagement/lifecycle-backfill-oneshot"
  );
  const { formatInCampaignTimezone } = await import("@/lib/campaign-timezone");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const tag = `lcos-${Date.now()}`;
  const key = `lcos-test-${Date.now()}`;
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(sql`
      INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);
    const dom = await one<{ id: number }>(sql`
      INSERT INTO short_domains (org_id, brand_id, domain) VALUES (${org}, ${brand.id}, ${`${tag}.example`}) RETURNING id`);
    const dest = await one<{ id: number }>(sql`
      INSERT INTO link_destinations (org_id, url, url_hash) VALUES (${org}, 'https://example.com/x', ${`h-${tag}`}) RETURNING id`);
    const mkCamp = async (type: string) =>
      (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode, brand_id)
        VALUES (${org}, ${`c-${type}-${tag}`}, ${`C ${tag}`}, 'active', ${type}, 'tracked', ${brand.id}) RETURNING id`)).id;
    const drip = await mkCamp("drip");
    const reg = await mkCamp("regular");
    const mkStage = async (camp: number) =>
      (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text, total_cost, sms_count, opt_out_count)
        VALUES (${org}, ${camp}, 1, 'STOP', '0', 0, 0) RETURNING id`)).id;
    const dStage = await mkStage(drip);
    const rStage = await mkStage(reg);
    const phones = fictionalPhones(2);
    await refuseIfPhonesInUse(db, phones);
    const mkContact = async (p: string) =>
      (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type) VALUES (${org}, ${p}, 'mobile') RETURNING id`)).id;
    const cDrip = await mkContact(phones[0]);
    const cReg = await mkContact(phones[1]);

    const D = formatInCampaignTimezone(new Date(Date.now() - 20 * 86_400_000), "yyyy-MM-dd");
    const at = fromZonedTime(`${D}T14:00:00`, "America/New_York").toISOString();
    const mkSend = async (camp: number, stage: number, contact: string, phone: string) =>
      (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at, cost_per_sms)
        VALUES (${org}, ${camp}, ${stage}, ${contact}::uuid, ${phone}, 'hi', 'sent', ${at}::timestamptz, '0.0100')
        RETURNING id`)).id;
    const dripSend = await mkSend(drip, dStage, cDrip, phones[0]);
    const regSend = await mkSend(reg, rStage, cReg, phones[1]);
    await db.execute(sql`
      INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status) VALUES (${regSend}::uuid, ${org}, 'warm')`);
    const link = (await one<{ id: number }>(sql`
      INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id, contact_id, send_token, campaign_tracking_id, stage_tracking_id)
      VALUES (${org}, ${`${tag}-l`}, ${dom.id}, ${dest.id}, ${reg}, ${rStage}, ${cReg}::uuid, ${`t-${tag}`}, ${`ct-${tag}`}, ${`st-${tag}`}) RETURNING id`)).id;
    const clickAt = new Date(Date.parse(at) - 45 * 86_400_000).toISOString(); // 45 days before ⇒ Warm 31–60
    await db.execute(sql`
      INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at)
      VALUES (${org}, ${link}, ${clickAt}::timestamptz, 'human', ${clickAt}::timestamptz)`);

    const W = new Date("2030-01-01T05:00:00Z");
    const cfg = {
      ...ONESHOT,
      key,
      orgId,
      windowStart: W,
      stopStarting: new Date(W.getTime() + 75 * 60_000),
      windowEnd: new Date(W.getTime() + 80 * 60_000),
      reconFrom: D,
      reconTo: D,
      rollupFrom: D,
      rollupTo: D,
      reportFrom: D,
      reportTo: D,
    };
    const sent: string[] = [];
    const notify = async (t: string) => {
      sent.push(t);
      return true;
    };
    const tick = (now: Date, over: Partial<typeof cfg> = {}) =>
      runLifecycleBackfillTick({ db, orgId, now: () => now, notify, cfg: { ...cfg, ...over } });

    console.log("PART W — the window");
    const early = await tick(new Date(W.getTime() - 60_000));
    bar("W1 a tick before the window does nothing", early.state === "outside_window" && sent.length === 0);

    console.log("\nPART R — resumable units");
    const stalled = await tick(W, { tickBudgetMs: -1 });
    bar("R1 a tick whose budget is spent starts no unit, but announces the start",
      stalled.state === "progress" && stalled.ranUnits.length === 0 && sent.length === 1 && sent[0].startsWith("▶️"),
      `${stalled.state}, ran ${stalled.ranUnits.length}, msgs ${sent.length}`);
    const full = await tick(new Date(W.getTime() + 5 * 60_000));
    bar("R2 the next tick runs every remaining unit and completes",
      full.state === "complete" && full.ranUnits.length === plannedUnits(cfg).length,
      `${full.state}, ran ${full.ranUnits.join(",")}`);
    bar("R3 …and the start line was NOT sent twice", sent.filter((s) => s.startsWith("▶️")).length === 1);

    const stamp = await one<{ status: string; reconstructed: boolean } | undefined>(sql`
      SELECT status, reconstructed FROM stage_send_lifecycle WHERE stage_send_id = ${dripSend}::uuid`);
    bar("R4 ⭐ the unstamped drip send now has a reconstructed stamp",
      !!stamp && stamp.reconstructed === true, JSON.stringify(stamp));
    const lca = await one<{ lca: string | null }>(sql`
      SELECT last_click_at::text AS lca FROM stage_send_lifecycle WHERE stage_send_id = ${regSend}::uuid`);
    bar("R5 ⭐ the warm stamp got its last human click time",
      lca.lca !== null && Date.parse(lca.lca) === Date.parse(clickAt), `${lca.lca}`);
    const cells = (await db.execute(sql`
      SELECT campaign_kind, cohort, sends FROM lifecycle_day_rollup
      WHERE org_id = ${org} AND et_day = ${D}::date ORDER BY 1, 2`)) as unknown as {
      campaign_kind: string; cohort: string; sends: number;
    }[];
    bar("R6 ⭐ the rollup was recomputed: drip cell + regular Warm 31–60 cell, no Unclassified",
      cells.some((c) => c.campaign_kind === "drip") &&
        cells.some((c) => c.campaign_kind === "regular" && c.cohort === "warm_31_60") &&
        !cells.some((c) => c.cohort === "__unclassified__"),
      JSON.stringify(cells));

    console.log("\nPART T — the Telegram line");
    const done = sent.find((s) => s.startsWith("✅"));
    bar("T1 ⭐ completion sends ONE before/after line with the totals",
      !!done && /Grand total sends [\d,]+ → 2\b/.test(done) && /Drip 0 → 1\b/.test(done),
      done?.split("\n").slice(0, 2).join(" | "));
    const again = await tick(new Date(W.getTime() + 10 * 60_000));
    bar("T2 a tick after completion is a no-op and sends nothing",
      again.state === "already_finished" && sent.filter((s) => s.startsWith("✅")).length === 1);

    console.log("\nPART F — a failed Telegram send is retried, not lost");
    const key2 = `${key}-b`;
    let deliver = false;
    const sent2: string[] = [];
    const flaky = async (t: string) => {
      sent2.push(t);
      return deliver;
    };
    const t2 = (now: Date) =>
      runLifecycleBackfillTick({
        db, orgId, now: () => now, notify: flaky,
        cfg: { ...cfg, key: key2, reconFrom: D, reconTo: D },
      });
    const f1 = await t2(W);
    bar("F1 work completes even when Telegram refuses the message", f1.state === "complete");
    deliver = true;
    const f2 = await t2(new Date(W.getTime() + 5 * 60_000));
    bar("F2 ⭐ the next tick re-sends the completion line (no unit re-run)",
      f2.state === "complete" && f2.ranUnits.length === 0 && sent2.filter((s) => s.startsWith("✅")).length === 2);
    const f3 = await t2(new Date(W.getTime() + 10 * 60_000));
    bar("F3 …and once delivered, it stops", f3.state === "already_finished");

    console.log("\nPART I — the window closes before the work does");
    const key3 = `${key}-c`;
    const sent3: string[] = [];
    const late = (now: Date) =>
      runLifecycleBackfillTick({
        db, orgId, now: () => now, notify: async (t) => { sent3.push(t); return true; },
        cfg: { ...cfg, key: key3 },
      });
    const i1 = await late(new Date(cfg.windowEnd.getTime() + 60_000));
    bar("I1 ⭐ past the window with work left ⇒ ONE 'INCOMPLETE' line, no unit run",
      i1.state === "incomplete" && i1.ranUnits.length === 0 && sent3.length === 1 && sent3[0].includes("INCOMPLETE"));
    const i2 = await late(new Date(cfg.windowEnd.getTime() + 6 * 60_000));
    bar("I2 …and only once", i2.state === "already_finished" && sent3.length === 1);
  } finally {
    await db.execute(sql`DELETE FROM cron_locks WHERE job_name LIKE ${`${key}%`}`);
    if (orgId) {
      const name = (await one<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_send_lifecycle WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM lifecycle_day_rollup WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM cron_locks WHERE job_name LIKE ${`${key}%`})) AS n`);
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
