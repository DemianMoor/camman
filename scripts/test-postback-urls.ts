// PURE checks — no DB, no env — for the standard conversion model, the
// per-event postback URLs, the advertiser spec, the simulated test, and the
// status-only validator rule.
//   npx tsx scripts/test-postback-urls.ts

import {
  buildAdvertiserSpec,
  buildPostbackUrls,
  checkPostbackBase,
  simulateConversion,
} from "../lib/conversions/postback-urls";
import { isOverride, STANDARD_EVENT_MODEL } from "../lib/conversions/standard-model";
import {
  DEFAULT_NETWORK_MAPPINGS,
  mappingRuleCreateSchema,
  mappingRuleUpdateSchema,
} from "../lib/validators/conversion-mappings";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

// ── base URL ──────────────────────────────────────────────────────────────
check("B1 unset base is refused", !checkPostbackBase(undefined).ok);
check("B2 http base is refused", !checkPostbackBase("http://24.199.82.86/key/postback").ok);
check("B3 a base with a query string is refused", !checkPostbackBase("https://t.example/k/postback?x=1").ok);
const b = checkPostbackBase("https://t.example/k/postback/");
check("B4 https base accepted, trailing slash trimmed", b.ok && b.base === "https://t.example/k/postback");

// ── URLs ──────────────────────────────────────────────────────────────────
const urls = buildPostbackUrls("https://t.example/k/postback", "dg24");
check("U1 one URL per standard event", urls.length === STANDARD_EVENT_MODEL.length);
const byType = Object.fromEntries(urls.map((u) => [u.keitaroType, new URL(u.url)]));
for (const t of ["lead", "registration", "sale", "deposit"]) {
  const u = byType[t];
  check(
    `U2 ${t}: status hardcoded, subid + new tid + payout placeholders, from=code`,
    u.searchParams.get("status") === t &&
      u.searchParams.get("subid") === "{CLICK_ID}" &&
      u.searchParams.get("tid") === "{TRANSACTION_ID}" &&
      u.searchParams.get("payout") === "{PAYOUT}" &&
      u.searchParams.get("from") === "dg24",
    u.toString(),
  );
}
const rej = byType.rejected;
check(
  "U3 rejected reuses the ORIGINAL tid and carries no payout",
  rej.searchParams.get("status") === "rejected" &&
    rej.searchParams.get("tid") === "{ORIGINAL_TRANSACTION_ID}" &&
    !rej.searchParams.has("payout"),
  rej.toString(),
);
check("U4 placeholders stay literal (searchable), not percent-encoded", urls.every((u) => u.url.includes("{CLICK_ID}")));

// ── spec ──────────────────────────────────────────────────────────────────
const spec = buildAdvertiserSpec("Digistore24", urls);
check("S1 spec names the network", spec.startsWith("POSTBACK SPEC — Digistore24"));
check("S2 spec carries every URL verbatim", urls.every((u) => spec.includes(u.url)));
check("S3 spec states: new tid per event", /NEW unique id for every new event/.test(spec));
check("S4 spec states: reversal reuses the original tid", /REUSES the transaction id of the event it reverses/.test(spec));
check("S5 spec states: payout per event, never cumulative", /THIS event only.*never a running total/.test(spec));

// ── defaults = the model ──────────────────────────────────────────────────
check(
  "D1 new-network defaults are exactly the standard model",
  JSON.stringify(DEFAULT_NETWORK_MAPPINGS.map((d) => [d.keitaro_type, d.event_type_key, d.conversion_status])) ===
    JSON.stringify([
      ["lead", "lead", "approved"],
      ["registration", "registration", "approved"],
      ["sale", "purchase", "approved"],
      ["deposit", "upsell", "approved"],
      ["rejected", null, "rejected"],
    ]),
);

// ── validator ─────────────────────────────────────────────────────────────
check("V1 rejected may be status-only", mappingRuleCreateSchema.safeParse({ keitaro_type: "rejected", event_type_id: null, conversion_status: "rejected" }).success);
check("V2 lead may NOT be status-only", !mappingRuleCreateSchema.safeParse({ keitaro_type: "lead", event_type_id: null, conversion_status: "approved" }).success);
check("V3 a missing event type is still refused", !mappingRuleCreateSchema.safeParse({ keitaro_type: "sale", conversion_status: "approved" }).success);
check("V4 PATCH accepts null (the route re-checks the stored type)", mappingRuleUpdateSchema.safeParse({ event_type_id: null }).success);

// ── override detection ────────────────────────────────────────────────────
check("O1 Sweeply lead→purchase is an override", isOverride("lead", "purchase", "approved"));
check("O2 sale→purchase approved is standard", !isOverride("sale", "purchase", "approved"));
check("O3 rejected→purchase is an override (standard keeps type)", isOverride("rejected", "purchase", "rejected"));
check("O4 a type outside the model (trash) is never an override", !isOverride("trash", "purchase", "rejected"));

// ── simulation (resolveMapping on the live rules) ─────────────────────────
const ets = [
  { id: 1, label: "Purchase", is_purchase: true, counts_revenue: true },
  { id: 2, label: "Reg", is_purchase: false, counts_revenue: false },
  { id: 9, label: "Lead", is_purchase: false, counts_revenue: true },
];
const rules = [
  { keitaro_type: "lead", event_type_id: 1, conversion_status: "approved" as const },
  { keitaro_type: "registration", event_type_id: 2, conversion_status: "approved" as const },
  { keitaro_type: "rejected", event_type_id: null, conversion_status: "rejected" as const },
];
const sLead = simulateConversion(48, "lead", rules, ets);
check("C1 override lead → Purchase, a sale with revenue", sLead.kind === "mapped" && sLead.eventLabel === "Purchase" && /a sale, payout counted as revenue/.test(sLead.text), sLead.text);
const sReg = simulateConversion(48, "registration", rules, ets);
check("C2 registration → Reg, not a sale, no revenue", sReg.kind === "mapped" && /not a sale, no revenue/.test(sReg.text), sReg.text);
check("C3 unmapped type reports unclassified", simulateConversion(48, "deposit", rules, ets).kind === "unmapped");
const sRej = simulateConversion(48, "rejected", rules, ets);
check("C4 status-only reversal keeps the type", sRej.kind === "status_only" && /Keeps the original event's type/.test(sRej.text), sRej.text);
const sLeadStd = simulateConversion(48, "lead", [{ keitaro_type: "lead", event_type_id: 9, conversion_status: "approved" }], ets);
check("C5 standard lead → Lead, not a sale, revenue counted", sLeadStd.kind === "mapped" && /not a sale, payout counted as revenue/.test(sLeadStd.text), sLeadStd.text);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
