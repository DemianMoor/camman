import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { db } from "@/db/client";
import { applyHourlyCarryTransition } from "@/lib/drip/hourly-maintenance";
import { dripConfigSchema } from "@/lib/validators/drip-campaigns";
import { makeFixture } from "./_drip-hourly-fixture";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  bar("V1 hourly_cap 0 rejected", !dripConfigSchema.safeParse({ interest_tag: "x", hourly_cap: 0 }).success);
  bar("V2 hourly_cap null accepted", dripConfigSchema.safeParse({ interest_tag: "x", hourly_cap: null }).success);
  bar("V3 hourly_carry boolean", dripConfigSchema.safeParse({ interest_tag: "x", hourly_carry: true }).success);

  const fx = await makeFixture();
  try {
    const on = await fx.campaign("cfg", 2, true);
    const ids = await fx.journeys(on, 3, new Date("2026-10-13T18:05:00Z"));
    const { sql } = await import("drizzle-orm");
    const cur = await fx.journeys(on, 2, new Date("2026-10-13T19:02:00Z")); // current-hour fresh leads
    await db.execute(sql`UPDATE drip_journeys SET hour_start = '2026-10-13T18:00:00Z', hour_fresh = true WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
    await db.execute(sql`UPDATE drip_journeys SET hour_start = '2026-10-13T19:00:00Z', hour_fresh = true WHERE id = ANY(${`{${cur.join(",")}}`}::uuid[])`);
    const n = await db.transaction((tx) => applyHourlyCarryTransition(tx, {
      campaignId: on, before: true, after: false, now: new Date("2026-10-13T19:10:00Z") }));
    const s = await fx.states([...ids, ...cur]);
    bar("H13 carry ON→OFF reverts ALL assigned (past + current hour) to waiting, nothing dropped",
      n === 5 && s.every((x) => x.state === "routed" && x.hour_start === null), `reverted ${n}`);
    const m = await db.transaction((tx) => applyHourlyCarryTransition(tx, {
      campaignId: on, before: false, after: false, now: new Date("2026-10-13T19:10:00Z") }));
    bar("H13b no transition ⇒ no write", m === 0);
  } finally {
    const left = await fx.teardown();
    if (left !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
