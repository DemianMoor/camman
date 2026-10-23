// scripts/test-migration-numbering-guard.ts — part of check:guards (no DB).
//
// 2026-10-23: three branches each minted "0220" (engagement-batch-index,
// lifecycle-report-totals, contact-group mobile-only), and one of them was
// applied to the shared preview DB with the SAME journal `when` another branch
// had chosen. Drizzle applies only journal entries whose `when` is greater than
// the newest one already applied, so a branch whose `when` is not above main's
// latest is SKIPPED SILENTLY wherever main's migrations already ran.
//
// For every migration this branch adds (journal entries whose tag is not on
// origin/main):
//   (a) its NNNN number must not already exist on origin/main;
//   (b) its journal `when` must be greater than origin/main's latest `when`.
// Fix: merge/rebase origin/main, take the next free number, bump `when`.
// The number is reserved by rebasing on origin/main the moment the file is
// created, and goes on the ClickUp card (docs/07-conventions.md).
//
// Needs origin/main locally (CI fetches it: .github/workflows/guards.yml).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

type Entry = { idx: number; tag: string; when: number };

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const num = (tag: string) => tag.slice(0, 4);

/** Problems with the branch's new migrations against main's journal. Pure. */
export function numberingProblems(main: Entry[], branch: Entry[]): string[] {
  const mainTags = new Set(main.map((e) => e.tag));
  const mainNums = new Set(main.map((e) => num(e.tag)));
  const latest = Math.max(...main.map((e) => e.when));
  const added = branch.filter((e) => !mainTags.has(e.tag));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of added) {
    if (mainNums.has(num(e.tag))) out.push(`(a) ${e.tag}: number ${num(e.tag)} already exists on origin/main`);
    if (seen.has(num(e.tag))) out.push(`(a) ${e.tag}: number ${num(e.tag)} used twice on this branch`);
    seen.add(num(e.tag));
    if (!(e.when > latest)) out.push(`(b) ${e.tag}: when ${e.when} is not greater than origin/main's latest ${latest}`);
  }
  return out;
}

console.log("Migration numbering guard");
// Controls — the check itself, on fixed journals.
const MAIN: Entry[] = [{ idx: 0, tag: "0219_a", when: 100 }, { idx: 1, tag: "0220_b", when: 200 }];
bar("C1 a new number above main's latest passes", numberingProblems(MAIN, [...MAIN, { idx: 2, tag: "0221_c", when: 300 }]).length === 0);
bar("C2 (a) a number already on main fails", numberingProblems(MAIN, [...MAIN, { idx: 2, tag: "0220_other", when: 300 }]).some((p) => p.startsWith("(a)")));
bar("C3 (b) an equal `when` fails (Drizzle's test is strict)", numberingProblems(MAIN, [...MAIN, { idx: 2, tag: "0221_c", when: 200 }]).some((p) => p.startsWith("(b)")));
bar("C4 (b) a lower `when` fails", numberingProblems(MAIN, [...MAIN, { idx: 2, tag: "0221_c", when: 150 }]).some((p) => p.startsWith("(b)")));
bar("C5 main's own entries are never judged (a branch with no new migration passes)", numberingProblems(MAIN, MAIN).length === 0);

// The real check.
const JOURNAL = "db/migrations/meta/_journal.json";
let mainRaw = "";
try {
  mainRaw = execFileSync("git", ["show", `origin/main:${JOURNAL}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch {
  bar("origin/main is available locally (git fetch origin main)", false, "cannot read origin/main's journal");
}
if (mainRaw) {
  const main = (JSON.parse(mainRaw) as { entries: Entry[] }).entries;
  const branch = (JSON.parse(readFileSync(JOURNAL, "utf8")) as { entries: Entry[] }).entries;
  const added = branch.filter((e) => !main.some((m) => m.tag === e.tag));
  const problems = numberingProblems(main, branch);
  bar(`this branch's new migrations are numbered after origin/main (${added.map((e) => e.tag).join(", ") || "none"})`,
    problems.length === 0, problems.join("; "));
  const missing = added.filter((e) => !existsSync(`db/migrations/${e.tag}.sql`));
  bar("every new journal entry has its SQL file", missing.length === 0, missing.map((e) => e.tag).join(", "));
}

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
