import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// On-read freshness for contact_org_stats (lib/contact-stats.ts) against the
// PREVIEW DB. Everything runs inside ONE transaction that is always rolled
// back, so there is zero residue and no dependence on wall-clock sleeps.
//
// ⚠️ now() is FROZEN at transaction start, so "older than the TTL" is staged by
// writing an explicitly old watermark, never by waiting.
//
// Covers: first read recomputes, a second read inside the TTL does not, an
// expired watermark recomputes again, a held lease collapses concurrent
// readers, and a failing recompute does not buy itself a TTL of silence.
// T1-T4 run in the rolled-back transaction; T5 must NOT (see its own note).
//
// Run: npx tsx --conditions=react-server scripts/test-contact-stats-ttl.ts

import { sql } from "drizzle-orm";

const ROLLBACK = "__rollback__";
// updated_at is NOT NULL, so "was it rewritten?" is staged with a sentinel
// stamp far outside any window, not with a null.
const SENTINEL = "2000-01-01T03:04:05.678Z";
const SENTINEL_HMS = "03:04:05.678";

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const C = await import("@/lib/contact-stats");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };

  await db
    .transaction(async (tx) => {
      const [{ id: orgId }] = (await tx.execute(
        sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
      )) as unknown as { id: string }[];
      const key = C.contactStatsJobKey(orgId);
      const stamp = async () =>
        (
          (await tx.execute(sql`
            SELECT (SELECT to_char(watermark, 'HH24:MI:SS.MS') FROM cron_locks WHERE job_name = ${key}) AS wm,
                   (SELECT to_char(updated_at, 'HH24:MI:SS.MS') FROM contact_org_stats WHERE org_id = ${orgId}::uuid) AS up
          `)) as unknown as { wm: string | null; up: string | null }[]
        )[0];

      // Start from a clean slate for this key.
      await tx.execute(sql`DELETE FROM cron_locks WHERE job_name = ${key}`);
      await tx.execute(sql`DELETE FROM contact_org_stats WHERE org_id = ${orgId}::uuid`);

      // T1 — no watermark at all ⇒ recompute, and the row appears.
      await C.ensureContactOrgStatsFresh(tx, orgId);
      const t1 = await stamp();
      bar("T1 first read recomputes and stamps the watermark", t1.wm !== null && t1.up !== null, `wm=${t1.wm}`);

      // T2 — inside the TTL ⇒ no recompute. Detected with a sentinel stamp
      // (updated_at is NOT NULL): a refresh would overwrite it with now().
      await tx.execute(sql`UPDATE contact_org_stats SET updated_at = ${SENTINEL} WHERE org_id = ${orgId}::uuid`);
      await C.ensureContactOrgStatsFresh(tx, orgId);
      const t2 = await stamp();
      bar("T2 second read inside the TTL does NOT recompute", t2.up === SENTINEL_HMS, `updated_at=${t2.up}`);

      // T3 — watermark older than the TTL ⇒ recompute again.
      await tx.execute(sql`
        UPDATE cron_locks
        SET watermark = now() - ${C.CONTACT_STATS_TTL_MS + 1000} * interval '1 millisecond'
        WHERE job_name = ${key}`);
      await C.ensureContactOrgStatsFresh(tx, orgId);
      const t3 = await stamp();
      bar("T3 expired watermark recomputes", t3.up !== SENTINEL_HMS, `updated_at=${t3.up}`);

      // T4 — a lease held by someone else collapses a concurrent reader: no
      // recompute, no throw. (Staged by writing a live lease_until directly.)
      await tx.execute(sql`
        UPDATE cron_locks
        SET watermark = now() - ${C.CONTACT_STATS_TTL_MS + 1000} * interval '1 millisecond',
            lease_until = now() + interval '30 seconds'
        WHERE job_name = ${key}`);
      await tx.execute(sql`UPDATE contact_org_stats SET updated_at = ${SENTINEL} WHERE org_id = ${orgId}::uuid`);
      let threw = false;
      await C.ensureContactOrgStatsFresh(tx, orgId).catch(() => {
        threw = true;
      });
      const t4 = await stamp();
      bar("T4 a held lease collapses the concurrent reader (no recompute, no throw)", t4.up === SENTINEL_HMS && !threw,
        `updated_at=${t4.up} threw=${threw}`);

      throw new Error(ROLLBACK);
    })
    .catch((e: unknown) => {
      if (!(e instanceof Error) || !e.message.includes(ROLLBACK)) throw e;
    });

  // T5 — the TTL is spent only on SUCCESS: a recompute that throws must leave
  // the watermark where it was, so the next read retries immediately instead of
  // being silenced for a TTL.
  //
  // ⚠️ This one CANNOT run inside the transaction above. In production
  // ensureContactOrgStatsFresh() is called on the pool, so the stamp and the
  // recompute are separate transactions and their ORDER is observable. Inside
  // one transaction a failed refresh rolls the stamp back too, and the bar
  // passes whichever order the code uses — it proves nothing. (It did: writing
  // the stamp before the refresh left the in-transaction version green.)
  //
  // The refresh is made to fail deterministically with a NOT VALID CHECK, which
  // existing rows ignore and the refresh's own UPSERT cannot satisfy.
  {
    const [{ id: orgId }] = (await db.execute(
      sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    )) as unknown as { id: string }[];
    const key = C.contactStatsJobKey(orgId);
    const OLD = "2001-02-03T04:05:06.789Z";
    const read = async () =>
      (
        (await db.execute(sql`
          SELECT (SELECT watermark::text FROM cron_locks WHERE job_name = ${key}) AS wm,
                 (SELECT updated_at::text FROM contact_org_stats WHERE org_id = ${orgId}::uuid) AS up
        `)) as unknown as { wm: string | null; up: string | null }[]
      )[0];

    try {
      await db.execute(sql`
        ALTER TABLE contact_org_stats
        ADD CONSTRAINT tmp_contact_stats_ttl_test CHECK (total_count < 0) NOT VALID`);
      await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${key}`);
      await db.execute(sql`
        INSERT INTO cron_locks (job_name, watermark) VALUES (${key}, ${OLD}::timestamptz)`);
      const before = await read();
      let threw = false;
      await C.ensureContactOrgStatsFresh(db, orgId).catch(() => {
        threw = true;
      });
      const after = await read();
      bar(
        "T5 a failed recompute does not advance the watermark (outside a transaction)",
        threw && after.wm === before.wm && after.up === before.up,
        `threw=${threw} wm ${before.wm} -> ${after.wm}`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE contact_org_stats DROP CONSTRAINT IF EXISTS tmp_contact_stats_ttl_test`);
      await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${key}`);
    }
  }

  // Teardown proof: the transaction rolled back and T5 cleaned up after itself,
  // so nothing above persisted.
  const [{ n }] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM cron_locks WHERE job_name LIKE 'contact-stats:%'`,
  )) as unknown as { n: number }[];
  bar("T6 zero residue after rollback", Number(n) === 0, `${n} contact-stats lease rows`);

  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} RED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
