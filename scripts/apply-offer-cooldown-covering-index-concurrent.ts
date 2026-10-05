// Builds migration 0198's covering index on contact_offer_campaigns WITHOUT a
// write lock, using CREATE INDEX CONCURRENTLY (which cannot run inside
// drizzle-kit's migration transaction). Task 3 E4, owner-approved 2026-10-03.
//
// WHY. The campaign's offer rules ("Not within Y days" / "Not more than N
// times") read last_sent_at per contact for one offer. The existing
// (org_id, offer_id, contact_id) index lacks last_sent_at, so every row is a
// heap fetch. Measured 2026-10-03 (Large, §9 item 3): offer 115's read 1.87 s
// with the heap vs 0.21 s index-only. contact_offer_campaigns is ~2.57M rows /
// 257 MB and is upserted by the engagement job every 15 minutes — a plain
// CREATE INDEX holds a SHARE lock for the whole build and would block that job.
//
// ORDER (production): run this with --apply FIRST, in the quiet window; then
// `npm run db:migrate` — 0198's plain CREATE INDEX IF NOT EXISTS no-ops and the
// migration is recorded in the chain. Mirrors
// scripts/apply-engagement-rule-indexes-concurrent.ts (0189).
//
// The old (org_id, offer_id, contact_id) index becomes redundant. Dropping it
// needs a SEPARATE owner approval after a week (owner, 2026-10-03) — this
// script never drops anything except its own INVALID half-build, and only with
// --drop-invalid.
//
// Connection: the SESSION pooler (port 5432), one connection. On the
// transaction pooler a `SET statement_timeout` is not guaranteed to reach the
// backend that runs the next statement, and the server-wide 120 s
// statement_timeout would then bind the build.
//
//   npx tsx scripts/apply-offer-cooldown-covering-index-concurrent.ts            # dry run
//   npx tsx scripts/apply-offer-cooldown-covering-index-concurrent.ts --apply    # build (05:00–05:50 UTC only, any target)
//   npx tsx scripts/apply-offer-cooldown-covering-index-concurrent.ts --verify   # plan check, read-only
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const NAME = "contact_offer_campaigns_org_offer_contact_sent_idx";
const DDL =
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NAME} ` +
  `ON public.contact_offer_campaigns (org_id, offer_id, contact_id) INCLUDE (last_sent_at)`;
const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const DROP_INVALID = process.argv.includes("--drop-invalid");

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
  // Every --apply is window-only, whatever the target: the script carries no
  // project-ref literal (scripts/test-preview-db-guard.ts), so it cannot tell
  // production from preview — and does not need to.
  if (APPLY && (minutes < 5 * 60 || minutes >= 5 * 60 + 50)) {
    console.error(`REFUSING — --apply runs only in the quiet window (start 05:00–05:50 UTC); now ${now.toISOString()}`);
    process.exit(1);
  }
  const pg = postgres(sessionUrl(raw), { prepare: false, max: 1 });
  const host = new URL(raw).hostname;
  console.log(`${APPLY ? "APPLYING to" : VERIFY ? "VERIFYING on" : "DRY RUN against"} ${host}\n`);
  try {
    await pg.unsafe(`SET statement_timeout = '600s'`);
    await pg.unsafe(`SET maintenance_work_mem = '256MB'`);
    const [s] = (await pg`
      SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS st,
             current_setting('maintenance_work_mem') AS mwm,
             (SELECT reltuples::bigint FROM pg_class WHERE relname = 'contact_offer_campaigns') AS rows,
             pg_size_pretty(pg_relation_size('public.contact_offer_campaigns')) AS heap`) as unknown as {
      pid: number; st: string; mwm: string; rows: string; heap: string;
    }[];
    console.log(`backend ${s.pid} · statement_timeout ${s.st} · maintenance_work_mem ${s.mwm}`);
    console.log(`contact_offer_campaigns ≈ ${Number(s.rows).toLocaleString()} rows, heap ${s.heap}\n`);

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

    if (!VERIFY) {
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
    }

    if (VERIFY || APPLY) {
      // The cooldown read's shape (lx_offer_stats in lib/audience-snapshot.ts),
      // for the offer measured in §9 item 3. Read-only EXPLAIN ANALYZE.
      const offerRow = (await pg`
        SELECT org_id AS org, offer_id AS offer FROM contact_offer_campaigns
        ORDER BY (offer_id = 115) DESC LIMIT 1`) as unknown as { org: string; offer: number }[];
      if (offerRow.length === 0) {
        console.log("\nno contact_offer_campaigns rows — plan check skipped");
        return;
      }
      const { org, offer } = offerRow[0];
      const plan = (await pg.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT contact_id, count(*), max(last_sent_at) FROM contact_offer_campaigns
         WHERE org_id = $1::uuid AND offer_id = $2::int GROUP BY contact_id`,
        [org, offer],
      )) as unknown as { "QUERY PLAN": { Plan: Record<string, unknown>; "Execution Time": number }[] }[];
      const top = plan[0]["QUERY PLAN"][0];
      const nodes: string[] = [];
      const walk = (n: Record<string, unknown>) => {
        if (n["Index Name"]) nodes.push(`${n["Node Type"]} ${n["Index Name"]} heap_fetches=${n["Heap Fetches"] ?? "-"}`);
        ((n.Plans as Record<string, unknown>[]) ?? []).forEach(walk);
      };
      walk(top.Plan);
      console.log(`\noffer ${offer} cooldown read: ${top["Execution Time"].toFixed(0)} ms · ${nodes.join(" | ") || "no index scan"}`);
      const usesNew = nodes.some((x) => x.includes(NAME) && x.startsWith("Index Only Scan"));
      console.log(usesNew ? `✓ planner uses ${NAME} as an Index Only Scan` : `✗ planner does NOT use ${NAME} index-only`);
      if (!usesNew && (st?.valid || APPLY)) process.exitCode = 1;
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
