// Pure-logic checks for the low-delivery Telegram alert
// (lib/reporting/low-delivery-alert.ts). No database, no network.
//   npx tsx --conditions=react-server scripts/test-low-delivery-alert.ts
//
// The SQL half was verified by a read-only replay against production as of
// 2026-11-05 15:52 UTC: it flagged exactly stage 5939 (campaign 1997, 1 of
// 1,198 delivered, 30007 × 1,197) and none of the same morning's 91–99% stages.
import assert from "node:assert/strict";

import {
  formatLowDeliveryAlert,
  isLowDelivery,
  lowDeliveryAlertKey,
  lowDeliveryWindow,
  type LowDeliveryBreach,
} from "@/lib/reporting/low-delivery-alert";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("below the 50-send floor never fires", () => {
  assert.equal(isLowDelivery(49, 0), false);
});
check("69.9% fires, exactly 70% does not", () => {
  assert.equal(isLowDelivery(1000, 699), true);
  assert.equal(isLowDelivery(1000, 700), false);
});
check("window = [now − 2h, now − 60 min)", () => {
  const w = lowDeliveryWindow(new Date("2026-11-05T15:52:00Z"));
  assert.equal(w.maturedBefore.toISOString(), "2026-11-05T14:52:00.000Z");
  assert.equal(w.fromUtc.toISOString(), "2026-11-05T13:52:00.000Z");
});
check("regular key is per stage; drip key is per stage per ET day", () => {
  const lateEvening = new Date("2026-11-06T03:30:00Z"); // 22:30 ET on 11-05
  assert.equal(lowDeliveryAlertKey(5939, false, lateEvening), "low-delivery:stage:5939");
  assert.equal(lowDeliveryAlertKey(77, true, lateEvening), "low-delivery:stage:77:2026-11-05");
  assert.equal(
    lowDeliveryAlertKey(77, true, new Date("2026-11-06T05:30:00Z")),
    "low-delivery:stage:77:2026-11-06",
  );
});

const base: LowDeliveryBreach = {
  org_id: "o",
  stage_id: 5939,
  stage_number: 1,
  campaign_id: 1997,
  campaign_name: "Warm - Wellaray - 11/05/26 - Weight Loss",
  tracking_id: "142_115_110526_2",
  is_drip: false,
  provider_name: "TextR",
  phone_numbers: ["+18449903688"],
  creative_id: 1323,
  creative_text: "Dietitians stunned.",
  first_sent_at: new Date("2026-11-05T14:50:35Z"),
  last_sent_at: new Date("2026-11-05T14:51:21Z"),
  sent: 1198,
  delivered: 1,
  undelivered: 1197,
  no_receipt: 0,
  error_codes: [{ code: "30007", messages: 1197 }],
};

check("message carries rate, ids, counts, labelled codes, creative", () => {
  const t = formatLowDeliveryAlert(base);
  assert.match(t, /0\.1% delivered \(alert below 70%\)/);
  assert.match(t, /Campaign 1997: Warm/);
  assert.match(t, /Tracking ID 142_115_110526_2 · Stage 1/);
  assert.match(t, /Sent 1,198 · Delivered 1 · Undelivered 1,197 · No receipt 0/);
  assert.match(t, /30007 \(carrier spam filter\): 1,197/);
  assert.match(t, /Creative #1323: Dietitians stunned\./);
  assert.doesNotMatch(t, /\(drip\)/);
});
check("unknown code shown bare; >6 codes summarised; drip marked", () => {
  const codes = ["1002", "30003", "30005", "30006", "2001", "30008", "60005", "3000"].map(
    (code, i) => ({ code, messages: 10 - i }),
  );
  const t = formatLowDeliveryAlert({ ...base, is_drip: true, error_codes: codes });
  assert.match(t, /\n {2}1002: 10\n/);
  assert.match(t, /…and 2 more codes/);
  assert.doesNotMatch(t, /60005/);
  assert.match(t, /Campaign 1997 \(drip\)/);
});
check("no codes reported", () => {
  assert.match(formatLowDeliveryAlert({ ...base, error_codes: [] }), /Error codes: none reported/);
});

console.log(`\n${passed} checks passed`);
