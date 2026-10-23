// scripts/test-session-set-guard.ts — source guard (no DB), part of check:guards.
//
// 2026-10-22: three ad-hoc "read-only" check scripts ran
// `SET default_transaction_read_only = on` through DATABASE_URL, which is
// Supavisor's TRANSACTION pooler (:6543). A session-level SET sticks to the
// shared server backend, not to the script, so the live app inherited it:
// 340 app INSERT/UPDATEs failed with "cannot execute … in a read-only
// transaction" (17:55–18:45 UTC) until every backend was RESET.
//
// A read-only check opens its OWN connection and makes the TRANSACTION read
// only — scripts/_readonly-db.ts (`withReadOnlyDb`). So:
//   G1  no source under scripts/ lib/ app/ SETS default_transaction_read_only
//       (SET … / set_config; comments excluded; reading it is fine) — there is
//       no safe way to set it on a pooled URL;
//   G2  no source runs SET SESSION …;
//   G3  the helper exists and is transaction-scoped on a dedicated session-mode
//       connection;
//   G4  the needles match the incident's shapes and not the safe ones;
//   G5  ANY other session-level SET (statement_timeout, lock_timeout, work_mem,
//       set_config(…, false), …) lives only in a file that opens its own
//       session-mode connection (toSessionModeUrl + max: 1). On the shared pool
//       use SET LOCAL inside a transaction instead (2026-10-23).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SELF = "scripts/test-session-set-guard.ts";
const HELPER = "scripts/_readonly-db.ts";
// Setting it, in any spelling — reading it with current_setting() is fine.
const READ_ONLY_DEFAULT = /\bSET\s+(SESSION\s+)?default_transaction_read_only\b|set_config\(\s*'default_transaction_read_only'/i;
const SET_SESSION = /\bSET\s+SESSION\b/i;
// A SET that STARTS a SQL string (after a quote/backtick/paren/semicolon), so an
// UPDATE's `SET col = …` on its own line is not one; LOCAL/TRANSACTION/
// CONSTRAINTS are transaction-scoped. Plus set_config(…, false) = session scope.
const SESSION_SET = /[`'"(;]\s*SET\s+(SESSION\s+)?(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)[a-z_][a-z0-9_.]*\s*(=|TO\b)|set_config\([^)]*,\s*false\s*\)/i;
const DEDICATED = (s: string) => /toSessionModeUrl\(/.test(s) && /max:\s*1\b/.test(s);

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules" || e.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(e)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

console.log("Session-level SET guard");
const files = [...walk("scripts"), ...walk("lib"), ...walk("app")].filter((f) => f !== SELF);
const src = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
const g1 = files.filter((f) => READ_ONLY_DEFAULT.test(src.get(f)!));
bar("G1 nothing sets default_transaction_read_only (use withReadOnlyDb)", g1.length === 0, JSON.stringify(g1));
const g2 = files.filter((f) => SET_SESSION.test(src.get(f)!));
bar("G2 nothing runs SET SESSION", g2.length === 0, JSON.stringify(g2));

const helper = existsSync(HELPER) ? stripComments(readFileSync(HELPER, "utf8")) : "";
bar("G3 _readonly-db.ts opens its own session-mode connection (toSessionModeUrl, max: 1)",
  /toSessionModeUrl\(/.test(helper) && /max:\s*1\b/.test(helper));
bar("G3 …and makes the TRANSACTION read only (begin(\"read only\"), no session SET)",
  /\.begin\(\s*["']read only["']/.test(helper) && !/\bSET\s+(?!LOCAL\b)/i.test(helper));

const hits = [
  "await sql`SET default_transaction_read_only = on`;",
  "sql`\n  SET default_transaction_read_only TO on`",
  "SELECT set_config('default_transaction_read_only', 'on', false)",
];
const sessionHits = ["SET SESSION statement_timeout = '5s'", "set session characteristics as transaction read only"];
const safe = ["BEGIN READ ONLY", "sql.begin(\"read only\", async (tx) => {})", "SET LOCAL statement_timeout = '5s'", "SET TRANSACTION READ ONLY", "UPDATE t SET session_id = 1",
  "SELECT current_setting('default_transaction_read_only') d"];
bar("G4 needles catch the incident shapes", hits.every((h) => READ_ONLY_DEFAULT.test(h)) && sessionHits.every((h) => SET_SESSION.test(h)));
bar("G4 …and pass the transaction-scoped ones", safe.every((s) => !READ_ONLY_DEFAULT.test(s) && !SET_SESSION.test(s)));

const g5 = files.filter((f) => SESSION_SET.test(src.get(f)!) && !DEDICATED(src.get(f)!));
bar("G5 every session-level SET is on a dedicated session-mode connection (else SET LOCAL in a transaction)",
  g5.length === 0, JSON.stringify(g5));
const anyHits = [
  "await db.execute(sql`SET statement_timeout = '120s'`)",
  "await db.execute(sql`set statement_timeout = '40s'`)",
  "pg.unsafe(`SET lock_timeout = '5s'`)",
  "sql.raw(`set work_mem = '64MB'`)",
  "sql`\n      SET maintenance_work_mem TO '1GB'`",
  "SELECT set_config('statement_timeout', '5s', false)",
];
const anySafe = [
  "tx.execute(sql`SET LOCAL statement_timeout = '120s'`)",
  "sql`\n  UPDATE org_members\n  SET role = ${r}`",
  "SELECT set_config('camman.allow_widened_backdate', 'on', true)",
  "`BEGIN; SET TRANSACTION READ ONLY`",
];
bar("G5 needle catches every session-SET shape", anyHits.every((h) => SESSION_SET.test(h)), JSON.stringify(anyHits.filter((h) => !SESSION_SET.test(h))));
bar("G5 …and passes SET LOCAL / UPDATE … SET / set_config(…, true)", anySafe.every((s) => !SESSION_SET.test(s)), JSON.stringify(anySafe.filter((s) => SESSION_SET.test(s))));

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
