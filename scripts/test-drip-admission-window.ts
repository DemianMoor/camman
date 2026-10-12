import { fromZonedTime } from "date-fns-tz";

import {
  admissionCloses,
  effectiveWidenedAt,
  isCarried,
  scanFloor,
  type AdmissionSettings,
} from "@/lib/drip/admission-window";

// Pure — no DB. Run: npx tsx scripts/test-drip-admission-window.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const et = (s: string) => fromZonedTime(s, "America/New_York");
const S = (o: Partial<AdmissionSettings> = {}): AdmissionSettings => ({
  cfgCarryDays: null, cfgCutoffMinutes: null, cfgWidenedAt: null,
  orgCarryDays: 0, orgCutoffMinutes: 0, orgWidenedAt: null, ...o,
});
const iso = (d: Date) => d.toISOString();

// W1 — carry 0, never widened == today's rule (end of arrival ET day + cutoff)
for (const [rec, cutoff, want] of [
  ["2026-10-11T10:00:00", 0, "2026-10-12T00:00:00"],
  ["2026-10-11T23:59:00", 0, "2026-10-12T00:00:00"],
  ["2026-10-11T10:00:00", 90, "2026-10-12T01:30:00"],
  ["2026-11-01T10:00:00", 0, "2026-11-02T00:00:00"], // DST end day (25 h)
  ["2026-03-08T10:00:00", 0, "2026-03-09T00:00:00"], // DST start day (23 h)
] as const) {
  const got = admissionCloses(et(rec), S({ cfgCutoffMinutes: cutoff })).closesAt;
  bar(`W1 carry 0 ${rec} cutoff ${cutoff}`, iso(got) === iso(et(want)), iso(got));
}

// W2 — carry N extends by N ET days (DST-safe), then the cutoff
const c1 = admissionCloses(et("2026-10-11T10:00:00"), S({ cfgCarryDays: 1 })).closesAt;
bar("W2 carry 1 → end of next ET day", iso(c1) === iso(et("2026-10-13T00:00:00")), iso(c1));
const c7 = admissionCloses(et("2026-10-31T10:00:00"), S({ cfgCarryDays: 7, cfgCutoffMinutes: 30 })).closesAt;
bar("W2 carry 7 across DST + 30 min", iso(c7) === iso(et("2026-11-08T00:30:00")), iso(c7));

// W3 — campaign override vs org default (NULL inherits)
const inh = admissionCloses(et("2026-10-11T10:00:00"), S({ orgCarryDays: 2 })).closesAt;
bar("W3 NULL carry inherits org 2", iso(inh) === iso(et("2026-10-14T00:00:00")), iso(inh));
const ovr = admissionCloses(et("2026-10-11T10:00:00"), S({ orgCarryDays: 2, cfgCarryDays: 0 })).closesAt;
bar("W3 campaign 0 overrides org 2", iso(ovr) === iso(et("2026-10-12T00:00:00")), iso(ovr));

// W4 — a lead that arrived before the widening gets window 0 (no carry, no cutoff)
const w = et("2026-10-11T15:00:00");
const pre = admissionCloses(et("2026-10-11T10:00:00"), S({ cfgCarryDays: 3, cfgCutoffMinutes: 60, cfgWidenedAt: w }));
bar("W4 pre-widening → midnight of arrival day", pre.preWidening && iso(pre.closesAt) === iso(et("2026-10-12T00:00:00")), iso(pre.closesAt));
const post = admissionCloses(et("2026-10-11T16:00:00"), S({ cfgCarryDays: 3, cfgWidenedAt: w }));
bar("W4 post-widening → full window", !post.preWidening && iso(post.closesAt) === iso(et("2026-10-15T00:00:00")), iso(post.closesAt));

// W5 — effective widened = GREATEST(campaign, org), NULLs ignored
const g = effectiveWidenedAt(S({ cfgWidenedAt: et("2026-10-10T00:00:00"), orgWidenedAt: et("2026-10-11T00:00:00") }));
bar("W5 greatest of campaign/org", g !== null && iso(g) === iso(et("2026-10-11T00:00:00")));
bar("W5 both NULL → null", effectiveWidenedAt(S()) === null);

// W6 — scan floor
const now = et("2026-10-12T09:00:00");
bar("W6 carry 0 → today's midnight", iso(scanFloor(now, S())) === iso(et("2026-10-12T00:00:00")));
bar("W6 cutoff 600 at 09:00 → yesterday's midnight", iso(scanFloor(now, S({ cfgCutoffMinutes: 600 }))) === iso(et("2026-10-11T00:00:00")));
bar("W6 carry 7, never widened → 7 days back", iso(scanFloor(now, S({ cfgCarryDays: 7 }))) === iso(et("2026-10-05T00:00:00")));
bar("W6 ⭐ carry 7 widened yesterday 15:00 → floor = widened_at",
  iso(scanFloor(now, S({ cfgCarryDays: 7, cfgWidenedAt: et("2026-10-11T15:00:00") }))) === iso(et("2026-10-11T15:00:00")));
bar("W6 ⭐ carry 7 widened today 08:00 → today's midnight",
  iso(scanFloor(now, S({ cfgCarryDays: 7, cfgWidenedAt: et("2026-10-12T08:00:00") }))) === iso(et("2026-10-12T00:00:00")));
bar("W6 ⭐ Oct-10 backlog below every floor (carry 7, widened 10-12 08:00)",
  et("2026-10-10T12:00:00") < scanFloor(now, S({ cfgCarryDays: 7, cfgWidenedAt: et("2026-10-12T08:00:00") })));

// W7 — carried = later ET day
bar("W7 same ET day → not carried", !isCarried(et("2026-10-12T00:00:01"), now));
bar("W7 yesterday 23:59 → carried", isCarried(et("2026-10-11T23:59:00"), now));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
