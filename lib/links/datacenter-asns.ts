// Hosting / datacenter / cloud ASN list — derives `is_datacenter` for click
// scoring. GeoLite2-ASN gives only the ASN number + organization name; it has
// NO hosting flag (that's a paid GeoIP2 feature), so we match against this
// maintained list instead.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ MAINTAINED DATA — goes stale. Last reviewed: 2026-06-03.              │
// │ Source: well-known cloud/hosting ASNs (each provider publishes its    │
// │ own; cross-checked against bgp.he.net / peeringdb).                   │
// │ Refresh cadence: review ~quarterly, or when a known datacenter range  │
// │ is slipping through as "human". This list is intentionally small +    │
// │ high-signal (the big SMS-bot offenders), NOT exhaustive — the org-    │
// │ keyword fallback below catches hosting ASNs we haven't enumerated.    │
// └─────────────────────────────────────────────────────────────────────┘

// Exact ASN numbers known to be cloud/hosting providers. High confidence.
export const DATACENTER_ASNS: ReadonlySet<number> = new Set([
  // Amazon
  16509, 14618, 8987, 9059, 39111, 7224, 38895,
  // Google (Cloud + GGC)
  15169, 396982, 19527, 36384, 36385,
  // Microsoft / Azure
  8075, 8068, 8069, 8070, 8071, 12076,
  // Cloudflare
  13335, 132892, 209242,
  // Oracle Cloud
  31898, 7160,
  // DigitalOcean
  14061,
  // OVH
  16276,
  // Hetzner
  24940, 213230,
  // Linode / Akamai
  63949, 20940, 16625, 12222,
  // Vultr / Choopa
  20473,
  // Leaseweb
  60781, 28753, 7203, 30633,
  // Contabo
  51167,
  // Scaleway / Online SAS
  12876,
  // Tencent Cloud
  132203, 45090,
  // Alibaba Cloud
  45102, 37963,
  // Fastly
  54113,
]);

// Substrings (lowercased) in the ASN organization name that strongly imply a
// hosting/cloud provider. Catches the long tail this list doesn't enumerate.
// Order/duplication doesn't matter — first match wins.
const DATACENTER_ORG_KEYWORDS: readonly string[] = [
  "amazon",
  "aws",
  "google",
  "microsoft",
  "azure",
  "cloudflare",
  "oracle",
  "digitalocean",
  "ovh",
  "hetzner",
  "linode",
  "akamai",
  "vultr",
  "choopa",
  "leaseweb",
  "contabo",
  "scaleway",
  "online s.a.s",
  "tencent",
  "alibaba",
  "aliyun",
  "fastly",
  "hosting",
  "datacenter",
  "data center",
  "server",
  "cloud",
  "vps",
  "dedicated",
  "colocation",
  "colo",
];

// True when the ASN (number or org name) looks like cloud/hosting infra.
// A click from a datacenter IP is the single strongest bot signal for SMS:
// real recipients tap from residential / mobile carrier networks.
export function isDatacenterAsn(
  asn: number | null | undefined,
  asnOrg: string | null | undefined,
): boolean {
  if (asn != null && DATACENTER_ASNS.has(asn)) return true;
  if (asnOrg) {
    const org = asnOrg.toLowerCase();
    return DATACENTER_ORG_KEYWORDS.some((kw) => org.includes(kw));
  }
  return false;
}
