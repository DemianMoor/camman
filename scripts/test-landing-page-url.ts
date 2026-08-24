import "./_env-preload";

import { buildLandingPageUrl } from "@/lib/landing-page-url";
import { validateBrandLpShape, validateDestination } from "@/lib/stage-url";
import { formatStageTrackingId } from "@/lib/tracking-id-format";
import { STAGE_TRACKING_PARAM } from "@/lib/stage-url";

// Landing-page destination construction. Pure — no database.
//
// ⭐ WHAT SHIPPED, AND WHY IT SURVIVED REVIEW. The stage form previewed the
// destination with a hand-rolled placeholder tracking id —
// `${campaignTrackingId}_s?_c?` — using literal question marks for the
// not-yet-known stage and creative. buildLandingPageUrl percent-encodes the id,
// so those became %3F and the operator was shown, and could SAVE:
//
//     https://www.lumzen.co/lp/llx?sub_id3=8_58_082426_1_s3_c335%3F_c%3F
//
// It looks almost right. Keitaro would receive a sub_id3 that matches no stage,
// so every click on that link is unattributable — a silent revenue-reporting
// hole rather than a visible break.
//
// ⭐ SO THE ASSERTION IS BYTE-IDENTITY, NOT "CONTAINS". A test that checked the
// URL merely CONTAINED the tracking id would have passed on the broken string:
// `…c335%3F_c%3F` contains `…c335`. These parse the URL and compare the decoded
// param to the tracking id exactly, and separately assert no percent-encoding
// artifact appears anywhere.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const PAGE = {
  id: 1,
  kind: "slug" as const,
  slug: "lhj",
  external_url: null,
  status: "active",
};

function main() {
  const tid = formatStageTrackingId({
    campaignTrackingId: "142_118_082426_1",
    stageNumber: 1,
    creativeId: 599,
  });
  console.log(`stage tracking id: ${tid}`);

  console.log("\n⭐ the constructed URL, parsed:");
  const r = buildLandingPageUrl({
    page: PAGE,
    landingHost: "www.lumzen.co",
    trackingId: tid,
  });
  check("built", r.ok, true);
  if (!r.ok) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exitCode = 1;
    return;
  }
  const u = new URL(r.url);
  check("host", u.host, "www.lumzen.co");
  check("path", u.pathname, "/lp/lhj");
  check("⭐ EXACTLY ONE param", [...u.searchParams.keys()], [STAGE_TRACKING_PARAM]);
  check("⭐ sub_id3 is BYTE-IDENTICAL to the stage tracking id",
        u.searchParams.get(STAGE_TRACKING_PARAM), tid);
  check("⭐ no percent-encoding artifact anywhere in the URL",
        /%[0-9A-Fa-f]{2}/.test(r.url), false);
  check("⭐ specifically no encoded '?' (%3F)", r.url.includes("%3F"), false);
  check("the whole URL, exactly",
        r.url, `https://www.lumzen.co/lp/lhj?sub_id3=142_118_082426_1_s1_c599`);

  console.log("\n⭐ the shape that shipped — proof this test would have caught it:");
  const broken = buildLandingPageUrl({
    page: { ...PAGE, slug: "llx" },
    landingHost: "www.lumzen.co",
    // exactly what the form used to pass: a placeholder with literal '?'
    trackingId: `8_58_082426_1_s3_c335_s?_c?`,
  });
  check("it still 'builds' (which is why nobody noticed)", broken.ok, true);
  if (broken.ok) {
    check("⭐ ...but carries a %3F artifact", broken.url.includes("%3F"), true);
    const bu = new URL(broken.url);
    check("⭐ ...and its sub_id3 does NOT equal any real stage tracking id",
          bu.searchParams.get(STAGE_TRACKING_PARAM) === "8_58_082426_1_s3_c335", false);
    // The weak assertion that would have passed on the broken value:
    check("⚠️ a 'contains' check would have PASSED on the broken URL",
          broken.url.includes("8_58_082426_1_s3_c335"), true);
  }

  console.log("\nno tracking id yet ⇒ no param at all (never a fake one):");
  const noTid = buildLandingPageUrl({ page: PAGE, landingHost: "www.lumzen.co", trackingId: null });
  check("built", noTid.ok, true);
  if (noTid.ok) {
    check("bare path, no query", noTid.url, "https://www.lumzen.co/lp/lhj");
    check("no params", [...new URL(noTid.url).searchParams.keys()], []);
  }

  console.log("\nrefusals:");
  check("no landing host ⇒ refused",
        buildLandingPageUrl({ page: PAGE, landingHost: null, trackingId: tid }).ok, false);
  check("malformed slug ⇒ refused",
        buildLandingPageUrl({ page: { ...PAGE, slug: "not a slug" }, landingHost: "www.lumzen.co", trackingId: tid }).ok, false);
  check("disabled page ⇒ refused",
        buildLandingPageUrl({ page: { ...PAGE, status: "disabled" }, landingHost: "www.lumzen.co", trackingId: tid }).ok, false);

  console.log("\nexternal_url keeps its own params and DOES take UTM:");
  const ext = buildLandingPageUrl({
    page: { id: 2, kind: "external_url", slug: null, external_url: "https://partner.example/offer?a=1", status: "active" },
    landingHost: "www.lumzen.co",
    trackingId: tid,
    utmTags: [{ tag_id: "utm_source", value_source: "sms" }],
  });
  check("built", ext.ok, true);
  if (ext.ok) {
    const eu = new URL(ext.url);
    check("its own param survives", eu.searchParams.get("a"), "1");
    check("tracking id byte-identical here too",
          eu.searchParams.get(STAGE_TRACKING_PARAM), tid);
    check("utm applied", eu.searchParams.get("utm_source"), "sms");
    check("no %3F artifact", ext.url.includes("%3F"), false);
  }

  // ⭐ THESE CASES MIRROR THE DB CHECK ONE FOR ONE. The app guard and the
  // constraint disagreeing is the defect that produced this work: a lumzen /lp/
  // URL with a UTM param passed every app check and was rejected by the database
  // at MINT, surfacing hours later as skipped leads. Change either side without
  // the other and these go red.
  console.log("\n⭐ widened shape (0170) — extra params allowed AFTER sub_id3:");
  const ok = (u: string) => validateBrandLpShape(u) === null;
  const T = "142_118_082426_1_s1_c599";
  check("canonical single param", ok(`https://www.lumzen.co/lp/lhj?sub_id3=${T}`), true);
  check("⭐ one extra param (the point of 0170)",
        ok(`https://www.lumzen.co/lp/lhj?sub_id3=${T}&utm_source=x`), true);
  check("several extra params",
        ok(`https://www.guidekn.com/lp/orv?sub_id3=${T}&utm_source=sms&utm_medium=a-b.c`), true);
  check("empty extra value", ok(`https://www.fitsyou.net/lp/llm?sub_id3=${T}&utm_source=`), true);

  console.log("\n⭐ ...and everything 0094 exists for is STILL refused:");
  check("A: tracking id concatenated into the path",
        ok("https://www.guidekn.com/lp/knd8_62_070826_1?sub_id3=8_62_070826_1"), false);
  check("B: empty sub_id3", ok("https://www.lumzen.co/lp/lhj?sub_id3="), false);
  check("B2: empty sub_id3 then params", ok("https://www.lumzen.co/lp/lhj?sub_id3=&utm_source=x"), false);
  check("C: unsubstituted placeholder", ok("https://www.lumzen.co/lp/lhj?subid3=sub_id3"), false);
  check("D: no sub_id3 at all", ok("https://www.lumzen.co/lp/lhj?utm_source=x"), false);
  check("⭐ E: the %3F preview bug",
        ok("https://www.lumzen.co/lp/llx?sub_id3=8_58_082426_1_s3_c335%3F_c%3F"), false);
  check("sub_id3 must be FIRST", ok(`https://www.lumzen.co/lp/lhj?utm_source=x&sub_id3=${T}`), false);
  check("unknown host is out of scope (no shape rule)",
        ok(`https://evil.example/lp/lhj?sub_id3=${T}`), true);
  check("a non-/lp/ URL is unaffected", ok("https://partner.example/offer?a=1&b=2"), true);

  console.log("\nvalidateDestination (guidekn) widened in step:");
  check("guidekn + UTM now passes",
        validateDestination(`https://www.guidekn.com/lp/orv?sub_id3=${T}&utm_source=x`, T), null);
  check("...but a mismatched sub_id3 still fails",
        validateDestination(`https://www.guidekn.com/lp/orv?sub_id3=WRONG&utm_source=x`, T) !== null, true);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
