import { setUrlParam, STAGE_TRACKING_PARAM } from "@/lib/stage-url";

// Pure unit test for the surgical sub_id3 rewrite used by every stage-copy path.
// Run: npx tsx scripts/test-set-url-param.ts

let failures = 0;
function eq(actual: string, expected: string, msg: string) {
  if (actual === expected) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

// 1) Replaces ONLY sub_id3, preserves sub_id1 (L2 attribution) and others.
eq(
  setUrlParam(
    "https://lp.example.com/orv?sub_id1=ABC&sub_id3=8_62_061226_1_s4_c163&subid5=facebook",
    STAGE_TRACKING_PARAM,
    "8_62_061226_1_s5_c163",
  ),
  "https://lp.example.com/orv?sub_id1=ABC&sub_id3=8_62_061226_1_s5_c163&subid5=facebook",
  "replaces sub_id3 only, leaves sub_id1 + subid5 untouched",
);

// 2) sub_id3 is the only param.
eq(
  setUrlParam("https://x/lp?sub_id3=old_s1_c1", STAGE_TRACKING_PARAM, "new_s2_c1"),
  "https://x/lp?sub_id3=new_s2_c1",
  "replaces sole sub_id3",
);

// 3) sub_id3 absent but a query string exists → append with '&'.
eq(
  setUrlParam("https://x/lp?sub_id1=ABC", STAGE_TRACKING_PARAM, "new_s2_c1"),
  "https://x/lp?sub_id1=ABC&sub_id3=new_s2_c1",
  "appends sub_id3 with '&' when query exists",
);

// 4) No query string at all → append with '?'.
eq(
  setUrlParam("https://x/lp", STAGE_TRACKING_PARAM, "new_s2_c1"),
  "https://x/lp?sub_id3=new_s2_c1",
  "appends sub_id3 with '?' when no query",
);

// 5) sub_id3 in the middle, value preserved positionally.
eq(
  setUrlParam("https://x/lp?a=1&sub_id3=old&b=2", STAGE_TRACKING_PARAM, "new"),
  "https://x/lp?a=1&sub_id3=new&b=2",
  "replaces middle sub_id3, keeps order",
);

// 6) Empty URL → no-op (copied stage with no inherited URL).
eq(setUrlParam("", STAGE_TRACKING_PARAM, "new_s2_c1"), "", "empty URL is a no-op");

// 7) Does not partially match a different param whose name contains sub_id3.
eq(
  setUrlParam("https://x/lp?xsub_id3=keep&sub_id3=old", STAGE_TRACKING_PARAM, "new"),
  "https://x/lp?xsub_id3=keep&sub_id3=new",
  "does not clobber a param whose name merely contains 'sub_id3'",
);

// 8) Value is URL-encoded (defensive — tracking ids are alnum/underscore, but
//    a stray space must not break the query).
eq(
  setUrlParam("https://x/lp?sub_id3=old", STAGE_TRACKING_PARAM, "a b"),
  "https://x/lp?sub_id3=a%20b",
  "encodes the new value",
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll setUrlParam assertions passed ✓");
