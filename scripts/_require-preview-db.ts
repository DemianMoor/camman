// PREVIEW-ONLY GUARD FOR FIXTURE-WRITING SCRIPTS — one copy, imported, not retyped.
//
// `.env.local` is PRODUCTION. Roughly a dozen suites in scripts/ seed fixtures,
// and an ordinary mistake (forgetting the `DATABASE_URL=…` prefix, a shell that
// swallowed it, a copied command line) points them at prod. This module is the
// single refusal.
//
// ⭐ IT IS AN ALLOWLIST, NOT A DENYLIST. The guard it replaces asked "does the
// URL contain the production project ref?" and ran if it did not. Everything
// that reaches the same database WITHOUT spelling that ref passed straight
// through: a raw IP, a custom hostname, a CNAME'd pooler alias, a second
// connection string for the same cluster, a future prod project with a new ref.
// A denylist has to enumerate every way to say "prod" and is wrong the moment
// one is added. This asks the opposite question — "is this one of the databases
// I am allowed to write to?" — and refuses everything else, including targets
// nobody has thought of yet. Adding a preview database is one line here;
// adding a production database is impossible by construction.
//
// ⭐ IT REFUSES AN EMPTY OR MISSING DATABASE_URL. `postgres()` falls back to the
// libpq `PG*` environment variables when it gets no connection string, so
// `DATABASE_URL= npx tsx …` is NOT "no database" — it is "whatever PGHOST,
// PGDATABASE and ~/.pgpass happen to say", which nothing in this repo controls.
// The old `(process.env.DATABASE_URL ?? "").includes(PROD_REF)` test read that
// case as safe: "" contains no prod ref, so it ran.
//
// ⭐ IMPORT IT FOR ITS SIDE EFFECT, SECOND — right after `./_env-preload` and
// BEFORE any app module:
//
//     import "./_env-preload";
//     import "./_require-preview-db";
//
//     import { db } from "../db/client";
//
// ESM evaluates imports in source order, so the check runs before `db/client`
// (or anything it drags in) is even evaluated — never mind connected to. That
// ordering is what makes the guard total: a module-scope query, in this script
// or in anything it imports, cannot outrun a refusal that already happened.
// A guard expressed as a statement in the script body could only ever run after
// EVERY import had been evaluated. scripts/test-preview-db-guard-coverage.ts
// enforces both the import and its position.
//
// Scripts that want the banner line call `requirePreviewDb()` for the parsed
// target; the check itself has already run by then.

/**
 * Databases these scripts may write to. Supabase project refs, matched against
 * the connection string's user and host.
 *
 * camman-v2 — the preview project. `.env.demo` points here.
 */
const PREVIEW_PROJECT_REFS: ReadonlyArray<{ ref: string; label: string }> = [
  { ref: "fdzxzxayhknywvmrhjcj", label: "camman-v2 (preview)" },
];

export interface PreviewDbTarget {
  /** The Supabase project ref the connection string resolves to. */
  ref: string;
  /** Human label for a banner line, e.g. "camman-v2 (preview)". */
  label: string;
}

function refuse(reason: string, detail?: string): never {
  console.error(
    [
      "",
      "REFUSING TO RUN — this script writes fixtures and may only target a preview database.",
      "",
      `  ${reason}`,
      ...(detail ? [`  ${detail}`] : []),
      "",
      "  Allowed targets (allowlist — everything else is refused, prod included):",
      ...PREVIEW_PROJECT_REFS.map((p) => `    • ${p.label} — project ref ${p.ref}`),
      "",
      "  Run it against the preview database:",
      `    DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \\`,
      "      npx tsx scripts/<script>.ts",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * Refuses unless `DATABASE_URL` names an allowlisted preview database. Exits 1
 * before any connection is opened. Runs once, on import; calling it afterwards
 * just returns the parsed target.
 */
function enforce(): PreviewDbTarget {
  const raw = process.env.DATABASE_URL;

  if (raw === undefined) {
    refuse(
      "DATABASE_URL is not set.",
      "postgres() would fall back to the PG* environment variables — an unknown target, not a safe one.",
    );
  }
  if (raw.trim() === "") {
    refuse(
      "DATABASE_URL is set but empty.",
      "postgres() would fall back to the PG* environment variables — an unknown target, not a safe one.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the value: the connection string carries the password.
    refuse("DATABASE_URL is not a parseable connection string.");
  }

  // The ref lives in the user (`postgres.<ref>`, pooler) or the host
  // (`db.<ref>.supabase.co`, direct). Deliberately not "anywhere in the string":
  // a ref appearing in a password or a query parameter is not a target.
  const haystack = `${decodeURIComponent(url.username)}|${url.hostname}`;
  const match = PREVIEW_PROJECT_REFS.find((p) => haystack.includes(p.ref));
  if (!match) {
    refuse(
      `DATABASE_URL points at ${url.hostname}, which is not an allowlisted preview database.`,
      "If that host IS a preview database, add its project ref to PREVIEW_PROJECT_REFS in scripts/_require-preview-db.ts.",
    );
  }

  return { ref: match.ref, label: match.label };
}

const TARGET: PreviewDbTarget = enforce();

/** The allowlisted preview database this process is pointed at. */
export function requirePreviewDb(): PreviewDbTarget {
  return TARGET;
}
