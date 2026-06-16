// Bug 3 regression: the stage tracking ID is carried by the fixed `sub_id3`
// param (Keitaro's ingest key), the same for every offer — never the per-offer
// `postfix` (which operators set to page slugs like `knd`). Pure builder test,
// no DB. Run: npx tsx scripts/test-stage-url.ts
import { STAGE_TRACKING_PARAM, buildStageFullUrl } from "@/lib/stage-url";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// Brief's exact acceptance case: page slug `knd`, tracking id 8_62_061626_1_s1_c124.
const url = buildStageFullUrl({
  salesPageUrl: "https://www.guidekn.com/lp/knd",
  trackingId: "8_62_061626_1_s1_c124",
});
check(
  "exact required format ?sub_id3=<tracking_id>",
  url === "https://www.guidekn.com/lp/knd?sub_id3=8_62_061626_1_s1_c124",
  `got ${url}`,
);
check("tracking param key is sub_id3 (underscore)", STAGE_TRACKING_PARAM === "sub_id3");
check("no stray knd= query param", !/[?&]knd=/.test(url), url);
check("value is the real tracking id, not a placeholder", !url.includes("sub_id3=sub_id3"), url);

// With UTM tags: they append after, each as <tag_id>=<value_source>.
const withTags = buildStageFullUrl({
  salesPageUrl: "https://x.co/lp/orv",
  trackingId: "8_3_052726_1_s1_c101",
  utmTags: [{ tag_id: "subid5", value_source: "facebook" }],
});
check(
  "tags append after the sub_id3 param",
  withTags === "https://x.co/lp/orv?sub_id3=8_3_052726_1_s1_c101&subid5=facebook",
  `got ${withTags}`,
);

// No tracking id ⇒ no sub_id3 param.
check(
  "no tracking id ⇒ bare base",
  buildStageFullUrl({ salesPageUrl: "https://x.co/lp" }) === "https://x.co/lp",
);

console.log(failed === 0 ? "\nBug 3 — stage URL builder verified." : `\nFAILED: ${failed}`);
if (failed > 0) process.exit(1);
