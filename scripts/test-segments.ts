// Segment counting used by the kickoff G8 gate. Wraps the EXISTING GSM-7/
// UCS-2 counter (lib/creative-helpers.ts calculateSmsSegments — already live
// in the creative-form UI and the stage creative-picker dialog) so the
// send-path gate and both UIs can never diverge on what counts as "1
// segment". Adds MAX_SEGMENTS (G8) + the narrower {encoding,chars,segments}
// shape the send path consumes.
// Run: npx tsx scripts/test-segments.ts
import { countSegments, MAX_SEGMENTS } from "@/lib/sends/segments";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

check("MAX_SEGMENTS is 4 (G8)", MAX_SEGMENTS === 4);

// GSM-7 boundary: 160 chars = 1 segment, 161 = 2 (concatenated framing, 153/seg).
const gsm159 = countSegments("A".repeat(159));
check("159 GSM-7 chars -> 1 segment", gsm159.segments === 1 && gsm159.encoding === "GSM-7", JSON.stringify(gsm159));
const gsm160 = countSegments("A".repeat(160));
check("160 GSM-7 chars -> 1 segment (exact boundary)", gsm160.segments === 1, JSON.stringify(gsm160));
const gsm161 = countSegments("A".repeat(161));
check("161 GSM-7 chars -> 2 segments", gsm161.segments === 2, JSON.stringify(gsm161));

// UCS-2 boundary: 70 chars = 1 segment, 71 = 2 (67/seg concatenated).
// NOTE: use a genuinely non-GSM-7 BMP char (中, 1 UTF-16 unit). Do NOT use
// accented Latin like é/à/ñ/ü — those ARE in the GSM-7 basic set (GSM 03.38)
// and count as GSM-7, so they would NOT exercise the UCS-2 path. (Verified
// against the live calculateSmsSegments: "é".repeat(70) => GSM-7, 1 segment.)
const ucs70 = countSegments("中".repeat(70));
check("70 UCS-2 chars -> 1 segment", ucs70.segments === 1 && ucs70.encoding === "UCS-2", JSON.stringify(ucs70));
const ucs71 = countSegments("中".repeat(71));
check("71 UCS-2 chars -> 2 segments", ucs71.segments === 2, JSON.stringify(ucs71));

// An emoji forces UCS-2 even in an otherwise pure-GSM-7 message.
const emoji = countSegments("Hello 😀");
check("emoji forces UCS-2 encoding", emoji.encoding === "UCS-2", JSON.stringify(emoji));

// Ceiling math: a GSM-7 message just over 4*153 chars exceeds MAX_SEGMENTS;
// exactly 4*153 is AT the ceiling, not over.
const overCeiling = countSegments("A".repeat(4 * 153 + 1));
check("4*153+1 GSM-7 chars exceeds MAX_SEGMENTS", overCeiling.segments > MAX_SEGMENTS, JSON.stringify(overCeiling));
const atCeiling = countSegments("A".repeat(4 * 153));
check("exactly 4*153 GSM-7 chars is AT the ceiling (not over)", atCeiling.segments === MAX_SEGMENTS, JSON.stringify(atCeiling));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
