import { existsSync, readFileSync } from "node:fs";

// ⭐ THE ONE GATE THAT PROVES PHASE 5'S CENTRAL CLAIM: the report columns are
// GENERATED from the event_types registry, not written down. If any of these
// files names an event key, adding an event type stops being a config change
// and becomes a code change — which is the entire thing this phase bought.
//
// PURE — no DB, no env. Run:
//   npx tsx --conditions=react-server scripts/test-reports-no-hardcoded-event-keys.ts
//
// ── WHY THE NEEDLES NEVER CONTAIN A NEWLINE ─────────────────────────────────
// ⭐ BOTH LINE ENDINGS. This checkout mixes CRLF and LF per file
// (core.autocrlf=true; .gitattributes pins only db/migrations/**), so every
// needle is matched against WHITESPACE-COLLAPSED source and never contains a
// newline. A multi-line needle is always absent, which makes a NEGATIVE
// assertion permanently and invisibly green — a gate that cannot fail.
//
// ── WHY THERE ARE NEGATIVE CONTROLS ─────────────────────────────────────────
// Every bar below but G0* asserts an ABSENCE. A typo in a regex makes every one
// of them pass, and the suite then reads as a working gate while checking
// nothing. G0a–G0g run the matcher against strings that MUST match and one that
// must NOT, so a broken matcher fails here first.
//
// ── WHY THE FILE LIST IS EXISTENCE-CHECKED ──────────────────────────────────
// G1 fails when a listed path does not exist. A renamed module would otherwise
// drop silently out of coverage and the gate would keep printing PASS for a
// surface it no longer reads.

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ⭐ ALL FOUR RENDERING SURFACES, plus everything between the registry and them.
// A gate that covers most of the surface is a gate that will be trusted about
// the part it does not cover.
const FILES = [
  // renderers
  "components/reports/event-columns-view.tsx",
  "components/reports/performance-report.tsx",
  "components/reports/keitaro-report.tsx",
  "app/(protected)/campaigns/[id]/page.tsx",
  "app/(protected)/creatives/page.tsx",
  "lib/reporting/telegram-report-format.ts",
  // producers
  "lib/reporting/event-columns.ts",
  "lib/reporting/performance-report.ts",
  "lib/reporting/stage-funnel.ts",
  "lib/reporting/creative-lifetime.ts",
  "lib/reporting/attribution.ts",
  "lib/reporting/report-snapshot.ts",
  "lib/keitaro/funnel.ts",
  "lib/keitaro/stage-day-conversions.ts",
  "lib/creatives/metrics-cache.ts",
  "app/api/reports/performance/route.ts",
  "app/api/keitaro/reports/route.ts",
  "app/api/campaigns/[campaignId]/stages/route.ts",
  "app/api/creatives/list/route.ts",
];

// The keys production seeds (migration 0181). A registry-driven module may name
// them in PROSE; it may not use one as a VALUE or as a PROPERTY.
//
// ⭐ BOTH FORMS. An earlier draft matched only the quoted form — but the most
// natural way to hard-code a key is unquoted property access
// (`events.purchase.n`, `m.events?.registration`), which sails straight through.
// Three needles per key:
//   quoted    "purchase" / 'purchase' / `purchase`   (a literal, a map lookup)
//   property  .purchase / ?.purchase                 (dot access)
//   key       purchase:                              (a key in an object literal,
//                                                     or a segment of a hard-coded
//                                                     generated column id)
//
// `\b` on the property and key needles is load-bearing in BOTH directions: it
// stops `t.is_purchase` and `is_purchase:` — the REGISTRY FLAGS, which every
// module here is supposed to read — from reading as hard-coded keys, and G0g
// pins that it also spares an innocent word that merely contains one.
const KEYS = ["registration", "purchase"];
const FORBIDDEN: RegExp[] = KEYS.flatMap((k) => [
  new RegExp(`["'\`]${k}["'\`]`),
  new RegExp(`\\??\\.${k}\\b`),
  new RegExp(`\\b${k}\\s*:`),
]);

/**
 * Strip comments, THEN collapse whitespace. Order matters: collapsing first
 * turns a `//` line comment into the rest of the file and the strip then eats
 * real code.
 *
 * Prose must stay free — every module here explains itself at length and those
 * explanations name the keys — so comments are removed before matching, not
 * exempted afterwards.
 */
export function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments (incl. JSDoc)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // line comments; the [^:] keeps "https://"
    .replace(/\s+/g, " ");
}

const flat = (p: string) => strip(readFileSync(p, "utf8"));

// ── G0: negative controls on the matcher itself ─────────────────────────────
check("G0a ⭐ the matcher fires on a quoted key", FORBIDDEN.some((re) => re.test(`const k = "purchase";`)));
check("G0b ⭐ the matcher fires on unquoted property access", FORBIDDEN.some((re) => re.test(`row.events.purchase.n`)));
check("G0c ⭐ the matcher fires on a key in an object literal", FORBIDDEN.some((re) => re.test(`{ purchase: 1 }`)));
check(
  "G0c2 ⭐ the matcher fires on a hard-coded generated column id",
  FORBIDDEN.some((re) => re.test(`cols.find((c) => c.id === "evtfunnel:registration:purchase")`)),
);
check("G0d ⭐ strip() removes a line comment but not the code after it", strip("// purchase\nconst a = 1;") === " const a = 1;");
check("G0e ⭐ strip() removes a block comment", strip("/* purchase */const a = 1;") === " const a = 1;");
check("G0f ⭐ strip() does NOT eat a URL's double slash", strip(`const u = "https://x/y"; const a = 1;`).includes("const a = 1;"));
check(
  "G0g ⭐ the matcher does NOT fire on an innocent word containing a key",
  FORBIDDEN.every((re) => !re.test("const repurchaseRate = 1;")),
);
check(
  "G0h ⭐ the matcher does NOT fire on the REGISTRY FLAG the modules are meant to read",
  FORBIDDEN.every((re) => !re.test("if (t.is_purchase) rank = 2;")) &&
    FORBIDDEN.every((re) => !re.test("{ is_purchase: true, counts_revenue: true }")),
);

// ── G1: the list itself cannot rot ──────────────────────────────────────────
const missing = FILES.filter((p) => !existsSync(p));
check(
  `G1 ⭐ every listed file exists (${FILES.length} files) — a renamed module must fail loudly, not drop out of coverage`,
  FILES.length >= 19 && missing.length === 0,
  missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
);

// ── G2: the gate proper ─────────────────────────────────────────────────────
//
// Deliberate omissions from FILES: lib/sale-attribution.ts (its frozen legacy
// section quotes 'lead' / 'sale', and it is the ledger's DEFINITION file, not a
// report surface) and everything under scripts/ (the tests MUST name keys —
// that is how they assert).
for (const p of FILES) {
  if (!existsSync(p)) continue; // already failed G1; do not also crash
  const src = flat(p);
  const hits = FORBIDDEN.filter((re) => re.test(src)).map((re) => {
    const m = re.exec(src);
    return `${re.source} @ …${src.slice(Math.max(0, (m?.index ?? 0) - 40), (m?.index ?? 0) + 40)}…`;
  });
  check(`G2 ${p} names no event key in code`, hits.length === 0, hits.join(" | "));
}

// ── G3: the endpoint whose empty events map means "NOT FETCHED" ─────────────
//
// ⭐ app/api/keitaro/results/route.ts uses an EXPLICIT projection that
// deliberately omits `events` and `unmapped_conversions` — nothing in that
// handler reads them. Its rows then flow through addRowToFunnel, whose
// `events?: unknown` is optional, so parseEventMap(undefined) yields `{}` and
// the tally reports `events: {}`, `unmapped: 0`. That is a FALSE empty map: it
// means "not selected", not "zero of everything". Rendered as generated columns
// it would read as a measured zero for every event type on the page.
//
// No rendering surface fetches it today (lib/authz/route-map.ts marks it
// machinery that no operator session reaches), and this bar keeps it that way.
// The POSITIVE CONTROL is the point: the same scanner must find the sibling
// endpoint the Overview table really does fetch, so a scanner that finds nothing
// fails here instead of reading as a clean bill of health.
const SURFACES = [
  "components/reports/keitaro-report.tsx",
  "components/reports/performance-report.tsx",
  "components/reports/event-columns-view.tsx",
];
const surfaceSrc = SURFACES.filter((p) => existsSync(p)).map((p) => flat(p)).join(" ");
check(
  "G3a the scanner sees the endpoint the Overview table DOES fetch (positive control)",
  surfaceSrc.includes("/api/keitaro/reports"),
);
check(
  "G3b ⭐ no rendering surface fetches /api/keitaro/results — its `events: {}` means NOT FETCHED, and generated columns over it would read as measured zeros",
  !surfaceSrc.includes("/api/keitaro/results"),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
