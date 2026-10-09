// 0200 on the PREVIEW database. Runs after the preview deploy has applied the
// migration (camman-v2 auto-applies on every preview build). Part A asserts
// the catalog + backfill; Part B inserts fixtures inside ONE rolled-back
// transaction to prove two keys of one partner may share a slug and that
// ON DELETE RESTRICT holds.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-partners-migration-db.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");
const pgMessage = (e: unknown) => (e as { cause?: Error }).cause?.message ?? (e as Error).message;

async function main() {
  // ── A. catalog + backfill ────────────────────────────────────────────────
  const cols = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'partners' ORDER BY ordinal_position
  `)) as unknown as { column_name: string }[];
  const colList = cols.map((c) => c.column_name).join(",");
  check("A1 partners has the 12 columns", colList ===
    "id,org_id,slug,name,status,archived_at,created_at,created_by,report_token_hash,report_token_issued_at,report_token_expires_at,report_show_revenue",
    colList);
  const idx = (await db.execute(sql`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('partners', 'partner_keys') ORDER BY indexname
  `)) as unknown as { indexname: string }[];
  const names = idx.map((i) => i.indexname);
  check("A2 partners indexes exist",
    ["partners_org_slug_uniq", "partners_report_token_hash_uniq", "partners_org_status_idx"].every((n) => names.includes(n)), names.join(","));
  check("A3 partner_keys_org_slug_uniq is GONE; partner_keys_org_slug_idx + partner_keys_partner_id_idx exist",
    !names.includes("partner_keys_org_slug_uniq") && names.includes("partner_keys_org_slug_idx") && names.includes("partner_keys_partner_id_idx"),
    names.join(","));
  const rls = (await db.execute(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'partners'`)) as unknown as { relrowsecurity: boolean }[];
  check("A4 RLS enabled on partners", rls[0]?.relrowsecurity === true);
  const pol = (await db.execute(sql`SELECT policyname FROM pg_policies WHERE tablename = 'partners'`)) as unknown as { policyname: string }[];
  check("A5 the SELECT policy exists and is the only one", pol.length === 1 && pol[0].policyname === "partners_select_own_org", JSON.stringify(pol));
  const bf = (await db.execute(sql`
    SELECT count(*)::int AS keys,
           count(*) FILTER (WHERE k.partner_id IS NULL)::int AS unassigned,
           count(*) FILTER (WHERE p.slug = k.partner_slug AND p.name = k.name
                              AND p.report_show_revenue = k.report_show_revenue
                              AND p.report_token_hash IS NOT DISTINCT FROM k.report_token_hash)::int AS copied
    FROM partner_keys k LEFT JOIN partners p ON p.id = k.partner_id
  `)) as unknown as { keys: number; unassigned: number; copied: number }[];
  check("A6 every key has a partner, and slug/name/revenue/token hash were copied",
    bf[0].unassigned === 0 && bf[0].copied === bf[0].keys, JSON.stringify(bf[0]));
  const nn = (await db.execute(sql`
    SELECT is_nullable FROM information_schema.columns WHERE table_name = 'partner_keys' AND column_name = 'partner_id'
  `)) as unknown as { is_nullable: string }[];
  check("A7 partner_keys.partner_id is still NULLABLE (C2)", nn[0]?.is_nullable === "YES", JSON.stringify(nn[0]));

  // ── B. behaviour, rolled back ────────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const p = (await tx.execute(sql`
        INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'zz-plan-test', 'Plan test') RETURNING id
      `)) as unknown as { id: number }[];
      const pid = p[0].id;
      const mk = (token: string) => tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId}::uuid, ${pid}, 'zz-plan-test', 'Plan test', ${token}, 'x')
      `);
      await mk("plan-token-1");
      await mk("plan-token-2");
      const two = (await tx.execute(sql`SELECT count(*)::int AS n FROM partner_keys WHERE partner_id = ${pid}`)) as unknown as { n: number }[];
      check("B1 two keys of one partner share a slug", two[0].n === 2);

      let restricted = false;
      await tx.execute(sql`SAVEPOINT s1`);
      try {
        await tx.execute(sql`DELETE FROM partners WHERE id = ${pid}`);
      } catch (e) {
        restricted = /violates foreign key constraint/.test(pgMessage(e));
        await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
      }
      check("B2 deleting a partner with keys is RESTRICTed", restricted);

      let dupSlug = false;
      await tx.execute(sql`SAVEPOINT s2`);
      try {
        await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'zz-plan-test', 'again')`);
      } catch (e) {
        dupSlug = /partners_org_slug_uniq/.test(pgMessage(e));
        await tx.execute(sql`ROLLBACK TO SAVEPOINT s2`);
      }
      check("B3 partner slug is unique per org", dupSlug);

      let badSlug = false;
      await tx.execute(sql`SAVEPOINT s3`);
      try {
        await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'Bad Slug', 'x')`);
      } catch (e) {
        badSlug = /partners_slug_check/.test(pgMessage(e));
        await tx.execute(sql`ROLLBACK TO SAVEPOINT s3`);
      }
      check("B4 the slug CHECK rejects uppercase/spaces", badSlug);
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
