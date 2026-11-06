// Bar for scripts/backfill-contact-blocks-from-opt-outs.ts (0237, spec O2/D5).
// Runs the REAL script with --apply against the PREVIEW DB on a fixture:
//   A  two opt_outs rows reason 'suppressed' (dup per contact) → ONE ledger row,
//      created_at = the earlier row; contact blocked (provider_list)
//   B  one 'scrubbed' row → ledger row + contact blocked
//   C  only reason 'opt_out' → untouched (not a provider-list row)
//   D  'suppressed' row but the phone ALREADY has an active 'manual' block →
//      ledger unchanged (no second active row), contact keeps 'manual'
//   R  a re-run adds nothing (idempotent); opt_outs rows are never touched.
// ⚠️ The script processes EVERY suppressed/scrubbed opt_outs row on the target.
// The preview DB holds none besides this fixture (checked first: refuses if any).
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-contact-blocks-backfill.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { execFileSync } from "node:child_process";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];
const runBackfill = () =>
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/backfill-contact-blocks-from-opt-outs.ts", "--apply", "--off-window"], {
    cwd: process.cwd(), encoding: "utf8", env: process.env,
  });

async function main() {
  const pre = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE reason IN ('suppressed', 'scrubbed')`);
  if (pre.n !== 0) {
    console.error(`REFUSING — the preview DB already has ${pre.n} suppressed/scrubbed opt_outs rows; the backfill would touch them.`);
    process.exit(1);
  }
  const sfx = Date.now().toString().slice(-7);
  const phones = { A: `+1914${sfx}1`, B: `+1914${sfx}2`, C: `+1914${sfx}3`, D: `+1914${sfx}4` };
  const ids: Record<string, string> = {};
  const blockIds: number[] = [];
  try {
    const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
    for (const [k, p] of Object.entries(phones)) {
      ids[k] = (await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${p}) RETURNING id`)).id;
    }
    const oo = (k: string, reason: string, at: string) => db.execute(sql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, reason, source, created_at)
      VALUES (${orgId}, ${ids[k]}, ${phones[k as keyof typeof phones]}, ${reason}, 'test', ${at}::timestamptz)`);
    await oo("A", "suppressed", "2026-01-02T00:00:00Z");
    await oo("A", "suppressed", "2026-01-01T00:00:00Z");
    await oo("B", "scrubbed", "2026-02-01T00:00:00Z");
    await oo("C", "opt_out", "2026-03-01T00:00:00Z");
    await oo("D", "suppressed", "2026-04-01T00:00:00Z");
    const manual = await one<{ id: number }>(sql`
      INSERT INTO contact_blocks (org_id, phone_number, reason, source) VALUES (${orgId}, ${phones.D}, 'manual', 'test') RETURNING id`);
    blockIds.push(manual.id);
    await db.execute(sql`UPDATE contacts SET blocked_at = now(), block_reason = 'manual' WHERE id = ${ids.D}`);
    const ooBefore = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ANY(${`{${Object.values(ids).join(",")}}`}::uuid[])`);

    const out1 = runBackfill();
    console.log(out1.split("\n").filter((l) => /done:|verify:|HOT/.test(l)).map((l) => `    ${l}`).join("\n"));

    const ledger = async (k: string) => (await db.execute(sql`
      SELECT id, reason, source, created_at FROM contact_blocks
      WHERE org_id = ${orgId} AND phone_number = ${phones[k as keyof typeof phones]} AND released_at IS NULL`)) as unknown as
      { id: number; reason: string; source: string; created_at: string }[];
    const contact = (k: string) => one<{ blocked_at: string | null; block_reason: string | null; ms: string }>(sql`
      SELECT blocked_at, block_reason, messaging_status AS ms FROM contacts WHERE id = ${ids[k]}`);

    const lA = await ledger("A"); const cA = await contact("A");
    lA.forEach((r) => blockIds.push(r.id));
    bar("A one ledger row (dup opt_outs collapse), provider_list, earliest created_at",
      lA.length === 1 && lA[0].reason === "provider_list" && lA[0].source === "opt_outs backfill" &&
      new Date(lA[0].created_at).toISOString() === "2026-01-01T00:00:00.000Z", JSON.stringify(lA));
    bar("A contact blocked: blocked_at = ledger created_at, reason provider_list, messaging_status blocked",
      cA.block_reason === "provider_list" && cA.ms === "blocked" &&
      new Date(cA.blocked_at!).toISOString() === "2026-01-01T00:00:00.000Z", JSON.stringify(cA));
    const lB = await ledger("B"); const cB = await contact("B");
    lB.forEach((r) => blockIds.push(r.id));
    bar("B scrubbed → ledger row + contact blocked", lB.length === 1 && lB[0].reason === "provider_list" && cB.block_reason === "provider_list");
    const lC = await ledger("C"); const cC = await contact("C");
    bar("C opt_out-only phone untouched", lC.length === 0 && cC.blocked_at === null && cC.ms === "eligible", JSON.stringify(cC));
    const lD = await ledger("D"); const cD = await contact("D");
    bar("D existing active 'manual' block kept; no second active row; contact stays manual",
      lD.length === 1 && lD[0].reason === "manual" && cD.block_reason === "manual", JSON.stringify(lD));

    const out2 = runBackfill();
    bar("R re-run is a no-op (+0 ledger rows, 0 contacts)", /\+0 ledger rows, 0 contacts blocked/.test(out2),
      out2.split("\n").find((l) => l.startsWith("done:")) ?? "");
    const ooAfter = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ANY(${`{${Object.values(ids).join(",")}}`}::uuid[])`);
    bar("R opt_outs rows untouched", ooAfter.n === ooBefore.n && ooAfter.n === 5, `${ooBefore.n} → ${ooAfter.n}`);
    bar("R script verify reported 0 invariant violations", /"invariant_violations":0/.test(out1) && /"invariant_violations":0/.test(out2));
  } finally {
    for (const id of blockIds) await db.execute(sql`DELETE FROM contact_blocks WHERE id = ${id}`);
    for (const id of Object.values(ids)) await db.execute(sql`DELETE FROM contacts WHERE id = ${id}`); // opt_outs cascade
    const left = await one<{ n: number }>(sql`
      SELECT ((SELECT count(*) FROM contacts WHERE phone_number = ANY(${`{${Object.values(phones).join(",")}}`}::text[]))
            + (SELECT count(*) FROM contact_blocks WHERE phone_number = ANY(${`{${Object.values(phones).join(",")}}`}::text[])))::int AS n`);
    console.log(`\nTeardown: ${left.n} row(s) left`);
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
