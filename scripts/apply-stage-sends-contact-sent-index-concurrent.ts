// Builds migration 0220's stage_sends_org_contact_sent_idx WITHOUT a write lock,
// using CREATE INDEX CONCURRENTLY (which cannot run inside drizzle-kit's migration
// transaction). Owner-approved 2026-10-21 (batched contact-engagement recount plan).
//
// WHY. The batched nightly recount reads one contact-id range of sent rows per
// batch. No index reached stage_sends by contact_id for sent rows: a batch walked
// all of stage_sends_sent_at_contact_idx (contact_id is its SECOND column) plus
// ~216K heap fetches, ~11x the single pass across 30 batches. stage_sends is
// ~6.9M rows / 2.6 GB heap and written by every send — a plain CREATE INDEX holds
// a SHARE lock for the whole build and would block sending.
//
// ORDER (production): run this with --apply FIRST; then `npm run db:migrate` —
// 0220's plain CREATE INDEX IF NOT EXISTS no-ops and the migration is recorded in
// the chain. Mirrors scripts/apply-offer-cooldown-covering-index-concurrent.ts.
// Measure before/after with scripts/measure-engagement-batch-plans.ts.
//
// Connection: the SESSION pooler (port 5432), one connection. On the transaction
// pooler a `SET statement_timeout` is not guaranteed to reach the backend that
// runs the next statement, and the server-wide 120 s statement_timeout would then
// cancel the build (CONCURRENTLY leaves an INVALID index behind when it fails).
//
//   npx tsx scripts/apply-stage-sends-contact-sent-index-concurrent.ts                  # dry run
//   npx tsx scripts/apply-stage-sends-contact-sent-index-concurrent.ts --apply          # build (05:00–05:50 UTC only)
//   … --apply --off-window     # owner's explicit "go now" outside that window
//   … --apply --drop-invalid   # drop this script's own INVALID half-build, then build
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const NAME = "stage_sends_org_contact_sent_idx";
const DDL =
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NAME} ` +
  `ON public.stage_sends (org_id, contact_id, sent_at) INCLUDE (campaign_id) WHERE status = 'sent'`;
const APPLY = process.argv.includes("--apply");
const DROP_INVALID = process.argv.includes("--drop-invalid");
const OFF_WINDOW = process.argv.includes("--off-window");

function sessionUrl(raw: string): string {
  const u = new URL(raw);
  if (u.port === "6543") u.port = "5432";
  u.searchParams.delete("prepare");
  return u.toString();
}

async function main() {
  const raw = process.env.DATABASE_URL!;
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Window-only whatever the target: the script carries no project-ref literal
  // (scripts/test-preview-db-guard.ts), so it cannot tell production from preview.
  if (APPLY && OFF_WINDOW) {
    console.log(`⚠ --off-window: owner-approved build outside 05:00–05:50 UTC at ${now.toISOString()}`);
  } else if (APPLY && (minutes < 5 * 60 || minutes >= 5 * 60 + 50)) {
    console.error(`REFUSING — --apply runs only in the quiet window (start 05:00–05:50 UTC); now ${now.toISOString()}`);
    process.exit(1);
  }
  const pg = postgres(sessionUrl(raw), { prepare: false, max: 1 });
  console.log(`${APPLY ? "APPLYING to" : "DRY RUN against"} ${new URL(raw).hostname}\n`);
  try {
    // A CONCURRENTLY build scans the table twice; ~2.6 GB heap measured 10-21.
    await pg.unsafe(`SET statement_timeout = '45min'`);
    const [s] = (await pg`
      SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS st,
             current_setting('maintenance_work_mem') AS mwm,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = 'stage_sends') AS rows,
             pg_size_pretty(pg_relation_size('public.stage_sends')) AS heap`) as unknown as {
      pid: number; st: string; mwm: string; rows: string; heap: string;
    }[];
    console.log(`backend ${s.pid} · statement_timeout ${s.st} · maintenance_work_mem ${s.mwm}`);
    console.log(`stage_sends ≈ ${Number(s.rows).toLocaleString()} rows, heap ${s.heap}\n`);

    const state = async () =>
      ((await pg`
        SELECT i.indisvalid AS valid, pg_size_pretty(pg_relation_size(c.oid)) AS size
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = ${NAME}`) as unknown as { valid: boolean; size: string }[])[0];

    let st: Awaited<ReturnType<typeof state>> | undefined = await state();
    if (st && !st.valid) {
      if (!DROP_INVALID) {
        console.error(`⚠ ${NAME} exists but is INVALID (a failed earlier build). Re-run with --drop-invalid --apply.`);
        process.exit(1);
      }
      if (APPLY) {
        console.log(`dropping INVALID ${NAME} …`);
        await pg.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${NAME}`);
        st = undefined;
      }
    }

    if (st?.valid) console.log(`${NAME} — already present and valid (${st.size}), skipping`);
    else if (!APPLY) console.log(`${NAME} — WOULD BUILD:\n  ${DDL}`);
    else {
      process.stdout.write(`${NAME} — building CONCURRENTLY … `);
      const t0 = Date.now();
      await pg.unsafe(DDL);
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const after = await state();
      if (!after?.valid) {
        console.error(`\n⚠ ${NAME} is INVALID after the build — re-run with --drop-invalid --apply.`);
        process.exit(1);
      }
      console.log(`${NAME} valid ✅  ${after.size}`);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
