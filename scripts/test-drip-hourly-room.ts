// scripts/test-drip-hourly-room.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { prepareHourly } from "@/lib/drip/hourly-maintenance";
import { hourCommitted, hourFullness, loadAssignedSplit, loadHourCounts, loadFirstSendWindows } from "@/lib/drip/hourly-room";
import { makeFixture } from "./_drip-hourly-fixture";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-room.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const Z = (iso: string) => new Date(iso);

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  // P — pure
  const c4 = { sentH: 2, assigned: 1, queued: 3, pendingFresh: 4 };
  bar("P1 committed = 10", hourCommitted(c4) === 10);
  const f10 = hourFullness(10, c4);
  bar("P2 full at cap", f10.full && f10.committed === 10 && f10.detail === "hour full (10/10 this hour)", JSON.stringify(f10));
  const f11 = hourFullness(11, c4);
  bar("P3 not full under cap", !f11.full && f11.detail === null);

  // D — DB
  const fx = await makeFixture();
  try {
    const H = Z("2026-10-13T18:00:00Z");
    const camp = await fx.campaign("room", 5, true);
    const idle = await fx.campaign("idle", 5, true);
    // window 14:00–14:30 ET so a lead routed 18:40Z is in H but outside every window
    await db.execute(sql`UPDATE campaign_stages SET window_start_min = 840, window_end_min = 870 WHERE campaign_id = ${camp}`);
    const setHour = async (ids: string[], hour: Date) => db.execute(sql`
      UPDATE drip_journeys SET hour_start = ${hour.toISOString()}::timestamptz, hour_fresh = false
      WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
    const sent = await fx.journeys(camp, 2, Z("2026-10-13T17:00:00Z"));
    await fx.markSent(sent, Z("2026-10-13T18:05:00Z"));
    await setHour(await fx.journeys(camp, 1, Z("2026-10-13T17:10:00Z")), H);
    await setHour(await fx.journeys(camp, 2, Z("2026-10-13T17:20:00Z")), Z("2026-10-13T17:00:00Z"));
    await fx.journeys(camp, 3, Z("2026-10-13T18:10:00Z"));      // pending, in window
    await fx.journeys(camp, 1, Z("2026-10-13T18:40:00Z"));      // routed in H, outside window
    const windows = (await loadFirstSendWindows(db, { campaignIds: [camp, idle] }));
    bar("D0 open windows per campaign", windows.get(camp)?.length === 1 && windows.get(idle)?.length === 1);
    const counts = await loadHourCounts(db, { campaigns: [{ id: camp, windows: windows.get(camp)! }, { id: idle, windows: [] }], hourStart: H });
    const c = counts.get(camp)!;
    bar("D1 counts", c.sentH === 2 && c.assigned === 1 && c.queued === 2 && c.pendingFresh === 3, JSON.stringify(c));
    bar("D1b campaign without rows gets zeros", JSON.stringify(counts.get(idle)) === JSON.stringify({ sentH: 0, assigned: 0, queued: 0, pendingFresh: 0 }));
    const split = await loadAssignedSplit(db, camp, H);
    bar("D1d fresh + backlog === assigned", split.fresh + split.backlog === c.assigned && c.assigned === 1, JSON.stringify(split));
    const noWin = (await loadHourCounts(db, { campaigns: [{ id: camp, windows: [] }], hourStart: H })).get(camp)!;
    bar("D1c no windows ⇒ pendingFresh 0", noWin.pendingFresh === 0);

    const before = hourCommitted(c);
    const r = await prepareHourly(db, {
      orgId: fx.orgId, now: Z("2026-10-13T18:10:30Z"), notify: async () => undefined,
      deps: { hasHeadroom: async () => true },
    });
    const after = (await loadHourCounts(db, { campaigns: [{ id: camp, windows: windows.get(camp)! }], hourStart: H })).get(camp)!;
    bar("D2a room = cap − sentH", r.rooms.get(camp)?.room === 5 - c.sentH, JSON.stringify(r.rooms.get(camp)));
    bar("D2b pending became assigned", after.pendingFresh === 0 && after.assigned === 4, JSON.stringify(after));
    bar("D2c committed unchanged by assignFresh", hourCommitted(after) === before, `${before} → ${hourCommitted(after)}`);
  } finally {
    const left = await fx.teardown();
    bar("teardown leaves nothing", left === 0, String(left));
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
