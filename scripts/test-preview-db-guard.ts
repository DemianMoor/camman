import { readdirSync, readFileSync, existsSync } from "node:fs";

// THE GUARD IDIOM, ASSERTED — because a hand-copied refusal asserts nothing.
//
// scripts/_require-preview-db.ts refuses to run a database-WRITING script
// against anything but an allowlisted preview database. Without this bar that
// protection is a comment plus a copy-paste: nothing fails when a new script
// forgets it, and nothing notices when a copy drifts from the original. Every
// check below is derived from the source tree, so a script added tomorrow is
// covered without anyone editing a list here.
//
// Run: npx tsx scripts/test-preview-db-guard.ts   (no database is touched)
// Or:  npm run check:guards
//
// ── HOW THE POPULATION IS DERIVED ───────────────────────────────────────────
// A script is in scope when it (a) reaches a database at all and (b) contains a
// WRITE signal — an ORM .insert/.update/.delete, a write verb in raw SQL, or
// `.unsafe(`, the raw-SQL escape hatch that could be either. The default is
// therefore PROTECTED: a new fixture script is enrolled the moment it writes,
// and a reviewer has to say so out loud to opt one out.
//
// Everything opted out is named in EXCLUSIONS below WITH A REASON. That list is
// the reviewable surface of this bar: it is short, every entry states why, and
// an entry naming a file that no longer exists fails the bar rather than
// rotting quietly.
//
// ── WHY THE IMPORT POSITION IS A CHECK AND NOT A STYLE NOTE ─────────────────
// A refusal written as a STATEMENT in the module body runs, under ESM (and
// under tsx's CJS output, which emits requires in source order), only after
// EVERY import has been evaluated. It would work purely because postgres-js
// connects lazily: `db/client` builds a client at import time but dials nothing
// until the first query. A module-scope query — in the script, or in any app
// module it imports — would outrun it. Expressing the refusal as a
// side-effecting IMPORT, ordered ahead of every app module, closes that: the
// process has already exited by the time `db/client` is required. Check 3 keeps
// that ordering true.
//
// ── THE LIMIT, STATED HONESTLY ──────────────────────────────────────────────
// The write signal is a SOURCE scan, so a script whose only writes happen
// inside an app library it calls — `ingestKeitaroConversions(db, …)`, say — has
// no write token of its own and is invisible here. Those exist (the conversion
// backfill is one) and they are handled by being named in EXCLUSIONS anyway.
// Closing that hole properly means transitive import analysis; measured against
// this tree it flags ~39 more scripts, nearly all read-only diagnostics that
// merely import a write-capable module, and it trades a crisp signal for a
// noisy one. If you add a script that writes ONLY through a library, add the
// guard import yourself — see docs/07-conventions.md.

const HELPER = "_require-preview-db";
const HELPER_FILE = `${HELPER}.ts`;
/** This bar's own file: it quotes db/client and .insert( in its controls. */
const SELF = "test-preview-db-guard.ts";

/**
 * Scripts that predate the shared helper and still carry their OWN inline
 * DATABASE_URL check, with a project ref spelled in the file. The helper import
 * is what actually protects them; a local check is redundant belt-and-braces,
 * and some also check things the helper does not — NEXT_PUBLIC_SUPABASE_URL, a
 * camman-* preview BASE_URL — so they are NOT mechanically strippable.
 *
 * The list may only SHRINK, and it is now EMPTY: the 14 entries it held were
 * cleaned on feat/conversion-events-p4 (the API-side halves kept, reading the
 * ref from requirePreviewDb() instead of a literal) and that branch merged here
 * on 2026-09-18. With no entries, check 1 covers every file in scripts/ with no
 * exemption — which is the end state this list existed to converge on. Add an
 * entry only for a script that genuinely cannot drop its literal yet.
 */
const LEGACY_REF_LITERALS: ReadonlyArray<string> = [];

/**
 * Scripts that carry a write signal but are DELIBERATELY not guarded, each with
 * the reason. Adding an entry here is a review decision, not a convenience.
 */
const EXCLUSIONS: ReadonlyArray<{ file: string; why: string }> = [
  // ── production operations tooling: changing production IS the purpose ──────
  { file: "apply-0099.ts", why: "controlled apply of migration 0099 against the production database" },
  { file: "apply-ahoi-stage-sends-index-concurrent.ts", why: "builds a production index with CREATE INDEX CONCURRENTLY" },
  { file: "apply-carrier-day-index-concurrent.ts", why: "builds a production index with CREATE INDEX CONCURRENTLY" },
  { file: "apply-eligible-indexes-concurrent.ts", why: "builds production indexes with CREATE INDEX CONCURRENTLY" },
  { file: "apply-links-short-domain-index-concurrent.ts", why: "builds a production index with CREATE INDEX CONCURRENTLY" },
  { file: "apply-lookup-migrations.ts", why: "controlled, ordered apply of migrations 0095–0098 against production" },
  { file: "apply-trgm-concurrent.ts", why: "builds production indexes with CREATE INDEX CONCURRENTLY" },
  { file: "backfill-content-dedup-exposures.ts", why: "one-shot production backfill of the content-dedup ledgers" },
  { file: "backfill-conversion-events.ts", why: "one-shot production backfill; writes only behind --apply (writes via lib/conversions/ingest, so it carries no write token of its own)" },
  { file: "backfill-creative-spam-scores.ts", why: "one-shot production backfill of creatives.spam_score" },
  { file: "backfill-drip-journey-lifecycle.ts", why: "one-shot production backfill; closes journeys already terminal in fact" },
  { file: "backfill-guidekn-destinations.ts", why: "one-shot production repair; writes only behind --apply" },
  { file: "backfill-optout-attributions.ts", why: "one-shot production backfill of opt_out_attributions" },
  { file: "backfill-optout-latest-stage.ts", why: "one-shot production backfill; writes only behind --apply" },
  { file: "backfill-provider-credentials-encryption.ts", why: "one-shot production backfill; writes only behind --apply" },
  { file: "backfill-rescore-datacenter.ts", why: "one-shot production rescore; writes only behind --apply" },
  { file: "backfill-stage-results.ts", why: "one-shot production backfill of the per-stage Results counters" },
  { file: "backfill-stage-send-provider-phone.ts", why: "one-shot production backfill; writes only behind --apply" },
  { file: "backfill-stage-total-cost.ts", why: "one-shot production backfill of campaign_stages.total_cost" },
  { file: "backfill-tracking-ids.ts", why: "one-shot production backfill of tracking_ids (CLAUDE.md §10g)" },
  { file: "cleanup-stage-test-fixtures.ts", why: "exists to delete test fixtures left in PRODUCTION; --apply, hardcoded reviewed ids" },
  { file: "delete-orphan-test-offers.ts", why: "exists to delete orphan test rows left in PRODUCTION" },
  { file: "drain-texthub-inbox.ts", why: "ingests real STOPs from the live provider inbox into production; --apply" },
  { file: "import-texthub-optouts.ts", why: "imports real opt-outs from a provider export into production; --apply" },
  { file: "resync-stage-day-conversions.ts", why: "one-shot production re-derive of the stage-day conversion columns; dry-run default, writes only behind --apply (writes via lib/keitaro/stage-day-conversions, so it carries no write token of its own)" },
  { file: "seed-ahoi-number-credential.ts", why: "seeds the real Ahoi sending number + credential in production" },
  { file: "seed-ahoi-webhook-token.ts", why: "mints the real production inbound-webhook token" },
  { file: "seed-tells-webhook-token.ts", why: "mints the real production inbound-webhook token" },
  { file: "set-textrequest-phone-config.ts", why: "one-off production data repair; writes only behind --apply" },

  // ── deliberate production proofs: preview cannot prove the deployed system ─
  { file: "verify-drip-enrichment-production.ts", why: "production proof of the deployed enrichment sweeper; synthetic +1999 numbers, self-cleaning" },
  { file: "verify-drip-routing-production.ts", why: "production proof of the deployed routing rules; synthetic fixtures, self-cleaning" },
  { file: "verify-intake-production.ts", why: "production proof of the deployed intake endpoint; sandbox leads through a sandbox key" },

  // ── writes only inside an always-rolled-back tx, AND assert about real rows ─
  { file: "test-brand-number-guard.ts", why: "probe row is written inside a tx that always rolls back; asserts about a real production brand/number mismatch" },
  { file: "test-drip-regular-unaffected.ts", why: "fixtures written inside a tx that always rolls back; asserts SET EQUALITY against production" },
  { file: "verify-keitaro-batch-update.ts", why: "UPDATEs inside a BEGIN…ROLLBACK; needs real stage_sends rows to mean anything" },
  { file: "verify-purchase-rule-definition.ts", why: "deliberately reads live data; its one synthesized write is inside a tx that always rolls back" },

  // ── read-only: matched the scan, issue no write ────────────────────────────
  { file: "perf-baseline.ts", why: "read-only: EXPLAIN ANALYZE over SELECTs (the .unsafe( token is the match)" },
  { file: "perf-baseline-tier2.ts", why: "read-only: EXPLAIN ANALYZE over SELECTs" },
  { file: "perf-baseline-tier3.ts", why: "read-only: EXPLAIN ANALYZE over SELECTs" },
  { file: "test-creative-metrics-cache.ts", why: "read-only: the .unsafe( call is the ground-truth SELECT" },
  { file: "verify-audience-report.ts", why: "read-only and server-enforced: every query runs inside begin(\"… read only\")" },
  { file: "verify-conversion-events.ts", why: "read-only conversion verification against production; every statement is a SELECT" },
  { file: "verify-migration-integrity.ts", why: "read-only diagnostic (CLAUDE.md §11); the match is createHash().update()" },
  { file: "verify-send-state-perf.ts", why: "read-only: EXPLAIN ANALYZE over a SELECT" },
];

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

/** Source with comments blanked, so prose never counts as a write. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");
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
    /from\s+["'](?:@\/|\.\.\/|\.\/)db\/client["']/.test(src) ||
    /import\s+["']\.\/_env-preload["']/.test(src) ||
    /from\s+["']postgres["']/.test(src) ||
    /from\s+["']drizzle-orm\/postgres-js["']/.test(src)
  );
}

/**
 * Does this script carry a WRITE signal? An ORM write, a raw-SQL write verb, or
 * `.unsafe(` — the raw-SQL escape hatch, counted because it can be either and
 * the read-only users of it are few enough to name in EXCLUSIONS.
 */
function writesDb(src: string): boolean {
  return /(\.\s*(insert|update|delete)\s*\(|insert\s+into\b|delete\s+from\b|update\s+[a-z_"][\w".]*(\s+(as\s+)?[a-z_][\w]*)?\s+set\b|truncate\b|create\s+(table|index|unique\s+index|or\s+replace)|drop\s+(table|index)|alter\s+table|refresh\s+materialized\s+view|\.unsafe\s*\(|onConflict)/i.test(
    src,
  );
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
const code = new Map<string, string>(files.map((f) => [f, stripComments(sources.get(f)!)]));

const excluded = new Set(EXCLUSIONS.map((e) => e.file));
const writers = files.filter(
  (f) => f !== HELPER_FILE && f !== SELF && touchesDb(code.get(f)!) && writesDb(code.get(f)!),
);
const population = writers.filter((f) => !excluded.has(f));
/** Also ordering-check anything that opted IN without a write signal. */
const alsoEnrolled = files.filter(
  (f) => f !== HELPER_FILE && !population.includes(f) && sources.get(f)!.includes(`"./${HELPER}"`),
);

function main() {
  console.log("=== preview-DB guard coverage ===\n");
  console.log(`scripts scanned:            ${files.length}`);
  console.log(`write-capable (derived):    ${writers.length}`);
  console.log(`deliberate exclusions:      ${EXCLUSIONS.length}`);
  console.log(`must carry the guard:       ${population.length}\n`);

  // An empty population would make every check below vacuously true.
  check("the derived population is non-empty", population.length > 0, `${population.length} scripts`);

  // ── 1. the literal lives in exactly one file ───────────────────────────────
  // A Supabase project ref is 20 lowercase letters. Anywhere else in scripts/,
  // a string of that shape is a hand-copied guard.
  const legacy = new Set(LEGACY_REF_LITERALS);
  const strayLiteral: string[] = [];
  for (const f of files) {
    if (f === HELPER_FILE || legacy.has(f)) continue;
    for (const m of sources.get(f)!.matchAll(/["'`]([a-z]{20})["'`]/g)) strayLiteral.push(`${f}:${m[1]}`);
  }
  check("⭐ no NEW project-ref literal outside the helper (a re-copied guard)", strayLiteral.length === 0,
        strayLiteral.join(", "));
  // The legacy list may only shrink, and never protects a script on its own.
  const legacyGone = LEGACY_REF_LITERALS.filter((f) => !existsSync(`scripts/${f}`));
  const legacyClean = LEGACY_REF_LITERALS.filter(
    (f) => existsSync(`scripts/${f}`) && !/["'`]([a-z]{20})["'`]/.test(sources.get(f) ?? ""),
  );
  check("the legacy inline-guard list has no stale entries", legacyGone.length === 0 && legacyClean.length === 0,
        [...legacyGone.map((f) => `${f} (gone)`), ...legacyClean.map((f) => `${f} (cleaned — remove it from the list)`)].join(", "));
  const legacyUnguarded = LEGACY_REF_LITERALS.filter((f) => !(sources.get(f) ?? "").includes(`"./${HELPER}"`));
  check("⭐ every legacy inline guard is backed by the real helper import", legacyUnguarded.length === 0,
        legacyUnguarded.join(", "));
  const helperSrc = sources.get(HELPER_FILE);
  check(`${HELPER_FILE} exists and still spells at least one allowlisted ref`,
        !!helperSrc && /["']([a-z]{20})["']/.test(helperSrc));

  // ── 2/3/4. the idiom, per script ───────────────────────────────────────────
  const missing: string[] = [];
  const outOfOrder: string[] = [];
  const queriesFirst: string[] = [];
  for (const f of [...population, ...alsoEnrolled]) {
    const v = verdictFor(sources.get(f)!);
    if (!v.importsHelper) missing.push(f);
    if (v.importedAhead.length) outOfOrder.push(`${f} (after ${v.importedAhead.join(", ")})`);
    if (v.queriesAhead.length) queriesFirst.push(`${f}:${v.queriesAhead.join(",")}`);
  }
  check(`⭐ every write-capable script imports ${HELPER} (${population.length} scripts)`,
        missing.length === 0, missing.join(", "));
  check("⭐ the guard import precedes every import that can open a connection",
        outOfOrder.length === 0, outOfOrder.join("; "));
  check("no module-scope query runs before the guard import",
        queriesFirst.length === 0, queriesFirst.join(", "));

  // ── 5. the exclusion list cannot rot ───────────────────────────────────────
  const goneExclusions = EXCLUSIONS.filter((e) => !existsSync(`scripts/${e.file}`)).map((e) => e.file);
  check("every exclusion names a script that still exists", goneExclusions.length === 0, goneExclusions.join(", "));
  const unreasoned = EXCLUSIONS.filter((e) => e.why.trim().length < 20).map((e) => e.file);
  check("every exclusion states a reason", unreasoned.length === 0, unreasoned.join(", "));
  const contradictory = EXCLUSIONS.filter((e) => (sources.get(e.file) ?? "").includes(`"./${HELPER}"`)).map((e) => e.file);
  check("no script is both excluded and guarded", contradictory.length === 0, contradictory.join(", "));

  // ── 6. prove each check can go red ─────────────────────────────────────────
  // Everything above passes, which on its own proves nothing: a bar that cannot
  // fail is decoration. Build the mistakes it exists to catch, out of a REAL
  // script's source, and confirm each is rejected.
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

  // A new write-capable script that forgot the guard.
  const newcomer = `import { db } from "../db/client";${eol}await db.insert(foo).values({});${eol}`;
  check("⭐ a brand-new write-capable script with no guard IS caught",
        touchesDb(newcomer) && writesDb(newcomer) && verdictFor(newcomer).importsHelper === false);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
