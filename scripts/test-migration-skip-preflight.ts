// Pure test of the apply-time skip preflight (scripts/_migration-skip.ts) and the
// line-ending hash rule (scripts/_migration-hash.ts) —
// part of check:guards, no DB. The scenarios are the real 2026-10-26 ones.
//
// Run: npx tsx scripts/test-migration-skip-preflight.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { hasCarriageReturn, recordedHashForm } from "./_migration-hash";
import { ACCEPTED_DRIFT, projectRefOf, skipReport } from "./_migration-skip";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const hash = (tag: string) => `h-${tag}`;
const NONE = new Set<string>();
const row = (tag: string, when: number) => ({ created_at: when, hash: hash(tag) });

const W = { m0222: 1795824000000, m0223: 1795910400000, m0225: 1796083200000, m0226: 1796169600000 };

console.log("Migration skip preflight");
{
  const r = skipReport([{ tag: "0222", when: W.m0222 }, { tag: "0225", when: W.m0225 }], [row("0222", W.m0222)], hash, NONE);
  bar("C1 a newer unapplied migration is pending, not skipped", r.skipped.length === 0 && r.pending[0]?.tag === "0225");
}
{
  // 0226 applied first, then a checkout carrying 0225 migrates.
  const r = skipReport(
    [{ tag: "0222", when: W.m0222 }, { tag: "0225", when: W.m0225 }],
    [row("0222", W.m0222), row("0226", W.m0226)],
    hash,
    NONE,
  );
  bar("C2 0225 after 0226 was applied ⇒ REFUSED (would be skipped)", r.skipped.map((e) => e.tag).join() === "0225", JSON.stringify(r));
}
{
  // 0225 applied in the window, then #378 (0223) merges and migrates.
  const r = skipReport(
    [{ tag: "0222", when: W.m0222 }, { tag: "0223", when: W.m0223 }, { tag: "0225", when: W.m0225 }],
    [row("0222", W.m0222), row("0225", W.m0225)],
    hash,
    NONE,
  );
  bar("C3 0223 after 0225 was applied ⇒ REFUSED", r.skipped.map((e) => e.tag).join() === "0223");
}
{
  const r = skipReport([{ tag: "0222", when: W.m0222 }], [row("0222", W.m0222), row("0225", W.m0225)], hash, NONE);
  bar("C4 the DB being AHEAD of this checkout is fine (applied elsewhere)", r.skipped.length === 0 && r.pending.length === 0);
}
{
  // Applied, then its journal `when` was bumped: matches by hash.
  const r = skipReport([{ tag: "0183", when: 200 }], [{ created_at: 100, hash: hash("0183") }, row("0184", 300)], hash, NONE);
  bar("C5 an applied migration whose `when` was bumped later matches by hash", r.skipped.length === 0 && r.pending.length === 0);
}
{
  const r = skipReport([{ tag: "0225", when: W.m0225 }], [row("0225", W.m0225)], hash, NONE);
  bar("C6 equal `when` with a matching record = applied (Drizzle's test is strict >)", r.skipped.length === 0 && r.pending.length === 0);
}
{
  const r = skipReport([{ tag: "0001", when: 1 }], [], hash, NONE);
  bar("C7 empty ledger ⇒ everything pending", r.pending.length === 1 && r.skipped.length === 0);
}

{
  // Refs are taken from ACCEPTED_DRIFT / built, never spelled: a quoted project
  // ref anywhere in scripts/ trips test-preview-db-guard's re-copied-guard check.
  const dbs = Object.keys(ACCEPTED_DRIFT);
  const preview = dbs[0];
  const other = "x".repeat(20); // stands for every other database, production included
  const behind = [{ tag: "0219_contact_zip", when: 50 }];
  const ledger = [row("0300", 900)];
  const onPreview = skipReport(behind, ledger, hash, new Set(Object.keys(ACCEPTED_DRIFT[preview])));
  bar("C8 a listed, verified drift on preview is reported as accepted, not refused",
    onPreview.skipped.length === 0 && onPreview.accepted.length === 1);
  const elsewhere = skipReport(behind, ledger, hash, new Set(Object.keys(ACCEPTED_DRIFT[other] ?? {})));
  bar("C9 the same entry on any other database is refused", elsewhere.skipped.length === 1);
  bar("C10 ACCEPTED_DRIFT covers exactly one database (the preview)", dbs.length === 1, dbs.join(","));
  bar("C11 ref parsed from a pooler URL", projectRefOf(`postgresql://postgres.${preview}:pw@aws-0-eu.pooler.supabase.com:6543/postgres`) === preview);
  bar("C12 ref parsed from a direct URL", projectRefOf(`postgresql://postgres:pw@db.${other}.supabase.co:5432/postgres`) === other);
}

console.log("\nLine endings vs recorded hash");
{
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const lf = "create table t (\n  id int\n);\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  bar("L1 LF file, LF hash recorded ⇒ lf", recordedHashForm(sha(lf), lf) === "lf");
  bar("L2 LF file, CRLF hash recorded ⇒ crlf (not drift)", recordedHashForm(sha(crlf), lf) === "crlf");
  bar("L3 CRLF file, LF hash recorded ⇒ lf", recordedHashForm(sha(lf), crlf) === "lf");
  bar("L4 different SQL ⇒ null (real drift still fails)", recordedHashForm(sha(lf), lf.replace("int", "bigint")) === null);
  bar("L5 no recorded row ⇒ null", recordedHashForm(undefined, lf) === null);
  bar("L6 CR detected in a pending file", hasCarriageReturn(crlf) && !hasCarriageReturn(lf));
  // The real 2026-10-12 cases: prod recorded these prefixes for files git holds as LF.
  for (const [tag, prodPrefix] of [["0204_drip_carry_over", "de5ee55b17"], ["0208_drip_daily_rollup", "11826a196a"]] as const) {
    const disk = readFileSync(`db/migrations/${tag}.sql`, "utf8");
    const asCrlf = sha(disk.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
    bar(`L7 ${tag}: prod hash is the CRLF form and is accepted`,
      asCrlf.startsWith(prodPrefix) && recordedHashForm(asCrlf, disk) === "crlf");
  }
}

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
