// Minor #5: two concurrent "make default" calls must not 500. Deterministic:
// transaction A makes T2 the default and HOLDS its commit while B tries T3. On
// the old code B's clear-old-default skips A's row (EvalPlanQual sees T1 no
// longer default) and its set hits the one-default-per-org unique index (23505).
// Throwaway org on the preview DB, torn down by id.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-message-formats-default-race.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { makeDefaultFormat } from "@/lib/messages/format-admin";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${"race " + Date.now()}) RETURNING id`)).id;
    await db.execute(sql`SELECT ensure_message_formats(${orgId}::uuid)`);
    const fmts = (await db.execute(sql`SELECT id, name FROM message_formats WHERE org_id = ${orgId}::uuid ORDER BY id`)) as unknown as { id: number; name: string }[];
    const t2 = fmts.find((f) => f.name.startsWith("T2"))!.id;
    const t3 = fmts.find((f) => f.name.startsWith("T3"))!.id;

    let bResult: Awaited<ReturnType<typeof makeDefaultFormat>> | { error: string } | null = null;
    let bDone: Promise<void> = Promise.resolve();
    await db.transaction(async (txA) => {
      const a = await makeDefaultFormat(txA, orgId, t2);
      bar("A: make T2 default ⇒ ok", a.ok);
      bDone = db
        .transaction((txB) => makeDefaultFormat(txB, orgId, t3))
        .then((r) => { bResult = r; })
        .catch((e) => { bResult = { error: String((e as { cause?: unknown }).cause ?? e).slice(0, 120) }; });
      await new Promise((r) => setTimeout(r, 1500)); // B is now blocked behind A
    });
    await bDone;
    const r = bResult as unknown as { ok?: boolean; error?: string };
    bar("B (concurrent): make T3 default ⇒ ok, no unique-index 500", r?.ok === true, JSON.stringify(r).slice(0, 160));
    const defs = (await db.execute(sql`SELECT id FROM message_formats WHERE org_id = ${orgId}::uuid AND is_default`)) as unknown as { id: number }[];
    bar("exactly one default afterwards, and it is the last writer's (T3)", defs.length === 1 && defs[0].id === t3, JSON.stringify(defs));
  } finally {
    if (orgId) await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
