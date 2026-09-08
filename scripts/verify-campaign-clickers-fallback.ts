// Guard for the campaign-detail Clickers substitution (the totals card).
//
// SYNTHETIC FIXTURES ON PURPOSE. The obvious guard — "campaign 1255 shows 23*"
// — is a countdown: the moment the landing page gets its Keitaro script the gap
// closes, the campaign stops substituting, and the guard goes red BECAUSE THE
// BUG WAS FIXED. Live Keitaro counts also move under it between poll ticks (a
// draft of this asserted 159 for campaign 1251 and failed minutes later at 161).
// So the world-state modelled here is the RULE, not today's data.
//
// It imports the same shouldSubstituteClickers / substitutionDominates the page
// calls, so it cannot transcribe a stale copy of the rule — the seam defect that
// PR #129 shipped and had to fix.
import {
  shouldSubstituteClickers,
  substitutionDominates,
  TRACKING_GAP_MATURITY_HOURS,
} from "../lib/reporting/tracking-gap-rules";

const NOW = new Date("2026-09-08T20:00:00Z");
const MATURE = new Date(NOW.getTime() - (TRACKING_GAP_MATURITY_HOURS + 1) * 3_600_000);
const FRESH = new Date(NOW.getTime() - 30 * 60_000);

interface Stage {
  linkMode: string;
  visitClicksRaw: number;
  visitClicksClean: number;
  countedClickers: number;
  stageSentAt: Date | null;
  clickCount: number;
}

// Exactly the reduction the campaign page's totals memo performs.
function totals(stages: Stage[]) {
  let clickers = 0;
  let substituted = 0;
  for (const s of stages) {
    if (shouldSubstituteClickers({ ...s, now: NOW })) {
      clickers += s.countedClickers;
      substituted += s.countedClickers;
    } else {
      clickers += s.clickCount;
    }
  }
  return { clickers, marked: substitutionDominates(substituted, clickers) };
}

const gapStage = (over: Partial<Stage> = {}): Stage => ({
  linkMode: "tracked",
  visitClicksRaw: 0,
  visitClicksClean: 0,
  countedClickers: 12,
  stageSentAt: MATURE,
  clickCount: 0,
  ...over,
});

const CASES: { name: string; stages: Stage[]; clickers: number; marked: boolean }[] = [
  {
    // The reported defect: campaign 8_130_090826_1, whose Leadpages LP shipped
    // with no Keitaro script. Two split lanes, 12 + 11 counted clickers, both
    // Keitaro columns zero. Was rendering "Clickers 0".
    name: "LP missing the Keitaro script → CamMan count, marked",
    stages: [gapStage({ countedClickers: 12 }), gapStage({ countedClickers: 11 })],
    clickers: 23,
    marked: true,
  },
  {
    name: "healthy LP → Keitaro's number, unmarked",
    stages: [gapStage({ visitClicksRaw: 210, visitClicksClean: 161, clickCount: 161 })],
    clickers: 161,
    marked: false,
  },
  {
    // raw is a SUPERSET of clean: "Keitaro saw visits, none unique" is common
    // and is NOT a blackout. Testing clean alone was 96.6% wrong (PR #129).
    name: "raw > 0, clean = 0 → NOT a gap",
    stages: [gapStage({ visitClicksRaw: 7, visitClicksClean: 0, clickCount: 0 })],
    clickers: 0,
    marked: false,
  },
  {
    name: "too fresh to judge → no substitution",
    stages: [gapStage({ stageSentAt: FRESH })],
    clickers: 0,
    marked: false,
  },
  {
    name: "never sent (null sent_at) → fails closed",
    stages: [gapStage({ stageSentAt: null })],
    clickers: 0,
    marked: false,
  },
  {
    name: "manual link mode mints no links → never substitutes",
    stages: [gapStage({ linkMode: "manual" })],
    clickers: 0,
    marked: false,
  },
  {
    // One 9-recipient resend beside four healthy stages is a Keitaro reading
    // with a patch on it — the marker must stay off.
    name: "minority substitution → value patched, row NOT marked",
    stages: [
      gapStage({ visitClicksRaw: 120, visitClicksClean: 100, clickCount: 100 }),
      gapStage({ countedClickers: 5 }),
    ],
    clickers: 105,
    marked: false,
  },
];

let failed = 0;
for (const c of CASES) {
  const got = totals(c.stages);
  const ok = got.clickers === c.clickers && got.marked === c.marked;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}\n      got clickers=${got.clickers}${got.marked ? "*" : ""}` +
      `  expected ${c.clickers}${c.marked ? "*" : ""}`,
  );
}
if (failed) {
  console.error(`\n${failed} of ${CASES.length} FAILED`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} cases passed.`);
