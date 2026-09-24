// Production application of migration 0188's contacts.lifecycle_status column.
//
// Four things drizzle-kit's migration transaction cannot do well on a
// 906K-row table that the send path reads:
//   1. CREATE INDEX CONCURRENTLY cannot run inside a transaction at all.
//   2. A ~783K-row backfill inside the migration transaction would hold its
//      locks for the whole run.
//   3. The backfill must happen BEFORE the index exists, or every one of those
//      updates also maintains a brand-new index, for nothing.
//   4. VACUUM cannot run inside a transaction either, and the backfill leaves
//      ~783K dead tuples the concurrent index build would otherwise read through.
// So this script does column -> backfill -> VACUUM (ANALYZE) -> index, and
// db:migrate afterwards finds the column and the index already there and only
// adds the CHECK. Same "script first, then the recorded migration no-ops"
// pattern as 0101, 0109 and 0143.
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
// Batch size and the pause between batches. contacts is on the send path, so
// the backfill deliberately yields: 10K rows is a fraction of a second of work,
// and the sleep leaves gaps for the drain rather than making it queue behind a
// long run of back-to-back writes.
const BATCH = 10_000;
const SLEEP_MS = 250;
const APPLY = process.argv.includes("--apply");

type Row = Record<string, string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fails closed if anything would ride along on an UPDATE of lifecycle_status.
 *
 * contacts carries `updated_at` (whose now() is a column DEFAULT, so it applies
 * on INSERT only) and one trigger, contacts_messaging_status_trg, which is
 * scoped `BEFORE INSERT OR UPDATE OF line_type, messaging_status` and therefore
 * does not fire for this backfill. Both of those are facts about today's schema,
 * and facts decay — so this checks them on every run instead of trusting a note.
 * A trigger that fires on ANY update, or one scoped to lifecycle_status, would
 * make 783K backfill rows look like 783K contact edits.
 */
async function assertNoRideAlongWrites(pg: ReturnType<typeof postgres>) {
  const trg = (await pg`
    SELECT t.tgname,
           pg_get_triggerdef(t.oid) AS def,
           (t.tgtype & 16) <> 0 AS on_update,
           coalesce(
             (SELECT array_agg(a.attname)
              FROM unnest(t.tgattr::int2[]) AS u(attnum)
              JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = u.attnum),
             '{}'
           ) AS cols
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.contacts'::regclass
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D'`) as unknown as {
    tgname: string;
    def: string;
    on_update: boolean;
    cols: string[];
  }[];

  const offenders = trg.filter(
    (t) => t.on_update && (t.cols.length === 0 || t.cols.includes("lifecycle_status")),
  );
  const rules = (await pg`
    SELECT rulename FROM pg_rules
    WHERE schemaname = 'public' AND tablename = 'contacts'`) as unknown as { rulename: string }[];

  console.log(`0. preconditions — ${trg.length} trigger(s), ${rules.length} rule(s) on contacts`);
  for (const t of trg) {
    const scope = t.cols.length === 0 ? "ANY column" : `columns: ${t.cols.join(", ")}`;
    const fires = offenders.includes(t) ? "WOULD FIRE" : "does not fire";
    console.log(`   ${t.tgname}: update=${t.on_update}, ${scope} — ${fires} for lifecycle_status`);
  }
  if (offenders.length > 0 || rules.length > 0) {
    console.error(
      "\n✗ REFUSING: something would ride along on the backfill UPDATE " +
        `(${offenders.map((o) => o.tgname).join(", ") || "rules: " + rules.map((r) => r.rulename).join(", ")}). ` +
        "Scope it away from lifecycle_status, or preserve the affected column explicitly, before running this.",
    );
    process.exit(1);
  }
  console.log("   no trigger or rule fires on an UPDATE of lifecycle_status ✓");
}

async function main() {
  // max:1 and no prepared statements — CONCURRENTLY needs a plain autocommit
  // connection, and one connection keeps the batch loop strictly sequential.
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${APPLY ? "APPLYING to" : "DRY RUN against"} ${host}\n`);

  try {
    // ── 0. Preconditions ───────────────────────────────────────────────────
    await assertNoRideAlongWrites(pg);

    // updated_at must not move. Recorded either side of the backfill as
    // evidence rather than assertion — a real edit from elsewhere during the
    // window would also move it, so this is reported, not enforced.
    const maxUpdatedAt = async () => {
      const [r] = (await pg`SELECT max(updated_at) AS t FROM contacts`) as unknown as {
        t: string | null;
      }[];
      return r.t;
    };
    const updatedAtBefore = await maxUpdatedAt();
    console.log(`   contacts.updated_at high-water before: ${updatedAtBefore}\n`);

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
      console.log(
        `2. backfill — WOULD UPDATE ${todo.toLocaleString()} row(s) ` +
          `in batches of ${BATCH.toLocaleString()}, ${SLEEP_MS} ms apart`,
      );
    } else {
      console.log(
        `2. backfill — ${todo.toLocaleString()} row(s), batches of ${BATCH.toLocaleString()}, ${SLEEP_MS} ms apart`,
      );
      const t0 = Date.now();
      let done = 0;
      let batches = 0;
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
        batches++;
        process.stdout.write(
          `\r   ${done.toLocaleString()} row(s) in ${batches} batch(es) …`,
        );
        // Yield between batches so the drain never queues behind this.
        await sleep(SLEEP_MS);
      }
      const secs = (Date.now() - t0) / 1000;
      console.log(
        `\r   ${done.toLocaleString()} row(s) in ${batches} batch(es), ${secs.toFixed(1)}s ` +
          `(${(secs - (batches * SLEEP_MS) / 1000).toFixed(1)}s of work, ` +
          `${((batches * SLEEP_MS) / 1000).toFixed(1)}s paused)   `,
      );

      const updatedAtAfter = await maxUpdatedAt();
      console.log(`   contacts.updated_at high-water after:  ${updatedAtAfter}`);
      // Compare by VALUE. postgres-js hands back Date objects, and `===` on two
      // distinct Dates is object identity — always false, so the 2026-09-24 run
      // reported "moved" against two byte-identical timestamps.
      const sameInstant =
        (updatedAtBefore == null) === (updatedAtAfter == null) &&
        (updatedAtBefore == null ||
          new Date(updatedAtBefore).getTime() === new Date(updatedAtAfter!).getTime());
      console.log(
        sameInstant
          ? "   updated_at did not move ✓"
          : "   ⚠ updated_at moved — check whether something else edited contacts during the window",
      );

      // ── 2b. VACUUM (ANALYZE) before the index ──────────────────────────
      // The backfill left one dead tuple per updated row on a 119 MB heap.
      // Building the index over that bloat would make it read pages it does
      // not need, and the planner has stale stats for a column that just went
      // from one value to six. VACUUM cannot run inside a transaction, which
      // is another reason this lives here and not in the migration.
      const tv = Date.now();
      process.stdout.write("2b. VACUUM (ANALYZE) contacts … ");
      await pg.unsafe("VACUUM (ANALYZE) public.contacts");
      console.log(`done in ${((Date.now() - tv) / 1000).toFixed(1)}s`);
      const [bloat] = (await pg`
        SELECT pg_size_pretty(pg_relation_size('public.contacts')) AS heap,
               (SELECT n_dead_tup FROM pg_stat_user_tables
                WHERE relname = 'contacts' AND schemaname = 'public') AS dead`) as unknown as {
        heap: string;
        dead: number | null;
      }[];
      console.log(`   heap ${bloat.heap}, dead tuples now ${bloat.dead ?? "?"}`);
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
