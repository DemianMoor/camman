// scripts/test-message-formats-ui-flag.ts — the message-formats UI flag (hotfix 2026-10-20).
// Flag OFF (default) ⇒ every screen looks and behaves exactly as before P2; the
// backend keeps stamping T1. Pure + source guards.
//   npx tsx scripts/test-message-formats-ui-flag.ts
import { readFileSync } from "node:fs";
import { MESSAGE_FORMATS_UI_ENV, messageFormatsUiEnabled, stageFormatPayload } from "@/lib/messages/ui-flag";
import { decideCreativeChange } from "@/lib/stages/send-locks";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("Flag");
delete process.env[MESSAGE_FORMATS_UI_ENV];
bar("F1 unset ⇒ OFF", messageFormatsUiEnabled() === false);
process.env[MESSAGE_FORMATS_UI_ENV] = "1";
bar("F2 anything but \"true\" ⇒ OFF", messageFormatsUiEnabled() === false);
process.env[MESSAGE_FORMATS_UI_ENV] = "true";
bar("F3 \"true\" ⇒ ON", messageFormatsUiEnabled() === true);

console.log("\nStage payload");
const vals = { message_format_id: 2, custom_text: null as string | null };
bar("F4 ON: a chosen format is sent", JSON.stringify(stageFormatPayload(vals, true)) === JSON.stringify({ message_format_id: 2 }));
bar("F5 OFF: no format / custom field is ever sent (server keeps what is stored; new stages get T1 from the trigger)",
  JSON.stringify(stageFormatPayload(vals, false)) === "{}" && JSON.stringify(stageFormatPayload({ message_format_id: null, custom_text: "x" }, false)) === "{}");

console.log("\nDrip creative lock");
const sentDrip = { isDrip: true, currentCreativeId: 5, inputCreativeId: 6, hasSent: true };
// Owner 2026-10-20: the SERVER lock is on regardless of the flag; only the
// greyed-out picker UI is behind it.
bar("F6 a sent drip stage's creative change is refused (409 creative_locked_after_send) — no flag input exists",
  decideCreativeChange(sentDrip).ok === false && !("lockEnabled" in sentDrip));

console.log("\nSource guards (every P2 UI addition sits behind the flag)");
const form = strip(readFileSync("components/campaigns/stage-form.tsx", "utf8"));
bar("G1 stage form gates the format field + warnings on the flag", /formatsUi\s*&&[\s\S]{0,200}<StageFormatField/.test(form) && /formatsUi\s*\?\s*formatWarnings/.test(form));
bar("G2 stage form gates the creative-lock UI on the flag", /creativeLocked\s*=\s*formatsUi\s*&&/.test(form));
bar("G3 stage form fetches formats only when the flag is on", /if\s*\(!formatsUi\)\s*return;[\s\S]{0,120}message-formats\/list/.test(form));
bar("G4 picker ALWAYS previews with the resolved footer (correctness fix, not gated)", /stopText=\{resolvedFooter\.text\}/.test(form) && !/stopText=\{formatsUi/.test(form));
const route = strip(readFileSync("app/api/campaigns/[campaignId]/stages/[stageId]/route.ts", "utf8"));
bar("G5 PATCH applies the drip creative lock regardless of the flag", /decideCreativeChange\(\{/.test(route) && !/lockEnabled/.test(route));
const settings = strip(readFileSync("app/(protected)/settings/message-formats/page.tsx", "utf8"));
bar("G6 Settings page shows the UI-off note", settings.includes("messageFormatsUiEnabled()") && settings.includes("switched off"));

console.log("\nSource guards — P4 creative editor (behind the flag)");
// Every occurrence must be gated, not just one: count all vs gated.
const allGated = (src: string, tag: string) => {
  const all = src.split(`<${tag}`).length - 1;
  const gated = (src.match(new RegExp(`formatsUi\\s*(?:&&|\\?)[\\s\\S]{0,160}?<${tag}`, "g")) ?? []).length;
  return all > 0 && all === gated;
};
for (const f of ["components/creatives/creative-form.tsx", "components/creatives/bulk-creative-form.tsx"]) {
  const src = strip(readFileSync(f, "utf8"));
  bar(`G7 ${f}: tag picker only when the flag is on`, allGated(src, "TagPicker"));
  bar(`G8 ${f}: worst case + unknown-tag hints only when the flag is on`, allGated(src, "CreativeTagHints"));
  bar(`G9 ${f}: reads the flag via messageFormatsUiEnabled()`, /const formatsUi\s*=\s*messageFormatsUiEnabled\(\)/.test(src));
}

console.log("\nSource guards — P4 skip counts + warnings (behind the flag)");
const stageForm = strip(readFileSync("components/campaigns/stage-form.tsx", "utf8"));
bar("G10 stage form: 'N% would be skipped' only when the flag is on", allGated(stageForm, "TagSkipLine "));
bar("G11 stage form: flag OFF ⇒ the preview request carries no extra fields and no new re-fire trigger",
  /const previewShapeKey\s*=\s*formatsUi\s*\?[\s\S]{0,400}:\s*""/.test(stageForm));
const prep = strip(readFileSync("components/campaigns/stage-prepare-dialog.tsx", "utf8"));
bar("G12 Prepare dialog: tag skip panel only when the flag is on", allGated(prep, "PrepareTagSkips "));
bar("G13 Prepare dialog: flag OFF ⇒ the missing data / segment limit buckets are filtered out",
  (prep.match(/formatsUi\s*\|\|\s*!\(TAG_BUCKETS/g) ?? []).length === 2);
const status = strip(readFileSync("components/campaigns/status-change-dialog.tsx", "utf8"));
bar("G14 activation dialog: >50% warning only when the flag is on", allGated(status, "ActivationTagWarning "));
bar("G15 activation dialog: the warning never holds the confirm button", /disabled=\{isPending \|\| awaitingExcl\}/.test(status));
for (const f of ["components/campaigns/stage-prepare-dialog.tsx", "components/campaigns/status-change-dialog.tsx"]) {
  bar(`G16 ${f}: reads the flag via messageFormatsUiEnabled()`, /const formatsUi\s*=\s*messageFormatsUiEnabled\(\)/.test(strip(readFileSync(f, "utf8"))));
}

console.log("\nSource guards — P6 By Format (behind the flag)");
const tabs = strip(readFileSync("components/reports/reports-tabs.tsx", "utf8"));
bar("G17 Reports tab bar lists By Format only when the flag is on",
  /\.filter\(\(d\)\s*=>\s*d\s*!==\s*"format"\s*\|\|\s*messageFormatsUiEnabled\(\)\)/.test(tabs));
const dimPage = strip(readFileSync("app/(protected)/reports/[dimension]/page.tsx", "utf8"));
bar("G18 /reports/format is a 404 while the flag is off",
  /dimension\s*===\s*"format"\s*&&\s*!messageFormatsUiEnabled\(\)\)\s*notFound\(\)/.test(dimPage));

console.log("\nSource guards — sidebar (flag walk 10-22)");
const nav = strip(readFileSync("components/protected/nav-config.ts", "utf8"));
bar("G19 sidebar Reports lists By Format only when the flag is on",
  /\.\.\.\(messageFormatsUiEnabled\(\)\s*\?\s*\[\s*\{\s*label:\s*"By Format",\s*href:\s*"\/reports\/format"/.test(nav));
bar("G20 sidebar Message Formats link uses the Settings layout's gate (providers.view), so an operator never gets a link to a 404",
  /label:\s*"Message Formats",\s*href:\s*"\/settings\/message-formats",\s*permission:\s*"providers\.view"/.test(nav)
  && /requirePagePermission\("providers\.view"\)/.test(strip(readFileSync("app/(protected)/settings/layout.tsx", "utf8"))));

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
