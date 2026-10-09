// Migration 0201 on the PREVIEW database (partner attribution Phase 2).
// Part A asserts the catalog after the preview apply; Part B runs the Q6
// auto-link statement text and the constraints on fixtures inside ONE
// rolled-back transaction.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-0201-group-partner-link-db.ts
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

// The 0201 Q6 backfill statement, verbatim (F4: exact prefix, longest slug wins).
const AUTOLINK = sql`
  UPDATE contact_groups g SET partner_id = p.id FROM partners p
  WHERE g.org_id = p.org_id AND g.contact_group_id LIKE 'drip:%' AND g.partner_id IS NULL AND g.system_role IS NULL
    AND left(g.name, length(p.slug) + 1) = p.slug || '-'
    AND NOT EXISTS (SELECT 1 FROM partners p2 WHERE p2.org_id = g.org_id AND p2.id <> p.id
                      AND left(g.name, length(p2.slug) + 1) = p2.slug || '-' AND length(p2.slug) > length(p.slug))`;

async function main() {
  // ── A. catalog ──────────────────────────────────────────────────────────
  const nn = (await db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'partner_keys' AND column_name = 'partner_id'`)) as unknown as { is_nullable: string }[];
  check("A1 partner_keys.partner_id is NOT NULL (C2 done)", nn[0]?.is_nullable === "NO", JSON.stringify(nn[0]));
  const cols = (await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'contact_groups' AND column_name IN ('partner_id','system_role') ORDER BY 1`)) as unknown as { column_name: string }[];
  check("A2 contact_groups has partner_id + system_role", cols.map((c) => c.column_name).join(",") === "partner_id,system_role", JSON.stringify(cols));
  const idx = (await db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('contact_groups','partner_attribution_recalcs') ORDER BY 1`)) as unknown as { indexname: string; indexdef: string }[];
  check("A3 partial index contact_groups_org_partner_idx WHERE partner_id IS NOT NULL",
    idx.some((i) => i.indexname === "contact_groups_org_partner_idx" && /WHERE \(partner_id IS NOT NULL\)/.test(i.indexdef)), idx.map((i) => i.indexname).join(","));
  check("A4 recalc indexes exist", ["partner_attribution_recalcs_org_status_idx", "partner_attribution_recalcs_group_idx"].every((n) => idx.some((i) => i.indexname === n)));
  const marks = (await db.execute(sql`SELECT contact_group_id, system_role FROM contact_groups WHERE contact_group_id IN ('drip-intake','drip-sandbox') ORDER BY 1`)) as unknown as { contact_group_id: string; system_role: string | null }[];
  check(`A5 (C4) drip-intake → drip_intake, drip-sandbox → drip_sandbox (${marks.length} such group(s) exist here)`,
    marks.every((m) => (m.contact_group_id === "drip-intake" ? m.system_role === "drip_intake" : m.system_role === "drip_sandbox")), JSON.stringify(marks));
  const rls = (await db.execute(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'partner_attribution_recalcs'`)) as unknown as { relrowsecurity: boolean }[];
  check("A6 RLS on partner_attribution_recalcs", rls[0]?.relrowsecurity === true);

  // ── B. behaviour, rolled back ────────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      let notNull = false;
      await tx.execute(sql`SAVEPOINT s1`);
      try { await tx.execute(sql`INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash) VALUES (${orgId}::uuid, 'zz-nopartner', 'x', 'tok-zz-nopartner', 'h')`); }
      catch (e) { notNull = /null value in column "partner_id"/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`); }
      check("B1 a key without partner_id → 23502", notNull);

      const mk = async (slug: string) => ((await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, ${slug}, ${slug}) RETURNING id`)) as unknown as { id: number }[])[0].id;
      const pAb = await mk("zz-ab"); const pAbCd = await mk("zz-ab-cd"); const pOther = await mk("zz-other"); const pUnder = await mk("zz_u");
      const grp = async (key: string, name: string) =>
        ((await tx.execute(sql`INSERT INTO contact_groups (contact_group_id, org_id, name, status) VALUES (${key}, ${orgId}::uuid, ${name}, 'active') RETURNING id`)) as unknown as { id: number }[])[0].id;
      const g1 = await grp(`drip:${orgId}:zz-ab-cd-x`, "zz-ab-cd-x");
      const g2 = await grp(`drip:${orgId}:zz-ab-y`, "zz-ab-y");
      const g3 = await grp(`zz-manual-ab-z`, "zz-ab-z");           // not a drip key → never auto-linked
      const g4 = await grp(`drip:${orgId}:zz-ab-w`, "zz-ab-w");
      await tx.execute(sql`UPDATE contact_groups SET partner_id = ${pOther} WHERE id = ${g4}`); // an existing link must survive
      const g5 = await grp(`drip:${orgId}:zzxu-t`, "zzxu-t");       // F4: 'zz_u' must NOT match 'zzxu-t'
      const g6 = await grp(`drip:${orgId}:zz_u-t`, "zz_u-t");       // …but DOES match its own slug
      await tx.execute(AUTOLINK);
      const got = (await tx.execute(sql`SELECT id, partner_id FROM contact_groups WHERE id IN (${g1}, ${g2}, ${g3}, ${g4}, ${g5}, ${g6}) ORDER BY id`)) as unknown as { id: number; partner_id: number | null }[];
      check("B2 longest slug wins: zz-ab-cd-x → zz-ab-cd", got[0].partner_id === pAbCd, JSON.stringify(got));
      check("B2b zz-ab-y → zz-ab", got[1].partner_id === pAb);
      check("B2c a non-drip key is never auto-linked", got[2].partner_id === null);
      check("B2d an already-linked group keeps its partner", got[3].partner_id === pOther);
      check("B2e (F4) 'zz_u' does not match 'zzxu-t' — exact prefix, not LIKE", got[4].partner_id === null);
      check("B2f (F4) 'zz_u' matches 'zz_u-t'", got[5].partner_id === pUnder);
      await tx.execute(AUTOLINK);
      const again = (await tx.execute(sql`SELECT partner_id FROM contact_groups WHERE id = ${g1}`)) as unknown as { partner_id: number }[];
      check("B2g idempotent", again[0].partner_id === pAbCd);

      let sysLinked = false;
      await tx.execute(sql`SAVEPOINT s2`);
      try { await tx.execute(sql`UPDATE contact_groups SET system_role = 'drip_intake', partner_id = ${pAb} WHERE id = ${g2}`); }
      catch (e) { sysLinked = /contact_groups_system_not_partner_check/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s2`); }
      check("B3 a system group cannot carry a partner (CHECK)", sysLinked);
      let badRole = false;
      await tx.execute(sql`SAVEPOINT s3`);
      try { await tx.execute(sql`UPDATE contact_groups SET system_role = 'other' WHERE id = ${g3}`); }
      catch (e) { badRole = /contact_groups_system_role_check/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s3`); }
      check("B3b system_role is constrained", badRole);
      let restrict = false;
      await tx.execute(sql`SAVEPOINT s4`);
      try { await tx.execute(sql`DELETE FROM partners WHERE id = ${pAbCd}`); }
      catch (e) { restrict = /violates foreign key constraint/.test(pgMessage(e)); await tx.execute(sql`ROLLBACK TO SAVEPOINT s4`); }
      check("B3c deleting a linked partner is RESTRICTed", restrict);

      const rc = (await tx.execute(sql`INSERT INTO partner_attribution_recalcs (org_id, contact_group_id, reason) VALUES (${orgId}::uuid, ${g1}, 'link') RETURNING status, campaigns_done`)) as unknown as { status: string; campaigns_done: number }[];
      check("B4 a recalc row starts queued with 0 done", rc[0].status === "queued" && rc[0].campaigns_done === 0, JSON.stringify(rc[0]));
      throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
