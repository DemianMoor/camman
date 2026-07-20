import {
  buildStageFullUrl,
  isGuideknLpUrl,
  setUrlParam,
  STAGE_TRACKING_PARAM,
  validateDestination,
} from "@/lib/stage-url";

// Pure test of the sibling-URL rebuild decision the split / behavioral-split
// routes use, and the drift case from the brief (a stage renumbered s4 → s10
// must get a destination URL regenerated to match its NEW tracking id — the bug
// that produced stale full_url rows). Mirrors the route logic without a DB.
// Run: npx tsx scripts/test-split-url-rebuild.ts

let failures = 0;
function eq(actual: string, expected: string, msg: string) {
  if (actual === expected) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// The exact decision the routes make for a sibling/lane, given the source's
// full_url + resolved sales page and the sibling's own tracking id.
function rebuildSiblingUrl(
  sourceFullUrl: string | null,
  salesPageUrl: string | null,
  siblingTrackingId: string,
): string | null {
  const srcFull = (sourceFullUrl ?? "").trim();
  const rebuildFromSalesPage = srcFull === "" || isGuideknLpUrl(srcFull);
  if (rebuildFromSalesPage && salesPageUrl) {
    return buildStageFullUrl({ salesPageUrl, trackingId: siblingTrackingId }) || sourceFullUrl;
  }
  if (srcFull) return setUrlParam(srcFull, STAGE_TRACKING_PARAM, siblingTrackingId);
  return sourceFullUrl;
}

console.log("Guidekn source → canonical rebuild from the sibling's own id:");
{
  const out = rebuildSiblingUrl(
    "https://www.guidekn.com/lp/knd?sub_id3=8_62_061226_2_s4_c174",
    "https://www.guidekn.com/lp/knd",
    "8_62_061226_2_s10_c174",
  );
  eq(
    out ?? "",
    "https://www.guidekn.com/lp/knd?sub_id3=8_62_061226_2_s10_c174",
    "renumber s4 → s10 regenerates sub_id3 (drift fixed)",
  );
  ok(validateDestination(out, "8_62_061226_2_s10_c174") === null, "rebuilt URL is canonical + matches new id");
}

console.log("\nMalformed guidekn source (id-in-path) → still canonical after rebuild:");
{
  const out = rebuildSiblingUrl(
    "https://www.guidekn.com/lp/knd8_62_070826_1_s3_c126?sub_id3=",
    "https://www.guidekn.com/lp/knd",
    "8_62_070826_1_s9_c126",
  );
  eq(
    out ?? "",
    "https://www.guidekn.com/lp/knd?sub_id3=8_62_070826_1_s9_c126",
    "malformed base does NOT propagate — rebuilt from sales page",
  );
  ok(validateDestination(out, "8_62_070826_1_s9_c126") === null, "rebuilt URL passes validation");
}

console.log("\nCustom non-guidekn source → preserved, only sub_id3 rewritten:");
{
  const out = rebuildSiblingUrl(
    "https://clicks2scale.com/click?o=14508&a=1737&sub_id3=old_s1_c1",
    "https://www.guidekn.com/lp/knd",
    "8_62_061226_3_s7_c124",
  );
  eq(
    out ?? "",
    "https://clicks2scale.com/click?o=14508&a=1737&sub_id3=8_62_061226_3_s7_c124",
    "non-guidekn URL preserved, sub_id3 updated to sibling id",
  );
  ok(validateDestination(out, "8_62_061226_3_s7_c124") === null, "non-guidekn URL passes (out of shape scope)");
}

console.log("\nEmpty source + sales page → sibling gets a canonical URL:");
{
  const out = rebuildSiblingUrl(null, "https://www.guidekn.com/lp/kns", "8_76_061926_1_s3_c163");
  eq(
    out ?? "",
    "https://www.guidekn.com/lp/kns?sub_id3=8_76_061926_1_s3_c163",
    "empty source builds fresh canonical URL",
  );
}

// The source stage (variant A) runs through the SAME rebuild as the siblings,
// using its OWN (unchanged) tracking id — so it comes out with sub_id3 attached
// instead of staying the bare sales-page URL. `rebuildSiblingUrl` is the exact
// shared decision (attachStageTracking) the route now applies to the source too.
console.log("\nVariant A (source) — bare auto URL gets its own tracking id attached:");
{
  // Create-then-split: the source was saved in auto mode as the bare sales page.
  const out = rebuildSiblingUrl(
    "https://www.guidekn.com/lp/knd",
    "https://www.guidekn.com/lp/knd",
    "8_62_061226_2_s3_c174",
  );
  eq(
    out ?? "",
    "https://www.guidekn.com/lp/knd?sub_id3=8_62_061226_2_s3_c174",
    "bare source URL gains sub_id3 (no more manual reopen)",
  );
  ok(
    validateDestination(out, "8_62_061226_2_s3_c174") === null,
    "variant A URL is canonical + matches its own id",
  );
}

console.log("\nVariant A (source) — custom non-guidekn URL keeps base, gains sub_id3:");
{
  const out = rebuildSiblingUrl(
    "https://clicks2scale.com/click?o=14508&a=1737",
    "https://www.guidekn.com/lp/knd",
    "8_62_061226_2_s3_c174",
  );
  eq(
    out ?? "",
    "https://clicks2scale.com/click?o=14508&a=1737&sub_id3=8_62_061226_2_s3_c174",
    "non-guidekn source preserved, sub_id3 appended",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll split-url-rebuild assertions passed ✓");
