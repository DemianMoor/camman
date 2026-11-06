// Builds migration 0237's two partial indexes on contacts WITHOUT a write lock,
// using CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's
// migration transaction). Mirrors scripts/apply-contact-fk-indexes-concurrent.ts.
//
// WHY. contacts is ~1.8M rows / 247 MB. A plain CREATE INDEX inside 0237 would
// hold a SHARE lock — blocking every contact write (drip intake, uploads, the
// engagement job) — for the length of two heap scans. CONCURRENTLY doesn't.
//
// The indexes lead on contacts.blocked_at, which 0237 adds. So this script first
// adds the two nullable columns (blocked_at, block_reason) — metadata-only, no
// rewrite, behind a 5 s lock_timeout — using the SAME `ADD COLUMN IF NOT EXISTS`
// 0237 uses, so the migration's statements then no-op.
//
// ORDER (production): this with --apply FIRST; then `npm run db:migrate` (0237's
// IF NOT EXISTS statements no-op; the rest of 0237 applies); then --verify.
// Attended only (CLAUDE.md §14): the owner typed "go now" in the session.
//
// A failed CONCURRENTLY build leaves an INVALID index; the script stops on one,
// and --drop-invalid --apply drops it (CONCURRENTLY) and rebuilds. It never
// drops anything else.
//
// Connection: the SESSION pooler (port 5432), one connection, so the
// session-level settings below reach the backend that builds (never the
// transaction pooler — feedback_no_session_set_through_pooler).
//
//   npx tsx scripts/apply-contact-blocks-indexes-concurrent.ts            # dry run
//   npx tsx scripts/apply-contact-blocks-indexes-concurrent.ts --apply    # build (05:00–05:50 UTC only)
//   npx tsx scripts/apply-contact-blocks-indexes-concurrent.ts --verify   # catalog check, read-only
//   … --apply --off-window   # owner-approved build OUTSIDE the window
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

import { toSessionModeUrl } from "@/lib/db/session-url";

const COLUMNS = [
  `ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS blocked_at timestamptz`,
  `ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_reason text`,
];
const INDEXES: { name: string; ddl: string }[] = [
  {
    name: "contacts_org_blocked_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_blocked_idx
            ON public.contacts (org_id, blocked_at DESC) WHERE blocked_at IS NOT NULL`,
  },
  {
    name: "contacts_org_archived_idx",
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_archived_idx
            ON public.contacts (org_id, archived_at DESC) WHERE archived_at IS NOT NULL`,
  },
];

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const DROP_INVALID = process.argv.includes("--drop-invalid");
const OFF_WINDOW = process.argv.includes("--off-window");

async function main() {
  const raw = process.env.DATABASE_URL!;
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (APPLY && OFF_WINDOW) {
    console.log(`⚠ --off-window: owner-approved build outside 05:00–05:50 UTC at ${now.toISOString()}`);
  }
  if (APPLY && !OFF_WINDOW && (minutes < 5 * 60 || minutes >= 5 * 60 + 50)) {
    console.error(`REFUSING — --apply runs only in the quiet window (start 05:00–05:50 UTC); now ${now.toISOString()}`);
    process.exit(1);
  }
  const pg = postgres(toSessionModeUrl(raw), { prepare: false, max: 1 });
  console.log(`${APPLY ? "APPLYING to" : VERIFY ? "VERIFYING on" : "DRY RUN against"} ${new URL(raw).hostname}\n`);
  try {
    await pg.unsafe(`SET statement_timeout = '1800s'`);
    await pg.unsafe(`SET maintenance_work_mem = '256MB'`);

    const columnsPresent = async () =>
      ((await pg`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contacts'
          AND column_name IN ('blocked_at', 'block_reason')`) as unknown as { n: number }[])[0].n;
    const state = async (name: string) =>
      ((await pg`
        SELECT i.indisvalid AS valid, pg_size_pretty(pg_relation_size(c.oid)) AS size
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = ${name}`) as unknown as { valid: boolean; size: string }[])[0];

    if (!VERIFY) {
      const have = await columnsPresent();
      if (have === 2) console.log(`contacts.blocked_at / block_reason — already present, skipping`);
      else if (!APPLY) console.log(`contacts columns — WOULD ADD:\n  ${COLUMNS.join(";\n  ")}`);
      else {
        // Metadata-only, but ADD COLUMN needs a brief ACCESS EXCLUSIVE lock: give
        // up after 5 s rather than queue behind a long transaction (and make
        // every contact write queue behind us).
        await pg.unsafe(`SET lock_timeout = '5s'`);
        for (const ddl of COLUMNS) await pg.unsafe(ddl);
        await pg.unsafe(`RESET lock_timeout`);
        console.log(`contacts.blocked_at / block_reason — added ✅`);
      }

      for (const ix of INDEXES) {
        let st: Awaited<ReturnType<typeof state>> | undefined = await state(ix.name);
        if (st && !st.valid) {
          if (!DROP_INVALID) {
            console.error(`⚠ ${ix.name} exists but is INVALID (a failed earlier build). Re-run with --drop-invalid --apply.`);
            process.exit(1);
          }
          if (APPLY) {
            console.log(`dropping INVALID ${ix.name} …`);
            await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${ix.name}`);
            st = undefined;
          }
        }
        if (st?.valid) { console.log(`${ix.name} — already valid (${st.size}), skipping`); continue; }
        if (!APPLY) { console.log(`${ix.name} — WOULD BUILD:\n  ${ix.ddl.replace(/\s+/g, " ")}`); continue; }
        process.stdout.write(`${ix.name} — building CONCURRENTLY … `);
        const t0 = Date.now();
        await pg.unsafe(ix.ddl);
        const after = await state(ix.name);
        if (!after?.valid) {
          console.error(`\n⚠ ${ix.name} is INVALID after the build — re-run with --drop-invalid --apply.`);
          process.exit(1);
        }
        console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${after.size} ✅`);
      }
    }

    if (VERIFY || APPLY) {
      const cols = await columnsPresent();
      const states = await Promise.all(INDEXES.map(async (ix) => ({ name: ix.name, st: await state(ix.name) })));
      const ok = cols === 2 && states.every((s) => s.st?.valid);
      console.log(`\n${ok ? "✓" : "✗"} columns ${cols}/2; ` +
        states.map((s) => `${s.name}: ${s.st ? (s.st.valid ? `valid ${s.st.size}` : "INVALID") : "missing"}`).join("; "));
      if (!ok) process.exitCode = 1;
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
