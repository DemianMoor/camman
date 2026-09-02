// RUN WITH: npx tsx --conditions=react-server scripts/test-guardrail-caps.ts
// caps.ts imports "server-only", which throws under a plain tsx run.
import "./_env-preload";

import {
  AGGREGATE_HOURLY_CAP,
  decideAggregateCap,
  PER_STAGE_HOURLY_CAP,
} from "@/lib/guardrails/caps";

// The aggregate cap, tested at the exact boundary the brief names:
// "the stage that crosses 60K when previous stages sum to 55K must be refused".
//
// This exercises the DECISION, not the SQL. That split is deliberate — the
// decision is where the bug would be (off-by-one at the limit, forgetting to add
// `pending`, comparing before adding `requested`), and testing it directly means
// hitting 55,000 exactly instead of seeding 55,000 rows and hoping the count
// lands where intended. The query half is covered against a real database by
// scripts/verify-operator-guardrails.ts.

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "OK " : "XX "} ${label} — ${detail}`);
  if (!ok) failures++;
}

console.log("=== guardrail caps ===\n");
console.log(`  scope: per-stage cap ${PER_STAGE_HOURLY_CAP.toLocaleString()}/h, aggregate cap ${AGGREGATE_HOURLY_CAP.toLocaleString()}/h`);
if (AGGREGATE_HOURLY_CAP !== 60_000) {
  check("aggregate cap value", false, `expected 60,000 (Dmytro, final), got ${AGGREGATE_HOURLY_CAP}`);
}

console.log("\n--- the 55K + crossing stage case ---");

// Previous stages sum to 55,000: some sent, some scheduled-and-unsent. Both
// must count, which is the whole point of `pending`.
const PRIOR_SENT = 40_000;
const PRIOR_PENDING = 15_000;
console.log(`  scope: prior = ${PRIOR_SENT.toLocaleString()} sent + ${PRIOR_PENDING.toLocaleString()} scheduled-unsent = 55,000`);

const crossing = decideAggregateCap({
  sent: PRIOR_SENT,
  pending: PRIOR_PENDING,
  requested: 6_000,
});
check(
  "a 6,000 stage that would reach 61,000 is REFUSED",
  crossing !== null && crossing.wouldTotal === 61_000,
  crossing ? `refused at ${crossing.wouldTotal.toLocaleString()}` : "NOT refused",
);

const fits = decideAggregateCap({
  sent: PRIOR_SENT,
  pending: PRIOR_PENDING,
  requested: 4_000,
});
check(
  "a 4,000 stage that lands exactly on 59,999... (59,000) is ALLOWED",
  fits === null,
  fits ? `wrongly refused at ${fits.wouldTotal}` : "allowed",
);

const exact = decideAggregateCap({
  sent: PRIOR_SENT,
  pending: PRIOR_PENDING,
  requested: 5_000,
});
check(
  "landing EXACTLY on the 60,000 limit is ALLOWED (<=, not <)",
  exact === null,
  exact ? `wrongly refused at exactly ${exact.wouldTotal}` : "allowed at exactly 60,000",
);

const oneOver = decideAggregateCap({
  sent: PRIOR_SENT,
  pending: PRIOR_PENDING,
  requested: 5_001,
});
check(
  "one recipient over the limit is REFUSED",
  oneOver !== null && oneOver.wouldTotal === 60_001,
  oneOver ? `refused at ${oneOver.wouldTotal.toLocaleString()}` : "NOT refused",
);

console.log("\n--- ten stages of 9,999 (the case `pending` exists for) ---");
// Each stage is scheduled while the others have sent NOTHING. If the cap counted
// only sent volume, every one of them would see sent=0 and pass.
let accumulated = 0;
let refusedAt: number | null = null;
for (let i = 1; i <= 10; i++) {
  const d = decideAggregateCap({ sent: 0, pending: accumulated, requested: 9_999 });
  if (d) {
    refusedAt = i;
    break;
  }
  accumulated += 9_999;
}
console.log(`  scope: 10 stages x 9,999 = ${(9_999 * 10).toLocaleString()} against a ${AGGREGATE_HOURLY_CAP.toLocaleString()} cap`);
check(
  "the run is stopped before all ten pass",
  refusedAt !== null,
  refusedAt ? `refused at stage ${refusedAt} (${accumulated.toLocaleString()} already committed)` : "ALL TEN PASSED — pending is not being counted",
);

console.log("\n--- sanity: an empty org is not blocked ---");
check(
  "nothing scheduled, nothing sent, small request",
  decideAggregateCap({ sent: 0, pending: 0, requested: 1_000 }) === null,
  "allowed",
);

console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
process.exit(failures === 0 ? 0 : 1);
