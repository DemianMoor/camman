import "./_env-preload";

import { isBlockedAddress, probeLandingUrl } from "@/lib/brand-landing-probe";
import { normalizeLandingHost } from "@/lib/api/brand-landing";
import { validateBrandLpShape, type BrandLandingPair } from "@/lib/stage-url";

// Brand landing UI + data-driven validation (migration 0212, ClickUp 869fhan29).
// PURE — no database. The DB half is scripts/test-landing-shape-trigger.ts
// (preview only), which runs the SAME 14 cases against the trigger and requires
// the two verdicts to agree.
//
//   1. The 14 cases from #362's preview CHECK test, against the app mirror.
//   2. Host normalization.
//   3. The Test button never fetches a private / loopback / link-local /
//      metadata address, https only, IP literals refused.
//
// `--live` adds two real fetches (blogcascade /bcf/sas, and localhost which
// must be refused at connect time).

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

// Production's pairs after 0211.
const PAIRS: BrandLandingPair[] = [
  { host: "www.guidekn.com", path: "lp" },
  { host: "www.lumzen.co", path: "lp" },
  { host: "www.fitsyou.net", path: "lp" },
  { host: "blogcascade.com", path: "bcf" },
];

// A = accepted, R = refused. Identical to the 0211 preview DO-block cases.
export const CASES: [string, "A" | "R"][] = [
  ["https://www.guidekn.com/lp/orv?sub_id3=8_62_082226_1_s1_c1", "A"],
  ["https://www.lumzen.co/lp/orv?sub_id3=8_62_082226_1_s1_c1&utm_source=x", "A"],
  ["https://blogcascade.com/bcf/sas?sub_id3=8_157_101326_1_s1_c1102", "A"],
  ["https://blogcascade.com/bcf/sas?sub_id3=8_157_101326_1_s1_c1102&utm_source=x", "A"],
  ["https://blogcascade.com/article/x?utm_source=y", "A"],
  ["https://partner.example/offer?a=1", "A"],
  ["https://www.blogcascade.com/bcf/sas?sub_id3=T1", "R"],
  ["https://blogcascade.com/bcf/sas", "R"],
  ["https://blogcascade.com/bcf/sas?subid3=sub_id3", "R"],
  ["https://blogcascade.com/bcf/sas8_157_1?sub_id3=T1", "R"],
  ["https://blogcascade.com/bcf/sas?utm_source=x&sub_id3=T1", "R"],
  ["https://blogcascade.com/bcf/sas?sub_id3=T%3F", "R"],
  ["https://blogcascade.com/lp/sas?sub_id3=T1", "R"],
  ["https://www.guidekn.com/lp/knd8_62_1?sub_id3=T1", "R"],
];

async function main() {
  console.log("1. the 14 #362 cases against the app mirror (prod pairs):");
  for (const [url, want] of CASES) {
    const got = validateBrandLpShape(url, PAIRS) === null ? "A" : "R";
    check(`${want} ${url}`, got === want, `got ${got}`);
  }
  console.log("\n   + data-driven additions:");
  const withNew = [...PAIRS, { host: "newbrand.example", path: "nb" }];
  check("new brand's own host/path accepted",
        validateBrandLpShape("https://newbrand.example/nb/abc?sub_id3=T1", withNew) === null);
  check("before the brand exists /nb/ is out of scope ⇒ no rule (accepted)",
        validateBrandLpShape("https://newbrand.example/nb/abc?sub_id3=T1", PAIRS) === null);
  const moved = [...PAIRS, { host: "newbrand2.example", path: "nb" }];
  check("after a host change the OLD host is refused",
        validateBrandLpShape("https://newbrand.example/nb/abc?sub_id3=T1", moved) !== null);
  check("...and the new host accepted",
        validateBrandLpShape("https://newbrand2.example/nb/abc?sub_id3=T1", moved) === null);
  check("unknown host on /lp/ refused (matches the database)",
        validateBrandLpShape("https://evil.example/lp/x?sub_id3=T1", PAIRS) !== null);
  check("refusal names the host problem",
        /not a brand landing host/.test(validateBrandLpShape("https://evil.example/lp/x?sub_id3=T1", PAIRS) ?? ""));

  console.log("\n2. host normalization:");
  for (const [raw, want] of [
    ["https://WWW.Brand.com/", "www.brand.com"],
    ["www.brand.com/lp/x?y=1", "www.brand.com"],
    ["Brand.com:443", "brand.com"],
    ["", null],
  ] as const) {
    const r = normalizeLandingHost(raw);
    check(`${JSON.stringify(raw)} ⇒ ${want}`, r.ok && r.host === want, JSON.stringify(r));
  }
  for (const bad of ["not a host", "localhost", "127.0.0.1", "brand"]) {
    check(`${JSON.stringify(bad)} refused`, !normalizeLandingHost(bad).ok);
  }

  console.log("\n3. Test button — never an internal address:");
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-ip",
  ]) {
    check(`blocked ${ip}`, isBlockedAddress(ip));
  }
  for (const ip of ["8.8.8.8", "76.76.21.21", "172.32.0.1", "2606:4700:4700::1111"]) {
    check(`allowed ${ip}`, !isBlockedAddress(ip));
  }
  const http = await probeLandingUrl("http://blogcascade.com/bcf/sas");
  check("http:// refused before any connection", http.outcome === "refused_address", JSON.stringify(http));
  const port = await probeLandingUrl("https://blogcascade.com:8443/bcf/sas");
  check("non-443 port refused", port.outcome === "refused_address", JSON.stringify(port));
  const lit = await probeLandingUrl("https://169.254.169.254/latest/meta-data");
  check("IP literal (metadata) refused", lit.outcome === "refused_address", JSON.stringify(lit));

  if (process.argv.includes("--live")) {
    console.log("\n   live fetches:");
    const local = await probeLandingUrl("https://localhost/lp/x");
    check("localhost refused AT CONNECT (resolves to loopback)", local.outcome === "refused_address", JSON.stringify(local));
    const cas = await probeLandingUrl("https://blogcascade.com/bcf/sas");
    check("blogcascade.com/bcf/sas serves", cas.outcome === "serves", JSON.stringify(cas));
    const www = await probeLandingUrl("https://www.blogcascade.com/bcf/sas");
    check("www reported as a redirect, not followed", www.outcome === "redirects" && !!www.location, JSON.stringify(www));
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
