// READ-ONLY DATABASE ACCESS FOR SCRIPTS — the only sanctioned way to "make a
// check read-only".
//
// ⚠️ NEVER `SET default_transaction_read_only = on` (or any session-level SET)
// on DATABASE_URL. It is Supavisor's TRANSACTION pooler (:6543): the setting
// sticks to the shared server backend, not to this script, and the live app
// inherits it. On 2026-10-22 that failed 340 production INSERT/UPDATEs in 50
// minutes. Guarded by scripts/test-session-set-guard.ts.
//
// This opens a DEDICATED session-mode connection (:5432, one backend, closed in
// `finally`) and runs `fn` inside ONE `BEGIN READ ONLY` transaction, so the read
// only-ness ends with the transaction and cannot outlive it on any backend.
//
//   import "./_env-preload";
//   import { withReadOnlyDb } from "./_readonly-db";
//   await withReadOnlyDb(async (tx) => console.log(await tx`SELECT count(*) FROM contacts`));
import postgres from "postgres";

import { toSessionModeUrl } from "@/lib/db/session-url";

export async function withReadOnlyDb<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const sql = postgres(toSessionModeUrl(raw), { prepare: false, max: 1, connect_timeout: 15 });
  try {
    return (await sql.begin("read only", fn)) as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
