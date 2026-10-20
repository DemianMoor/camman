// scripts/test-stage-format-copy-guard.ts — source guard (no DB), part of check:guards.
//
// 0216: a stage's message shape (message_format_id / custom_text) is copied to
// every stage DERIVED from it. Forgetting a site is silent: the BEFORE INSERT
// trigger fills the org default, so the copy compiles, inserts and quietly
// renders a different format from its parent. So:
//   G1  every derived insert site calls inheritedStageFormat(…);
//   G2  the set of campaign_stages insert sites under app/ + lib/ is exactly the
//       known derived sites + the base create route (which relies on the
//       trigger for the default). A new site fails here until it is classified.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DERIVED = [
  "app/api/campaigns/[campaignId]/duplicate/route.ts",
  "app/api/campaigns/[campaignId]/stages/[stageId]/duplicate/route.ts",
  "app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts",
  "lib/stages/behavioral-split.ts",
  "lib/drip/children.ts",
];
const BASE_CREATE = "app/api/campaigns/[campaignId]/stages/route.ts";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

const INSERT = /insert\(\s*campaign_stages\s*\)|INSERT\s+INTO\s+campaign_stages/i;

console.log("Stage format copy guard");
for (const f of DERIVED) {
  bar(`G1 ${f} calls inheritedStageFormat`, /inheritedStageFormat\(/.test(stripComments(readFileSync(f, "utf8"))));
}
const sites = [...walk("app"), ...walk("lib")].filter((f) => INSERT.test(stripComments(readFileSync(f, "utf8")))).sort();
const expected = [...DERIVED, BASE_CREATE].sort();
bar("G2 campaign_stages insert sites are exactly the classified ones",
  JSON.stringify(sites) === JSON.stringify(expected),
  `unclassified: ${JSON.stringify(sites.filter((s) => !expected.includes(s)))}, missing: ${JSON.stringify(expected.filter((s) => !sites.includes(s)))}`);

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
