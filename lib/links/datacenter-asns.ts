// Hosting / datacenter / cloud ASN list — derives `is_datacenter` for click
// scoring. GeoLite2-ASN gives only the ASN number + organization name; it has
// NO hosting flag (that's a paid GeoIP2 feature), so we match against this
// maintained list instead.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ MAINTAINED DATA — goes stale. Last reviewed: 2026-08-11.             │
// │ Source: well-known cloud/hosting ASNs (each provider publishes its   │
// │ own; cross-checked against bgp.he.net / peeringdb).                  │
// │ Refresh cadence: review ~quarterly, or when a known datacenter range │
// │ is slipping through as "human".                                      │
// └─────────────────────────────────────────────────────────────────────┘
//
// MATCHING IS EXACT-ASN ONLY. There was previously a substring fallback over
// the ASN organization NAME ("hosting", "cloud", "colo", "google", …). It was
// removed 2026-08-11 because substring matching on a free-text org name is
// unsound in a way that silently suppresses real recipients:
//
//   • "colo"   matched "NE COLORADO CELLULAR", "COLORADO VALLEY
//              COMMUNICATIONS" and "University of Colorado Hospital"
//              — a mobile carrier, a rural telco and a hospital.
//   • "google" matched "Google Fiber Inc." — a residential ISP.
//
// Those recipients scored +60 (datacenter) → `suspect` → dropped from every
// click metric on the platform. The failure is silent: a false positive looks
// exactly like successful bot filtering. Every ASN caught by the old fallback
// was audited against production traffic before removal; the genuine hosting
// providers among them are enumerated explicitly below.
//
// If a new hosting ASN starts slipping through as "human", add its NUMBER
// here. Do not reintroduce name matching.

// Consumer privacy-relay / CDN egress ASNs. These are explicitly NOT treated
// as datacenter: Apple's iCloud Private Relay (default-on for iCloud+) exits
// through Cloudflare, Akamai and Fastly, and Google Fiber is a residential
// ISP. Real recipients — disproportionately good ones — arrive from here.
//
// Measured over all traffic to 2026-08-11: clickers on these ASNs converted at
// 2.24%, versus a 0.97% benchmark for clickers scored `human` and 0.0002% for
// Google AS15169 (the SMS link-scanner mass). Treating them as datacenter put
// 82 buyers and $5,725 of revenue outside every click metric.
//
// This set wins over DATACENTER_ASNS below, so re-adding one of these numbers
// to that list by mistake cannot resurrect the bug.
export const CONSUMER_RELAY_ASNS: ReadonlySet<number> = new Set([
  54113, // Fastly — iCloud Private Relay egress
  13335, // Cloudflare — iCloud Private Relay egress
  36183, // Akamai Technologies — iCloud Private Relay egress
  16591, // Google Fiber — residential ISP
]);

// Exact ASN numbers known to be cloud/hosting providers. High confidence.
export const DATACENTER_ASNS: ReadonlySet<number> = new Set([
  // Amazon
  16509, 14618, 8987, 9059, 39111, 7224, 38895,
  // Google (Cloud + GGC). NOTE: 16591 (Google Fiber) is a residential ISP and
  // is deliberately absent — see CONSUMER_RELAY_ASNS.
  15169, 396982, 19527, 36384, 36385, 36040, 394089,
  // Microsoft / Azure
  8075, 8068, 8069, 8070, 8071, 12076,
  // Cloudflare. NOTE: 13335 is deliberately absent — see CONSUMER_RELAY_ASNS.
  132892, 209242,
  // Oracle Cloud
  31898, 7160,
  // DigitalOcean
  14061,
  // OVH
  16276,
  // Hetzner
  24940, 213230, 212317,
  // Linode / Akamai Connected Cloud (the rebranded Linode VPS estate — this is
  // hosting. Akamai's CDN/Private Relay ASN 36183 is NOT here, see above.)
  63949, 20940, 16625, 12222,
  // Vultr / Choopa
  20473,
  // Leaseweb
  60781, 28753, 7203, 30633, 393886, 395954,
  // Contabo
  51167,
  // Scaleway / Online SAS
  12876,
  // Tencent Cloud
  132203, 45090,
  // Alibaba Cloud
  45102, 37963,
  // Enumerated 2026-08-11 from a production audit of what the removed org-name
  // fallback was actually catching. Each verified as a genuine hosting/colo
  // provider (and each showing no meaningful conversion behaviour).
  42675, // Obehosting AB
  3236, // Server.ua LLC
  63018, // Dedicated.com
  44901, // Belcloud LTD
  26548, // PureVoltage Hosting Inc.
  401152, // Ace Data Centers II, L.L.C.
  40281, // QWK.net Hosting, L.L.C.
  7979, // Servers.com, Inc.
  25697, // UpCloud USA Inc
  13739, // Datacenter IP, LLC
  13649, // Flexential Colorado Corp.
  201200, // SuperHosting.BG Ltd.
  19084, // ColoUp
  401304, // PropelCLOUD
]);

// True when the ASN is known cloud/hosting infra. A click from a datacenter IP
// is the single strongest bot signal for SMS: real recipients tap from
// residential / mobile carrier networks.
//
// Exact-number matching only — see the header for why org-name matching was
// removed. An ASN we haven't enumerated returns false (scored as a person);
// that direction is the safe one, because a missed bot dilutes a metric while
// a false positive deletes a real customer from it.
export function isDatacenterAsn(asn: number | null | undefined): boolean {
  if (asn == null) return false;
  if (CONSUMER_RELAY_ASNS.has(asn)) return false;
  return DATACENTER_ASNS.has(asn);
}
