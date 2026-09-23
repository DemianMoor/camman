import { readdirSync, readFileSync } from "node:fs";

// PURE SOURCE BARS — no DB, no env, no browser, no network. Run:
//   npx tsx scripts/test-frozen-first-column.ts
//
// ⭐ WHAT THIS FILE CAN AND CANNOT PROVE. It CANNOT prove that the first column
// actually stays put while the rest scroll, or that the frozen cell is opaque
// on screen — that is a rendered-layout fact and only a browser can answer it
// (it was proven by measuring `getBoundingClientRect().x` before and after
// scrolling the container, at two viewport widths, on Overview and on the By-X
// tabs; see docs/07-conventions.md). What it CAN prove is the WIRING, which is
// where this feature would rot:
//
//   1. the shared bundle still carries every mechanic the effect depends on —
//      drop any one of them and the column silently stops being frozen, or
//      stops being readable, with nothing else failing;
//   2. the opt-in is still opt-in: the wrapper's default is OFF, the class is
//      only ever applied to the FIRST cell, and EXACTLY ONE screen passes the
//      prop. `components/data-table.tsx` backs every registry list in the app,
//      so a second consumer appearing is the regression worth catching;
//   3. the frozen cell's tint still MATCHES its own table's row styles. Both
//      tints are derived from the row classes in the very file they belong to,
//      so changing a row's hover without updating the frozen cell fails here
//      instead of shipping a visible seam down the middle of a hovered row.

const FROZEN = "lib/ui/frozen-column.ts";
const WRAPPER = "components/data-table.tsx";
const PRIMITIVE = "components/ui/table.tsx";
const OVERVIEW = "components/reports/keitaro-report.tsx";
const BYX = "components/reports/performance-report.tsx";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (f: string) => readFileSync(f, "utf-8");

/** Every .tsx under the given roots, forward-slashed and repo-relative. */
function tsxFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
  };
  roots.forEach(walk);
  return out;
}

console.log("S1 · the shared bundle carries every mechanic");

{
  const src = read(FROZEN);
  // ⭐ THE NEEDLES ARE MATCHED AGAINST THE CONSTANT'S VALUE, NOT THE FILE. The
  // file's own comment explains what `sticky` and `before:-z-10` are for, so a
  // whole-file `includes()` stayed green with `sticky` DELETED from the class
  // string — the bar passed on its own documentation. Caught by mutant M1.
  const value = src.match(/export const FROZEN_FIRST_COLUMN_CELL =([\s\S]*?);/)?.[1] ?? "";
  // Each of these is load-bearing on its own:
  //   sticky+left-0  — the pinning itself
  //   z-10           — paints above the scrolling siblings AND makes the cell a
  //                    stacking context, which is what keeps before:-z-10 from
  //                    falling behind them
  //   bg-background  — the OPAQUE base; without it the scrolling columns show
  //                    through the frozen cell
  //   before:*       — the row-state tint layer over that opaque base
  //   shadow-[1px…]  — the boundary edge (a border-r would be swallowed by
  //                    border-collapse: collapse)
  const needles = [
    "sticky",
    "left-0",
    "z-10",
    "bg-background",
    "shadow-[1px_0_0_0_var(--color-border)]",
    "before:absolute",
    "before:inset-0",
    "before:-z-10",
  ];
  const missing = needles.filter((n) => !value.includes(n));
  check(
    "S1 lib/ui/frozen-column.ts exports one bundle with sticky+left-0, an opaque background, the ::before tint layer at a negative z-index, and the shadow edge",
    value.length > 0 && missing.length === 0,
    `missing from the constant's value: ${missing.join(", ") || "none"}`,
  );
}

console.log("\nS2 · the wrapper's default is OFF and only the first cell is frozen");

{
  const src = read(WRAPPER);
  // Every use of the class must sit behind a first-cell guard. Counting them is
  // what makes this one-sided: an unguarded `className={frozenCell}` anywhere
  // would freeze a column that is not the first one and still contain the
  // string this bar looks for.
  const uses = src.match(/frozenCell/g)?.length ?? 0;
  const guarded = src.match(/(?:index|j) === 0 \? frozenCell : undefined/g)?.length ?? 0;
  check(
    "S2 `freezeFirstColumn` defaults to false, and every application of the frozen class is guarded by a first-cell index (header, body, skeleton)",
    src.includes("freezeFirstColumn = false") &&
      src.includes("freezeFirstColumn?: boolean") &&
      src.includes("FROZEN_FIRST_COLUMN_CELL") &&
      guarded === 3 &&
      // 1 declaration + the 3 guarded uses, nothing else.
      uses === 4,
    `guarded uses: ${guarded} | total mentions: ${uses}`,
  );
}

console.log("\nS3 · exactly one screen opts in");

{
  // Scanning the tree by name rather than trusting the wrapper's default: the
  // regression this guards is a SECOND table opting in, which no amount of
  // reading data-table.tsx would reveal.
  const consumers = tsxFiles(["app", "components"])
    .filter((f) => f !== WRAPPER && read(f).includes("freezeFirstColumn"))
    .sort();
  check(
    "S3 /reports Overview is the only DataTable that passes `freezeFirstColumn` — every other registry list is untouched",
    consumers.length === 1 && consumers[0] === OVERVIEW,
    `consumers: ${consumers.join(", ") || "none"}`,
  );
}

console.log("\nS4 · each frozen cell's tint matches ITS OWN table's row styles");

{
  // The wrapper's rows are styled by the TableRow primitive, so the tint is
  // derived from THAT file — change the hover there and this bar goes red.
  const primitive = read(PRIMITIVE);
  const rowHover = primitive.match(/data-slot="table-row"[\s\S]{0,400}?(hover:bg-muted\/\d+)/)?.[1];
  const wrapper = read(WRAPPER);
  check(
    `S4a the wrapper's frozen cell re-applies TableRow's own hover (${rowHover ?? "not found"}) as its ::before tint`,
    !!rowHover && wrapper.includes(`"[tr:hover>&]:before:bg-muted/${rowHover.split("/")[1]}"`),
    `TableRow hover: ${rowHover ?? "none"}`,
  );

  // The By-X table hand-rolls its markup, so both its row styles live in one
  // file and both are derived from it: a flat header tint and a body hover.
  const byx = read(BYX);
  const headerTint = byx.match(/<tr className="border-b (bg-muted\/\d+)/)?.[1];
  const bodyHover = byx.match(/<tr key=\{r\.key\}[\s\S]{0,120}?hover:(bg-muted\/\d+)/)?.[1];
  check(
    `S4b the By-X table re-uses the shared bundle and tints its header with its own ${headerTint ?? "?"} and its body rows with its own ${bodyHover ?? "?"}`,
    byx.includes("FROZEN_FIRST_COLUMN_CELL") &&
      !!headerTint &&
      !!bodyHover &&
      byx.includes(`${"${FROZEN_FIRST_COLUMN_CELL}"} before:${headerTint}`) &&
      byx.includes(`${"${FROZEN_FIRST_COLUMN_CELL}"} [tr:hover>&]:before:${bodyHover}`) &&
      // One-sided: it must be the SHARED constant, not a pasted copy of it.
      !byx.includes("sticky left-0 z-10"),
    `header tint: ${headerTint ?? "none"} | body hover: ${bodyHover ?? "none"}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
