import "./_env-preload";

import {
  followupDueAt,
  isValidTimer,
  OFFER_REACH_POLL_CYCLE_MINUTES,
  TIER_DEFAULT,
  TIER_OPTIONS,
  type FollowupTier,
} from "@/lib/drip/followup-timing";

// Behavioural follow-up timing (Drip Phase 6). Pure functions — no database.
//
// ⭐ THE CENTRAL ASSERTION IS THAT A TIMER RUNS FROM DETECTION, NOT THE EVENT.
// offer_reached_at carries Keitaro's EVENT time and the network lags by hours
// (p50 146 min). A 60-minute Offer timer measured from the event is already
// expired when we learn of it, so the follow-up fires instantly and the operator
// who typed "60 minutes" gets zero. The event/detection pair below is the case
// that would have shipped that behaviour.
//
// ⭐ AND THE IGNORED FLOOR MUST ONLY EVER DELAY. A floor that could shorten a
// timer would turn a safety rule into a cause of sends. Both directions are
// asserted: it lifts a 1-minute timer, and it leaves 24h untouched.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const T0 = new Date("2026-08-24T12:00:00.000Z");
const mins = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

function main() {
  console.log("⭐ detection vs event — the case that would ship an instant send:");
  // A real shape: sent at 12:00, the recipient reached the offer at 12:10
  // (event), and the poller told us at 14:30 (detection, 146 min later ~ p50).
  const eventAt = new Date("2026-08-24T12:10:00.000Z");
  const detectedAt = new Date("2026-08-24T14:30:00.000Z");
  const fromDetection = followupDueAt({ tier: 2, minutes: 60, detectedAt, firstSentAt: T0 });
  check("due 60 min after DETECTION", fromDetection.due && mins(detectedAt, fromDetection.at), 60);
  check("⭐ ...which is AFTER detection, i.e. it actually waits",
        fromDetection.due && fromDetection.at > detectedAt, true);
  // What the naive implementation would have produced:
  const naive = new Date(eventAt.getTime() + 60 * 60_000);
  check("⭐ ...whereas 60 min after the EVENT is already in the past at detection",
        naive < detectedAt, true);

  console.log("\ntier 1 (clicked) — detection IS the event, so no gap:");
  const clickAt = new Date("2026-08-24T12:29:50.000Z");
  const c = followupDueAt({ tier: 1, minutes: 60, detectedAt: clickAt, firstSentAt: T0 });
  check("due 60 min after the click", c.due && mins(clickAt, c.at), 60);

  console.log("\n⭐ no detection ⇒ NOT due (fails toward not sending):");
  check("tier 1 with no detection", followupDueAt({ tier: 1, minutes: 60, detectedAt: null, firstSentAt: T0 }),
        { due: false, reason: "no_detection" });
  check("tier 2 with no detection", followupDueAt({ tier: 2, minutes: 60, detectedAt: null, firstSentAt: T0 }),
        { due: false, reason: "no_detection" });

  console.log("\ntier 0 (ignored) — measured from the message that was ignored:");
  const i24 = followupDueAt({ tier: 0, minutes: 1440, detectedAt: null, firstSentAt: T0 });
  check("24h timer ⇒ 1440 min after first send", i24.due && mins(T0, i24.at), 1440);
  check("...and is NOT floored", i24.due && i24.flooredBy, "none");

  console.log(`\n⭐ the Ignored floor (${OFFER_REACH_POLL_CYCLE_MINUTES} min) DELAYS ONLY:`);
  const short = followupDueAt({ tier: 0, minutes: 1, detectedAt: null, firstSentAt: T0 });
  check("a 1-minute timer is lifted to the poll cycle",
        short.due && mins(T0, short.at), OFFER_REACH_POLL_CYCLE_MINUTES);
  check("...and says so", short.due && short.flooredBy, "ignored_poll_cycle");
  const exact = followupDueAt({ tier: 0, minutes: 15, detectedAt: null, firstSentAt: T0 });
  check("exactly one cycle is not floored (boundary)", exact.due && exact.flooredBy, "none");
  check("⭐ the floor NEVER shortens: 1440 stays 1440",
        i24.due && mins(T0, i24.at) >= 1440, true);
  // The floor is only reachable at all because the option list starts at 60 for
  // tier 0; a 1-minute value cannot be chosen in the UI. Asserted anyway, since
  // the API takes minutes and a future option list could go lower.
  check("tier 0's shortest OPTION (60m) is above the floor",
        Math.min(...TIER_OPTIONS[0]) > OFFER_REACH_POLL_CYCLE_MINUTES, true);

  console.log("\noption lists and defaults match the spec:");
  check("Ignored default 24h", TIER_DEFAULT[0], 1440);
  check("Clicked default 1h", TIER_DEFAULT[1], 60);
  check("Offer default 60m (raised from 30m per G5)", TIER_DEFAULT[2], 60);
  check("Ignored options 1/3/6/8/12/18/24h", TIER_OPTIONS[0], [60, 180, 360, 480, 720, 1080, 1440]);
  check("Clicked options 15m/30m/1/3/6/12/24h", TIER_OPTIONS[1], [15, 30, 60, 180, 360, 720, 1440]);
  check("every default is a member of its own option list",
        ([0, 1, 2] as FollowupTier[]).every((t) => isValidTimer(t, TIER_DEFAULT[t])), true);
  check("⭐ 30m is NOT offered for Ignored (its list starts at 1h)", isValidTimer(0, 30), false);
  check("an off-list value is refused", isValidTimer(1, 45), false);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
