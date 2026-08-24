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
// ⭐ IT ASSERTS AN INVARIANT, NOT A DIFF. The primary check is
// isIntentionallyPublic(): every path in the corpus must run the middleware
// UNLESS it is deliberately public. Two earlier designs were worse and both
// failed in ways worth remembering:
//   1. A list of "routes I think should still be gated" — that only tests the
//      author's imagination, and mine was wrong about which routes were even at
//      risk (the lookahead is root-anchored; see below).
//   2. A pure differential against origin/main — which went RED the moment it
//      was merged, because its baseline became itself. A guard that cannot
//      survive its own merge is worse than none: someone deletes it.
// The differential still runs, but only when the matcher actually differs.
//
// ⚠️ THE LOOKAHEAD IS ANCHORED AT THE PATH ROOT. `/((?!…|partner-report/|…).*)`
// inspects only the text right after the leading slash, so an exclusion can
// only ever affect TOP-LEVEL paths. `/settings/partners` could not have been
// swallowed even by a bare `partner`; `/partners` and `/partner-keys` could.
// The can-go-red control at the bottom demonstrates exactly which paths a
// widened entry would un-gate, rather than asking anyone to trust this note.
//
// The matcher is read from proxy.ts itself — a re-typed copy would keep passing
// after someone widened the real one.

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

/**
 * The DURABLE invariant: which paths are deliberately public.
 *
 * ⭐ THIS, NOT A DIFF AGAINST main, IS THE PRIMARY ASSERTION. The first version
 * of this test was a pure differential against `origin/main` — which meant it
 * went RED the moment it was merged, because its baseline became itself. A guard
 * that cannot survive its own merge is worse than no guard: someone deletes it.
 *
 * So the invariant is stated directly and holds for ever. The differential below
 * still runs, but only as a bonus when the matcher actually differs from main.
 */
function isIntentionallyPublic(p: string): boolean {
  return (
    p.startsWith("/_next/static/") ||
    p.startsWith("/_next/image") ||
    p.startsWith("/_next/data") ||
    p === "/favicon.ico" ||
    p.startsWith("/r/") ||               // public short-link redirect
    p.startsWith("/partner-report/") ||  // public signed report (Drip P7)
    // ⚠️ EXACT path, not a prefix — this one is a leaf page, so
    // `/docs/partner-api-internal` must stay gated. See proxy.ts.
    p === "/docs/partner-api" ||         // public partner API docs
    p === "/docs/partner-api/" ||
    p.startsWith("/api/") ||             // every route self-authenticates
    /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf)$/.test(p)
  );
}

function main() {
  const nowPattern = extractMatcher(readFileSync("proxy.ts", "utf8"));
  const now = matcherFor(nowPattern);

  // "runs" = the middleware processes the path = session refresh + the
  // PROTECTED_PREFIXES redirect apply to it.
  const runsNow = (p: string) => now.test(p);

  // The corpus is every real page route plus the adversarial prefix family —
  // the names one careless edit away from the exclusion.
  const corpus = [
    ...realPageRoutes(),
    "/partners", "/partner", "/partner-keys", "/partner-keys/15",
    "/partner-reports", "/partner-report", "/partnerreport",
    "/settings/partners", "/settings/partner-keys",
    // the docs/partner-api family — a bare prefix would swallow these
    "/docs", "/docs/partner-api", "/docs/partner-api/", "/docs/partner-api-internal",
    "/docs/partner-apix", "/docs/internal", "/docs/partner-api/extra",
    "/api/campaigns/list", "/_next/static/x.js", "/favicon.ico", "/r/x",
  ].filter((p, i, a) => a.indexOf(p) === i); // a real page route may also be in the adversarial list

  // ── 1. the public pages must bypass the middleware ───────────────────────
  console.log("⭐ the PUBLIC pages must bypass the middleware (no session):");
  check("/partner-report/<token>", runsNow("/partner-report/abc123"), false);
  check("/partner-report/<base64url token>", runsNow("/partner-report/a_b-cD9"), false);
  check("/docs/partner-api", runsNow("/docs/partner-api"), false);
  check("/docs/partner-api/ (trailing slash)", runsNow("/docs/partner-api/"), false);
  check("(control) the existing public short link still bypasses", runsNow("/r/AbCdEfG"), false);

  console.log("\n⭐ ...and the near-misses around them stay GATED:");
  check("⭐ /partner-report with NO token segment", runsNow("/partner-report"), true);
  check("⭐ /docs (the parent) is NOT public", runsNow("/docs"), true);
  check("⭐ /docs/partner-api-internal is NOT public", runsNow("/docs/partner-api-internal"), true);
  check("⭐ /docs/partner-api/extra (a child) is NOT public",
        runsNow("/docs/partner-api/extra"), true);

  // ── 2. the invariant, over every path ────────────────────────────────────
  console.log(`\n⭐ the invariant over ${corpus.length} paths (${realPageRoutes().length} real page routes):`);
  const wrong = corpus.filter((p) => runsNow(p) === isIntentionallyPublic(p));
  for (const p of wrong) {
    console.log(`     ${p}: middleware runs=${runsNow(p)}, intended public=${isIntentionallyPublic(p)}`);
  }
  check("⭐ every path is gated unless it is deliberately public", wrong, []);

  // ── 3. the differential against main, when there IS one ──────────────────
  // Informational on main itself; a real regression check on a branch that
  // touches the matcher.
  let basePattern = nowPattern;
  try {
    basePattern = extractMatcher(
      execFileSync("git", ["show", "origin/main:proxy.ts"], { encoding: "utf8" }),
    );
  } catch {
    console.log("\n(no origin/main to diff against — skipping the differential)");
  }
  if (basePattern !== nowPattern) {
    const base = matcherFor(basePattern);
    const changed = corpus.filter((p) => runsNow(p) !== base.test(p));
    console.log(`\n⭐ the matcher DIFFERS from origin/main — ${changed.length} path(s) changed:`);
    for (const p of changed) {
      console.log(`     ${p}  (main: ${base.test(p)} → here: ${runsNow(p)})`);
    }
    const lostGate = changed.filter((p) => base.test(p) && !isIntentionallyPublic(p));
    check("⭐ no path lost its gate that is not deliberately public", lostGate, []);
  } else {
    console.log("\nmatcher is identical to origin/main — differential not applicable.");
  }

  // ── 4. prove this test can go red ────────────────────────────────────────
  // Everything above passes today, which by itself is worth nothing: a test
  // that cannot fail is decoration. Build the exact mistake this exists to
  // catch — the trailing slash dropped, leaving a bare `partner` — and confirm
  // the invariant check rejects it.
  const widened = matcherFor(
    nowPattern.replace("partner-report/", "partner").replace("docs/partner-api/?$", "docs"),
  );
  const widenedLost = corpus.filter(
    (p) => !widened.test(p) && !isIntentionallyPublic(p),
  );
  check("⭐ widened `partner` + `docs` entries ARE caught (this test can go red)",
        widenedLost.length > 0, true);
  console.log(`        it would silently un-gate: ${widenedLost.join(", ") || "(nothing)"}`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
