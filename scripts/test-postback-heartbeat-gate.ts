import { postbacksLive, shouldAlertPostbackHeartbeat } from "@/lib/partners/postbacks/heartbeat-gate";

// Truth table for the partner-postbacks heartbeat alert gate. No DB, no Telegram.
// Run: npx tsx scripts/test-postback-heartbeat-gate.ts

let failed = 0;
for (const stale of [false, true]) {
  for (const deliveryEnabled of [false, true]) {
    for (const anyKeyEnabled of [false, true]) {
      const expected = stale && (deliveryEnabled || anyKeyEnabled);
      const actual = shouldAlertPostbackHeartbeat({ stale, deliveryEnabled, anyKeyEnabled });
      const ok = actual === expected;
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"} stale=${stale} switch=${deliveryEnabled} anyKey=${anyKeyEnabled} ⇒ ${actual}`);
    }
  }
}
// The pre-go-live case named in the ruling, explicitly.
const preGoLive = shouldAlertPostbackHeartbeat({ stale: true, deliveryEnabled: false, anyKeyEnabled: false });
if (preGoLive) failed++;
console.log(`${preGoLive ? "FAIL" : "PASS"} never-run heartbeat before go-live does not page`);

// The go-live predicate alone: also gates the enqueue-failure alert in lib/drip/monitors.ts.
for (const deliveryEnabled of [false, true]) {
  for (const anyKeyEnabled of [false, true]) {
    const expected = deliveryEnabled || anyKeyEnabled;
    const actual = postbacksLive({ deliveryEnabled, anyKeyEnabled });
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} postbacksLive switch=${deliveryEnabled} anyKey=${anyKeyEnabled} ⇒ ${actual}`);
  }
}
const enqueuePreGoLive = postbacksLive({ deliveryEnabled: false, anyKeyEnabled: false });
if (enqueuePreGoLive) failed++;
console.log(`${enqueuePreGoLive ? "FAIL" : "PASS"} enqueue failure before go-live does not page`);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
