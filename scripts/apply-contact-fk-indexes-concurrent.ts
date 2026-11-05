// Builds migration 0235's twelve contact-FK indexes WITHOUT a write lock, using
// CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's migration
// transaction). Mirrors scripts/apply-offer-cooldown-covering-index-concurrent.ts.
//
// WHY. Deleting a contact made Postgres seq-scan every referencing table that
// had no index leading on the FK column — ~21M rows on 2026-11-05 — and the
// delete hit the 120 s statement_timeout. See db/migrations/0235_contact_fk_indexes.sql.
//
// ORDER (production): run this with --apply FIRST; then `npm run db:migrate` —
// 0235's plain CREATE INDEX IF NOT EXISTS no-ops and the migration is recorded.
// Attended only (CLAUDE.md §14): the owner typed "go now" in the session.
//
// A failed CONCURRENTLY build leaves an INVALID index behind. The script stops
// on one; --drop-invalid --apply drops it (CONCURRENTLY) and rebuilds. It never
// drops anything else.
//
// Connection: the SESSION pooler (port 5432), one connection, so the
// session-level statement_timeout below reaches the backend that builds.
//
//   npx tsx scripts/apply-contact-fk-indexes-concurrent.ts            # dry run
//   npx tsx scripts/apply-contact-fk-indexes-concurrent.ts --apply    # build (05:00–05:50 UTC only)
//   npx tsx scripts/apply-contact-fk-indexes-concurrent.ts --verify   # catalog check, read-only
//   … --apply --off-window   # owner-approved build OUTSIDE the window
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

import { toSessionModeUrl } from "@/lib/db/session-url";

// Smallest first: a problem shows up before the 3 GB stage_sends build.
const INDEXES: { table: string; col: string; partial: boolean }[] = [
  { table: "stage_manual_recipients", col: "contact_id", partial: false },
  { table: "stage_result_rows", col: "contact_id", partial: true },
  { table: "ahoi_inbound_events", col: "matched_contact_id", partial: true },
  { table: "tells_webhook_events", col: "matched_contact_id", partial: true },
  { table: "texthub_inbound_events", col: "matched_contact_id", partial: true },
  { table: "counted_clickers", col: "contact_id", partial: false },
  { table: "textrequest_inbound_events", col: "matched_contact_id", partial: true },
  { table: "lead_events", col: "contact_id", partial: false },
  { table: "offer_exposures", col: "contact_id", partial: false },
  { table: "drip_journeys", col: "contact_id", partial: false },
  { table: "creative_exposures", col: "contact_id", partial: false },
  { table: "stage_sends", col: "contact_id", partial: false },
];
const nameOf = (i: (typeof INDEXES)[number]) => `${i.table}_${i.col}_idx`;
const ddlOf = (i: (typeof INDEXES)[number]) =>
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${nameOf(i)} ON public.${i.table} (${i.col})` +
  (i.partial ? ` WHERE ${i.col} IS NOT NULL` : "");

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

    const state = async (name: string) =>
      ((await pg`
        SELECT i.indisvalid AS valid, pg_size_pretty(pg_relation_size(c.oid)) AS size
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = ${name}`) as unknown as { valid: boolean; size: string }[])[0];

    if (!VERIFY) {
      for (const ix of INDEXES) {
        const name = nameOf(ix);
        let st: Awaited<ReturnType<typeof state>> | undefined = await state(name);
        if (st && !st.valid) {
          if (!DROP_INVALID) {
            console.error(`⚠ ${name} exists but is INVALID (a failed earlier build). Re-run with --drop-invalid --apply.`);
            process.exit(1);
          }
          if (APPLY) {
            console.log(`dropping INVALID ${name} …`);
            await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
            st = undefined;
          }
        }
        if (st?.valid) { console.log(`${name} — already valid (${st.size}), skipping`); continue; }
        if (!APPLY) { console.log(`${name} — WOULD BUILD:\n  ${ddlOf(ix)}`); continue; }
        process.stdout.write(`${name} — building CONCURRENTLY … `);
        const t0 = Date.now();
        await pg.unsafe(ddlOf(ix));
        const after = await state(name);
        if (!after?.valid) {
          console.error(`\n⚠ ${name} is INVALID after the build — re-run with --drop-invalid --apply.`);
          process.exit(1);
        }
        console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${after.size} ✅`);
      }
    }

    if (VERIFY || APPLY) {
      // The end state that matters: EVERY foreign key into contacts — not just
      // these twelve — has a VALID index whose first column is the FK column.
      const missing = (await pg`
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'public.contacts'::regclass
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indisvalid)
        ORDER BY 1`) as unknown as { tbl: string; col: string }[];
      if (missing.length === 0) console.log(`\n✓ every FK into contacts has a valid leading index`);
      else {
        console.log(`\n✗ FKs into contacts WITHOUT a valid leading index:`);
        for (const m of missing) console.log(`  ${m.tbl}.${m.col}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
