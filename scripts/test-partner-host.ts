import "./_env-preload";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CamMan answers on TWO production hostnames: a primary one (auth emails,
// internal alerts, provider webhooks) and a partner-facing one. This guard
// holds the line between them.
//
// ⭐ THE FAILURE IS SILENT IN BOTH DIRECTIONS, WHICH IS WHY IT NEEDS A GUARD.
// Nothing errors when a URL is built from the wrong host — the copy box shows a
// plausible URL, the provider accepts the registration, and it looks fine:
//   · a partner endpoint copied from a PREVIEW deployment 404s weeks later,
//     after the partner has already integrated against it;
//   · an opt-out callback registered from the PARTNER host quietly moves STOP
//     delivery off the primary name, and STOPs are a compliance obligation.
//
// ⭐ IT TESTS THE SHIPPED EXPRESSION, NOT A RETYPED COPY. partnerBase() takes
// the browser origin as an argument precisely so this file can feed it a
// real old-host and a real preview URL and assert the partner host still wins.
// An earlier draft re-typed the template literal here; that version passes
// forever no matter what the component does, which is worse than no test.
//
// The route half is necessarily structural — invoking those handlers needs auth
// and a DB — so it asserts the property that makes the bug impossible: the two
// registration routes contain NO request-host read at all, and their only
// origin source is appOrigin(), which takes zero arguments and so cannot be
// handed a request. The can-go-red control at the bottom proves the structural
// checks actually detect a reintroduced host read.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const CALLBACK_ROUTE =
  "app/api/providers/[providerId]/credentials/[credentialId]/register-callback/route.ts";
const TXR_ROUTE =
  "app/api/providers/[providerId]/credentials/[credentialId]/register-textrequest-hooks/route.ts";
const PARTNER_KEYS = "components/settings/partner-keys.tsx";
const DOCS_PAGE = "app/docs/partner-api/page.tsx";

// Real hostnames this deployment is reachable on, plus a preview URL. These are
// the inputs a browser would actually supply.
const PRIMARY = "https://camman.vercel.app";
const PREVIEW = "https://camman-git-feat-partner-host-abc123.vercel.app";
const PARTNER = "https://camman.exuma.io";

async function main() {
  // The module reads process.env at CALL time, so set it before each import-use.
  // (In a client bundle Next inlines these at BUILD time — same logic, earlier
  // substitution. What is under test here is the resolution logic.)
  const { appOrigin, partnerOrigin, partnerBase } = await import("../lib/app-origin");

  console.log("\nnormalization");
  process.env.NEXT_PUBLIC_PARTNER_HOST = "camman.exuma.io";
  check("bare hostname gains https://", partnerOrigin(), PARTNER);
  process.env.NEXT_PUBLIC_PARTNER_HOST = "https://camman.exuma.io/";
  check("trailing slash dropped", partnerOrigin(), PARTNER);
  process.env.NEXT_PUBLIC_PARTNER_HOST = "  https://camman.exuma.io  ";
  check("whitespace trimmed", partnerOrigin(), PARTNER);
  process.env.NEXT_PUBLIC_PARTNER_HOST = "";
  check("blank is null (not empty string)", partnerOrigin(), null);
  delete process.env.NEXT_PUBLIC_PARTNER_HOST;
  check("unset is null", partnerOrigin(), null);

  // ⭐ The user-facing requirement, stated as the test: the copy box shows the
  // partner URL NO MATTER which hostname the operator is browsing.
  console.log("\npartner endpoint URL — partner host CONFIGURED");
  process.env.NEXT_PUBLIC_PARTNER_HOST = PARTNER;
  check("operator on the OLD primary host", partnerBase(PRIMARY), PARTNER);
  check("operator on a PREVIEW deployment URL", partnerBase(PREVIEW), PARTNER);
  check("operator already on the partner host", partnerBase(PARTNER), PARTNER);
  check("operator on localhost", partnerBase("http://localhost:3001"), PARTNER);
  check("SSR pass with no window (empty origin)", partnerBase(""), PARTNER);

  console.log("\npartner endpoint URL — partner host UNSET (single-hostname deploy)");
  delete process.env.NEXT_PUBLIC_PARTNER_HOST;
  check("falls back to the current origin", partnerBase(PRIMARY), PRIMARY);
  check("fallback keeps preview behavior unchanged", partnerBase(PREVIEW), PREVIEW);

  // ⭐ The other half: registration must NEVER emit the partner or preview host.
  console.log("\nregistration origin — env only, partner host must not leak in");
  process.env.NEXT_PUBLIC_PARTNER_HOST = PARTNER;
  process.env.NEXT_PUBLIC_SITE_URL = PRIMARY;
  check("appOrigin is the primary host", appOrigin(), PRIMARY);
  check("appOrigin ignores NEXT_PUBLIC_PARTNER_HOST", appOrigin() === PARTNER, false);
  check("appOrigin takes no arguments (no request can reach it)", appOrigin.length, 0);
  delete process.env.NEXT_PUBLIC_SITE_URL;
  check("unset primary is null → route must 500, not fall back", appOrigin(), null);
  process.env.NEXT_PUBLIC_SITE_URL = PRIMARY;

  // Structural: the registration routes cannot read a host even in principle.
  console.log("\nregistration routes — no request-host read remains");
  const hostRead =
    /x-forwarded-host|x-forwarded-proto|headers\.get\(\s*["'`]host["'`]|nextUrl\.origin|req\.url/i;
  for (const [label, path] of [
    ["register-callback", CALLBACK_ROUTE],
    ["register-textrequest-hooks", TXR_ROUTE],
  ] as const) {
    const src = read(path);
    check(`${label}: no host-header / request-URL read`, hostRead.test(src), false);
    check(`${label}: no resolveOrigin() helper left`, /function resolveOrigin/.test(src), false);
    check(`${label}: origin comes from appOrigin()`, /\bappOrigin\(\)/.test(src), true);
  }

  // Structural: the component must go through partnerBase(), not window directly.
  console.log("\ncall sites use the shared helpers");
  const keys = read(PARTNER_KEYS);
  check("partner-keys: builds the URL via partnerBase()", /partnerBase\(/.test(keys), true);
  check(
    "partner-keys: window.location.origin appears ONLY as partnerBase's argument",
    (keys.match(/window\.location\.origin/g) ?? []).length,
    (keys.match(/partnerBase\(\s*typeof window[^)]*window\.location\.origin\s*\)/g) ?? []).length,
  );
  const docs = read(DOCS_PAGE);
  check("partner-api docs: BASE uses partnerOrigin()", /partnerOrigin\(\)/.test(docs), true);
  check(
    "partner-api docs: placeholder retained as the unset fallback",
    /your-camman-host/.test(docs),
    true,
  );

  // ⭐ CAN-GO-RED CONTROL. A structural check that cannot fail is decoration.
  // Feed the same predicates the code they are meant to reject.
  console.log("\ncontrol — the structural checks detect a reintroduced host read");
  const reintroduced = `
    function resolveOrigin(req: NextRequest): string | null {
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      if (host) return \`https://\${host}\`;
      return null;
    }`;
  check("control: host-read pattern matches the old code", hostRead.test(reintroduced), true);
  check(
    "control: resolveOrigin pattern matches the old code",
    /function resolveOrigin/.test(reintroduced),
    true,
  );
  check(
    "control: appOrigin pattern does NOT match the old code",
    /\bappOrigin\(\)/.test(reintroduced),
    false,
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

void main();
