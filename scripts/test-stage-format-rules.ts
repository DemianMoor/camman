// scripts/test-stage-format-rules.ts — stage format / custom text / lock rules (M3.*). Pure.
//   npx tsx scripts/test-stage-format-rules.ts
import { readFileSync } from "node:fs";
import { decideStageFormatChange, stageFormatLocked } from "@/lib/messages/stage-format";
import { decideCreativeChange } from "@/lib/stages/send-locks";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const eq = (n: string, got: unknown, want: unknown) =>
  bar(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const T1 = { message_format_id: 1, custom_text: null };
const CUSTOM = "Hi<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}";
const base = { current: T1, canCustomMessage: true, locked: false, formatUsable: true };

console.log("M3 — stage format rules");
const op = decideStageFormatChange({ ...base, canCustomMessage: false, input: { custom_text: CUSTOM } });
bar("M3.1 role without stages.custom_message setting custom_text ⇒ 403 custom_message_locked (field custom_text)",
  !op.ok && op.status === 403 && op.reason === "custom_message_locked" && op.field === "custom_text");
const noStop = decideStageFormatChange({ ...base, input: { custom_text: "{creative_text} {url}" } });
bar("M3.2 owner custom text without {stop_text} ⇒ 400 custom_text_missing_required_block",
  !noStop.ok && noStop.status === 400 && noStop.reason === "custom_text_missing_required_block");
const noCreative = decideStageFormatChange({ ...base, input: { custom_text: "Hi {url} {stop_text}" } });
bar("M3.3 owner custom text with {url}+{stop_text} but no {creative_text} ⇒ 400 custom_text_missing_required_block",
  !noCreative.ok && noCreative.reason === "custom_text_missing_required_block");
eq("M3.4 owner custom text with all three ⇒ sets custom, clears format",
  decideStageFormatChange({ ...base, input: { custom_text: CUSTOM } }), { ok: true, set: { message_format_id: null, custom_text: CUSTOM } });
const sent = decideStageFormatChange({ ...base, locked: true, input: { message_format_id: 2 } });
bar("M3.5 switching format on a locked stage ⇒ 409 format_locked_after_send", !sent.ok && sent.status === 409 && sent.reason === "format_locked_after_send");
eq("M3.6 echoing the same format on a locked stage ⇒ no change, ok", decideStageFormatChange({ ...base, locked: true, input: { message_format_id: 1 } }), { ok: true, set: {} });
eq("M3.7 echoing the same custom text (operator, locked stage) ⇒ no change, ok",
  decideStageFormatChange({ ...base, current: { message_format_id: null, custom_text: CUSTOM }, canCustomMessage: false, locked: true, input: { custom_text: CUSTOM, message_format_id: null } }),
  { ok: true, set: {} });
const opLeave = decideStageFormatChange({ ...base, current: { message_format_id: null, custom_text: CUSTOM }, canCustomMessage: false, input: { message_format_id: 1 } });
bar("M3.8 role without stages.custom_message switching a custom stage back to a format ⇒ 403",
  !opLeave.ok && opLeave.status === 403 && opLeave.reason === "custom_message_locked");
const disabled = decideStageFormatChange({ ...base, formatUsable: false, input: { message_format_id: 2 } });
bar("M3.9 picking a disabled / foreign format ⇒ 400 format_unavailable", !disabled.ok && disabled.status === 400 && disabled.reason === "format_unavailable");
eq("M3.10 operator picking another enabled format ⇒ ok", decideStageFormatChange({ ...base, canCustomMessage: false, input: { message_format_id: 2 } }), { ok: true, set: { message_format_id: 2, custom_text: null } });
eq("M3.11 create with nothing ⇒ ok, nothing set (trigger fills the default)", decideStageFormatChange({ ...base, current: null, input: {} }), { ok: true, set: {} });

console.log("\nM3 — when the format locks (spec R4, P4: regular = materialized_at, drip = sent ≥ 1)");
bar("M3.16 regular stage materialized but not yet sent ⇒ locked", stageFormatLocked({ isDrip: false, materialized: true, hasSent: false }) === true);
bar("M3.17 drip stage materialized but not yet sent ⇒ NOT locked", stageFormatLocked({ isDrip: true, materialized: true, hasSent: false }) === false);
bar("M3.18 drip stage with a sent row ⇒ locked", stageFormatLocked({ isDrip: true, materialized: false, hasSent: true }) === true);
bar("M3.19 regular stage not materialized (cancelled run reset it) ⇒ NOT locked", stageFormatLocked({ isDrip: false, materialized: false, hasSent: true }) === false);
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const route = strip(readFileSync("app/api/campaigns/[campaignId]/stages/[stageId]/route.ts", "utf8"));
bar("M3.20 PATCH route decides the format lock with stageFormatLocked on materialized_at",
  /stageFormatLocked\(\{[\s\S]{0,200}materialized:\s*current\.materialized_at\s*!=\s*null/.test(route) && /locked:\s*formatLocked/.test(route));
const creator = strip(readFileSync("components/campaigns/stage-inline-creator.tsx", "utf8"));
bar("M3.21 stage editor shows the same lock (stageFormatLocked on materialized_at)", /formatLocked=\{[\s\S]{0,200}stageFormatLocked\(/.test(creator));

console.log("\nM3 — creative lock");
const dripSent = decideCreativeChange({ isDrip: true, currentCreativeId: 5, inputCreativeId: 6, hasSent: true });
bar("M3.12 drip creative change after send ⇒ 409 creative_locked_after_send", !dripSent.ok && dripSent.reason === "creative_locked_after_send");
bar("M3.13 drip creative change before send ⇒ ok", decideCreativeChange({ isDrip: true, currentCreativeId: 5, inputCreativeId: 6, hasSent: false }).ok);
bar("M3.14 drip echo of the same creative after send ⇒ ok", decideCreativeChange({ isDrip: true, currentCreativeId: 5, inputCreativeId: 5, hasSent: true }).ok);
bar("M3.15 regular creative change after send ⇒ ok (creative lock is drip-only)", decideCreativeChange({ isDrip: false, currentCreativeId: 5, inputCreativeId: 6, hasSent: true }).ok);

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
