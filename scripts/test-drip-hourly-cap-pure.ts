// Pure unit test — no DB.  npx tsx scripts/test-drip-hourly-cap-pure.ts
import {
  backlogRoom, hourStartOf, inAnyWindow, minutesIntoHour, MISSED_HOUR_CLOSE_REASON,
  orderForHour, planHourEnd,
} from "@/lib/drip/hourly-cap";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const at = (iso: string) => new Date(iso);

// hour key
bar("P1 hourStartOf truncates to the UTC hour",
  hourStartOf(at("2026-10-13T14:37:12.345Z")).toISOString() === "2026-10-13T14:00:00.000Z");
// 2026-11-01 fall-back: 01:30 EDT = 05:30Z, 01:30 EST = 06:30Z — two distinct hours
bar("P2 DST fall-back: the two 01:xx ET hours stay distinct",
  hourStartOf(at("2026-11-01T05:30:00Z")).getTime() !== hourStartOf(at("2026-11-01T06:30:00Z")).getTime());
bar("P3 minutesIntoHour", Math.abs(minutesIntoHour(at("2026-10-13T14:15:30Z")) - 15.5) < 1e-9);

// window test (ET; 2026-10-13 is EDT = UTC-4). Window 09:00–18:00 ET = 540–1080.
const w = [{ stage_id: 1, window_start_min: 540, window_end_min: 1080 }];
bar("P4 09:00 ET is inside (half-open start)", inAnyWindow(at("2026-10-13T13:00:00Z"), w));
bar("P5 18:00 ET is outside (half-open end)", !inAnyWindow(at("2026-10-13T22:00:00Z"), w));
bar("P6 08:59 ET is outside", !inAnyWindow(at("2026-10-13T12:59:00Z"), w));

// backlog room
const c = (s: number, f: number, b: number, q: number) =>
  ({ sentInHour: s, freshUnsentInHour: f, backlogUnsentInHour: b, queuedUnsent: q });
bar("P7 OFF at :30, cap 60, nothing yet ⇒ paced to 30",
  backlogRoom({ cap: 60, carry: false, counts: c(0, 0, 0, 0), minutesIntoHour: 30 }) === 30);
bar("P8 OFF fresh pending take room first",
  backlogRoom({ cap: 60, carry: false, counts: c(10, 45, 0, 0), minutesIntoHour: 59 }) === 5);
bar("P9 OFF released-but-unsent backlog counts against pacing",
  backlogRoom({ cap: 60, carry: false, counts: c(0, 0, 30, 0), minutesIntoHour: 30 }) === 0);
bar("P10 OFF at :00 still releases ceil(cap/60)",
  backlogRoom({ cap: 120, carry: false, counts: c(0, 0, 0, 0), minutesIntoHour: 0 }) === 2);
bar("P11 ON: cap − sent − everything assigned, no pacing",
  backlogRoom({ cap: 100, carry: true, counts: c(20, 10, 5, 30), minutesIntoHour: 1 }) === 35);
bar("P12 never negative",
  backlogRoom({ cap: 10, carry: true, counts: c(20, 0, 0, 0), minutesIntoHour: 1 }) === 0);

// hour-end plan
const f = (id: string, min: number, blocked = false) =>
  ({ journeyId: id, routedAt: at(`2026-10-13T14:${String(min).padStart(2, "0")}:00Z`), blocked });
const p1 = planHourEnd({ cap: 3, sentInHour: 3, backlogSentInHour: 2,
  freshUnsent: [f("a", 1), f("b", 2), f("c", 3), f("d", 4), f("x", 5, true)] });
bar("P13 newest min(U,B) demoted",
  JSON.stringify(p1.demote) === JSON.stringify(["c", "d"]), JSON.stringify(p1.demote));
bar("P14 oldest dropped as cap, blocked dropped as blocked",
  JSON.stringify(p1.drop) === JSON.stringify([
    { journeyId: "x", cause: "blocked" }, { journeyId: "a", cause: "cap" }, { journeyId: "b", cause: "cap" },
  ]), JSON.stringify(p1.drop));
const p2 = planHourEnd({ cap: 10, sentInHour: 4, backlogSentInHour: 0, freshUnsent: [f("a", 1)] });
bar("P15 below cap ⇒ cause closed", p2.drop.length === 1 && p2.drop[0].cause === "closed" && p2.demote.length === 0);
bar("P16 close reasons", MISSED_HOUR_CLOSE_REASON.cap === "missed_hour_cap" &&
  MISSED_HOUR_CLOSE_REASON.closed === "missed_hour_closed" &&
  MISSED_HOUR_CLOSE_REASON.blocked === "missed_hour_blocked");

// ordering
const r = (id: string, hour: string | null, fresh: boolean | null, routed: string) =>
  ({ journey_id: id, hour_start: hour, hour_fresh: fresh, routed_at: routed });
const rows = [
  r("fresh15", "2026-10-13T15:00:00Z", true, "2026-10-13T15:05:00Z"),
  r("back15", "2026-10-13T15:00:00Z", false, "2026-10-12T23:00:00Z"),
  r("queue14", "2026-10-13T14:00:00Z", true, "2026-10-13T14:30:00Z"),
];
bar("P17 ON: queue first (hour), then routed_at",
  orderForHour(rows, true).map((x) => x.journey_id).join() === "queue14,back15,fresh15");
bar("P18 OFF: fresh first, then backlog",
  orderForHour(rows.slice(0, 2), false).map((x) => x.journey_id).join() === "fresh15,back15");

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
