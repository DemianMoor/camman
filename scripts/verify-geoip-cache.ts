import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getCachedMmdb, type Downloader } from "@/lib/links/geoip-cache";

// Verifies the geoip_cache logic that bounds MaxMind downloads to ~1/24h:
//   - freshness gate: a fresh row is served without downloading
//   - backoff gate: a stale row whose last attempt is recent serves stale,
//     no download (so a persistent 429 day can't re-hammer the cap)
//   - refresh: a stale row past the retry window downloads once + advances ts
//   - concurrency: two simultaneous cold starts (separate connections) hit the
//     advisory xact-lock → exactly ONE download happens
//
// Uses a throwaway edition_id and cleans up after itself. Run:
//   npx tsx scripts/verify-geoip-cache.ts

const ED = "__verify_geoip_cache__";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function counter(label: string, bytes: string) {
  let calls = 0;
  const fn: Downloader = async () => {
    calls++;
    return { data: Buffer.from(bytes), etag: `${label}-etag` };
  };
  return { fn, calls: () => calls };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  // Second independent pool/connection for the concurrency test.
  const pg2 = postgres(dbUrl, { prepare: false, max: 1 });
  const db2 = drizzle(pg2);

  let failed = false;
  try {
    await db.execute(sql`DELETE FROM geoip_cache WHERE edition_id = ${ED}`);

    // 1. Fresh row → no download.
    console.log("Freshness gate:");
    await db.execute(sql`
      INSERT INTO geoip_cache (edition_id, data, downloaded_at, refresh_attempted_at)
      VALUES (${ED}, ${Buffer.from("FRESH")}, now() - make_interval(hours => 1), now() - make_interval(hours => 1))
    `);
    const d1 = counter("fresh", "SHOULD-NOT-DOWNLOAD");
    const r1 = await getCachedMmdb(db, ED, d1.fn);
    assert(d1.calls() === 0, "fresh row served without downloading");
    assert(r1.source === "fresh" && r1.data?.toString() === "FRESH", "fresh data returned as-is");

    // 2. Stale row, recent attempt (backoff) → serve stale, no download.
    console.log("Backoff gate (stale + recent attempt):");
    await db.execute(sql`DELETE FROM geoip_cache WHERE edition_id = ${ED}`);
    await db.execute(sql`
      INSERT INTO geoip_cache (edition_id, data, downloaded_at, refresh_attempted_at)
      VALUES (${ED}, ${Buffer.from("STALE")}, now() - make_interval(hours => 48), now() - make_interval(hours => 1))
    `);
    const d2 = counter("backoff", "SHOULD-NOT-DOWNLOAD");
    const r2 = await getCachedMmdb(db, ED, d2.fn);
    assert(d2.calls() === 0, "stale-but-recently-attempted row does NOT re-download (backoff holds)");
    assert(r2.source === "stale" && r2.data?.toString() === "STALE", "stale data served as fallback");

    // 3. Stale row, attempt past the retry window → download once + advance.
    console.log("Refresh when due:");
    await db.execute(sql`DELETE FROM geoip_cache WHERE edition_id = ${ED}`);
    await db.execute(sql`
      INSERT INTO geoip_cache (edition_id, data, downloaded_at, refresh_attempted_at)
      VALUES (${ED}, ${Buffer.from("OLD")}, now() - make_interval(hours => 48), now() - make_interval(hours => 7))
    `);
    const d3 = counter("due", "NEW");
    const r3 = await getCachedMmdb(db, ED, d3.fn);
    assert(d3.calls() === 1, "stale row past retry window downloads exactly once");
    assert(r3.source === "downloaded" && r3.data?.toString() === "NEW", "fresh bytes returned");
    const after = (await db.execute(sql`
      SELECT (downloaded_at > now() - make_interval(mins => 1)) AS recent, octet_length(data) AS sz
      FROM geoip_cache WHERE edition_id = ${ED}
    `)) as unknown as { recent: boolean; sz: number }[];
    assert(Boolean(after[0].recent), "downloaded_at advanced to ~now");
    assert(Number(after[0].sz) === 3, "stored bytes overwritten with NEW (3 bytes)");

    // 4. Concurrency: two cold starts at once → exactly one download.
    console.log("Concurrent cold starts (advisory xact-lock):");
    await db.execute(sql`DELETE FROM geoip_cache WHERE edition_id = ${ED}`);
    let dlCount = 0;
    const slow: Downloader = async () => {
      dlCount++;
      await sleep(400); // hold the lock long enough to force real contention
      return { data: Buffer.from("CONC"), etag: null };
    };
    const [a, b] = await Promise.all([
      getCachedMmdb(db, ED, slow),
      getCachedMmdb(db2, ED, slow),
    ]);
    assert(dlCount === 1, "two simultaneous cold starts → exactly ONE MaxMind download");
    const downloadedCount = [a, b].filter((r) => r.source === "downloaded").length;
    assert(downloadedCount === 1, "exactly one caller performed the download");
    assert(
      [a, b].some((r) => r.data?.toString() === "CONC"),
      "the winner returned the downloaded bytes",
    );
    // Loser saw the lock held on a cold cache → 'none' (degraded this call);
    // the next run reads the now-committed fresh copy.
    const r5 = await getCachedMmdb(db, ED, counter("post", "X").fn);
    assert(r5.source === "fresh" && r5.data?.toString() === "CONC", "post-refresh read is fresh from cache");

    console.log("\nAll geoip-cache assertions passed.");
  } catch (err) {
    console.error("\nVerification FAILED:", err);
    failed = true;
  } finally {
    try {
      await db.execute(sql`DELETE FROM geoip_cache WHERE edition_id = ${ED}`);
    } catch {
      // best-effort cleanup
    }
    await pg.end({ timeout: 5 });
    await pg2.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-geoip-cache OK.");
}

main().catch((err) => {
  console.error("verify-geoip-cache crashed:", err);
  process.exit(1);
});
