import { readdirSync, readFileSync } from "node:fs";

// THE GUARD IDIOM, ASSERTED — because 32 hand-copied refusals asserted nothing.
//
// scripts/_require-preview-db.ts refuses to run a fixture-writing script against
// anything but an allowlisted preview database. Before this bar existed, that
// protection was a comment plus a copy-paste: nothing failed when a new script
// forgot it, and nothing noticed when a copy drifted from the original. Every
// check below is derived from the source tree, so a script added tomorrow is
// covered without anyone editing a list here.
//
// ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
//  1. No project-ref literal survives outside the helper. A Supabase project ref
//     is 20 lowercase letters; the helper is the only place one may be spelled.
//     This is what catches the next hand-copy.
//  2. Every preview-only DB script imports the helper.
//  3. The import comes FIRST — before anything that can open a connection.
//  4. Module-scope queries (if any) sit after that import.
//
// ── WHY THE IMPORT POSITION IS A CHECK AND NOT A STYLE NOTE ─────────────────
// The refusal it replaced was a STATEMENT in the module body, which under ESM
// (and under tsx's CJS output, which emits requires in source order) runs only
// after EVERY import has been evaluated. It worked purely because postgres-js
// connects lazily: `db/client` builds a client at import time but dials nothing
// until the first query. A module-scope query — in the script, or in any app
// module it imports — would therefore have outrun the guard. Expressing the
// refusal as a side-effecting IMPORT, ordered ahead of every app module, closes
// that: the process has already exited by the time `db/client` is required.
// Check 3 is what keeps that ordering true.
//
// ── THE LIMIT, STATED HONESTLY ──────────────────────────────────────────────
// The population is derived (below), not exhaustive: a script must look like a
// preview-only DB script to be enrolled — it has to touch a database AND say so
// (import the helper, or carry the `.env.demo` run line every one of these
// carries). A brand-new script that writes fixtures, imports the helper NOT AT
// ALL and never mentions `.env.demo` is invisible to this bar. That is the
// remaining hole, and it is deliberate: ~150 other scripts in this directory
// are read-only diagnostics that are SUPPOSED to run against production, so
// "every script that touches a database must refuse production" would be false.
// Closing the hole properly means every DB-writing script declaring its target
// either way; that is a bigger change than this bar.
//
// Run: npx tsx scripts/test-preview-db-guard.ts   (no database is touched)

const HELPER = "_require-preview-db";
const HELPER_FILE = `${HELPER}.ts`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
}

// ── source model ─────────────────────────────────────────────────────────────

interface ImportLine {
  /** 1-based line number. */
  line: number;
  /** The module specifier, e.g. "@/db/client". */
  from: string;
}

function importsOf(src: string): ImportLine[] {
  const out: ImportLine[] = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const m = /^\s*import\s+(?:[^"';]*?from\s*)?["']([^"']+)["']/.exec(text);
    if (m) out.push({ line: i + 1, from: m[1] });
  });
  return out;
}

/** Imports allowed to precede the guard: they cannot reach a database. */
function mayPrecedeGuard(spec: string): boolean {
  return spec === "./_env-preload" || spec === "dotenv" || spec.startsWith("node:");
}

/** Does this script reach a database at all? */
function touchesDb(src: string): boolean {
  return (
    /from\s+["'](?:@\/|\.\.\/)db\/client["']/.test(src) ||
    /import\s+["']\.\/_env-preload["']/.test(src) ||
    /from\s+["']postgres["']/.test(src) ||
    /from\s+["']drizzle-orm\/postgres-js["']/.test(src)
  );
}

/**
 * Does this script declare itself preview-only? Either it already imports the
 * helper, or it carries the `.env.demo` run line that every preview-only script
 * in this directory carries. A new fixture script copied from an existing one
 * inherits that line and is therefore enrolled automatically.
 */
function declaresPreviewTarget(src: string): boolean {
  return src.includes(HELPER) || src.includes(".env.demo");
}

/** Lines whose statement is at column 0 and performs a query — module scope. */
function moduleScopeQueryLines(src: string): number[] {
  const out: number[] = [];
  src.split(/\r?\n/).forEach((text, i) => {
    if (/^\S/.test(text) && /\b\w+\.(execute|transaction|insert|update|delete)\s*\(/.test(text)) {
      out.push(i + 1);
    }
  });
  return out;
}

interface Verdict {
  importsHelper: boolean;
  /** Imports that open a connection and were evaluated BEFORE the guard. */
  importedAhead: string[];
  /** Module-scope queries that would run before the guard. */
  queriesAhead: number[];
}

/** The whole rule, applied to one script's source. Used on disk AND on mutants. */
function verdictFor(src: string): Verdict {
  const imports = importsOf(src);
  const guard = imports.find((i) => i.from.includes(HELPER));
  if (!guard) return { importsHelper: false, importedAhead: [], queriesAhead: [] };
  return {
    importsHelper: true,
    importedAhead: imports.filter((i) => i.line < guard.line && !mayPrecedeGuard(i.from)).map((i) => i.from),
    queriesAhead: moduleScopeQueryLines(src).filter((l) => l < guard.line),
  };
}

// ── the corpus ───────────────────────────────────────────────────────────────

const files = readdirSync("scripts").filter((f) => f.endsWith(".ts"));
const sources = new Map<string, string>(files.map((f) => [f, readFileSync(`scripts/${f}`, "utf8")]));

const population = files.filter(
  (f) => f !== HELPER_FILE && touchesDb(sources.get(f)!) && declaresPreviewTarget(sources.get(f)!),
);

function main() {
  console.log("=== preview-DB guard coverage ===\n");
  console.log(`scripts scanned: ${files.length}`);
  console.log(`preview-only DB scripts (derived): ${population.length}\n`);

  // An empty population would make every check below vacuously true.
  check("the derived population is non-empty", population.length > 0, `${population.length} scripts`);

  // ── 1. the literal lives in exactly one file ───────────────────────────────
  // A Supabase project ref is 20 lowercase letters. Anywhere else in scripts/,
  // a string of that shape is a hand-copied guard.
  const strayLiteral: string[] = [];
  for (const f of files) {
    if (f === HELPER_FILE) continue;
    for (const m of sources.get(f)!.matchAll(/["'`]([a-z]{20})["'`]/g)) strayLiteral.push(`${f}:${m[1]}`);
  }
  check("⭐ no project-ref literal outside the helper (a re-copied guard)", strayLiteral.length === 0,
        strayLiteral.join(", "));
  const helperSrc = sources.get(HELPER_FILE);
  check(`${HELPER_FILE} exists and still spells at least one allowlisted ref`,
        !!helperSrc && /["']([a-z]{20})["']/.test(helperSrc));

  // ── 2/3/4. the idiom, per script ───────────────────────────────────────────
  const missing: string[] = [];
  const outOfOrder: string[] = [];
  const queriesFirst: string[] = [];
  for (const f of population) {
    const v = verdictFor(sources.get(f)!);
    if (!v.importsHelper) missing.push(f);
    if (v.importedAhead.length) outOfOrder.push(`${f} (after ${v.importedAhead.join(", ")})`);
    if (v.queriesAhead.length) queriesFirst.push(`${f}:${v.queriesAhead.join(",")}`);
  }
  check(`⭐ every preview-only DB script imports ${HELPER} (${population.length} scripts)`,
        missing.length === 0, missing.join(", "));
  check("⭐ the guard import precedes every import that can open a connection",
        outOfOrder.length === 0, outOfOrder.join("; "));
  check("no module-scope query runs before the guard import",
        queriesFirst.length === 0, queriesFirst.join(", "));

  // ── 5. prove each check can go red ─────────────────────────────────────────
  // Everything above passes, which on its own proves nothing: a bar that cannot
  // fail is decoration. Build the three mistakes it exists to catch, out of a
  // REAL script's source, and confirm each is rejected.
  console.log("\ncan-go-red controls (mutations held in memory; no file is written):");
  const sample = population.find((f) => /^test-/.test(f))!;
  const src = sources.get(sample)!;
  console.log(`  mutating ${sample}`);

  const dropped = src.replace(/^.*_require-preview-db.*$\r?\n/m, "");
  check("⭐ deleting the guard import IS caught", verdictFor(dropped).importsHelper === false);

  // Move the guard below an app import: the shape that silently reopens the
  // hoisting hole, and the one a reviewer's eye slides straight past.
  const guardLine = src.split(/\r?\n/).find((l) => l.includes(HELPER))!;
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const moved = src.replace(`${guardLine}${eol}`, "").replace(
    /^(.*from ["'](?:@\/|\.\.\/)(?:db|lib)\/[^"']+["'];.*)$/m,
    `$1${eol}${guardLine}`,
  );
  const movedVerdict = verdictFor(moved);
  check("⭐ moving the guard below an app import IS caught",
        movedVerdict.importsHelper && movedVerdict.importedAhead.length > 0,
        `importedAhead=${movedVerdict.importedAhead.join(", ") || "(none — mutation did not apply)"}`);

  // A module-scope query ahead of the guard — the hazard the ordering closes.
  const withEarlyQuery = `await db.execute(sql\`select 1\`);${eol}${src}`;
  check("⭐ a module-scope query ahead of the guard IS caught",
        verdictFor(withEarlyQuery).queriesAhead.length > 0);

  // And a re-copied literal. Assembled at runtime on purpose — spelled out here
  // it would be a 20-letter literal in scripts/, and check 1 would fail on this
  // very file.
  const fakeRef = "abcdefghij" + "klmnopqrst";
  const recopied = `const PREVIEW_REF = "${fakeRef}";${eol}${src}`;
  check("⭐ a re-copied project-ref literal IS caught",
        /["'`]([a-z]{20})["'`]/.test(recopied));

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
