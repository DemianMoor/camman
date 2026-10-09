// contact_contact_groups.created_at MEANS "appeared" (appearance = delivery for
// drip partner groups since the Phase 2 repair), and Phase 3's resolver reads it
// for R3/R4. Nothing on the send path or in the audience snapshot may read it:
// a reader there would make a membership stamp change the audience, and the
// repair rewrote 16K of them. This bar enumerates every reader from the
// filesystem (docs/07-conventions.md: a list of "files I think read it" only
// tests the author's imagination) and allows exactly the known ones.
//
//   npx tsx scripts/test-membership-timestamp-readers.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOTS = ["lib", "app", "db"];
const ALLOWED = new Set([
  "app/api/contact-groups/[id]/contacts/route.ts", // the group's Contacts tab: "joined" column + sort
  // Phase 3 adds: lib/partners/attribution-resolver.ts
]);
const JUNCTION = /contact_contact_groups/;
const READS_STAMP =
  /\bccg\w*\.created_at\b|contact_contact_groups\.created_at|"contact_contact_groups"\."created_at"|contactContactGroups\.created_at/;

// A reader is CODE. Comments and docstrings may (and should) name the column
// when they explain what it means — lib/drip/groups.ts does — so they are
// stripped before the scan. Block comments first, then line comments.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

let failed = 0;
const hits: string[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const f of walk(resolve(process.cwd(), root))) {
    scanned++;
    const src = stripComments(readFileSync(f, "utf-8"));
    if (!JUNCTION.test(src) || !READS_STAMP.test(src)) continue;
    const rel = relative(process.cwd(), f).split(sep).join("/");
    if (!ALLOWED.has(rel)) {
      failed++;
      hits.push(rel);
    }
  }
}
console.log(
  hits.length
    ? `✗ unallowed readers of contact_contact_groups.created_at:\n  ${hits.join("\n  ")}`
    : `✓ no reader of contact_contact_groups.created_at outside the allowlist (${scanned} files scanned)`,
);

// controls: the bar can go red, and the allowed file really does read it
const allowedSrc = readFileSync(resolve(process.cwd(), "app/api/contact-groups/[id]/contacts/route.ts"), "utf-8");
const control1 = READS_STAMP.test("select ccg.created_at as joined_at from contact_contact_groups ccg");
const control2 = READS_STAMP.test(stripComments(allowedSrc)) && JUNCTION.test(allowedSrc);
const control3 = !READS_STAMP.test(
  stripComments("// `contact_contact_groups.created_at` means appeared\n/* ccg.created_at */\nselect 1 from contact_contact_groups"),
);
if (!control1 || !control2 || !control3) failed++;
console.log(`${control1 ? "✓" : "✗"} control: a synthetic reader is flagged`);
console.log(`${control2 ? "✓" : "✗"} control: the allowed file is a real reader (the scan is not blind)`);
console.log(`${control3 ? "✓" : "✗"} control: a mention inside a comment is NOT a reader`);
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
if (failed > 0) process.exit(1);
