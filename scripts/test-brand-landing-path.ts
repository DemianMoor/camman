import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { buildLandingPageUrl, isBrandLandingHost } from "@/lib/landing-page-url";
import { STAGE_TRACKING_PARAM, validateBrandLpShape } from "@/lib/stage-url";

// Per-brand landing path (migration 0211, ClickUp 869fhabkw).
//
// A kind='slug' landing page mints https://<landing_host>/<landing_path>/<slug>.
// Every brand keeps 'lp' except CascadeBlog, which serves /bcf/<slug>.
//
// ⭐ THE BARS, as the owner set them:
//   1. existing brands produce BYTE-IDENTICAL /lp/ URLs (compared to literal
//      strings, not to the builder's own output);
//   2. campaign 1705's stages mint https://blogcascade.com/bcf/sas?sub_id3=<tid>;
//   3. UTM is still skipped on a brand landing path;
//   4. the single-param rule holds, and the URL passes the app mirror of the
//      DB CHECK (validateBrandLpShape).
//
// Pure section needs no DB. `--db` adds a READ-ONLY section that reads brand
// 410 and page 79 from whatever DATABASE_URL points at and builds the same
// URLs from the LIVE rows — run it after the migration is applied.

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

const page = (slug: string) => ({ id: 79, kind: "slug" as const, slug, external_url: null, status: "active" });
const TID = "8_62_082226_1_s1_c1";

// Campaign 1705 stages 5324–5327 (prod tracking ids, read 2026-10-14).
const C1705 = [
  "8_157_101326_1_s1_c1102",
  "8_157_101326_1_s2_c1103",
  "8_157_101326_1_s3_c1106",
  "8_157_101326_1_s4_c1107",
];

async function main() {
  console.log("1. existing brands — byte-identical /lp/ URLs:");
  for (const [host, want] of [
    ["www.guidekn.com", `https://www.guidekn.com/lp/orv?sub_id3=${TID}`],
    ["www.lumzen.co", `https://www.lumzen.co/lp/orv?sub_id3=${TID}`],
    ["www.fitsyou.net", `https://www.fitsyou.net/lp/orv?sub_id3=${TID}`],
  ] as const) {
    const r = buildLandingPageUrl({ page: page("orv"), landingHost: host, landingPath: "lp", trackingId: TID });
    check(`${host} ⇒ ${want}`, r.ok && r.url === want, r.ok ? r.url : r.message);
  }

  console.log("\n2. CascadeBlog — campaign 1705's stages mint /bcf/:");
  for (const tid of C1705) {
    const want = `https://blogcascade.com/bcf/sas?sub_id3=${tid}`;
    const r = buildLandingPageUrl({ page: page("sas"), landingHost: "blogcascade.com", landingPath: "bcf", trackingId: tid });
    check(want, r.ok && r.url === want, r.ok ? r.url : r.message);
  }
  check(
    "SAME page, different brand ⇒ different host AND path (rebrand self-corrects)",
    (() => {
      const a = buildLandingPageUrl({ page: page("sas"), landingHost: "www.guidekn.com", landingPath: "lp", trackingId: TID });
      const b = buildLandingPageUrl({ page: page("sas"), landingHost: "blogcascade.com", landingPath: "bcf", trackingId: TID });
      return a.ok && b.ok && a.url === `https://www.guidekn.com/lp/sas?sub_id3=${TID}` && b.url === `https://blogcascade.com/bcf/sas?sub_id3=${TID}`;
    })(),
  );

  console.log("\n3. UTM skipped on a brand landing path:");
  const utm = buildLandingPageUrl({
    page: page("sas"),
    landingHost: "blogcascade.com",
    landingPath: "bcf",
    trackingId: C1705[0],
    utmTags: [{ tag_id: "subid3", value_source: "sub_id3" }],
  });
  check("no UTM appended on /bcf/", utm.ok && utm.url === `https://blogcascade.com/bcf/sas?sub_id3=${C1705[0]}`, utm.ok ? utm.url : "");
  check("appliedUtm reported false", utm.ok && utm.appliedUtm === false);
  // Legacy auto-build path (kickoff.ts) skips UTM by HOST. Owner ruling 10-14:
  // that now covers every blogcascade.com path, /article/ included.
  check("legacy skip: /bcf/ on the brand host", isBrandLandingHost("https://blogcascade.com/bcf/sas", ["blogcascade.com"]));
  check("legacy skip: /article/ on the brand host (accepted side effect)",
        isBrandLandingHost("https://blogcascade.com/article/x", ["blogcascade.com"]));

  console.log("\n4. single-param rule + the app mirror of the DB CHECK:");
  const one = buildLandingPageUrl({ page: page("sas"), landingHost: "blogcascade.com", landingPath: "bcf", trackingId: C1705[0] });
  if (one.ok) {
    const u = new URL(one.url);
    check("exactly one param, sub_id3", JSON.stringify([...u.searchParams.keys()]) === JSON.stringify([STAGE_TRACKING_PARAM]));
    check("sub_id3 byte-identical to the stage tracking id", u.searchParams.get(STAGE_TRACKING_PARAM) === C1705[0]);
    check("passes validateBrandLpShape", validateBrandLpShape(one.url) === null, validateBrandLpShape(one.url) ?? "");
  } else check("built", false, one.message);
  const ok = (u: string) => validateBrandLpShape(u) === null;
  const T = C1705[0];
  check("bcf + extra params after sub_id3 (0170 shape)", ok(`https://blogcascade.com/bcf/sas?sub_id3=${T}&utm_source=x`));
  check("bcf: www host refused (www 308s; CHECK lists the apex)", !ok(`https://www.blogcascade.com/bcf/sas?sub_id3=${T}`));
  check("bcf: tracking id glued into the path refused", !ok(`https://blogcascade.com/bcf/sas8_157_1?sub_id3=${T}`));
  check("bcf: no sub_id3 refused", !ok("https://blogcascade.com/bcf/sas?utm_source=x"));
  check("bcf: sub_id3 not first refused", !ok(`https://blogcascade.com/bcf/sas?utm_source=x&sub_id3=${T}`));
  check("bcf: placeholder subid3=sub_id3 refused", !ok("https://blogcascade.com/bcf/sas?subid3=sub_id3"));
  check("blogcascade.com /article/ has no shape rule", ok(`https://blogcascade.com/article/x?sub_id3=${T}`));
  check("lp: guidekn canonical still passes", ok(`https://www.guidekn.com/lp/orv?sub_id3=${T}`));
  check("lp: guidekn on /bcf/ is not a brand path (no rule)", ok(`https://www.guidekn.com/bcf/orv?x=1`));

  console.log("\n5. refusals — an invalid landing path never mints:");
  for (const bad of ["", "/bcf", "bcf/", "BCF", "-bcf", "bcf-", "b c f", "lp/x"]) {
    const r = buildLandingPageUrl({ page: page("sas"), landingHost: "blogcascade.com", landingPath: bad, trackingId: T });
    check(`landingPath ${JSON.stringify(bad)} ⇒ refused`, !r.ok && r.reason === "page_malformed", r.ok ? r.url : r.reason);
  }
  check("dashes allowed inside the path",
        (() => { const r = buildLandingPageUrl({ page: page("sas"), landingHost: "a.com", landingPath: "my-lp", trackingId: "T" }); return r.ok && r.url === "https://a.com/my-lp/sas?sub_id3=T"; })());
  const noHost = buildLandingPageUrl({ page: page("sas"), landingHost: null, landingPath: "bcf", trackingId: T });
  check("no landing host still refused first", !noHost.ok && noHost.reason === "brand_missing_landing_host");

  if (process.argv.includes("--db")) {
    console.log("\nLIVE rows (read-only):");
    const brands = (await db.execute(sql`
      SELECT id, name, landing_host, landing_path FROM brands WHERE status='active' ORDER BY id
    `)) as unknown as { id: number; name: string; landing_host: string | null; landing_path: string }[];
    for (const b of brands) console.log(`        brand ${b.id} ${b.name}: ${b.landing_host ?? "(no host)"} /${b.landing_path}/`);
    for (const b of brands.filter((x) => x.id !== 410)) {
      check(`brand ${b.id} keeps landing_path 'lp'`, b.landing_path === "lp", b.landing_path);
    }
    const cas = brands.find((b) => b.id === 410);
    check("brand 410 = blogcascade.com /bcf/", cas?.landing_host === "blogcascade.com" && cas?.landing_path === "bcf",
          JSON.stringify(cas));
    const p79 = (await db.execute(sql`
      SELECT id, kind, slug, external_url, status FROM offer_landing_pages WHERE id = 79
    `)) as unknown as { id: number; kind: "slug"; slug: string; external_url: null; status: string }[];
    const stages = (await db.execute(sql`
      SELECT s.id, s.tracking_id FROM campaign_stages s WHERE s.campaign_id = 1705 AND s.id IN (5324,5325,5326,5327) ORDER BY s.id
    `)) as unknown as { id: number; tracking_id: string }[];
    if (cas && p79[0]) {
      for (const s of stages) {
        const r = buildLandingPageUrl({ page: p79[0], landingHost: cas.landing_host, landingPath: cas.landing_path, trackingId: s.tracking_id });
        const want = `https://blogcascade.com/bcf/sas?sub_id3=${s.tracking_id}`;
        check(`stage ${s.id} + page 79 ⇒ ${want}`, r.ok && r.url === want, r.ok ? r.url : r.message);
      }
    } else check("brand 410 and page 79 present", false);
    await pgConn.end({ timeout: 5 });
  } else {
    await pgConn.end({ timeout: 5 }).catch(() => {});
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
