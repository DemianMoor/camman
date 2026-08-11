import "./_env-preload";
import { readFileSync } from "node:fs";
import { SORTABLE } from "@/app/api/keitaro/reports/route";

// GUARD against a whole class of silent bug, generalised from one instance.
//
// The Overview table is rendered client-side but SORTED server-side against a
// whitelist. A column declared `enableSorting: true` whose id is absent from
// that whitelist does NOT fail: the request is accepted, the route falls back to
// sorting by revenue, the header responds and the order changes — just not by
// what was clicked. It looks like it works.
//
// That happened once while adding the lifetime columns. This check makes it
// impossible to reintroduce quietly: it reads the component source, extracts
// every column id declared sortable, and asserts each one is in the whitelist.
//
// Source-parsing is deliberately simple and fails loudly if the shape changes —
// finding zero sortable columns is treated as an error, not a pass.
//
// Run: npx tsx --conditions=react-server scripts/verify-sortable-columns.ts

function assert(c: boolean, m: string) {
  if (!c) throw new Error(`ASSERTION FAILED: ${m}`);
  console.log(`  ✓ ${m}`);
}

const COMPONENT = "components/reports/keitaro-report.tsx";

function sortableColumnIds(src: string): string[] {
  const ids: string[] = [];
  // Column objects look like: { id: "x", header: "...", enableSorting: true, ... }
  // Walk each `id: "..."` and look ahead within the same object literal for
  // enableSorting: true (before the next `id:` declaration).
  const idRe = /id:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  const positions: { id: string; at: number }[] = [];
  while ((m = idRe.exec(src)) !== null) positions.push({ id: m[1], at: m.index });
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].at;
    const end = i + 1 < positions.length ? positions[i + 1].at : src.length;
    if (/enableSorting:\s*true/.test(src.slice(start, end))) ids.push(positions[i].id);
  }
  return ids;
}

const src = readFileSync(COMPONENT, "utf-8");
const declared = sortableColumnIds(src);

console.log(`sortable columns declared in ${COMPONENT}: ${declared.length}`);
console.log(`  ${declared.join(", ")}`);
console.log(`server-side whitelist entries: ${SORTABLE.size}`);

assert(declared.length > 0, "found sortable columns (a zero result means the parse broke, not that all is well)");

const missing = declared.filter((id) => !SORTABLE.has(id));
assert(
  missing.length === 0,
  missing.length === 0
    ? "every enableSorting column has a matching server-side whitelist entry"
    : `columns declared sortable but MISSING from the whitelist: ${missing.join(", ")} — clicking these silently sorts by revenue`,
);

console.log("\nverify-sortable-columns OK.");
