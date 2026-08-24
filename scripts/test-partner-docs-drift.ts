import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";

import PartnerApiDocsPage from "@/app/docs/partner-api/page";
import { RESPONSE_CODES } from "@/lib/intake/api-contract";
import { LEAD_FIELDS, LEAD_FIELD_KEYS, canonicalFieldKey } from "@/lib/intake/fields";

// Drift guard for the PUBLIC partner API docs (/docs/partner-api).
//
// ⭐ IT RENDERS THE ACTUAL PAGE AND PARSES WHAT CAME OUT. Comparing
// `LEAD_FIELDS` to `LEAD_FIELDS` would be a tautology that passes no matter what
// the page does; the only way to catch a page that hardcodes, filters or forgets
// a field is to look at its OUTPUT. So the page is rendered to static markup and
// the field list is read back out of the rendered table.
//
// ⭐ AND THE "ACCEPTED" SIDE IS PROBED THROUGH THE REAL FUNCTION. The endpoint
// decides what it accepts by calling canonicalFieldKey(); this test calls the
// same function rather than reading the array the page reads. A field that is
// declared but not actually resolvable — or an alias that collides with another
// field — fails here, not in a partner's integration.
//
// Runs in `npm run vercel-build`, which is this repo's only pre-merge gate
// (there is no GitHub Actions workflow), so drift cannot reach production.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Field keys the PAGE actually rendered, read out of its markup. */
function fieldsOnPage(html: string): string[] {
  return [...html.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]).sort();
}

/** Status codes the PAGE actually rendered. */
function statusesOnPage(html: string): number[] {
  return [...html.matchAll(/data-status="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** Statuses the intake ROUTE can actually return, read from its source. */
function statusesInRoute(): number[] {
  const src = readFileSync("app/api/intake/leads/[token]/route.ts", "utf8");
  const found = new Set<number>();
  for (const m of src.matchAll(/jsonError\(\s*(\d{3})/g)) found.add(Number(m[1]));
  for (const m of src.matchAll(/status:\s*(\d{3})\s*[,}]/g)) found.add(Number(m[1]));
  for (const m of src.matchAll(/\{\s*status:\s*(\d{3})\s*\}/g)) found.add(Number(m[1]));
  // 404 is the "no token in the path" case — not reachable through a real
  // partner URL (the route would not match at all), so it is deliberately not
  // documented as a partner-actionable code.
  found.delete(404);
  return [...found].sort((a, b) => a - b);
}

function main() {
  const html = renderToStaticMarkup(PartnerApiDocsPage() as React.ReactElement);
  console.log(`rendered /docs/partner-api — ${html.length.toLocaleString()} bytes\n`);

  // ── 1. the field list ────────────────────────────────────────────────────
  console.log("⭐ the page's field list vs what the endpoint accepts:");
  const onPage = fieldsOnPage(html);
  const accepted = [...LEAD_FIELD_KEYS].sort();
  console.log(`  page:     ${onPage.join(", ")}`);
  check("⭐ the rendered field list EQUALS the endpoint's accepted field list",
        onPage, accepted);

  // Probed through the real resolver, not the array — this is what the endpoint
  // does with an incoming key.
  const notResolvable = onPage.filter((k) => canonicalFieldKey(k) !== k);
  check("⭐ every documented field actually resolves via canonicalFieldKey()",
        notResolvable, []);

  // Every documented ALIAS must resolve to its own field. An alias that
  // silently resolves elsewhere is a doc that lies in the most expensive way:
  // the partner sends it and the value lands on the wrong field.
  const badAlias: string[] = [];
  for (const f of LEAD_FIELDS) {
    for (const a of f.aliases) {
      if (canonicalFieldKey(a) !== f.key) badAlias.push(`${a} -> ${canonicalFieldKey(a)} (want ${f.key})`);
    }
  }
  check("⭐ every documented alias resolves to its own field", badAlias, []);

  // ── 1b. the COMMITTED anchor ─────────────────────────────────────────────
  // ⭐ WITHOUT THIS, REMOVING A FIELD FROM THE SHARED DEFINITION IS INVISIBLE.
  // The page renders from LEAD_FIELDS and the "accepted" list IS LEAD_FIELDS, so
  // deleting a field moves both sides together and check 1 stays green. Measured
  // — I deleted `state` and the whole suite passed.
  //
  // The committed markdown at docs/partners/lead-intake.md is the fixed point:
  // it only changes when someone regenerates it. So a field leaving the shared
  // definition shows up HERE, as the page and the committed doc disagreeing, and
  // the fix (regenerate) puts the removal in the PR diff where it belongs —
  // which is also what prompts the changelog entry the convention requires.
  console.log("\n⭐ the page vs the COMMITTED partner doc (catches a removal):");
  const md = readFileSync("docs/partners/lead-intake.md", "utf8");
  const inMarkdown = [...md.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
  check("⭐ the page's fields equal the committed doc's fields", onPage, inMarkdown);

  // ── 2. required-ness ─────────────────────────────────────────────────────
  console.log("\n⭐ required-ness matches:");
  const requiredOnPage = LEAD_FIELDS.filter((f) => f.required).map((f) => f.key);
  check("at least one field is required (a docs page saying nothing is required is a bug)",
        requiredOnPage.length > 0, true);
  // The page prints the required marker in the table; assert the count of
  // rendered ">yes<" cells matches, so a rendering change that drops the flag
  // is caught rather than silently telling partners nothing is mandatory.
  const yesCells = [...html.matchAll(/<span class="font-medium">yes<\/span>/g)].length;
  check("⭐ the page renders exactly one `yes` per required field",
        yesCells, requiredOnPage.length);

  // ── 3. response codes ────────────────────────────────────────────────────
  console.log("\n⭐ the page's response codes vs the route's:");
  const pageCodes = statusesOnPage(html);
  const routeCodes = statusesInRoute();
  console.log(`  page:  ${pageCodes.join(", ")}`);
  console.log(`  route: ${routeCodes.join(", ")}`);
  check("⭐ every status the route can return is documented",
        routeCodes.filter((c) => !pageCodes.includes(c)), []);
  check("⭐ and the page documents no status the route cannot return",
        pageCodes.filter((c) => !routeCodes.includes(c)), []);
  check("the contract module and the page agree",
        pageCodes, RESPONSE_CODES.map((r) => r.status).sort((a, b) => a - b));

  // ── 4. nothing internal leaked ───────────────────────────────────────────
  // ⚠️ This is a PUBLIC page. A table name or a provider name reaching it is a
  // disclosure, and the kind that gets pasted in during a hurried edit.
  console.log("\n⭐ no internal detail on a public page:");
  const banned = [
    "lead_inbox", "partner_keys", "drip_journeys", "stage_sends", "campaign_",
    "supabase", "vercel", "postgres", "texthub", "telnyx", "tells.co", "keitaro",
    "sendnexus", "simpletexting", "org_id", "secret_hash", "DATABASE_URL",
  ];
  const leaked = banned.filter((b) => html.toLowerCase().includes(b.toLowerCase()));
  check("⭐ no table, infra or provider name appears", leaked, []);

  // A real secret can only get here by being pasted in; placeholders are fine.
  const secretish = [...html.matchAll(/(?:Bearer|secret)[^<]{0,40}/gi)]
    .map((m) => m[0])
    .filter((s) => !/YOUR_SECRET|&lt;|placeholder/i.test(s))
    .filter((s) => /[A-Za-z0-9_-]{24,}/.test(s));
  check("⭐ no credential-shaped string outside the placeholders", secretish, []);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
