import "server-only";

import { gunzipSync } from "node:zlib";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import maxmind, {
  type Reader,
  type Response,
  type AsnResponse,
  type CountryResponse,
} from "maxmind";

// MaxMind GeoLite2 ASN (+ optional Country) lookups for click scoring.
//
// Acquisition (per the Phase-3 brief): the raw .mmdb is NEVER committed (the
// GeoLite license forbids redistribution). It's fetched at runtime using a
// license key (env `MAXMIND_LICENSE_KEY`) and cached in the lambda's /tmp +
// an in-process reader singleton. Vercel recycles lambdas often, so a cold
// start naturally re-downloads a fresh copy — that IS the "refresh" cadence;
// no separate refresh job is needed.
//
// Degraded mode: with no license key, lookups return null and the scoring job
// still runs on UA signals alone (asn/country/is_datacenter stay NULL). That's
// the honest pre-key state — flip nothing on, just add the env var later and
// run a re-score pass.
//
// ⚠️ NOT exercised by scripts/verify-scoring.ts (which injects a fake enricher)
// — this path is integration-verified only once a real MAXMIND_LICENSE_KEY is
// present.

export interface IpGeo {
  asn: number | null;
  asnOrg: string | null;
  country: string | null;
}

const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;

export function isGeoipConfigured(): boolean {
  return !!LICENSE_KEY;
}

// Minimal tar extractor: returns the first entry whose name ends in `.mmdb`.
// MaxMind tarballs are well-formed ustar with short paths (no GNU longname),
// so the basic 512-byte-record walk is sufficient.
function extractMmdbFromTar(tar: Buffer): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*$/, "");
    if (!name) break; // two zero blocks mark end-of-archive
    const sizeOctal = tar.toString("utf8", offset + 124, offset + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    if (name.endsWith(".mmdb")) {
      return tar.subarray(dataStart, dataStart + size);
    }
    // Advance past this entry's data, rounded up to the next 512 boundary.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function downloadAndOpen<T extends Response>(
  editionId: string,
): Promise<Reader<T> | null> {
  if (!LICENSE_KEY) return null;
  const cacheDir = join(tmpdir(), "camman-geoip");
  const dbPath = join(cacheDir, `${editionId}.mmdb`);

  if (!existsSync(dbPath)) {
    const url =
      `https://download.maxmind.com/app/geoip_download` +
      `?edition_id=${editionId}&license_key=${encodeURIComponent(LICENSE_KEY)}&suffix=tar.gz`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`geoip: download of ${editionId} failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
    const mmdb = extractMmdbFromTar(tar);
    if (!mmdb) {
      console.error(`geoip: no .mmdb found in ${editionId} archive`);
      return null;
    }
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(dbPath, mmdb);
  }

  return maxmind.open<T>(dbPath);
}

// Reader singletons (per edition), keyed so concurrent callers share one open.
let asnReaderPromise: Promise<Reader<AsnResponse> | null> | null = null;
let countryReaderPromise: Promise<Reader<CountryResponse> | null> | null = null;

function getAsnReader() {
  if (!asnReaderPromise) asnReaderPromise = downloadAndOpen<AsnResponse>("GeoLite2-ASN");
  return asnReaderPromise;
}
function getCountryReader() {
  if (!countryReaderPromise) countryReaderPromise = downloadAndOpen<CountryResponse>("GeoLite2-Country");
  return countryReaderPromise;
}

// Look up ASN (+ best-effort country) for an IP. Never throws — returns null
// fields on any failure so the caller can score on whatever it has. Country
// is opportunistic (separate GeoLite2-Country db); ASN is the load-bearing one.
export async function lookupIp(ip: string | null | undefined): Promise<IpGeo> {
  const empty: IpGeo = { asn: null, asnOrg: null, country: null };
  if (!ip) return empty;

  try {
    const asnReader = await getAsnReader();
    const asnRec = asnReader?.get(ip) ?? null;

    let country: string | null = null;
    try {
      const countryReader = await getCountryReader();
      country = countryReader?.get(ip)?.country?.iso_code ?? null;
    } catch {
      // Country db missing/unavailable — non-fatal.
    }

    return {
      asn: asnRec?.autonomous_system_number ?? null,
      asnOrg: asnRec?.autonomous_system_organization ?? null,
      country,
    };
  } catch (err) {
    console.error(`geoip: lookup failed for ${ip}`, err);
    return empty;
  }
}
