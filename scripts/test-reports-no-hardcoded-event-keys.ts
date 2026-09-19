import { existsSync, readdirSync, readFileSync } from "node:fs";

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
// ── WHY THE FILE LIST IS CHECKED IN BOTH DIRECTIONS ─────────────────────────
// G1 fails when a listed path does not exist. A renamed module would otherwise
// drop silently out of coverage and the gate would keep printing PASS for a
// surface it no longer reads.
//
// ⭐ THAT ALONE IS ONE-DIRECTIONAL, and a one-directional list is how
// lib/reporting/stage-keitaro-aggregate.ts — written after this gate — came to
// be an unlisted producer. G1b walks app/, lib/ and components/ and fails on a
// module that touches the breakdown and is in neither FILES nor EXEMPT; G1c is
// its positive control.

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
  "lib/reporting/stage-keitaro-aggregate.ts",
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
  FILES.length >= 20 && missing.length === 0,
  missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
);

// ── G1b: …AND THE LIST CANNOT BE SHORT ──────────────────────────────────────
//
// ⭐ G1 IS ONE-DIRECTIONAL, AND THAT IS HOW A PRODUCER GOES MISSING. It proves
// every LISTED file exists; it says nothing about a file that exists and is not
// listed. lib/reporting/stage-keitaro-aggregate.ts was written after this gate
// and had to be added by hand — the gate would have kept printing PASS over a
// producer it had never read, and the only thing that caught it was a reviewer.
//
// So the other direction is DISCOVERED: every .ts/.tsx under app/, lib/ and
// components/ that imports the event-column registry, or names the
// `unmapped_conversions` column, is a producer or a consumer of this breakdown
// and must be covered. Both needles are CODE (an import specifier, a SQL
// identifier), and comments are stripped first, so a module that merely
// discusses the breakdown in prose is not dragged in.
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
};
const TOUCHES = ["@/lib/reporting/event-columns", "unmapped_conversions"];
const allSources = ["app", "lib", "components"].flatMap((d) => walk(d));
const touching = allSources.filter((p) => {
  const s = flat(p);
  return TOUCHES.some((n) => s.includes(n));
});
// Covered = in FILES, or exempt for a stated reason. EXEMPT is deliberately
// tiny: it is not a way to drop a surface, it is the record of a decision.
const EXEMPT = [
  // The ledger's DEFINITION file, not a report surface: its frozen legacy
  // section quotes 'lead' / 'sale' (documented under G2's omissions).
  "lib/sale-attribution.ts",
];
const uncovered = touching.filter((p) => !FILES.includes(p) && !EXEMPT.includes(p));
check(
  `G1b ⭐ every module that imports the event-column registry or names unmapped_conversions is COVERED (${touching.length} of ${allSources.length} scanned)`,
  uncovered.length === 0,
  uncovered.length > 0 ? `not in FILES: ${uncovered.join(", ")}` : "",
);
// POSITIVE CONTROL on the scanner. G1b asserts an ABSENCE, so a walker pointed
// at the wrong root, or a needle that stopped matching, would find nothing and
// read as "nothing is missing" forever. These two are producers the gate exists
// for — the second is the very file that exposed G1's one-directionality.
check(
  "G1c ⭐ the scanner really does reach the producers (positive control on G1b's walk and needles)",
  touching.includes("lib/keitaro/stage-day-conversions.ts") &&
    touching.includes("lib/reporting/stage-keitaro-aggregate.ts") &&
    touching.length >= 10,
  `touching (${touching.length}): ${touching.join(", ")}`,
);
// ⭐ …AND EVERY NEEDLE SEPARATELY. `touching` is built with `.some()`, so A
// MULTI-NEEDLE SCAN BAR PASSES IF ANY ONE NEEDLE STILL MATCHES — and G1c above
// is exactly that shape. Measured on this tree: BOTH files G1c names are found
// by `unmapped_conversions` alone, so nothing in its file clause depends on the
// registry-import needle at all; only its incidental `length >= 10` threshold
// notices when that needle dies OUTRIGHT. Narrow it instead of killing it —
// measured 2026-09-19 with the needle changed to "event-columns-view" — and
// G1b and G1c both stay GREEN at 10 touching files while 8 producers
// (report-snapshot, attribution's importers, performance-report, the four API
// routes…) drop out of coverage unnoticed. The same systemic finding as T22 in
// the telegram formatter and X11 in the view suite.
//
// So: one bar per needle, each named to a file that carries THAT NEEDLE AND NOT
// THE OTHER — which is what makes the bar fail when its own needle rots. The
// isolation is asserted, not assumed: a witness that grows the other needle
// later fails here rather than quietly becoming a second copy of G1c.
const witness: ReadonlyArray<{ needle: string; file: string }> = [
  // Imports the registry; names no column.
  { needle: "@/lib/reporting/event-columns", file: "lib/reporting/report-snapshot.ts" },
  // Names the column; imports no registry. (It is also the projection WRITER —
  // the module the whole breakdown comes from — so losing it would be the
  // costliest gap of all.)
  { needle: "unmapped_conversions", file: "lib/keitaro/stage-day-conversions.ts" },
];
for (const w of witness) {
  const found = allSources.filter((p) => flat(p).includes(w.needle));
  const otherNeedles = TOUCHES.filter((n) => n !== w.needle);
  const isolated = otherNeedles.every((n) => !flat(w.file).includes(n));
  check(
    `G1c2 ⭐ the needle ${JSON.stringify(w.needle)} finds files ON ITS OWN (${found.length}), including ${w.file}, which NO other needle reaches`,
    found.includes(w.file) && isolated && found.every((p) => touching.includes(p)),
    !found.includes(w.file)
      ? `witness not found by this needle; found (${found.length}): ${found.slice(0, 6).join(", ")}`
      : !isolated
        ? `witness is NOT isolated — it also carries: ${otherNeedles.filter((n) => flat(w.file).includes(n)).join(", ")}`
        : `matches outside touching: ${found.filter((p) => !touching.includes(p)).join(", ")}`,
  );
}
// ⭐ …AND IN BOTH LINE ENDINGS. This checkout mixes CRLF and LF per file
// (core.autocrlf=true; .gitattributes pins only db/migrations/**), so a needle
// that survived strip() in one of them and not the other would silently drop a
// producer depending on which machine last touched the file — in the direction
// that makes G1b pass. The samples are HAND-WRITTEN per needle rather than
// generated from TOUCHES: a control built out of the thing it controls is a
// tautology. Each sample puts the needle on its own line (the multi-line import
// and the multi-line SQL both do) and each carries a comment mentioning it, so
// the same sample proves the match AND proves comment-stripping in that ending.
const asCrlf = (s: string) => s.replace(/\n/g, "\r\n");
const inCode = (n: string) => `// ${n} in prose\nconst q = call(\n  "${n}"\n);\n`;
const inProse = (n: string) => `// ${n} in prose\nconst a = 1;\n`;
const endingBroken = witness
  .flatMap((w) => [
    { w, label: "LF", code: inCode(w.needle), prose: inProse(w.needle) },
    { w, label: "CRLF", code: asCrlf(inCode(w.needle)), prose: asCrlf(inProse(w.needle)) },
  ])
  .filter((c) => !(strip(c.code).includes(c.w.needle) && !strip(c.prose).includes(c.w.needle)));
check(
  `G1c3 ⭐ every needle survives strip() in BOTH line endings, and is NOT matched from a comment in either (${witness.length} needles × 2)`,
  endingBroken.length === 0,
  endingBroken.map((c) => `${c.w.needle} @ ${c.label}`).join(" | "),
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

// ── G3: the endpoint that carries NO breakdown, and now says so ─────────────
//
// ⭐ app/api/keitaro/results/route.ts uses an EXPLICIT projection that
// deliberately omits `events` and `unmapped_conversions` — nothing in that
// handler reads them. Its rows flow through addRowToFunnel, whose
// `events?: unknown` is optional, so parseEventMap(undefined) yields `{}` and
// the tally held `events: {}`, `unmapped: 0`. That was a FALSE empty map: it
// meant "not selected", not "zero of everything", and rendered as generated
// columns it would read as a measured zero for every event type on the page.
//
// FIXED 2026-09-19: the route now strips all three fields with
// withoutEventBreakdown(), so the body no longer makes that claim at all (bar
// W20, scripts/test-event-columns-view.ts). This bar is NOT retired with it —
// the endpoint still carries no breakdown, so a surface that started fetching it
// for event columns would render nothing where the sibling endpoint renders
// data. No rendering surface fetches it today (lib/authz/route-map.ts marks it
// machinery that no operator session reaches), and this keeps it that way.
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
  "G3b ⭐ no rendering surface fetches /api/keitaro/results — it carries NO per-event breakdown (it selects neither column and now emits neither field), so generated columns over it would render nothing",
  !surfaceSrc.includes("/api/keitaro/results"),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
