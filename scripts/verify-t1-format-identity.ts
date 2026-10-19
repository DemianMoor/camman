// scripts/verify-t1-format-identity.ts — the P1 byte-for-byte T1 proof.
// PURE: reads the JSON written by scripts/export-t1-corpus.ts, touches no DB.
//
//   npx tsx scripts/verify-t1-format-identity.ts <corpus.json>
//
// Bars (plan P1 Task 3):
//   (a) NEW buildStageSms (T1 via lib/messages) === FROZEN origin/main
//       buildStageSms on every corpus row's inputs. One diff is a hard stop.
//   (b) the rows where NEW != stored rendered_text are EXACTLY the rows where
//       LEGACY != stored rendered_text — the new code reproduces live bodies
//       wherever the old one did. Those rows are classified (inputs that moved
//       since the send), never waved through.
//   (c) fault injection: a one-character footer change must turn (a) red, or a
//       green (a) proves nothing.
import { readFileSync } from "node:fs";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { getDescriptor } from "@/lib/sends/providers/registry";
import { buildStageSms } from "@/lib/sends/stage-sms";

// FROZEN copy of origin/main cdf96d7f lib/sends/stage-sms.ts — never edit.
function legacyBuildStageSms(opts: { brandName: string; creativeText: string | null | undefined; linkUrl?: string | null; stopText: string }): string {
  const { brandName, creativeText, stopText } = opts;
  if (!creativeText) return "";
  const link = (opts.linkUrl ?? "").trim();
  const base = `${brandName}: ${creativeText}`;
  const footer = (stopText ?? "").trim();
  const parts = [base];
  if (link.length > 0) parts.push(link);
  if (footer.length > 0) parts.push(footer);
  return parts.join("\n");
}

interface Row {
  stage_id: number; campaign_type: string; link_mode: string; brand_name: string | null;
  creative_text: string | null; link_url: string | null; stop_text: string | null;
  phone_footer: string | null; provider_footer: string | null; adapter_code: string | null;
  sent_at: string; rendered_text: string;
}

const file = process.argv[2];
if (!file) { console.error("usage: npx tsx scripts/verify-t1-format-identity.ts <corpus.json>"); process.exit(2); }
const corpus = JSON.parse(readFileSync(file, "utf8")) as { exported_at: string; days: number; rows: Row[] };

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const inputs = (r: Row, stopOverride?: string) => {
  const footer = resolveOptOutFooter({
    numberFooter: r.phone_footer, providerFooter: r.provider_footer, stageStopText: r.stop_text,
    providerAppendsOwnOptOut: r.adapter_code ? getDescriptor(r.adapter_code)?.appendsOwnOptOut === true : false,
  });
  return { brandName: r.brand_name ?? "", creativeText: r.creative_text, linkUrl: r.link_url, stopText: stopOverride ?? footer.text };
};

function classify(r: Row, rebuilt: string): string {
  const got = r.rendered_text;
  const brand = r.brand_name ?? "";
  if (!got.startsWith(`${brand}: `)) return "brand changed since send";
  if (!got.startsWith(`${brand}: ${r.creative_text ?? ""}`)) return "creative text differs (stage creative changed / pre-link row)";
  const gotLines = got.split("\n"), newLines = rebuilt.split("\n");
  if (gotLines.at(-1) !== newLines.at(-1)) return "opt-out footer changed since send";
  if (gotLines.length !== newLines.length) return "line count differs (link presence)";
  return "link differs";
}

console.log(`Corpus: ${corpus.rows.length.toLocaleString()} SENT rows, last ${corpus.days}d, exported ${corpus.exported_at}`);
const byType: Record<string, number> = {};
for (const r of corpus.rows) byType[`${r.campaign_type}/${r.link_mode}`] = (byType[`${r.campaign_type}/${r.link_mode}`] ?? 0) + 1;
console.log(`  by campaign type / link mode: ${JSON.stringify(byType)}`);

let aDiffs = 0, newMiss = 0, legacyMiss = 0, setDiff = 0, matched = 0;
const classes: Record<string, number> = {};
const examples: string[] = [];
for (const r of corpus.rows) {
  const i = inputs(r);
  const nu = buildStageSms(i);
  const legacy = legacyBuildStageSms(i);
  if (nu !== legacy) { aDiffs++; if (examples.length < 3) examples.push(JSON.stringify({ stage: r.stage_id, nu, legacy })); }
  const nMiss = nu !== r.rendered_text, lMiss = legacy !== r.rendered_text;
  if (nMiss) newMiss++;
  if (lMiss) legacyMiss++;
  if (nMiss !== lMiss) setDiff++;
  if (!nMiss) matched++;
  else { const c = classify(r, nu); classes[c] = (classes[c] ?? 0) + 1; }
}

console.log("\n(a) NEW T1 == FROZEN legacy on every row's inputs");
bar("(a) 0 diffs", aDiffs === 0, `${aDiffs} diffs / ${corpus.rows.length}`);
for (const e of examples) console.log(`      ${e}`);

console.log("\n(b) mismatch sets vs stored rendered_text are identical");
bar("(b) NEW-mismatch set == LEGACY-mismatch set", setDiff === 0, `rows in exactly one set: ${setDiff}`);
console.log(`      byte-identical to stored rendered_text: ${matched.toLocaleString()} / ${corpus.rows.length.toLocaleString()} (${((100 * matched) / Math.max(1, corpus.rows.length)).toFixed(2)}%)`);
console.log(`      mismatches: NEW ${newMiss.toLocaleString()}, LEGACY ${legacyMiss.toLocaleString()}`);
for (const [c, n] of Object.entries(classes).sort((x, y) => y[1] - x[1])) console.log(`        ${n.toLocaleString()} × ${c}`);

console.log("\n(c) fault injection: legacy with footer 'Stop to ENDX' must break (a)");
let injected = 0;
for (const r of corpus.rows.slice(0, 2000)) {
  if (!r.creative_text) continue;
  if (buildStageSms(inputs(r)) !== legacyBuildStageSms(inputs(r, "Stop to ENDX"))) injected++;
}
bar("(c) the harness goes red on a corrupted footer", injected > 0, `${injected} injected diffs`);

console.log(fail === 0 ? "\nT1 PROOF GREEN" : `\n${fail} BAR(S) RED`);
process.exit(fail === 0 ? 0 : 1);
