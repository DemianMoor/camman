// Production application of migration 0188's contacts.lifecycle_status column.
//
// Three things drizzle-kit's migration transaction cannot do well on a
// 906K-row table that the send path reads:
//   1. CREATE INDEX CONCURRENTLY cannot run inside a transaction at all.
//   2. A ~783K-row backfill inside the migration transaction would hold its
//      locks for the whole run.
//   3. The backfill must happen BEFORE the index exists, or every one of those
//      updates also maintains a brand-new index, for nothing.
// So this script does column -> backfill -> index, and db:migrate afterwards
// finds all three already done and only adds the CHECK. Same "script first,
// then the recorded migration no-ops" pattern as 0101, 0109 and 0143.
//
// Idempotent and resumable: every step is guarded, and the backfill only ever
// touches rows that still disagree with contact_engagement, so an interrupted
// run is continued simply by running it again.
//
// Dry run by default — prints what it would do and writes nothing.
// Run:  npx tsx scripts/apply-lifecycle-status-column.ts            (dry run)
//       npx tsx scripts/apply-lifecycle-status-column.ts --apply
// Outside the send window: before 08:00 or after 22:00 ET.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const INDEX = "contacts_org_lifecycle_created_idx";
const BATCH = 10_000;
const APPLY = process.argv.includes("--apply");

type Row = Record<string, string>;

async function main() {
  // max:1 and no prepared statements — CONCURRENTLY needs a plain autocommit
  // connection, and one connection keeps the batch loop strictly sequential.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${APPLY ? "APPLYING to" : "DRY RUN against"} ${host}\n`);

  try {
    // ── 1. The column ──────────────────────────────────────────────────────
    const [{ exists: columnAlreadyThere }] = (await pg`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contacts'
          AND column_name = 'lifecycle_status'
      ) AS exists`) as unknown as { exists: boolean }[];
    let hasColumn = columnAlreadyThere;

    if (hasColumn) {
      console.log("1. column contacts.lifecycle_status — already present, skipping");
    } else if (!APPLY) {
      console.log("1. column contacts.lifecycle_status — WOULD ADD (metadata-only)");
    } else {
      const t0 = Date.now();
      // Constant default => metadata-only on PG 11+. The timing below is the
      // evidence: a rewrite of a 119 MB heap could not finish in milliseconds.
      await pg.unsafe(
        `ALTER TABLE public.contacts ` +
          `ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'new'`,
      );
      console.log(`1. column added in ${Date.now() - t0} ms (metadata-only — no rewrite)`);
      hasColumn = true;
    }

    // ── 2. Backfill from contact_engagement, in batches ────────────────────
    const pending = async () => {
      if (!hasColumn && !APPLY) return null; // column does not exist yet
      const [r] = (await pg`
        SELECT count(*)::int AS n
        FROM contacts c
        JOIN contact_engagement ce ON ce.contact_id = c.id AND ce.org_id = c.org_id
        WHERE c.lifecycle_status IS DISTINCT FROM ce.status`) as unknown as { n: number }[];
      return Number(r.n);
    };

    const todo = await pending();
    if (todo === null) {
      console.log("2. backfill — WOULD COPY every contact_engagement.status (column not added yet)");
      const [r] = (await pg`SELECT count(*)::int AS n FROM contact_engagement`) as unknown as { n: number }[];
      console.log(`   contact_engagement rows: ${Number(r.n).toLocaleString()}`);
    } else if (!APPLY) {
      console.log(`2. backfill — WOULD UPDATE ${todo.toLocaleString()} row(s)`);
    } else {
      const t0 = Date.now();
      let done = 0;
      for (;;) {
        // Only rows that still disagree, so this is self-limiting and a retry
        // after an interruption picks up exactly where it stopped.
        const res = await pg.unsafe(
          `WITH b AS (
             SELECT c.id, ce.status
             FROM contacts c
             JOIN contact_engagement ce ON ce.contact_id = c.id AND ce.org_id = c.org_id
             WHERE c.lifecycle_status IS DISTINCT FROM ce.status
             LIMIT ${BATCH}
           )
           UPDATE contacts c SET lifecycle_status = b.status
           FROM b WHERE c.id = b.id`,
        );
        const n = res.count ?? 0;
        if (n === 0) break;
        done += n;
        process.stdout.write(`\r2. backfill — ${done.toLocaleString()} row(s) …`);
      }
      console.log(`\r2. backfill — ${done.toLocaleString()} row(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s   `);
    }

    // ── 3. The index, CONCURRENTLY ─────────────────────────────────────────
    const [{ exists: hasIndex }] = (await pg`
      SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = ${INDEX}) AS exists`) as unknown as {
      exists: boolean;
    }[];
    if (hasIndex) {
      console.log(`3. index ${INDEX} — already present, skipping`);
    } else if (!APPLY) {
      console.log(`3. index ${INDEX} — WOULD BUILD CONCURRENTLY`);
    } else {
      const t0 = Date.now();
      process.stdout.write(`3. building ${INDEX} CONCURRENTLY … `);
      await pg.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ` +
          `ON public.contacts (org_id, lifecycle_status, created_at DESC)`,
      );
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      // A failed CONCURRENTLY build leaves an INVALID index that the planner
      // ignores while it still costs write amplification — fail loudly.
      const invalid = await pg`
        SELECT c.relname FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relname = ${INDEX}`;
      if (invalid.length) {
        console.error(`\n⚠ ${INDEX} is INVALID — drop it and re-run this script.`);
        process.exit(1);
      }
    }

    // ── 4. Verify the projection against its source ────────────────────────
    if (!APPLY && !hasColumn) {
      console.log("\n4. verification — skipped in a dry run before the column exists");
      return;
    }
    const dist = (await pg`
      SELECT c.lifecycle_status AS projected,
             coalesce(ce.status, 'new') AS source,
             count(*)::int AS n
      FROM contacts c
      LEFT JOIN contact_engagement ce ON ce.contact_id = c.id AND ce.org_id = c.org_id
      GROUP BY 1, 2 ORDER BY 3 DESC`) as unknown as Row[];

    console.log("\n4. contacts.lifecycle_status vs contact_engagement:");
    let agree = 0;
    const disagree: Row[] = [];
    for (const r of dist) {
      if (r.projected === r.source) {
        agree += Number(r.n);
        console.log(`   ${String(r.projected).padEnd(11)} ${Number(r.n).toLocaleString().padStart(9)}`);
      } else {
        disagree.push(r);
      }
    }
    console.log(`   ${"TOTAL".padEnd(11)} ${agree.toLocaleString().padStart(9)}`);

    const [{ n: noRow }] = (await pg`
      SELECT count(*)::int AS n FROM contacts c
      WHERE NOT EXISTS (SELECT 1 FROM contact_engagement ce
                        WHERE ce.contact_id = c.id AND ce.org_id = c.org_id)`) as unknown as {
      n: number;
    }[];
    console.log(`   (${Number(noRow).toLocaleString()} contact(s) have no contact_engagement row — they read 'new')`);

    if (disagree.length > 0) {
      console.error("\n✗ MISMATCH — the projection disagrees with its source:");
      for (const r of disagree) {
        console.error(`   projected=${r.projected} source=${r.source} rows=${r.n}`);
      }
      process.exit(1);
    }
    console.log("\n✅ Every contact's lifecycle_status matches contact_engagement exactly.");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
