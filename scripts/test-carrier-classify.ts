// Pure unit tests for the v2 carrier resolver chain + key normalization (no DB,
// no network). Run: npx tsx scripts/test-carrier-classify.ts
import {
  classifyCarrier,
  type ClassifierContext,
  type CompiledPattern,
} from "@/lib/carrier/classify";
import { normalizeCarrierKey } from "@/lib/carrier/normalize-key";
import type { CarrierNorm } from "@/lib/telnyx/types";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}\n      expected ${e}\n      got      ${a}`);
  }
}

console.log("\nnormalizeCarrierKey — route/SPID suffix stripping + canonicalization:");
eq(normalizeCarrierKey("T-Mobile US-SVR-10X/2"), "T MOBILE US", "route suffix stripped");
eq(normalizeCarrierKey("Cingular Wireless/2"), "CINGULAR WIRELESS", "trailing /N stripped");
eq(normalizeCarrierKey("Keystone Wireless:6921 - SVR/2"), "KEYSTONE WIRELESS", "SPID+SVR tail stripped");
eq(normalizeCarrierKey("AT&T Mobility LLC"), "AT&T MOBILITY LLC", "ampersand preserved, uppercased");
eq(normalizeCarrierKey("Vonage: 197D - NSR/4"), "VONAGE", "numeric SPID + NSR tail stripped");
eq(normalizeCarrierKey("Verizon/1"), "VERIZON", "bare /1 stripped");
eq(normalizeCarrierKey(""), "", "empty -> empty");
// The load-bearing property: route-suffix variants collapse to ONE key.
eq(
  normalizeCarrierKey("Cingular Wireless/2") === normalizeCarrierKey("Cingular Wireless-NSR-10X/1"),
  true,
  "two suffix variants of the same brand share a key",
);

// A v2 context mirroring the migration 0104 seed patterns + a couple of learned mappings.
function pat(pattern: string, brand: CarrierNorm, priority: number): CompiledPattern {
  return { re: new RegExp(pattern, "i"), brand, priority };
}
const ctx: ClassifierContext = {
  v2: true,
  mappings: new Map<string, CarrierNorm>([
    [normalizeCarrierKey("Cellco Partnership dba Verizon Wireless"), "Verizon"],
    // A learned AI/human mapping for an opaque MVNO the patterns don't catch.
    [normalizeCarrierKey("Acme Anonymous MVNO"), "Other Mobile"],
  ]),
  patterns: [
    pat("T MOBILE|METRO ?PCS|OMNIPOINT|POWERTEL|VOICESTREAM|SUNCOM|SPRINT", "T-Mobile", 10),
    pat("AT&T|CINGULAR|PACIFIC BELL|BELLSOUTH|AMERITECH", "AT&T", 10),
    pat("VERIZON|CELLCO|BELL ATLANTIC|MCIMETRO", "Verizon", 10),
    pat("US CELLULAR|USCC|BOOST|CRICKET", "Other Mobile", 20),
    pat("BANDWIDTH|TWILIO|SINCH|LEVEL 3|ONVOY|PEERLESS|TELNYX", "VoIP", 30),
  ],
};

console.log("\nclassifyCarrier (v2 chain):");

// Acceptance: raw 'T-Mobile' with a BLANK Telnyx normalized_carrier resolves to
// T-Mobile (not Unknown). (The 714-row regression check.) It normalizes to the same
// key as the 'T-Mobile' bucket, so it resolves via the direct-bucket short-circuit.
eq(
  classifyCarrier({ telnyxNormalized: null, carrierName: "T-Mobile" }, ctx),
  { carrier_norm: "T-Mobile", source: "mapping" },
  "raw 'T-Mobile', blank normalized -> T-Mobile (direct bucket)",
);

// Acceptance: OMNIPOINT... with Telnyx normalized_carrier='T-Mobile' resolves to
// T-Mobile via step 1.
eq(
  classifyCarrier(
    { telnyxNormalized: "T-Mobile", carrierName: "OMNIPOINT COMMUNICATIONS, INC." },
    ctx,
  ),
  { carrier_norm: "T-Mobile", source: "telnyx_norm" },
  "Telnyx normalized 'T-Mobile' wins at step 1",
);

// Telnyx normalized is a full brand string, not itself a bucket -> resolved via layers.
eq(
  classifyCarrier({ telnyxNormalized: "Verizon Wireless", carrierName: "random" }, ctx),
  { carrier_norm: "Verizon", source: "telnyx_norm" },
  "'Verizon Wireless' normalized -> Verizon (step 1 through pattern)",
);

// Step 2 exact mapping beats nothing; learned MVNO mapping resolves.
eq(
  classifyCarrier({ carrierName: "Acme Anonymous MVNO" }, ctx),
  { carrier_norm: "Other Mobile", source: "mapping" },
  "learned mapping -> Other Mobile (source mapping)",
);

// Step 3 pattern catches a suffixed Cellco variant not in the mapping.
eq(
  classifyCarrier({ carrierName: "CELLCO PARTNERSHIP DBA VERIZON WIRELESS - TX" }, ctx),
  { carrier_norm: "Verizon", source: "pattern" },
  "unmapped Cellco variant -> Verizon via pattern",
);

// Unresolved present string -> Unmapped (enqueued for triage).
eq(
  classifyCarrier({ carrierName: "Totally Unknown Telco XYZ" }, ctx),
  { carrier_norm: "Unmapped", source: "unresolved" },
  "unrecognized present string -> Unmapped",
);

// Empty carrier name -> Unknown.
eq(
  classifyCarrier({ carrierName: "" }, ctx),
  { carrier_norm: "Unknown", source: "unresolved" },
  "empty carrier -> Unknown",
);

// v1 fallback preserves prior behaviour (map keyed by normalizeCarrierName upstream).
const v1ctx: ClassifierContext = {
  v2: false,
  mappings: new Map<string, CarrierNorm>([["t-mobile usa, inc.", "T-Mobile"]]),
  patterns: [],
};
eq(
  classifyCarrier({ carrierName: "T-Mobile USA, Inc." }, v1ctx),
  { carrier_norm: "T-Mobile", source: "v1" },
  "v1 exact map hit -> T-Mobile (source v1)",
);
eq(
  classifyCarrier({ carrierName: "Unseeded Carrier" }, v1ctx),
  { carrier_norm: "Unmapped", source: "v1" },
  "v1 miss -> Unmapped",
);

console.log(
  failures === 0
    ? "\nAll carrier-classify tests passed ✅"
    : `\nFAILED: ${failures} assertion(s) ✗`,
);
process.exit(failures === 0 ? 0 : 1);
