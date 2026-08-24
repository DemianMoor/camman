import "./_env-preload";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// The public-route matcher (Drip Phase 7).
//
// ⭐ THE RISK IS NOT THAT THE PUBLIC PAGE FAILS TO RENDER — that is loud and
// obvious the first time anyone opens the link. The risk is that the exclusion
// is WIDER than intended and silently drops an authenticated surface out of the
// middleware, which nothing complains about and no one notices.
//
// ⭐ SO THIS IS A DIFFERENTIAL TEST, NOT A LIST OF GUESSES. It compares the
// matcher on this branch against the matcher on origin/main across every real
// page route in the repo plus an adversarial prefix family, and asserts that
// EXACTLY ONE set of paths changed behaviour: those under `/partner-report/`.
// Enumerating "routes I think should still be gated" only ever tests my
// imagination — and the first version of this test did exactly that, and was
// wrong about which routes were even at risk (see the anchoring note below).
//
// ⚠️ THE LOOKAHEAD IS ANCHORED AT THE PATH ROOT. `/((?!…|partner-report/|…).*)`
// inspects only the text right after the leading slash, so an exclusion can
// only ever affect TOP-LEVEL paths. `/settings/partners` could not have been
// swallowed even by a bare `partner`; `/partners` and `/partner-keys` could.
// The differential below establishes that without my having to be right about
// it in advance.
//
// Both matchers are read from source — a re-typed copy would keep passing after
// someone widened the real one.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Pull the matcher pattern out of a proxy.ts source string. */
function extractMatcher(src: string): string {
  const m = src.match(/"(\/\(\(\?!_next\/static[^"]*)"/);
  if (!m) throw new Error("could not find the matcher — did proxy.ts change shape?");
  // The file carries TS string escaping (\\.); unescape to the real pattern.
  return m[1].replace(/\\\\/g, "\\");
}

function matcherFor(pattern: string): RegExp {
  return new RegExp(`^${pattern}$`);
}

/** Every real page route in the app, as the URL path the browser requests. */
function realPageRoutes(): string[] {
  const files = readdirSync("app", { recursive: true, encoding: "utf8" })
    .map((f) => `app/${f}`.replace(/\\/g, "/"))
    .filter((f) => f.endsWith("/page.tsx"));
  const paths = new Set<string>();
  for (const f of files) {
    const p = f
      .replace(/\\/g, "/")
      .replace(/^app/, "")
      .replace(/\/page\.tsx$/, "")
      .replace(/\/\([^)]+\)/g, "") // route groups are not in the URL
      .replace(/\[([^\]]+)\]/g, "x"); // a dynamic segment stands in as a literal
    paths.add(p === "" ? "/" : p);
  }
  return [...paths].sort();
}

function main() {
  const nowPattern = extractMatcher(readFileSync("proxy.ts", "utf8"));
  const basePattern = extractMatcher(
    execFileSync("git", ["show", "origin/main:proxy.ts"], { encoding: "utf8" }),
  );

  const now = matcherFor(nowPattern);
  const base = matcherFor(basePattern);

  // "runs" = the middleware processes the path = session refresh + the
  // PROTECTED_PREFIXES redirect apply to it.
  const runsNow = (p: string) => now.test(p);
  const runsBase = (p: string) => base.test(p);

  console.log(`baseline : origin/main`);
  console.log(`changed  : ${nowPattern === basePattern ? "NO" : "yes"}\n`);
  check("the matcher actually changed on this branch", nowPattern !== basePattern, true);

  // ── 1. the public page must bypass the middleware ────────────────────────
  console.log("\n⭐ the signed-link report must BYPASS the middleware (no session):");
  check("/partner-report/<token>", runsNow("/partner-report/abc123"), false);
  check("/partner-report/<base64url token>", runsNow("/partner-report/a_b-cD9"), false);
  check("(control) the existing public short link still bypasses", runsNow("/r/AbCdEfG"), false);
  check("⭐ /partner-report with NO token segment is still gated",
        runsNow("/partner-report"), true);

  // ── 2. the differential: nothing ELSE changed ────────────────────────────
  // The corpus is every real page route plus the adversarial prefix family —
  // the names one careless edit away from the exclusion.
  const corpus = [
    ...realPageRoutes(),
    "/partners", "/partner", "/partner-keys", "/partner-keys/15",
    "/partner-reports", "/partner-report", "/partnerreport",
    "/settings/partners", "/settings/partner-keys",
    "/api/campaigns/list", "/_next/static/x.js", "/favicon.ico", "/r/x",
  ];

  const changed = corpus.filter((p) => runsNow(p) !== runsBase(p));
  const expectedChanged = corpus.filter((p) => p.startsWith("/partner-report/"));

  console.log(`\n⭐ differential over ${corpus.length} paths (${realPageRoutes().length} real page routes):`);
  for (const p of changed) {
    console.log(`     changed: ${p}  (main: ${runsBase(p)} → here: ${runsNow(p)})`);
  }
  check("⭐ ONLY /partner-report/* changed behaviour", changed, expectedChanged);

  // A path that never changed cannot have "lost its gate", so this single
  // assertion covers every route in the repo — including ones added later.
  const lostGate = corpus.filter((p) => runsBase(p) && !runsNow(p) && !p.startsWith("/partner-report/"));
  check("⭐ no path that ran the middleware on main stopped running it", lostGate, []);

  // ── 3. prove this test can go red ────────────────────────────────────────
  // Everything above passes today, which by itself is worth nothing: a test
  // that cannot fail is decoration. Build the exact mistake this exists to
  // catch — the trailing slash dropped, leaving a bare `partner` — and confirm
  // the differential rejects it.
  const widened = matcherFor(nowPattern.replace("partner-report/", "partner"));
  const widenedLost = corpus.filter(
    (p) => runsBase(p) && !widened.test(p) && !p.startsWith("/partner-report/"),
  );
  check("⭐ a widened `partner` matcher IS caught (test can go red)",
        widenedLost.length > 0, true);
  console.log(`        it would silently un-gate: ${widenedLost.join(", ") || "(nothing)"}`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
