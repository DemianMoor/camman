// lib/drip/groups.ts after Phase 2 — the PREVIEW database, one rolled-back
// transaction. Proves the three helper changes (C4 marker + heal, Q6 link +
// keep-existing, Q2 delivery stamp + first-wins) against the real tables, and
// pins by SOURCE that enrichment passes the delivery time and the partner id
// (the end-to-end proof is gate B's precondition on prod: one fresh pml lead
// stamped at received_at — the batch runner cannot run inside a rolled-back
// transaction and would enqueue paid lookups on a real phone).
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-drip-groups-stamping-db.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { addContactsToGroup, ensureDripGroup, ensurePartnerTagGroup } from "@/lib/drip/groups";

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

      // ── C4: the system groups carry the marker, and a pre-0201 row is healed
      const before = (await tx.execute(sql`SELECT id, system_role FROM contact_groups WHERE contact_group_id = 'drip-intake'`)) as unknown as { id: number; system_role: string | null }[];
      if (before[0]) await tx.execute(sql`UPDATE contact_groups SET system_role = NULL WHERE id = ${before[0].id}`); // simulate a pre-0201 row
      const g1 = await ensureDripGroup(tx, { orgId, sandbox: false });
      const g1b = await ensureDripGroup(tx, { orgId, sandbox: false });
      const g2 = await ensureDripGroup(tx, { orgId, sandbox: true });
      const marks = (await tx.execute(sql`SELECT id, system_role FROM contact_groups WHERE id IN (${g1}, ${g2}) ORDER BY id`)) as unknown as { id: number; system_role: string }[];
      check("1 ensureDripGroup is idempotent", g1 === g1b);
      check("1b (C4) drip-intake carries drip_intake (healed if it was NULL)", marks.find((m) => m.id === g1)?.system_role === "drip_intake", JSON.stringify(marks));
      check("1c (C4) drip-sandbox carries drip_sandbox", marks.find((m) => m.id === g2)?.system_role === "drip_sandbox", JSON.stringify(marks));

      // ── Q6: the partner×tag group is linked at creation; an existing link is kept
      const mk = async (slug: string) => ((await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, ${slug}, ${slug}) RETURNING id`)) as unknown as { id: number }[])[0].id;
      const pA = await mk("zz-stamp-a"); const pB = await mk("zz-stamp-b");
      const gp = await ensurePartnerTagGroup(tx, { orgId, partnerSlug: "zz-stamp-a", interestTag: "ACA", partnerId: pA });
      const gp2 = await ensurePartnerTagGroup(tx, { orgId, partnerSlug: "zz-stamp-a", interestTag: "aca", partnerId: pB });
      const link = (await tx.execute(sql`SELECT name, partner_id, system_role FROM contact_groups WHERE id = ${gp}`)) as unknown as { name: string; partner_id: number; system_role: string | null }[];
      check("2 ensurePartnerTagGroup names the group <slug>-<tag> (lowercased) and links it to its partner", gp === gp2 && link[0].name === "zz-stamp-a-aca" && link[0].partner_id === pA, JSON.stringify(link));
      check("2b a second call with another partner keeps the existing link (COALESCE)", link[0].partner_id === pA);
      check("2c a partner×tag group is not a system group", link[0].system_role === null);

      // ── Q2: the membership is stamped at the given delivery time; the first delivery wins
      const [c] = (await tx.execute(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, '+15550009001') RETURNING id`)) as unknown as { id: string }[];
      const T0 = "2026-10-01T12:00:00.123456Z";
      const n1 = await addContactsToGroup(tx, { orgId, groupId: gp, contactIds: [c.id], createdAt: T0 });
      const n2 = await addContactsToGroup(tx, { orgId, groupId: gp, contactIds: [c.id], createdAt: "2026-10-01T13:00:00Z" });
      const st = (await tx.execute(sql`SELECT created_at::text AS t FROM contact_contact_groups WHERE contact_id = ${c.id}::uuid AND contact_group_id = ${gp}`)) as unknown as { t: string }[];
      check("3 addContactsToGroup stamps the membership at the given delivery time", n1 === 1 && st[0].t.startsWith("2026-10-01 12:00:00.123456"), `${n1} ${st[0]?.t}`);
      check("3b a later delivery does not move it (first wins)", n2 === 0 && st[0].t.startsWith("2026-10-01 12:00:00.123456"));
      const n3 = await addContactsToGroup(tx, { orgId, groupId: g1, contactIds: [c.id] });
      const sys = (await tx.execute(sql`SELECT (created_at > now() - interval '1 minute') AS fresh FROM contact_contact_groups WHERE contact_id = ${c.id}::uuid AND contact_group_id = ${g1}`)) as unknown as { fresh: boolean }[];
      check("3c without createdAt the stamp is now() (the system-group membership)", n3 === 1 && sys[0].fresh === true);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ── source: enrichment passes the delivery time and the partner id ───────
  const src = readFileSync("lib/drip/enrichment.ts", "utf-8");
  check("4 enrichment stamps the partner×tag membership at received_at", /createdAt:\s*row\.received_at/.test(src));
  check("4b enrichment links the group to the key's partner", /partnerId:\s*row\.partner_id/.test(src) && /pk\.partner_id/.test(src));
  check("4c the system-group membership is NOT given a delivery stamp", !/groupId:\s*row\.sandbox \? sandboxGroup : realGroup,[\s\S]{0,80}createdAt/.test(src));

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
