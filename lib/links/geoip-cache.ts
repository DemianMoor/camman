import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Cross-instance cache for MaxMind .mmdb blobs, backed by the geoip_cache table
// (migration 0054). This module is deliberately free of `fs`, `maxmind`, and
// `server-only` so it can be unit-verified from a plain tsx script — geoip.ts
// (server-only) wraps it with the /tmp L1 cache and the maxmind Reader.
//
// The whole point is to bound MaxMind downloads to ~1/24h regardless of how
// many lambda cold starts happen:
//   * Freshness gate  — data downloaded < FRESH_HOURS ago is reused as-is.
//   * Backoff gate    — a refresh is ATTEMPTED at most once per RETRY_HOURS,
//                       so a persistent 429 day can't re-hammer the cap.
//   * Advisory xact-lock — pg_try_advisory_xact_lock so concurrent cold starts
//     don't all download; the loser serves stale (or returns none if cold).
//     MUST be xact-scoped, not session-scoped: DATABASE_URL is the Supabase
//     transaction pooler, where a session-level lock can be acquired on one
//     pooled backend and unlocked on another. Xact locks auto-release on
//     commit/rollback and are pooler-safe.
//
// All time comparisons run in SQL via now() + make_interval so there's no
// JS↔DB clock skew, and tests control behavior purely by seeding timestamps.

export type DbOrTx =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const FRESH_HOURS = 24;
export const RETRY_HOURS = 6;

// Where the bytes came from. 'downloaded' = we hit MaxMind this call; 'fresh' /
// 'stale' = served from the DB cache (stale = older than FRESH_HOURS but a
// refresh wasn't due or just failed); 'none' = no usable bytes (cold cache and
// we couldn't/ didn't download → caller is degraded → leave clicks pending).
export type CacheSource = "fresh" | "stale" | "downloaded" | "none";

export interface CacheResult {
  data: Buffer | null;
  source: CacheSource;
  downloadedAt: Date | null;
  refreshError: string | null;
}

// Fetches the raw .mmdb bytes from MaxMind. Throws on failure (e.g. 429); the
// throw is caught and converted into a stale/none result so the attempt is
// still recorded (backoff) without crashing the scorer.
export type Downloader = () => Promise<{ data: Buffer; etag: string | null }>;

interface RowState {
  data: Buffer | null;
  downloaded_at: Date | null;
  fresh: boolean;
  attempt_due: boolean;
  exists: boolean;
}

function toBuffer(v: unknown): Buffer | null {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}

// Read row + compute freshness/backoff in SQL (now() relative), so there is no
// reliance on the Node clock matching the DB clock.
async function readState(dbc: DbOrTx, editionId: string): Promise<RowState> {
  const rows = (await dbc.execute(sql`
    SELECT
      data,
      downloaded_at,
      (data IS NOT NULL AND downloaded_at > now() - make_interval(hours => ${FRESH_HOURS}))
        AS fresh,
      (refresh_attempted_at IS NULL OR refresh_attempted_at < now() - make_interval(hours => ${RETRY_HOURS}))
        AS attempt_due
    FROM geoip_cache
    WHERE edition_id = ${editionId}
    LIMIT 1
  `)) as unknown as Array<{
    data: unknown;
    downloaded_at: Date | null;
    fresh: boolean;
    attempt_due: boolean;
  }>;

  if (!rows[0]) {
    // No row yet: cold cache. A refresh is due.
    return { data: null, downloaded_at: null, fresh: false, attempt_due: true, exists: false };
  }
  return {
    data: toBuffer(rows[0].data),
    downloaded_at: rows[0].downloaded_at,
    fresh: Boolean(rows[0].fresh),
    attempt_due: Boolean(rows[0].attempt_due),
    exists: true,
  };
}

// Resolve the .mmdb bytes for an edition, downloading from MaxMind at most once
// per FRESH_HOURS (and attempting at most once per RETRY_HOURS), coordinating
// across concurrent cold starts via a transaction-scoped advisory lock.
export async function getCachedMmdb(
  dbc: DbOrTx,
  editionId: string,
  download: Downloader,
): Promise<CacheResult> {
  // Fast path: fresh enough, no transaction/lock needed.
  const state = await readState(dbc, editionId);
  if (state.fresh && state.data) {
    return { data: state.data, source: "fresh", downloadedAt: state.downloaded_at, refreshError: null };
  }
  // Not fresh, but a refresh isn't due yet (backoff): serve stale if we have it.
  if (!state.attempt_due) {
    return state.data
      ? { data: state.data, source: "stale", downloadedAt: state.downloaded_at, refreshError: "backoff" }
      : { data: null, source: "none", downloadedAt: null, refreshError: "backoff" };
  }

  // Refresh path — inside a transaction so the advisory lock is xact-scoped.
  return dbc.transaction(async (tx) => {
    const got = (await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${"geoip:" + editionId})::int8) AS locked
    `)) as unknown as Array<{ locked: boolean }>;

    if (!got[0]?.locked) {
      // Another instance holds the lock (refreshing). Re-read — it may have just
      // committed fresh data — otherwise serve stale, or none if cold.
      const s = await readState(tx, editionId);
      if (s.data) {
        return {
          data: s.data,
          source: s.fresh ? "fresh" : "stale",
          downloadedAt: s.downloaded_at,
          refreshError: s.fresh ? null : "locked_by_other",
        } as CacheResult;
      }
      return { data: null, source: "none", downloadedAt: null, refreshError: "locked_by_other" };
    }

    // We hold the lock. Re-check freshness: another instance may have refreshed
    // in the window between our fast-path read and acquiring the lock.
    const s = await readState(tx, editionId);
    if (s.fresh && s.data) {
      return { data: s.data, source: "fresh", downloadedAt: s.downloaded_at, refreshError: null };
    }

    // Record the attempt FIRST, so a failed download (429) still advances
    // refresh_attempted_at and the backoff gate applies on the next cold start.
    await tx.execute(sql`
      INSERT INTO geoip_cache (edition_id, refresh_attempted_at)
      VALUES (${editionId}, now())
      ON CONFLICT (edition_id) DO UPDATE SET refresh_attempted_at = now()
    `);

    try {
      const dl = await download();
      await tx.execute(sql`
        INSERT INTO geoip_cache (edition_id, data, downloaded_at, refresh_attempted_at, etag, byte_size)
        VALUES (${editionId}, ${dl.data}, now(), now(), ${dl.etag}, ${dl.data.length})
        ON CONFLICT (edition_id) DO UPDATE SET
          data = excluded.data,
          downloaded_at = now(),
          refresh_attempted_at = now(),
          etag = excluded.etag,
          byte_size = excluded.byte_size
      `);
      return { data: dl.data, source: "downloaded", downloadedAt: new Date(), refreshError: null };
    } catch (err) {
      // Download failed. Attempt already recorded → backoff applies. Serve the
      // stale copy if we have one; otherwise we're cold → none (degraded).
      const reason = err instanceof Error ? err.message : String(err);
      return s.data
        ? { data: s.data, source: "stale", downloadedAt: s.downloaded_at, refreshError: reason }
        : { data: null, source: "none", downloadedAt: null, refreshError: reason };
    }
  });
}
