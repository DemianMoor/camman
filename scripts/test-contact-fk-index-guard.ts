// scripts/test-contact-fk-index-guard.ts — source guard (no DB), part of check:guards.
//
// 2026-11-05: deleting ONE contact from the contact page timed out. Postgres's
// FK trigger runs `DELETE/UPDATE … WHERE <fk_col> = $1` on every table that
// references contacts(id), and 12 of them had no index LEADING on that column
// (a composite like (org_id, contact_id) does not count — PG 17 cannot skip-scan
// it). One delete seq-scanned ~21M rows. Migration 0235 indexed them; this
// guard keeps the next table from repeating it — the cost is invisible while a
// table is small and grows linearly with it.
//
//   G1  every column in db/schema.ts declared `.references(() => contacts.id …)`
//       is the FIRST column of an index, unique constraint, or primary key
//       declared in the same table (or is itself .primaryKey() / .unique());
//   G2  the guard actually finds the known FK columns (a parser that matches
//       nothing would pass G1 vacuously).
//
// The live-database twin of this check is
// `npx tsx scripts/apply-contact-fk-indexes-concurrent.ts --verify`.
import { readFileSync } from "node:fs";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const src = readFileSync("db/schema.ts", "utf8");
const blocks = src.split(/^export const (\w+) = pgTable\(/m);

const fks: { table: string; col: string; indexed: boolean }[] = [];
for (let i = 1; i < blocks.length; i += 2) {
  const varName = blocks[i];
  const body = blocks[i + 1].split(/^\);/m)[0];
  const refRe = /\.references\(\s*\(\)\s*=>\s*contacts\.id\b/g;
  for (let m; (m = refRe.exec(body)); ) {
    const before = body.slice(0, m.index);
    const cols = [...before.matchAll(/^\s*(\w+):\s*\w+\(/gm)];
    const col = cols[cols.length - 1]?.[1];
    if (!col) { fks.push({ table: varName, col: "?", indexed: false }); continue; }
    const leads = new RegExp(
      String.raw`(?:(?:index|uniqueIndex|unique)\("[^"]*"\)\s*\.on\(|primaryKey\(\{\s*columns:\s*\[)\s*table\.${col}\b`,
    );
    // An inline .primaryKey() / .unique() on the column itself is also a leading index.
    const colDef = before.slice(cols[cols.length - 1].index) + body.slice(m.index).split(/\n\s*\w+:\s*\w+\(/)[0];
    const inline = /\.(primaryKey|unique)\(\)/.test(colDef);
    fks.push({ table: varName, col, indexed: inline || leads.test(body) });
  }
}

console.log("Contact FK index guard");
const unindexed = fks.filter((f) => !f.indexed).map((f) => `${f.table}.${f.col}`);
bar("G1 every FK into contacts leads an index in its table", unindexed.length === 0,
  unindexed.length ? `add an index on: ${unindexed.join(", ")}` : `${fks.length} FK columns`);
const known = ["stage_sends.contact_id", "creative_exposures.contact_id", "texthub_inbound_events.matched_contact_id"];
const found = new Set(fks.map((f) => `${f.table}.${f.col}`));
bar("G2 parser finds the known FK columns", known.every((k) => found.has(k)) && fks.length >= 20,
  `${fks.length} found`);

if (fail) { console.log(`\nFAIL — ${fail} bar(s)`); process.exit(1); }
console.log("\nPASS");
