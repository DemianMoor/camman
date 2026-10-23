// scripts/test-readonly-db-helper.ts — withReadOnlyDb behaviour, on the PREVIEW DB.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-readonly-db-helper.ts
// R1 the transaction is read only; R2 a write inside it is refused (25006);
// R4 nothing leaked: the shared pool's backends still default to read-write.
// (The session-mode connection itself is asserted by G3 in test-session-set-guard.)
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import postgres from "postgres";

import { withReadOnlyDb } from "./_readonly-db";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  const r = await withReadOnlyDb(async (tx) => {
    const [s] = await tx`SELECT current_setting('transaction_read_only') ro, inet_server_port() port`;
    let code = "";
    await tx.savepoint(async (sp) => { await sp`CREATE TEMP TABLE ro_probe (x int)`; }).catch((e: { code?: string }) => { code = e.code ?? String(e); });
    return { ro: s.ro as string, code };
  });
  bar("R1 transaction_read_only = on inside withReadOnlyDb", r.ro === "on", r.ro);
  bar("R2 a write inside it is refused with 25006", r.code === "25006", r.code);

  const pool = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
  try {
    const rows = await Promise.all(Array.from({ length: 12 }, () => pool`SELECT current_setting('default_transaction_read_only') d`));
    const bad = rows.filter((x) => x[0].d !== "off").length;
    bar("R4 shared-pool backends still default to read-write afterwards", bad === 0, `${bad}/12 read-only`);
  } finally {
    await pool.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
