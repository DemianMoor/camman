// Pure verification of the tracked-mode SMS preview composition + counter.
// No DB, no network. Confirms the representative tracked link composes correctly
// and that calculateSmsSegments counts the WHOLE message (incl. the link line)
// with correct GSM-7/UCS-2 detection.
//
// Run: npx tsx scripts/verify-sms-preview.ts

import { calculateSmsSegments } from "@/lib/creative-helpers";
import { buildStageSms } from "@/lib/sends/stage-sms";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const CODE_PLACEHOLDER = "XXXXXXX"; // must equal mint CODE_LENGTH (7)
const brandName = "Guide Kin";
const stopText = "Stop to END";
const trackedLink = `https://gdkn.org/r/${CODE_PLACEHOLDER}`;

console.log("Placeholder length:");
assert(CODE_PLACEHOLDER.length === 7, "tracked code placeholder is 7 chars (mint CODE_LENGTH)");

console.log("Tracked composition:");
const creative = "Flash sale ends tonight, 50% off today only.";
const tracked = buildStageSms({ brandName, creativeText: creative, linkUrl: trackedLink, stopText });
assert(
  tracked === `Guide Kin: ${creative}\n${trackedLink}\nStop to END`,
  "composes brand: creative \\n tracked-link \\n stop",
);

console.log("Counter is over the WHOLE message:");
const noLink = buildStageSms({ brandName, creativeText: creative, linkUrl: "", stopText });
const segTracked = calculateSmsSegments(tracked);
const segNoLink = calculateSmsSegments(noLink);
assert(segTracked.charset === "GSM-7", "plain ASCII tracked message → GSM-7");
// The link line adds the URL chars + one newline beyond the no-link version.
assert(
  segTracked.characters === segNoLink.characters + trackedLink.length + 1,
  "char count includes the link line (URL + newline), not just the creative",
);
assert(segTracked.segments >= 1 && segTracked.per_segment_limit === 160, "GSM-7 single-segment limit 160");

console.log("Encoding flip (UCS-2):");
const emDashCreative = "Flash sale ends tonight — 50% off today only."; // em dash → UCS-2
const ucs = calculateSmsSegments(
  buildStageSms({ brandName, creativeText: emDashCreative, linkUrl: trackedLink, stopText }),
);
assert(ucs.charset === "UCS-2", "one non-GSM char (em dash) forces UCS-2");
assert(ucs.per_segment_limit === 70 || ucs.per_segment_limit === 67, "UCS-2 drops the per-segment limit to 70/67");

console.log("\nAll assertions passed.");
console.log("verify-sms-preview OK.");
