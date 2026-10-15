import { sendCapacity } from "@/lib/drip/daily-sends";
import {
  classifyRoutingOutcome,
  overflowSkips,
  type CandidateVerdict,
  type LeadRoutingEvaluation,
} from "@/lib/drip/routing-eval";

// Drip routing send capacity (0210). Pure — no DB.
//   npx tsx scripts/test-drip-send-capacity.ts
//
//   F1-F5  the fullness formula: S + U ≥ daily_cap, edges, no cap
//   O1-O5  overflow record: only higher-ranked, capacity-only skips
//   D1-D3  classification: all-full ⇒ defer, never permanent
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// ── fullness formula ────────────────────────────────────────────────────────
bar("F1 below the cap is open", sendCapacity(7000, 3000, 3999).full === false);
const atCap = sendCapacity(7000, 3000, 4000);
bar("F2 exactly at the cap is full", atCap.full === true);
bar("F3 detail names committed/cap and both operands",
  atCap.detail === "campaign full (7000/7000 today: 3000 sent + 4000 queued)", String(atCap.detail));
bar("F4 no daily cap ⇒ never full", sendCapacity(null, 1e6, 1e6).full === false);
// A send moves one journey from U to S — the verdict cannot change.
bar("F5 sending does not change the verdict (S+1, U-1)",
  sendCapacity(5000, 3594, 1406).full === sendCapacity(5000, 3595, 1405).full &&
  sendCapacity(5000, 3594, 1405).full === sendCapacity(5000, 3595, 1404).full);
// The live 8_155 numbers from 2026-10-13.
const live = sendCapacity(7000, 7000, 15647);
bar("F6 8_155 on 10-13 (7,000 sent + 15,647 queued) is full", live.full,
  String(live.detail));

// ── overflow record ─────────────────────────────────────────────────────────
const cand = (
  id: number, priority: number, failing: Record<string, string> = {},
): CandidateVerdict => {
  const rules: CandidateVerdict["rules"] = { interest_tag: "pass", campaign_paused: "pass" };
  const detail: Record<string, string> = {};
  for (const [k, d] of Object.entries(failing)) {
    rules[k] = k === "filter_state" ? "mismatch" : "blocked";
    detail[k] = d;
  }
  return {
    campaign_id: id, campaign_name: `C${id}`, priority, rules, detail,
    eligible: Object.keys(failing).length === 0,
  };
};
const full = { send_capacity: "campaign full (7000/7000 today: 7000 sent + 0 queued)" };

// These bars pin the day-level (0210) behaviour, written before the hour rule (0213) existed:
// hour rule OFF, so no `kind` may appear — the flag-off byte identity.
const NO_HOUR = { hourRuleOn: false };
const winner = cand(3, 100);
const skips = overflowSkips([
  cand(1, 97, full),                                       // full, ranked above ⇒ overflow
  cand(2, 98, { campaign_paused: "campaign status is paused" }), // paused ⇒ not overflow
  winner,
  cand(4, 120, full),                                      // full but ranked BELOW ⇒ not overflow
], winner, NO_HOUR);
bar("O1 a full higher-priority campaign is recorded", skips.some((s) => s.campaign_id === 1));
bar("O2 a paused campaign is NOT an overflow", !skips.some((s) => s.campaign_id === 2));
bar("O3 a full lower-priority campaign is NOT an overflow", !skips.some((s) => s.campaign_id === 4));
bar("O4 the detail is the capacity detail", skips[0]?.detail === full.send_capacity, skips[0]?.detail);
const mixed = overflowSkips([
  cand(1, 97, { ...full, filter_state: "lead state=CA not in excluded" }), // full AND filtered
  winner,
], winner, NO_HOUR);
bar("O5 full AND failing a filter ⇒ not an overflow (it would never have taken the lead)",
  mixed.length === 0);
// Tie on priority → the newer (higher id) campaign ranks first.
const tie = overflowSkips([cand(9, 100, full), winner], winner, NO_HOUR);
bar("O6 same priority, newer id ranks above the winner ⇒ recorded", tie.length === 1 && tie[0].campaign_id === 9);
const admission = overflowSkips([cand(1, 97, { routing_daily_admission: "cap 10 reached" }), winner], winner, NO_HOUR);
bar("O7 an admission-cap skip is a day-level overflow too", admission.length === 1);
const lifetime = overflowSkips([cand(1, 97, { campaign_cap: "campaign cap reached" }), winner], winner, NO_HOUR);
bar("O8 the lifetime campaign cap is NOT a today-overflow", lifetime.length === 0);

// ── classification ──────────────────────────────────────────────────────────
const verdict = (candidates: CandidateVerdict[]): LeadRoutingEvaluation => ({
  lead_event_id: "x", contact_id: "y", phone: null, interest_tag: "medicare",
  partner_key_id: 1, received_at: new Date().toISOString(),
  global: { opted_out: "pass", in_use: "pass", week_rule: "pass" }, globalDetail: {},
  candidates, winner: null, send_capacity_on: true, overflowed_from: [], hour_fallback: false,
});
bar("D1 every candidate full ⇒ defer", classifyRoutingOutcome(verdict([cand(1, 97, full), cand(2, 100, full)])) === "defer");
bar("D2 one full + one filtered out ⇒ defer (the full one may reopen)",
  classifyRoutingOutcome(verdict([cand(1, 97, full), cand(2, 100, { filter_state: "x" })])) === "defer");
bar("D3 full + paused ⇒ defer", classifyRoutingOutcome(verdict([
  cand(1, 97, full), cand(2, 100, { campaign_paused: "paused" }),
])) === "defer");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
