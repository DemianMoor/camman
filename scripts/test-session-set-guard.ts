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
//   G4  the needles match the incident's shapes and not the safe ones.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SELF = "scripts/test-session-set-guard.ts";
const HELPER = "scripts/_readonly-db.ts";
// Setting it, in any spelling — reading it with current_setting() is fine.
const READ_ONLY_DEFAULT = /\bSET\s+(SESSION\s+)?default_transaction_read_only\b|set_config\(\s*'default_transaction_read_only'/i;
const SET_SESSION = /\bSET\s+SESSION\b/i;

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

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
