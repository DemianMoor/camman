// scripts/test-drip-hourly-maintenance.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { clearIneligibleHourAssignments, prepareHourly } from "@/lib/drip/hourly-maintenance";
import { makeFixture } from "./_drip-hourly-fixture";

// node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const Z = (iso: string) => new Date(iso);

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const fx = await makeFixture();
  const alerts: string[] = [];
  const run = (now: Date, hasHeadroom = true) => prepareHourly(db, {
    orgId: fx.orgId, now,
    notify: async (key) => { alerts.push(key); },
    deps: { hasHeadroom: async () => hasHeadroom },
  });
  try {
    // H2 — OFF, cap 3: 9 fresh in 18:00Z hour, 3 sent, at 19:00Z 6 dropped as cap.
    const off = await fx.campaign("off", 3, false);
    const fresh = await fx.journeys(off, 9, Z("2026-10-13T18:05:00Z"));
    const snap = async () => ((await db.execute(sql`
      SELECT count(*)::int AS n, string_agg(phone_number, ',' ORDER BY phone_number) AS phones,
             md5(string_agg(to_jsonb(c)::text, '|' ORDER BY c.id)) AS h
      FROM contacts c WHERE org_id = ${fx.orgId}::uuid`)) as unknown as { n: number; phones: string; h: string }[])[0];
    const before = await snap();
    let r = await run(Z("2026-10-13T18:30:00Z"));
    bar("H2a fresh assigned to the routed hour", (await fx.states(fresh)).every((s) => s.hour_fresh === true && new Date(s.hour_start!).toISOString() === "2026-10-13T18:00:00.000Z"));
    bar("H2b room = cap", r.rooms.get(off)?.room === 3, JSON.stringify(r.rooms.get(off)));
    await fx.markSent(fresh.slice(0, 3), Z("2026-10-13T18:31:00Z"));
    r = await run(Z("2026-10-13T19:00:30Z"));
    const s2 = await fx.states(fresh.slice(3));
    bar("H2c 6 dropped missed_hour_cap", s2.every((s) => s.state === "expired" && s.close_reason === "missed_hour_cap"), JSON.stringify(r.dropped));
    bar("H2d reason.missed_hour recorded", s2.every((s) => (s.reason as { missed_hour?: { cause: string } })?.missed_hour?.cause === "cap"));
    const contacts = (await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${fx.orgId}::uuid`)) as unknown as { n: number }[];
    const after = await snap();
    bar("H2e contacts untouched (9 rows, same phones, identical full-row hash)",
      contacts[0].n === 9 && before.n === 9 && after.n === 9 && before.phones === after.phones && before.h === after.h,
      `${before.n}/${after.n}`);

    // H4 — OFF, cap 60: 180 waiting routed overnight; window opens 13:00Z (09:00 ET).
    const eve = await fx.campaign("eve", 60, false);
    const back = await fx.journeys(eve, 180, Z("2026-10-13T00:30:00Z")); // 20:30 ET the evening before
    await run(Z("2026-10-13T12:30:00Z")); // 08:30 ET — window closed
    bar("H4a outside the window nothing is assigned", (await fx.states(back)).every((s) => s.hour_start === null));
    r = await run(Z("2026-10-13T13:00:30Z")); // 09:00:30 ET
    const rel1 = (await fx.states(back)).filter((s) => s.hour_start !== null).length;
    bar("H4b released paced (ceil(60*1/60) = 1)", rel1 === 1, `released ${rel1}`);
    r = await run(Z("2026-10-13T13:30:00Z"));
    const rel2 = (await fx.states(back)).filter((s) => s.hour_start !== null).length;
    bar("H4c paced to 30 by :30", rel2 === 30, `released ${rel2}`);
    r = await run(Z("2026-10-13T14:00:30Z")); // next hour, none sent
    const s4 = await fx.states(back);
    bar("H4d backlog never dropped", s4.every((s) => s.state === "routed"), JSON.stringify(r.dropped));

    // H5 — OFF, cap 4, hour 15:00Z: backlog sent 2, fresh 5 unsent ⇒ newest 2 demoted, oldest 3 dropped.
    const mix = await fx.campaign("mix", 4, false);
    const b5 = await fx.journeys(mix, 2, Z("2026-10-13T02:00:00Z"));
    await run(Z("2026-10-13T15:00:30Z")); // releases ≤ ceil(4/60)=1 …
    await run(Z("2026-10-13T15:20:00Z")); // … then up to 2
    await fx.markSent(b5, Z("2026-10-13T15:21:00Z"));
    const f5 = await fx.journeys(mix, 5, Z("2026-10-13T15:30:00Z"));
    await run(Z("2026-10-13T15:40:00Z"));
    await run(Z("2026-10-13T16:00:30Z"));
    const s5 = await fx.states(f5);
    const byId = new Map(s5.map((s) => [s.id, s]));
    bar("H5a oldest 3 dropped (closed: 2 sent < cap 4)", f5.slice(0, 3).every((id) => byId.get(id)?.close_reason === "missed_hour_closed"));
    // Demoted = waiting; the same run may already have re-released them as backlog (hour_fresh false).
    bar("H5b newest 2 demoted, not dropped", f5.slice(3).every((id) => {
      const s = byId.get(id);
      return s?.state === "routed" && (s.hour_start === null || s.hour_fresh === false);
    }));

    // H6 — pause mid-hour, resume next hour ⇒ zero drops.
    const pz = await fx.campaign("pz", 2, false);
    const p6 = await fx.journeys(pz, 5, Z("2026-10-13T17:10:00Z"));
    await run(Z("2026-10-13T17:15:00Z"));
    await db.execute(sql`UPDATE campaigns SET send_paused = true WHERE id = ${pz}`);
    await clearIneligibleHourAssignments(db);
    await db.execute(sql`UPDATE campaigns SET send_paused = false WHERE id = ${pz}`);
    await run(Z("2026-10-13T18:00:30Z"));
    bar("H6a pause reverts, nothing dropped", (await fx.states(p6)).every((s) => s.state === "routed"));
    // org-level pause
    await run(Z("2026-10-13T18:05:00Z"));
    const p6b = await fx.journeys(pz, 3, Z("2026-10-13T18:06:00Z"));
    await run(Z("2026-10-13T18:07:00Z"));
    await db.execute(sql`UPDATE org_settings SET drip_paused = true WHERE org_id = ${fx.orgId}::uuid`);
    await clearIneligibleHourAssignments(db);
    await db.execute(sql`UPDATE org_settings SET drip_paused = false WHERE org_id = ${fx.orgId}::uuid`);
    await run(Z("2026-10-13T19:00:30Z"));
    bar("H6b org drip_paused reverts, nothing dropped", (await fx.states(p6b)).every((s) => s.state === "routed"));
    // number exhaustion
    const p6c = await fx.journeys(pz, 2, Z("2026-10-13T19:10:00Z"));
    await run(Z("2026-10-13T19:11:00Z"), false);
    await run(Z("2026-10-13T20:00:30Z"));
    bar("H6c exhaustion reverts, nothing dropped", (await fx.states(p6c)).every((s) => s.state === "routed"));

    // H6d — a stop control at the hour rollover must never drop.
    const sd = await fx.campaign("sd", 2, false);
    const d6 = await fx.journeys(sd, 4, Z("2026-10-14T14:05:00Z"));
    await run(Z("2026-10-14T14:11:00Z")); // headroom true ⇒ assigned to 14:00Z
    bar("H6d-0 fresh assigned", (await fx.states(d6)).every((s) => s.hour_fresh === true));
    await run(Z("2026-10-14T15:00:30Z"), false); // rollover, no headroom
    const d6a = await fx.states(d6);
    bar("H6d-1 no headroom at rollover: none dropped, reverted to waiting",
      d6a.every((s) => s.state === "routed" && s.hour_start === null));
    await run(Z("2026-10-14T15:05:00Z"));
    bar("H6d-2 later run with headroom: still none dropped", (await fx.states(d6)).every((s) => s.state === "routed"));

    // H6e — prepareHourly alone (no clearIneligibleHourAssignments) is safe under send_paused.
    const se = await fx.campaign("se", 2, false);
    const e6 = await fx.journeys(se, 4, Z("2026-10-15T14:05:00Z"));
    await run(Z("2026-10-15T14:11:00Z"));
    await db.execute(sql`UPDATE campaigns SET send_paused = true WHERE id = ${se}`);
    await run(Z("2026-10-15T15:00:30Z"));
    bar("H6e send_paused at rollover: none dropped", (await fx.states(e6)).every((s) => s.state === "routed"));

    // H5c — R1: backlog first-sends count in the hour they were SENT in, whatever hour they were released into.
    const bk = await fx.campaign("bk", 4, false);
    const X = Z("2026-10-14T18:00:00Z");
    const [bkb] = await fx.journeys(bk, 1, Z("2026-10-13T02:00:00Z"));
    const f5c = await fx.journeys(bk, 4, Z("2026-10-14T18:05:00Z"));
    await run(Z("2026-10-14T18:11:00Z")); // assigns the 4 fresh to X
    await fx.markSent(f5c.slice(0, 3), Z("2026-10-14T18:15:00Z"));
    await fx.markSent([bkb], new Date(X.getTime() + 2000));
    await db.execute(sql`UPDATE drip_journeys SET hour_start = ${new Date(X.getTime() - 3600_000).toISOString()}::timestamptz,
      hour_fresh = false WHERE id = ${bkb}::uuid`);
    await run(Z("2026-10-14T19:00:30Z"));
    const s5c = (await fx.states([f5c[3]]))[0];
    bar("H5c fresh lead demoted (backlog sent at :00 counted), not dropped", s5c.state === "routed", `${s5c.state}/${s5c.close_reason}`);

    // H12 — gate/mint refusal inside the hour ⇒ missed_hour_blocked + one alert per hour.
    const bl = await fx.campaign("bl", 5, false);
    const j12 = await fx.journeys(bl, 2, Z("2026-10-13T20:10:00Z"));
    await run(Z("2026-10-13T20:11:00Z"));
    const { recordSendRefusal } = await import("@/lib/drip/hourly-maintenance");
    await recordSendRefusal(db, { journeyId: j12[0], kind: "mint", now: Z("2026-10-13T20:12:00Z") });
    alerts.length = 0;
    await run(Z("2026-10-13T21:00:30Z"));
    const s12 = new Map((await fx.states(j12)).map((s) => [s.id, s]));
    bar("H12a refused lead dropped as blocked", s12.get(j12[0])?.close_reason === "missed_hour_blocked");
    bar("H12b the other as closed (0 sent < cap)", s12.get(j12[1])?.close_reason === "missed_hour_closed");
    bar("H12c exactly one alert keyed to the hour", alerts.length === 1 && alerts[0].endsWith(":2026-10-13T20:00:00.000Z"), alerts.join());

    // H11 (maintenance half) — ON: past-hour unsent stay assigned (queue), nothing dropped.
    const on = await fx.campaign("on", 2, true);
    const j11 = await fx.journeys(on, 5, Z("2026-10-13T21:05:00Z"));
    await run(Z("2026-10-13T21:06:00Z"));
    await fx.markSent(j11.slice(0, 2), Z("2026-10-13T21:07:00Z"));
    r = await run(Z("2026-10-13T22:00:30Z"));
    const s11 = await fx.states(j11.slice(2));
    bar("H11a ON keeps the queue on its old hour", s11.every((s) => s.state === "routed" && new Date(s.hour_start!).toISOString() === "2026-10-13T21:00:00.000Z"));
    bar("H11b ON room this hour = cap", r.rooms.get(on)?.room === 2);

    // R — Task 6: funnel outcome labels + hourly panel.
    const { getDripFunnel } = await import("@/lib/drip/funnel");
    const fun = await getDripFunnel(fx.orgId, off);
    bar("R1 funnel outcome row for missed_hour_cap with its label",
      fun.outcomes.some((o) => o.close_reason === "missed_hour_cap" && o.label === "Dropped — hourly cap full" && o.count === 6));
    bar("R2 funnel hourly panel present for a capped campaign", fun.hourly?.cap === 3);
    bar("R3 drops_by_day has the cap drops", (fun.hourly?.drops_by_day ?? []).reduce((s, d) => s + d.cap, 0) === 6);
    const plain = await fx.campaign("plain", null, false);
    bar("R4 no cap ⇒ hourly null", (await getDripFunnel(fx.orgId, plain)).hourly === null);
  } finally {
    const left = await fx.teardown();
    console.log(`\nTeardown: ${left} row(s) left`);
    if (left !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
