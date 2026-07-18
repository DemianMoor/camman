import { validateDestination } from "@/lib/stage-url";

// Pure unit test for the guidekn destination-shape guard. Every row below is a
// real (or exactly-shaped) production URL from the stage-url-validation brief.
// Run: npx tsx scripts/test-validate-destination.ts

let failures = 0;

function reject(url: string, trackingId: string | null, msg: string) {
  const err = validateDestination(url, trackingId);
  if (err) {
    console.log(`  ✓ REJECT ${msg} — "${err}"`);
  } else {
    failures++;
    console.error(`  ✗ REJECT ${msg}\n      URL was ACCEPTED but should be rejected: ${url}`);
  }
}

function accept(url: string, trackingId: string | null, msg: string) {
  const err = validateDestination(url, trackingId);
  if (!err) {
    console.log(`  ✓ ACCEPT ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ACCEPT ${msg}\n      URL was REJECTED (${err}): ${url}`);
  }
}

console.log("Rejections (brief §6):");
// A: id in path, empty value
reject(
  "https://www.guidekn.com/lp/knd8_62_070826_1_s3_c126?sub_id3=",
  "8_62_070826_1_s3_c126",
  "id in path, empty value",
);
// A: id in path, no param
reject(
  "https://www.guidekn.com/lp/knd8_62_070926_2_s2_c247",
  "8_62_070926_2_s2_c247",
  "id in path, no param",
);
// C: placeholder present
reject(
  "https://www.guidekn.com/lp/knd?sub_id3=8_62_070326_1_s2_c120&subid3=sub_id3",
  "8_62_070326_1_s2_c120",
  "unsubstituted placeholder subid3=sub_id3",
);
// C: no sub_id3 at all (param name is the slug)
reject(
  "https://www.guidekn.com/lp/knd?knd=8_62_061626_1_s1_c124&subid3=sub_id3",
  "8_62_061626_1_s1_c124",
  "no sub_id3 (param name is the slug)",
);
reject(
  "https://www.guidekn.com/lp/llx?llx=8_58_061126_1_s1_c23&subid3=sub_id3",
  "8_58_061126_1_s1_c23",
  "no sub_id3 (llx slug param)",
);
// empty value
reject("https://www.guidekn.com/lp/knd?sub_id3=", "8_62_070326_2_s2_c126", "empty sub_id3 value");
// no param
reject("https://www.guidekn.com/lp/knd", "8_62_070326_2_s2_c126", "no param at all");
// mismatched tracking id
reject(
  "https://www.guidekn.com/lp/knd?sub_id3=WRONG_ID",
  "8_62_070326_2_s2_c126",
  "sub_id3 mismatches the stage tracking_id",
);

console.log("\nAcceptances (brief §6):");
accept(
  "https://www.guidekn.com/lp/knd?sub_id3=8_62_070326_2_s2_c126",
  "8_62_070326_2_s2_c126",
  "canonical knd destination",
);
accept(
  "https://www.guidekn.com/lp/kcwv?sub_id3=8_62_070726_2_s4_c126",
  "8_62_070726_2_s4_c126",
  "canonical kcwv destination",
);
// slug containing a digit — legit, must NOT be mistaken for id-in-path.
accept(
  "https://www.guidekn.com/lp/gb1?sub_id3=8_80_071826_1_s1_c351",
  "8_80_071826_1_s1_c351",
  "canonical digit-bearing slug (gb1)",
);
accept(
  "https://www.guidekn.com/lp/gb18?sub_id3=8_80_071826_1_s1_c351",
  "8_80_071826_1_s1_c351",
  "canonical multi-digit slug (gb18)",
);
// but a digit-bearing slug WITH the id glued on is still the concat bug.
reject(
  "https://www.guidekn.com/lp/gb18_80_071826_1_s1_c351",
  "8_80_071826_1_s1_c351",
  "id-in-path survives even with a digit-bearing slug",
);
// non-guidekn destination — out of scope of the shape rule
accept(
  "https://clicks2scale.com/click?o=14508&a=1737",
  "8_62_061226_3_s6_c124",
  "non-guidekn network destination is out of scope",
);

console.log("\nScope / edge cases:");
// Empty and null pass (drafts / auto mode).
accept("", "8_62_070326_2_s2_c126", "empty URL passes (draft / auto mode)");
accept("   ", null, "whitespace URL passes");
// Shape-only mode (no tracking id): defects still rejected, mismatch not checked.
reject(
  "https://www.guidekn.com/lp/knd8_62_070826_1_s3_c126?sub_id3=",
  null,
  "shape-only: id-in-path still rejected without a tracking id",
);
accept(
  "https://www.guidekn.com/lp/knd?sub_id3=8_62_070326_2_s2_c126",
  null,
  "shape-only: canonical URL accepted without a tracking id (equality skipped)",
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll validateDestination assertions passed ✓");
