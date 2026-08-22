import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { buildLandingPageUrl, isBrandLandingHost } from "@/lib/landing-page-url";

// Landing-page destination construction (Drip P1 1b, migrations 0150/0151).
//
// ⭐ THE CENTRAL CLAIM UNDER TEST: a stage stores WHICH PAGE, not which URL, so
// RE-BRANDING A CAMPAIGN SELF-CORRECTS ITS LINKS. This is not theoretical — on
// 2026-08-22 campaigns 902 (Guide Kin→LumZen) and 923 (FitsYou→LumZen) were
// re-branded in production and every stage kept pointing at the old brand's
// pages, because the destination was a frozen absolute URL.
//
// The rebrand case is asserted by building the SAME page against TWO different
// brands and requiring two different hosts. A test that only built once would
// pass even if the host were hardcoded.
//
// ⭐ It also asserts the REFUSALS. A constructor that returned a URL for every
// input would pass a positive-only test; the failure modes here (disabled page,
// brand with no landing_host, malformed slug) each ship a 404 that silently
// kills attribution, which is the exact class migration 0094 exists to prevent.
//
// Pure-function assertions need no DB. The DB section is read-only: it verifies
// the migration landed and reports the live landing_host per brand, so a PASS
// names the world it ran against.

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

const slugPage = {
  id: 1,
  kind: "slug" as const,
  slug: "orv",
  external_url: null,
  status: "active",
};

async function main() {
  console.log("construction — same page, different brands (the rebrand case):");
  const gk = buildLandingPageUrl({ page: slugPage, landingHost: "www.guidekn.com", trackingId: "8_62_082226_1_s1_c1" });
  const lz = buildLandingPageUrl({ page: slugPage, landingHost: "www.lumzen.co", trackingId: "8_62_082226_1_s1_c1" });
  check("Guide Kin host", gk.ok && gk.url === "https://www.guidekn.com/lp/orv?sub_id3=8_62_082226_1_s1_c1", gk.ok ? gk.url : gk.message);
  check("LumZen host", lz.ok && lz.url === "https://www.lumzen.co/lp/orv?sub_id3=8_62_082226_1_s1_c1", lz.ok ? lz.url : lz.message);
  check("SAME page ⇒ DIFFERENT url per brand (rebrand self-corrects)", gk.ok && lz.ok && gk.url !== lz.url);

  console.log("\nsingle-param rule — UTM never reaches an /lp/ destination:");
  const withUtm = buildLandingPageUrl({
    page: slugPage,
    landingHost: "www.guidekn.com",
    trackingId: "T1",
    // The literal tag configured in this org; appending it emits the
    // "unsubstituted placeholder" defect and fails the 0151 CHECK.
    utmTags: [{ tag_id: "subid3", value_source: "sub_id3" }],
  });
  check("no UTM appended", withUtm.ok && withUtm.url === "https://www.guidekn.com/lp/orv?sub_id3=T1", withUtm.ok ? withUtm.url : "");
  check("appliedUtm reported false", withUtm.ok && withUtm.appliedUtm === false);
  check("exactly one query param", withUtm.ok && (withUtm.url.split("?")[1] ?? "").split("&").length === 1);
  check(
    "matches the 0151 canonical shape",
    withUtm.ok &&
      /^https:\/\/(www\.guidekn\.com|www\.lumzen\.co|www\.fitsyou\.net)\/lp\/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$/.test(withUtm.url),
  );

  console.log("\nexternal_url — verbatim, and UTM IS allowed (no shape rule applies):");
  const ext = buildLandingPageUrl({
    page: { id: 2, kind: "external_url", slug: null, external_url: "https://clicks2scale.com/click?o=1", status: "active" },
    landingHost: null,
    trackingId: "T1",
    utmTags: [{ tag_id: "subid5", value_source: "facebook" }],
  });
  check("base preserved + params appended with &", ext.ok && ext.url === "https://clicks2scale.com/click?o=1&sub_id3=T1&subid5=facebook", ext.ok ? ext.url : ext.message);
  check("appliedUtm reported true", ext.ok && ext.appliedUtm === true);
  check("external_url needs NO brand landing host", ext.ok);

  console.log("\nrefusals (a constructor that always returned a URL would pass a positive-only test):");
  const noHost = buildLandingPageUrl({ page: slugPage, landingHost: null, trackingId: "T1" });
  check("slug + brand with NO landing_host ⇒ refused", !noHost.ok && noHost.reason === "brand_missing_landing_host", JSON.stringify(noHost));
  const disabled = buildLandingPageUrl({ page: { ...slugPage, status: "disabled" }, landingHost: "www.guidekn.com", trackingId: "T1" });
  check("disabled page ⇒ refused", !disabled.ok && disabled.reason === "page_disabled");
  const badSlug = buildLandingPageUrl({ page: { ...slugPage, slug: "knd8_62_1" }, landingHost: "www.guidekn.com", trackingId: "T1" });
  check("slug with an UNDERSCORE ⇒ refused (the 0094 path-glue signature)", !badSlug.ok && badSlug.reason === "page_malformed");
  const emptyExt = buildLandingPageUrl({ page: { id: 3, kind: "external_url", slug: null, external_url: "", status: "active" }, landingHost: null, trackingId: "T1" });
  check("external_url with no URL ⇒ refused", !emptyExt.ok);

  console.log("\nisBrandLandingHost (drives the legacy UTM skip):");
  check("matches a brand landing host", isBrandLandingHost("https://www.guidekn.com/lp/orv", ["www.guidekn.com"]));
  check("does not match another host", !isBrandLandingHost("https://clicks2scale.com/x", ["www.guidekn.com"]));
  check("tolerates NULL hosts in the set", !isBrandLandingHost("https://x.test/a", [null, undefined, ""]));

  // ── read-only DB section: name the world this ran against ──────────────────
  console.log("\nlive schema + brand landing hosts (read-only):");
  const tbl = (await db.execute(sql`SELECT to_regclass('public.offer_landing_pages')::text AS t`)) as unknown as { t: string | null }[];
  check("offer_landing_pages exists (migration 0150 applied)", !!tbl[0]?.t, "run npm run db:migrate");
  const col = (await db.execute(sql`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='campaign_stages' AND column_name='landing_page_id'
  `)) as unknown as { n: number }[];
  check("campaign_stages.landing_page_id exists", (col[0]?.n ?? 0) === 1);

  const brands = (await db.execute(sql`
    SELECT id, name, landing_host FROM brands WHERE status='active' ORDER BY id
  `)) as unknown as { id: number; name: string; landing_host: string | null }[];
  for (const b of brands) {
    console.log(`        brand ${b.id} ${b.name}: landing_host = ${b.landing_host ?? "(NULL — cannot use slug pages)"}`);
  }
  check("every active brand has a landing_host", brands.every((b) => !!b.landing_host),
        brands.filter((b) => !b.landing_host).map((b) => b.name).join(", "));

  // Nothing was written by this script.
  const stages = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaign_stages WHERE landing_page_id IS NOT NULL
  `)) as unknown as { n: number }[];
  console.log(`        stages using a landing page: ${stages[0]?.n ?? 0} (expected 0 until the UI is used)`);

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
