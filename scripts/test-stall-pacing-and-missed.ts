// Guards for three changes to send-queue watching (2026-08-28, 2026-08-29):
//
//   A. A stage held at a provider's PACING CEILING is classified `rate_24h`, not
//      `stalled`, and never raises the alarm on its own. Text Request sat at
//      30,038 against a 30,000/24h ceiling and the detector called it 3,976
//      stalled messages — "check provider health" about a queue obeying its own
//      configuration.
//   B. A stage the scheduler STOOD DOWN with messages still queued is reported —
//      the case findStalledStages excludes by construction — and is reported
//      ONCE, then re-armed when it recovers.
//   C. The stall grace runs from when a stage became ELIGIBLE TO DRAIN, not
//      from when it was materialized. Materialization is a pre-pass that runs
//      hours ahead of the send, so a stage that has only just come due had
//      already spent its whole grace and was alarm-eligible the instant it was
//      allowed to send. On 2026-08-29 the hourly cron landed in the 29-second
//      gap before the fourth of four co-due stages got its first row out, and a
//      healthy queue was reported as 2934 pending, never sent.
//
// Rolled-back tx, throwaway org, injected clock, injected notifier (no Telegram,
// no sends). Every assertion is paired with a control that proves it can fail:
// the SAME fixture with a roomy cap must come back `stalled`, and the same
// missed stage must go quiet on the second tick and audible again after recovery.
//
// Run: npx tsx scripts/test-stall-pacing-and-missed.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { findStalledStages, formatStallAlert, trulyStalled } from "@/lib/sends/stall-detector";
import { findMissedStages, reportMissedStages } from "@/lib/sends/missed-stages";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// Weekday noon ET, so the provider send window is open deterministically.
const NOW = new Date("2026-06-15T16:00:00Z");
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();
const ROLLBACK = Symbol("rollback");

async function main() {
  let n = 0;
  const uniq = () => `${Date.now()}-${n++}`;
  let pnSeq = 3_000_000;
  const mkNumber = () => `+1557${pnSeq++}`;

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const orgId = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${`sp-${uniq()}`}) RETURNING id`)).id;
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true`);
      const brandId = (await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${`b-${uniq()}`}, 'B') RETURNING id`)).id;
      const mkCampaign = async (status: string) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
          VALUES (${orgId}, ${`c-${uniq()}`}, ${brandId}, 'tracked', ${status}) RETURNING id`)).id;
      const campId = await mkCampaign("active");

      // cap24h drives the pacing verdict; the window is all-day so quiet hours
      // never interfere with what we are actually testing.
      const mkProvider = async (cap24h: number) =>
        (await one<{ id: number }>(sql`
          INSERT INTO sms_providers
            (sms_provider_id, org_id, name, supports_api_send, status, max_sends_per_24h,
             send_window_weekday_start, send_window_weekday_end,
             send_window_weekend_start, send_window_weekend_end)
          VALUES (${`p-${uniq()}`}, ${orgId}, 'P', true, 'active', ${cap24h}, 0, 1439, 0, 1439)
          RETURNING id`)).id;
      const mkPhone = async (providerId: number) =>
        (await one<{ id: number }>(sql`
          INSERT INTO provider_phones (org_id, provider_id, phone_number, max_sends_per_second)
          VALUES (${orgId}, ${providerId}, ${mkNumber()}, 60) RETURNING id`)).id;

      let stageSeq = 0;
      const mkStage = async (o: {
        providerId: number; phoneId: number; campaignId?: number;
        materializedMinsAgo?: number | null; releasedMinsAgo?: number | null;
        pending?: number; sentAtMinsAgo?: number | null; missed?: boolean;
        // Defaults to 120 min ago (long due). null = never scheduled, released by hand.
        scheduledMinsAgo?: number | null;
      }) => {
        const cid = o.campaignId ?? campId;
        const st = (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, sms_provider_id, provider_phone_id,
             send_approved, scheduled_at, materialized_at, sent_at, schedule_missed_at)
          VALUES (${orgId}, ${cid}, ${stageSeq++}, ${o.providerId}, ${o.phoneId}, true,
                  ${o.scheduledMinsAgo === undefined
                      ? iso(120)
                      : o.scheduledMinsAgo === null
                        ? null
                        : iso(o.scheduledMinsAgo)},
                  ${o.materializedMinsAgo == null ? null : iso(o.materializedMinsAgo)},
                  ${o.releasedMinsAgo == null ? null : iso(o.releasedMinsAgo)},
                  ${o.missed ? iso(60) : null})
          RETURNING id`)).id;
        for (let i = 0; i < (o.pending ?? 0); i++) {
          const c = (await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${mkNumber()}) RETURNING id`)).id;
          await tx.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
            VALUES (${orgId}, ${cid}, ${st}, ${c}, ${mkNumber()}, 'm', 'pending')`);
        }
        if (o.sentAtMinsAgo != null) {
          const c = (await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${mkNumber()}) RETURNING id`)).id;
          await tx.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
            VALUES (${orgId}, ${cid}, ${st}, ${c}, ${mkNumber()}, 'm', 'sent', ${iso(o.sentAtMinsAgo)})`);
        }
        return st;
      };

      // ── A. pacing ceiling ───────────────────────────────────────────────────
      // countSentSince counts against the DB's real now(), not the injected
      // clock, so the row that trips the ceiling is stamped now() — and it lives
      // on a DIFFERENT stage of the same provider, which is both how production
      // looks (one provider, many stages) and necessary: a fresh send on the
      // candidate itself would disqualify it from being a candidate at all.
      const capped = await mkProvider(1);
      const cappedPh = await mkPhone(capped);
      const cappedStage = await mkStage({
        providerId: capped, phoneId: cappedPh,
        materializedMinsAgo: 90, releasedMinsAgo: 90, pending: 7, sentAtMinsAgo: 60,
      });
      const volumeStage = await mkStage({
        providerId: capped, phoneId: cappedPh, materializedMinsAgo: 90, releasedMinsAgo: 90,
      });
      const vc = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${mkNumber()}) RETURNING id`)).id;
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${orgId}, ${campId}, ${volumeStage}, ${vc}, ${mkNumber()}, 'm', 'sent', now())`);

      const cappedResult = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      const cs = cappedResult.find((r) => r.stage_id === cappedStage);
      check("capped stage is still returned (visibility kept)", !!cs, JSON.stringify(cappedResult));
      check("capped stage classified rate_24h", cs?.hold === "rate_24h", `hold=${cs?.hold}`);
      check("hold_detail names the numbers", !!cs?.hold_detail?.includes("/1 in the last 24h"), `${cs?.hold_detail}`);
      check("trulyStalled() excludes it ⇒ no alarm", trulyStalled(cappedResult).length === 0,
        JSON.stringify(trulyStalled(cappedResult).map((x) => x.stage_id)));

      // CONTROL: identical fixture, roomy cap ⇒ must come back as a real stall.
      await tx.execute(sql`UPDATE sms_providers SET max_sends_per_24h = 1000000 WHERE id = ${capped}`);
      const roomy = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      const rs = roomy.find((r) => r.stage_id === cappedStage);
      check("CONTROL: roomy cap ⇒ same stage reads 'stalled'", rs?.hold === "stalled", `hold=${rs?.hold}`);
      check("CONTROL: trulyStalled() now returns it", trulyStalled(roomy).some((x) => x.stage_id === cappedStage));
      check("alert body advises provider health for a real stall",
        formatStallAlert(roomy, NOW, 30).includes("Send queue STALLED"));
      await tx.execute(sql`UPDATE sms_providers SET max_sends_per_24h = 1 WHERE id = ${capped}`);

      // A capped stage alongside a real stall must be listed, but in its own section.
      const other = await mkProvider(1000000);
      const otherPh = await mkPhone(other);
      await mkStage({ providerId: other, phoneId: otherPh, materializedMinsAgo: 90, releasedMinsAgo: 90, pending: 4, sentAtMinsAgo: 60 });
      const mixed = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      const body = formatStallAlert(mixed, NOW, 30);
      check("mixed alert separates the two", body.includes("held at a pacing ceiling"), body);
      check("mixed alert counts only real stalls in the header",
        body.includes("STALLED — 1 stage(s), 4 message(s)"), body.split("\n")[0]);

      // ── B. missed stages ────────────────────────────────────────────────────
      const mProv = await mkProvider(1000000);
      const mPh = await mkPhone(mProv);
      const missedWithRows = await mkStage({ providerId: mProv, phoneId: mPh, materializedMinsAgo: 200, pending: 9, missed: true });
      const missedNoRows = await mkStage({ providerId: mProv, phoneId: mPh, materializedMinsAgo: 200, pending: 0, missed: true });
      const completedCamp = await mkCampaign("completed");
      const missedCompleted = await mkStage({ providerId: mProv, phoneId: mPh, campaignId: completedCamp, materializedMinsAgo: 200, pending: 5, missed: true });

      const found = await findMissedStages(dbc, { orgId });
      const foundIds = new Set(found.map((f) => f.stage_id));
      check("missed stage WITH pending rows is found", foundIds.has(missedWithRows));
      check("missed stage with NO pending rows is not", !foundIds.has(missedNoRows));
      check("missed stage under a COMPLETED campaign is not", !foundIds.has(missedCompleted));
      check("pending count is carried", found.find((f) => f.stage_id === missedWithRows)?.pending === 9,
        JSON.stringify(found.map((f) => ({ id: f.stage_id, p: f.pending }))));

      const sentTexts: string[] = [];
      const fakeSend = async (t: string) => { sentTexts.push(t); return true; };
      const tick = () => reportMissedStages(dbc, { now: NOW, orgId, send: fakeSend });

      await tick();
      check("first tick notifies once", sentTexts.length === 1, `${sentTexts.length}`);
      check("alert names the stage and its queued count",
        sentTexts[0]?.includes("STOOD DOWN") && sentTexts[0]?.includes("9 message(s)"), sentTexts[0]);

      await tick();
      check("second tick is SILENT (latched, no hourly spam)", sentTexts.length === 1, `${sentTexts.length}`);

      // Recovery: the rows are cancelled (status 'rejected', the recall audit shape) ⇒ latch must re-arm, or the NEXT
      // occurrence on this stage would be silent forever.
      await tx.execute(sql`UPDATE stage_sends SET status = 'rejected' WHERE stage_id = ${missedWithRows}`);
      await tick();
      check("recovered stage sends nothing", sentTexts.length === 1, `${sentTexts.length}`);
      const stateAfter = (await tx.execute(sql`
        SELECT state FROM alert_state WHERE alert_key = ${`missed_stage:stage:${missedWithRows}`}`)) as unknown as { state: string }[];
      check("latch cleared on recovery", stateAfter[0]?.state === "ok", JSON.stringify(stateAfter));

      await tx.execute(sql`UPDATE stage_sends SET status = 'pending' WHERE stage_id = ${missedWithRows}`);
      await tick();
      check("CONTROL: recurrence is audible again", sentTexts.length === 2, `${sentTexts.length}`);

      // ── C. grace runs from eligibility, not materialization ─────────────────
      const gProv = await mkProvider(1000000);
      const gPh = await mkPhone(gProv);

      // Production shape: materialized 150 min early by the pre-pass, due 1 min
      // ago, claimed by the drain 1 min ago, not one row out yet.
      const justDue = await mkStage({
        providerId: gProv, phoneId: gPh,
        materializedMinsAgo: 150, scheduledMinsAgo: 1, releasedMinsAgo: 1, pending: 5,
      });

      // RED PROOF, anchored to a hand-written literal that does NOT move when
      // stall-detector.ts is edited: the OLD predicate (grace measured from
      // materialized_at) admits this fixture. Without it the pass below could be
      // vacuous — a fixture excluded for some unrelated reason looks identical.
      const underOldAnchor = (await tx.execute(sql`
        SELECT s.id FROM campaign_stages s
        WHERE s.id = ${justDue}
          AND s.materialized_at < ${NOW.toISOString()}::timestamptz - make_interval(mins => 30)
      `)) as unknown as { id: number }[];
      check("fixture WOULD have fired under the old materialized_at grace",
        underOldAnchor.length === 1, JSON.stringify(underOldAnchor));

      const graceRes = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      check("stage that only just came due is NOT stalled",
        !graceRes.some((r) => r.stage_id === justDue),
        JSON.stringify(graceRes.filter((r) => r.stage_id === justDue)));

      // CONTROL: same rows, same materialization — only the due/release instant
      // moves past the threshold. A stage genuinely wedged since it came due must
      // still alarm, or this fix would have blinded the detector instead.
      await tx.execute(sql`
        UPDATE campaign_stages SET scheduled_at = ${iso(45)}, sent_at = ${iso(45)}
        WHERE id = ${justDue}`);
      const graceCtl = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      check("CONTROL: due 45m ago with nothing sent ⇒ stalled",
        graceCtl.some((r) => r.stage_id === justDue && r.hold === "stalled"),
        JSON.stringify(graceCtl.map((r) => ({ id: r.stage_id, hold: r.hold }))));

      // A stage released by hand (no scheduled_at at all) takes its grace from
      // the release stamp, the same way.
      const justReleased = await mkStage({
        providerId: gProv, phoneId: gPh,
        materializedMinsAgo: 150, scheduledMinsAgo: null, releasedMinsAgo: 2, pending: 5,
      });
      const relRes = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      check("stage released 2m ago (no scheduled_at) is NOT stalled",
        !relRes.some((r) => r.stage_id === justReleased));

      await tx.execute(sql`UPDATE campaign_stages SET sent_at = ${iso(45)} WHERE id = ${justReleased}`);
      const relCtl = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      check("CONTROL: released 45m ago with nothing sent ⇒ stalled",
        relCtl.some((r) => r.stage_id === justReleased && r.hold === "stalled"),
        JSON.stringify(relCtl.map((r) => ({ id: r.stage_id, hold: r.hold }))));

      console.log("\nAll cases done. Rolling back.");
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) { console.error("\nCRASHED:", err); failed = 1; }
  } finally {
    await pgConn.end({ timeout: 5 });
  }

  if (failed) { console.log(`\nFAILED: ${failed} check(s).`); process.exit(1); }
  console.log("\ntest-stall-pacing-and-missed OK.");
}

main().catch((err) => { console.error("crashed:", err); process.exit(1); });
