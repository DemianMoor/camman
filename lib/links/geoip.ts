import "server-only";

import { gunzipSync } from "node:zlib";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import maxmind, { Reader, type AsnResponse } from "maxmind";

import { db } from "@/db/client";
import {
  getCachedMmdb,
  type CacheSource,
  type Downloader,
} from "@/lib/links/geoip-cache";

// MaxMind GeoLite2-ASN lookups for click scoring.
//
// ── Why this is structured the way it is ────────────────────────────────────
// The raw .mmdb is NEVER committed (GeoLite license forbids redistribution).
// It used to be re-downloaded on every lambda cold start (Vercel /tmp is
// per-instance + ephemeral, so the existsSync guard never helped across
// instances). At the cron cadence that blew past MaxMind's ~30 downloads/day
// cap, after which downloads 429 and — silently — enrichment fell back to
// UA-only with `asn`/`is_datacenter` going NULL.
//
// Now the bytes live in the geoip_cache table (lib/links/geoip-cache.ts), which
// bounds MaxMind to ~1 download/24h across all cold starts (freshness + backoff
// + an advisory xact-lock). This file just layers a per-instance /tmp L1 and
// the in-memory maxmind Reader on top, and reports enrichment health loudly.
//
// ── Country dropped on purpose ──────────────────────────────────────────────
// scoreClick only consumes asn / asnOrg / isDatacenter — country fed no
// classification, so the GeoLite2-Country download was pure cap pressure for a
// display-only field. Removed. clicks.country stays in the schema (historical
// values preserved; score-clicks no longer writes it) for a possible re-add.

const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;
const ASN_EDITION = "GeoLite2-ASN";

export interface IpGeo {
  asn: number | null;
  asnOrg: string | null;
}

export type EnrichmentReason =
  | "ok" // reader open, data fresh
  | "stale" // reader open from a stale copy (refresh failed; ASN ~1 day old, still usable)
  | "no_key" // MAXMIND_LICENSE_KEY not set
  | "rate_limited" // MaxMind 429 and no cached copy to fall back to
  | "download_failed" // other download error and no cached copy
  | "no_data"; // cold cache, refresh on backoff cooldown

export interface EnrichmentStatus {
  // Can we resolve ASNs at all this run? false ⇒ scorer leaves clicks pending.
  available: boolean;
  reason: EnrichmentReason;
  source: CacheSource | "none";
}

// One loud line per cold start, not per row — silence is exactly what made the
// old failure dangerous. Fires for every not-available reason, including the
// previously-invisible no-key path.
let warnedThisInstance = false;
function warnDegradedOnce(status: EnrichmentStatus, detail?: string | null) {
  if (warnedThisInstance) return;
  warnedThisInstance = true;
  console.error(
    `[geoip][DEGRADED] reason=${status.reason}` +
      (detail ? ` detail="${detail}"` : "") +
      " — ASN enrichment unavailable; click scoring will leave rows PENDING" +
      " (no scored_at) so a healthy run re-scores them later.",
  );
}

function isRateLimit(msg: string | null): boolean {
  return !!msg && /\b429\b/.test(msg);
}

// Pull the .mmdb bytes from MaxMind. Throws on any non-2xx (the message carries
// the status so the cache layer can record it and we can detect 429s).
const downloadAsn: Downloader = async () => {
  const url =
    `https://download.maxmind.com/app/geoip_download` +
    `?edition_id=${ASN_EDITION}&license_key=${encodeURIComponent(LICENSE_KEY!)}&suffix=tar.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`MaxMind download failed: ${res.status} ${res.statusText}`);
  }
  const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
  const mmdb = extractMmdbFromTar(tar);
  if (!mmdb) throw new Error(`no .mmdb found in ${ASN_EDITION} archive`);
  return { data: mmdb, etag: res.headers.get("etag") };
};

// Minimal tar extractor: first entry whose name ends in `.mmdb`. MaxMind
// tarballs are well-formed ustar with short paths (no GNU longname), so the
// basic 512-byte-record walk is sufficient.
function extractMmdbFromTar(tar: Buffer): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*$/, "");
    if (!name) break; // two zero blocks mark end-of-archive
    const sizeOctal = tar
      .toString("utf8", offset + 124, offset + 136)
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    if (name.endsWith(".mmdb")) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

interface ReaderState {
  reader: Reader<AsnResponse> | null;
  status: EnrichmentStatus;
}

async function buildReaderState(): Promise<ReaderState> {
  if (!LICENSE_KEY) {
    const status: EnrichmentStatus = { available: false, reason: "no_key", source: "none" };
    warnDegradedOnce(status);
    return { reader: null, status };
  }

  // L1: warm-instance /tmp copy. Cheapest path — skips the DB read entirely.
  const cacheDir = join(tmpdir(), "camman-geoip");
  const dbPath = join(cacheDir, `${ASN_EDITION}.mmdb`);
  if (existsSync(dbPath)) {
    try {
      const reader = await maxmind.open<AsnResponse>(dbPath);
      return { reader, status: { available: true, reason: "ok", source: "fresh" } };
    } catch {
      // Corrupt /tmp copy — fall through and re-resolve from the DB cache.
    }
  }

  // L2: cross-instance Postgres cache (MaxMind is the upstream source).
  const result = await getCachedMmdb(db, ASN_EDITION, downloadAsn);

  if (!result.data) {
    const reason: EnrichmentReason =
      result.refreshError === "backoff" || result.refreshError === "locked_by_other"
        ? "no_data"
        : isRateLimit(result.refreshError)
          ? "rate_limited"
          : "download_failed";
    const status: EnrichmentStatus = { available: false, reason, source: "none" };
    warnDegradedOnce(status, result.refreshError);
    return { reader: null, status };
  }

  // Persist to /tmp for the rest of this instance's life (best-effort), and
  // open the reader straight from the buffer we already hold.
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(dbPath, result.data);
  } catch {
    // /tmp write is an optimization only — non-fatal.
  }

  const reader = new Reader<AsnResponse>(result.data);
  if (result.source === "stale") {
    // Usable, just not freshly refreshed — score normally but say so.
    console.warn(
      `[geoip] serving STALE ASN db (refresh failed: ${result.refreshError}); ` +
        "ASN data may be ~1 day old but enrichment continues.",
    );
    return { reader, status: { available: true, reason: "stale", source: "stale" } };
  }
  return { reader, status: { available: true, reason: "ok", source: result.source } };
}

// Per-instance singleton: one resolve per cold start, shared by all callers.
let readerStatePromise: Promise<ReaderState> | null = null;
function getReaderState(): Promise<ReaderState> {
  if (!readerStatePromise) readerStatePromise = buildReaderState();
  return readerStatePromise;
}

export function isGeoipConfigured(): boolean {
  return !!LICENSE_KEY;
}

// Probe enrichment health WITHOUT a per-IP lookup. The scorer calls this once
// per run: if not available, it leaves clicks pending instead of scoring them
// on UA-only signals and falsely marking them done.
export async function getEnrichmentStatus(): Promise<EnrichmentStatus> {
  const { status } = await getReaderState();
  return status;
}

// Look up ASN for an IP. Never throws — returns nulls on any failure. A null
// ASN here (when the reader IS available) is a legitimate result: that IP just
// has no ASN record. "Couldn't enrich at all" is signalled by getEnrichmentStatus,
// not by these nulls.
export async function lookupIp(ip: string | null | undefined): Promise<IpGeo> {
  const empty: IpGeo = { asn: null, asnOrg: null };
  if (!ip) return empty;

  const { reader } = await getReaderState();
  if (!reader) return empty;

  try {
    const rec = reader.get(ip);
    return {
      asn: rec?.autonomous_system_number ?? null,
      asnOrg: rec?.autonomous_system_organization ?? null,
    };
  } catch (err) {
    console.error(`[geoip] lookup failed for ${ip}`, err);
    return empty;
  }
}
