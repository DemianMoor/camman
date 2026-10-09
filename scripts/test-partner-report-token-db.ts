// The signed link lives on the PARTNER (0200, Q7/Q10). Fixtures inside one
// rolled-back transaction; the token functions take the transaction as their
// executor so they can see the fixtures.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-partner-report-token-db.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { issueReportToken, resolveReportToken, revokeReportToken } from "@/lib/reporting/partner-report-token";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const partner = async (slug: string) =>
        ((await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, ${slug}, ${slug}) RETURNING id`)) as unknown as { id: number }[])[0].id;
      const key = (pid: number, slug: string, sandbox: boolean, status = "active") =>
        tx.execute(sql`INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, sandbox, status)
                       VALUES (${orgId}::uuid, ${pid}, ${slug}, ${slug}, ${slug + "-" + Math.random()}, 'x', ${sandbox}, ${status})`);

      // 1. file-only partner (no keys) can have a link
      const fileOnly = await partner("zz-file-only");
      const t1 = await issueReportToken(orgId, fileOnly, null, tx);
      check("1 a file-only partner gets a link", typeof t1 === "string" && t1.length > 20);
      const r1 = await resolveReportToken(t1, tx);
      check("1b …and it resolves to the PARTNER (not a key)",
        r1?.partnerId === fileOnly && r1?.partnerSlug === "zz-file-only" && r1?.showRevenue === false, JSON.stringify(r1));

      // 2. sandbox-only partner gets NO link
      const sandboxOnly = await partner("zz-sandbox-only");
      await key(sandboxOnly, "zz-sandbox-only", true);
      const t2 = await issueReportToken(orgId, sandboxOnly, null, tx);
      check("2 a sandbox-only partner is refused a link", t2 === null);

      // 3. live key → link; a DISABLED key does not kill the partner's link (Q7: the partner's status does)
      const live = await partner("zz-live");
      await key(live, "zz-live", false, "disabled");
      await key(live, "zz-live", true);
      const t3 = await issueReportToken(orgId, live, null, tx);
      check("3 a partner with a live (even disabled) key gets a link", typeof t3 === "string");
      check("3b it resolves", (await resolveReportToken(t3, tx))?.partnerId === live);

      // 4. archiving the partner kills the link; restoring brings it back
      await tx.execute(sql`UPDATE partners SET status = 'archived', archived_at = now() WHERE id = ${live}`);
      check("4 archived partner → link resolves to null", (await resolveReportToken(t3, tx)) === null);
      await tx.execute(sql`UPDATE partners SET status = 'active', archived_at = NULL WHERE id = ${live}`);
      check("4b restored → resolves again", (await resolveReportToken(t3, tx))?.partnerId === live);

      // 5. revoke
      check("5 revoke returns true", await revokeReportToken(orgId, live, tx));
      check("5b …and the link is dead", (await resolveReportToken(t3, tx)) === null);

      // 6. stored hashed, never the plaintext; expiry honoured
      const t6 = await issueReportToken(orgId, fileOnly, new Date(Date.now() - 1000), tx);
      check("6 an expired link resolves to null", (await resolveReportToken(t6, tx)) === null);
      const stored = (await tx.execute(sql`SELECT report_token_hash FROM partners WHERE id = ${fileOnly}`)) as unknown as { report_token_hash: string }[];
      check("6b the plaintext is NOT stored", stored[0].report_token_hash !== t6 && /^[0-9a-f]{64}$/.test(stored[0].report_token_hash));

      // 7. wrong org cannot issue
      check("7 another org id cannot issue for this partner",
        (await issueReportToken("00000000-0000-0000-0000-000000000000", fileOnly, null, tx)) === null);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
