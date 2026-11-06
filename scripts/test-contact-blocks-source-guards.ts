// Source guards for contact blocks + soft delete (0237).
// Spec: docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md
//
//   G1 'not_applicable' readers (D1, owner ruling §15). Since 0237
//      messaging_status has THREE values: eligible / not_applicable (landline)
//      / blocked (blocked or deleted). A comparison against 'not_applicable'
//      used to mean "can (not) be messaged"; it now silently counts a blocked
//      contact as sendable. Every such comparison in app/, lib/, components/
//      must be on the allowlist below, with the reason it is a genuine
//      landline test. Gate on `= 'eligible'` instead.
//   G2 Single writer (D2, V16). Only lib/contacts/blocks.ts writes
//      contact_blocks, contacts.blocked_at / block_reason, and contacts
//      archived_at / is_archived. Any other writer can break the invariants
//      (blocked_at ⇔ active ledger row; an archived contact always has one).
//      scripts/ is out of scope (the attended backfill is the one exception).
//   G3 No hard delete (V15). No `.delete(contacts)` / `DELETE FROM contacts`
//      in app/ or lib/: a hard delete cascades away the contact's opt_outs, so
//      the number becomes sendable again on re-import. Delete is
//      softDeleteContacts. (Phase 2 Erase will be the one, explicit exception.)
//   S  Self-test: each pattern matches a known sample, so a typo can't make a
//      guard silently match nothing.
// No database. Runs in check:guards.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const files = ["app", "lib", "components"].flatMap((d) => walk(join(ROOT, d)));
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
// lib/drip/enrichment.ts contains a NUL byte; read as latin1 so it still scans.
const src = new Map(files.map((p) => [rel(p), readFileSync(p, "latin1")]));

// ── G1 ──────────────────────────────────────────────────────────────────────
const NA_COMPARE = /(?:!==?|<>|={1,3}|\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM)\s*['"]not_applicable['"]|['"]not_applicable['"]\s*(?:!==?|<>|={1,3})/gi;
const NA_ALLOW: Record<string, string> = {
  "lib/contact-stats.ts":
    "the not_applicable bucket count, next to its own `= 'eligible'` and `= 'blocked'` buckets",
};

// ── G2 ──────────────────────────────────────────────────────────────────────
const WRITER_PATTERNS: [string, RegExp][] = [
  ["raw SQL write to contact_blocks", /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+contact_blocks\b/i],
  ["drizzle write to contact_blocks", /\.(?:insert|update|delete)\(\s*contact_blocks\s*\)/],
  [
    "raw UPDATE contacts setting a block/archive column",
    /UPDATE\s+contacts\b(?:\s+\w+)?\s+SET\b[^;`]{0,600}?\b(?:blocked_at|block_reason|archived_at|is_archived)\s*=/i,
  ],
  [
    "drizzle update(contacts).set({...}) with a block/archive column",
    /\.update\(\s*contacts\s*\)\s*\.set\(\s*\{[^}]{0,600}?\b(?:blocked_at|block_reason|archived_at|is_archived)\b/,
  ],
];
const WRITER_ALLOW = new Set(["lib/contacts/blocks.ts"]);

// ── G3 ──────────────────────────────────────────────────────────────────────
const HARD_DELETE = /\.delete\(\s*contacts\s*\)|\bDELETE\s+FROM\s+contacts\b/i;

console.log("S — patterns match known samples");
const samples: [string, RegExp, string][] = [
  ["G1 SQL !=", NA_COMPARE, "count(*) FILTER (WHERE messaging_status != 'not_applicable')"],
  ["G1 TS ===", NA_COMPARE, `r.messaging_status === "not_applicable"`],
  ["G1 SQL =", NA_COMPARE, "WHERE messaging_status = 'not_applicable'"],
  ["G1 reversed", NA_COMPARE, `"not_applicable" !== status`],
  ...WRITER_PATTERNS.map(([n, re], i): [string, RegExp, string] => [
    `G2 ${n}`,
    re,
    [
      "INSERT INTO contact_blocks (org_id) VALUES ($1)",
      "await tx.update(contact_blocks).set({ released_at: now })",
      "UPDATE contacts c SET line_type = 'x', archived_at = now() WHERE id = $1",
      ".update(contacts)\n    .set({\n      is_archived: true,\n      archived_at: now,\n    })",
    ][i],
  ]),
];
for (const [n, re, s] of samples) {
  re.lastIndex = 0;
  bar(n, re.test(s));
}
bar("G3 drizzle hard delete", HARD_DELETE.test("await db\n    .delete(contacts)\n    .where(x)"));
bar("G3 raw hard delete", HARD_DELETE.test("DELETE FROM contacts WHERE id = $1"));
bar("G3 ignores contact_blocks / another identifier",
  !HARD_DELETE.test("DELETE FROM contact_blocks WHERE id = 1") && !HARD_DELETE.test(".delete(contactsTable)"));
NA_COMPARE.lastIndex = 0;
bar("G1 ignores a label string", !NA_COMPARE.test(`landline: "Landline / Not applicable"`));
bar(
  "G2 ignores an update of another table's archived_at",
  !WRITER_PATTERNS.some(([, re]) => re.test(".update(campaigns).set({ archived_at: sql`now()` })")),
);

console.log("\nG1 — 'not_applicable' comparisons are allowlisted landline tests");
const naHits: string[] = [];
for (const [file, text] of src) {
  NA_COMPARE.lastIndex = 0;
  if (NA_COMPARE.test(text) && !NA_ALLOW[file]) naHits.push(file);
}
bar("no unlisted comparison against 'not_applicable'", naHits.length === 0, naHits.join(", "));
for (const file of Object.keys(NA_ALLOW)) {
  NA_COMPARE.lastIndex = 0;
  bar(`allowlist entry still needed: ${file}`, NA_COMPARE.test(src.get(file) ?? ""), "stale entry — remove it");
}

console.log("\nG2 — only lib/contacts/blocks.ts writes the ledger / block / archive columns");
const writers: string[] = [];
for (const [file, text] of src) {
  if (WRITER_ALLOW.has(file)) continue;
  for (const [n, re] of WRITER_PATTERNS) if (re.test(text)) writers.push(`${file} (${n})`);
}
bar("no other writer", writers.length === 0, writers.join("; "));
const blocks = src.get("lib/contacts/blocks.ts") ?? "";
bar("lib/contacts/blocks.ts is a writer (the guard is pointed at the right file)",
  WRITER_PATTERNS.filter(([, re]) => re.test(blocks)).length >= 2);

console.log("\nG3 — no hard delete of a contact in app/ or lib/");
const hard = [...src].filter(([file, text]) => !file.startsWith("components/") && HARD_DELETE.test(text)).map(([f]) => f);
bar("no hard delete", hard.length === 0, hard.join(", "));
const delRoute = src.get("app/api/contacts/[id]/route.ts") ?? "";
const delBody = delRoute.slice(delRoute.indexOf("export async function DELETE"));
bar("DELETE /api/contacts/[id] soft-deletes through softDeleteContacts",
  delRoute.includes("export async function DELETE") && /softDeleteContacts\(/.test(delBody));

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
