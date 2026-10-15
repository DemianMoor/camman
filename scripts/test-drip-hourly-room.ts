// scripts/test-drip-hourly-room.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { prepareHourly } from "@/lib/drip/hourly-maintenance";
import { hourCommitted, hourFullness, loadHourCounts, loadOpenWindowCampaigns } from "@/lib/drip/hourly-room";
import { makeFixture } from "./_drip-hourly-fixture";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-room.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const Z = (iso: string) => new Date(iso);

// G1 — the hour-count SQL shapes: first sends counted in an hour range, and FILTER-counts on hour_start.
export const HOUR_COUNT_SHAPES = [
  /first_send_at\s*>=\s*\$\{[^}]*(hour|from|\bh\b)/i,
  /FILTER\s*\(\s*WHERE[^)]*hour_start\s*(=|<)\s*\$\{/i,
];
// funnel.ts:~317 is the dashboard's own display query (different semantics: waiting/oldest), not a decision path.
const G1_EXEMPT = new Set(["hourly-room.ts", "funnel.ts"]);
const offenders = (files: Record<string, string>) =>
  Object.entries(files).filter(([f, src]) => !G1_EXEMPT.has(f) && HOUR_COUNT_SHAPES.some((re) => re.test(src))).map(([f]) => f);

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  // P — pure
  const c4 = { sentH: 2, assigned: 1, queued: 3, pendingFresh: 4 };
  bar("P1 committed = 10", hourCommitted(c4) === 10);
  const f10 = hourFullness(10, c4);
  bar("P2 full at cap", f10.full && f10.committed === 10 && f10.detail === "hour full (10/10 this hour)", JSON.stringify(f10));
  const f11 = hourFullness(11, c4);
  bar("P3 not full under cap", !f11.full && f11.detail === null);

  // G1 — source guard, real tree + provable-red mutation
  const dir = join(process.cwd(), "lib", "drip");
  const real: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) real[f] = readFileSync(join(dir, f), "utf8");
  bar("G1a real tree has no re-derivation outside hourly-room.ts", offenders(real).length === 0, offenders(real).join(","));
  const mutSent = { ...real, "hourly-maintenance.ts": real["hourly-maintenance.ts"] +
    "\nconst x = sql`SELECT count(*) FROM drip_journeys j WHERE j.first_send_at >= ${hour.toISOString()}::timestamptz`;" };
  const mutAssigned = { ...real, "routing.ts": "sql`count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz)`" };
  const mutQueued = { ...real, "x.ts": "sql`count(*) FILTER (WHERE j.hour_start < ${h}::timestamptz)`" };
  bar("G1b guard goes red on a re-derived sent-in-hour count", offenders(mutSent).includes("hourly-maintenance.ts"));
  bar("G1c guard goes red on a re-derived assigned/queued count",
    offenders(mutAssigned).includes("routing.ts") && offenders(mutQueued).includes("x.ts"));
  bar("G1d room module itself matches the shapes (guard is aimed at the right code)",
    HOUR_COUNT_SHAPES.every((re) => re.test(real["hourly-room.ts"])));

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
    const windows = (await loadOpenWindowCampaigns(db, { campaignIds: [camp, idle] }));
    bar("D0 open windows per campaign", windows.get(camp)?.length === 1 && windows.get(idle)?.length === 1);
    const counts = await loadHourCounts(db, { campaigns: [{ id: camp, windows: windows.get(camp)! }, { id: idle, windows: [] }], hourStart: H });
    const c = counts.get(camp)!;
    bar("D1 counts", c.sentH === 2 && c.assigned === 1 && c.queued === 2 && c.pendingFresh === 3, JSON.stringify(c));
    bar("D1b campaign without rows gets zeros", JSON.stringify(counts.get(idle)) === JSON.stringify({ sentH: 0, assigned: 0, queued: 0, pendingFresh: 0 }));
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
