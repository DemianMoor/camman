import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import {
  diffFields,
  logDripConfigChange,
  logDripStageChange,
  readDripConfigSnapshot,
  readDripStageSnapshot,
  summarizeChanges,
} from "@/lib/drip/change-events";

// Drip settings change log (lib/drip/change-events.ts). Pure bars, then DB bars
// on the PREVIEW DB inside one transaction that is rolled back (no residue).
// The DB bars replay each route's exact sequence: lock-read → write → read → log.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-change-events.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
class Rollback extends Error {}

function pure() {
  console.log("Pure:");
  const F = ["a", "b", "f"];
  bar("P1 identical rows → no changes", Object.keys(diffFields({ a: 1, b: null }, { a: 1, b: null }, F)).length === 0);
  const d = diffFields({ a: 1, b: null }, { a: 2, b: null }, F);
  bar("P2 one change → {from,to}", JSON.stringify(d) === '{"a":{"from":1,"to":2}}', JSON.stringify(d));
  bar("P3 jsonb key order ignored",
    Object.keys(diffFields({ f: { x: 1, y: [1, 2] } }, { f: { y: [1, 2], x: 1 } }, F)).length === 0);
  bar("P4 array order matters", Object.keys(diffFields({ f: [1, 2] }, { f: [2, 1] }, F)).length === 1);
  bar("P5 missing key == null", Object.keys(diffFields({ a: 1 }, { a: 1, b: null }, F)).length === 0);
  bar("P6 no before row (created) → no changes", Object.keys(diffFields(null, { a: 1 }, F)).length === 0);
  bar("P7 field outside the list ignored", Object.keys(diffFields({ z: 1 }, { z: 2 }, F)).length === 0);
  const s = summarizeChanges({
    window_start_min: { from: 540, to: 600 },
    carry_days: { from: 0, to: 1 },
    drip_active: { from: true, to: false },
    end_at: { from: null, to: "2026-10-20T04:00:00+00:00" },
  });
  bar("P8 summary renders clock, bool, null",
    s === "window start 09:00 → 10:00; carry-over days 0 → 1; Active on → off; admission closes none → 2026-10-20T04:00:00+00:00", s);
}

async function dbBars() {
  console.log(`\nDB (${requirePreviewDb().label}, rolled back):`);
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: SQL) => ((await tx.execute(q)) as unknown as T[])[0];
      const orgId = (await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES ('__DRIP_CHANGE_EVENTS_TEST__') RETURNING id`)).id;
      const camp = async (type: "drip" | "regular") =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type)
          VALUES (${orgId}::uuid, ${"dce-" + Math.random().toString(36).slice(2, 9)}, 'DCE', 'paused', ${type})
          RETURNING id`)).id;
      const events = async (cid: number) =>
        (await tx.execute(sql`
          SELECT event_type, stage_id, summary, metadata FROM campaign_events
          WHERE campaign_id = ${cid} ORDER BY id`)) as unknown as {
          event_type: string; stage_id: number | null; summary: string; metadata: { changes: Record<string, { from: unknown; to: unknown }> };
        }[];

      const cid = await camp("drip");
      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, campaign_cap, carry_days, end_at, filters)
        VALUES (${cid}, ${orgId}::uuid, 'dce', 300, 0, '2026-10-20 00:00:00-04', '{"states":["CA","NY"]}')`);

      // A config save, exactly as PUT /drip-config does it.
      const saveConfig = async (set: SQL) => {
        const before = await readDripConfigSnapshot(tx, cid, orgId, { forUpdate: true });
        await tx.execute(sql`UPDATE drip_campaign_configs SET ${set}, updated_at = now() WHERE campaign_id = ${cid}`);
        return logDripConfigChange(tx, {
          orgId, campaignId: cid, actorUserId: null, before,
          after: await readDripConfigSnapshot(tx, cid, orgId),
        });
      };

      await saveConfig(sql`campaign_cap = 300, carry_days = 0`);
      bar("D1 no-op save (same values) → no event", (await events(cid)).length === 0);

      await saveConfig(sql`end_at = '2026-10-20 04:00:00+00'`);
      bar("D2 same instant, different text → no event", (await events(cid)).length === 0);

      await saveConfig(sql`filters = '{"states":["CA","NY"]}'::jsonb`);
      bar("D3 identical jsonb rewritten → no event", (await events(cid)).length === 0);

      await saveConfig(sql`campaign_cap = 10000, carry_days = 1, admission_cutoff_minutes = 30`);
      let ev = await events(cid);
      bar("D4 real change → exactly one drip_config_changed", ev.length === 1 && ev[0].event_type === "drip_config_changed",
        JSON.stringify(ev.map((e) => e.event_type)));
      const ch = ev[0]?.metadata?.changes ?? {};
      bar("D5 metadata lists exactly the 3 changed fields with from/to",
        Object.keys(ch).sort().join(",") === "admission_cutoff_minutes,campaign_cap,carry_days" &&
          ch.campaign_cap?.from === 300 && ch.campaign_cap?.to === 10000 &&
          ch.carry_days?.from === 0 && ch.carry_days?.to === 1 &&
          ch.admission_cutoff_minutes?.from === null && ch.admission_cutoff_minutes?.to === 30,
        JSON.stringify(ch));
      bar("D6 summary is human-readable", ev[0]?.summary.startsWith("Drip settings: ") === true, ev[0]?.summary);

      await saveConfig(sql`end_at = '2026-10-25 00:00:00-04'`);
      ev = await events(cid);
      bar("D7 admission close moved → logged as end_at", ev.length === 2 && "end_at" in (ev[1]?.metadata?.changes ?? {}),
        ev[1]?.summary);

      await saveConfig(sql`behavioral_enabled = true`);
      ev = await events(cid);
      const bc = ev[2]?.metadata?.changes ?? {};
      bar("D8 behavioural toggle (drip-followups path) → logged", ev.length === 3 &&
        Object.keys(bc).join(",") === "behavioral_enabled" &&
        bc.behavioral_enabled?.from === false && bc.behavioral_enabled?.to === true,
        JSON.stringify(bc));

      // Stage edits, exactly as the stage PATCH does it.
      const sid = (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
        VALUES (${orgId}::uuid, ${cid}, 1, 540, 1020, true) RETURNING id`)).id;
      const patchStage = async (stageId: number, campaignId: number, set: SQL) => {
        const before = await readDripStageSnapshot(tx, stageId, orgId, { forUpdate: true });
        await tx.execute(sql`UPDATE campaign_stages SET ${set} WHERE id = ${stageId}`);
        if (!before?.isDrip) return null;
        const after = await readDripStageSnapshot(tx, stageId, orgId);
        return logDripStageChange(tx, {
          orgId, campaignId, stageId, stageNumber: before.stageNumber, actorUserId: null,
          before: before.snap, after: after?.snap ?? null,
        });
      };

      await patchStage(sid, cid, sql`window_start_min = 540, window_end_min = 1020`);
      bar("D9 stage no-op → no event", (await events(cid)).length === 3);

      await patchStage(sid, cid, sql`window_start_min = 600, window_end_min = 1080, drip_active = false`);
      ev = await events(cid);
      const se = ev[3];
      bar("D10 window + Active change → one drip_stage_changed on that stage",
        ev.length === 4 && se?.event_type === "drip_stage_changed" && se?.stage_id === sid, se?.summary);
      bar("D11 stage summary", se?.summary === "Stage 1: window start 09:00 → 10:00; window end 17:00 → 18:00; Active on → off",
        se?.summary);

      // A regular campaign's stage edit must not be logged by this path.
      const rid = await camp("regular");
      const rsid = (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number) VALUES (${orgId}::uuid, ${rid}, 1) RETURNING id`)).id;
      await patchStage(rsid, rid, sql`window_start_min = 600, window_end_min = 1080`);
      bar("D12 regular-campaign stage → no drip event", (await events(rid)).length === 0);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM organizations WHERE name = '__DRIP_CHANGE_EVENTS_TEST__'`)) as unknown as { n: number }[];
  bar("D13 rolled back: no fixture org left", left[0]?.n === 0);
}

async function main() {
  pure();
  await dbBars();
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
