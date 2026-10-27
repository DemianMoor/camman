// "Not more than N times" default for NEW campaigns — 2 since 2026-10-27
// (owner; ClickUp 1amdve28n15). Pure: no database, no server.
//
// The default lives in ONE constant. The bars pin its value, and pin that every
// place a NEW campaign takes a fallback reads the constant rather than a literal
// — a literal left behind is exactly how a default silently disagrees between
// the form (what the operator sees) and the API (what gets stored). They also
// pin that the duplicate route copies its SOURCE's value, so existing
// campaigns' settings are never rewritten by this default.
//
// Run: npx tsx scripts/test-offer-limit-default.ts

import { readFileSync } from "node:fs";

import { OFFER_LIMIT_TIMES_DEFAULT } from "../lib/validators/campaigns";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
// Comments are stripped so a "?? 5" mentioned in prose cannot satisfy or fail a bar.
const src = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

bar("D1 ⭐ OFFER_LIMIT_TIMES_DEFAULT is 2", OFFER_LIMIT_TIMES_DEFAULT === 2, `${OFFER_LIMIT_TIMES_DEFAULT}`);

const api = src("app/api/campaigns/route.ts");
const apiUses = (api.match(/offer_limit_times \?\? OFFER_LIMIT_TIMES_DEFAULT/g) ?? []).length;
bar("D2 ⭐ the create API's BOTH fallbacks read the constant", apiUses === 2, `${apiUses} use(s)`);
bar("D3 …and no literal fallback is left for the limit in the create API",
  !/offer_limit_times \?\? \d/.test(api));

const form = src("components/campaigns/campaign-form-state.ts");
bar("D4 ⭐ the form's initial value reads the constant",
  /offer_limit_times: initialValues\?\.offer_limit_times \?\? OFFER_LIMIT_TIMES_DEFAULT/.test(form));
bar("D5 …and no literal fallback is left for the limit in the form", !/offer_limit_times \?\? \d/.test(form));

const dup = src("app/api/campaigns/[campaignId]/duplicate/route.ts");
bar("D6 a duplicate copies its source's limit — existing settings are not rewritten",
  /offer_limit_times: source\.offer_limit_times/.test(dup) && !dup.includes("OFFER_LIMIT_TIMES_DEFAULT"));

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
