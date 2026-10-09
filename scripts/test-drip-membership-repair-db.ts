// scripts/repair-drip-membership-appearance.ts against the PREVIEW database,
// inside ONE rolled-back transaction (the backup table is created inside it,
// so it rolls back too). Proves: scope (drip partner×tag groups only, by the
// naming rule, system groups and underscore-slug look-alikes untouched),
// idempotency, append-only backup, and the revert.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-drip-membership-repair-db.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { countRepairable, repair, revert } from "./repair-drip-membership-appearance";

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
      const base = await countRepairable(tx);
      console.log(`(preview baseline: rows_to_repair=${base.rows_to_repair})`);

      // fixtures — partner, key, groups
      const [p] = (await tx.execute(sql`INSERT INTO partners (org_id, slug, name) VALUES (${orgId}::uuid, 'zz-rep', 'zz-rep') RETURNING id`)) as unknown as { id: number }[];
      const [k] = (await tx.execute(sql`INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, sandbox)
        VALUES (${orgId}::uuid, ${p.id}, 'zz-rep', 'zz-rep', 'tok-zz-rep', 'h', false) RETURNING id`)) as unknown as { id: number }[];
      const grp = async (key: string, name: string) =>
        ((await tx.execute(sql`INSERT INTO contact_groups (contact_group_id, org_id, name, status) VALUES (${key}, ${orgId}::uuid, ${name}, 'active') RETURNING id`)) as unknown as { id: number }[])[0].id;
      const gAca = await grp(`drip:${orgId}:zz-rep-aca`, "zz-rep-aca");
      // a system group with no 0201 marker dependency: identified by its key
      const sys = (await tx.execute(sql`SELECT id FROM contact_groups WHERE contact_group_id = 'drip-intake'`)) as unknown as { id: number }[];
      const gSys = sys[0]?.id ?? (await grp("drip-intake", "Drip intake"));

      const T0 = "2026-10-01T12:00:00.123456Z";
      const contact = async (phone: string) =>
        ((await tx.execute(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone}) RETURNING id`)) as unknown as { id: string }[])[0].id;
      const lead = (cid: string, slug: string, tag: string | null, at: string) => tx.execute(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at, sandbox, line_type)
        VALUES (${orgId}::uuid, ${cid}::uuid, ${k.id}, ${slug}, ${tag}, ${at}::timestamptz, false, 'mobile')`);
      const member = (cid: string, gid: number, at: string) => tx.execute(sql`
        INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id, created_at) VALUES (${cid}::uuid, ${gid}, ${orgId}::uuid, ${at}::timestamptz)`);
      const stamp = async (cid: string, gid: number) =>
        ((await tx.execute(sql`SELECT created_at::text AS t FROM contact_contact_groups WHERE contact_id = ${cid}::uuid AND contact_group_id = ${gid}`)) as unknown as { t: string }[])[0].t;

      const A = await contact("+15550000001"); await lead(A, "zz-rep", "ACA", T0); await member(A, gAca, "2026-10-01T12:50:00Z");   // late by 50 min → repaired
      const B = await contact("+15550000002"); await lead(B, "zz-rep", "aca", T0); await member(B, gAca, T0);                      // exact → untouched
      const C = await contact("+15550000003"); await lead(C, "zz-rep", "aca", T0); await member(C, gSys, "2026-10-01T12:50:00Z");   // system group → untouched
      const D = await contact("+15550000004"); await lead(D, "zz_rep", "aca", T0); await member(D, gAca, "2026-10-01T12:50:00Z");   // slug 'zz_rep' ≠ 'zz-rep' → no match → untouched

      const c1 = await countRepairable(tx);
      check("1 exactly one membership is repairable (A)", c1.rows_to_repair === base.rows_to_repair + 1 && c1.backfilled_rows === base.backfilled_rows + 1, JSON.stringify(c1));
      const r1 = await repair(tx);
      check("2 repair() backs up 1 and updates 1", r1.backed_up_new === base.rows_to_repair + 1 && r1.updated === base.rows_to_repair + 1, JSON.stringify(r1));
      const a1 = await stamp(A, gAca);
      check("2b A is stamped at its first delivery, to the microsecond", a1.startsWith("2026-10-01 12:00:00.123456"), a1);
      check("2c B (exact) untouched", (await stamp(B, gAca)).startsWith("2026-10-01 12:00:00.123456"));
      check("2d C (system group) untouched", (await stamp(C, gSys)).startsWith("2026-10-01 12:50:00"));
      check("2e D ('zz_rep' is not 'zz-rep') untouched", (await stamp(D, gAca)).startsWith("2026-10-01 12:50:00"));
      const bk = (await tx.execute(sql`SELECT old_created_at::text AS o, new_created_at::text AS n FROM drip_membership_stamp_backup WHERE contact_id = ${A}::uuid`)) as unknown as { o: string; n: string }[];
      check("2f the backup holds A's old and new stamps", bk.length === 1 && bk[0].o.startsWith("2026-10-01 12:50:00") && bk[0].n.startsWith("2026-10-01 12:00:00.123456"), JSON.stringify(bk));
      const c2 = await countRepairable(tx);
      check("3 nothing left to repair", c2.rows_to_repair === 0, JSON.stringify(c2));
      const r2 = await repair(tx);
      check("3b a second run is a no-op (idempotent)", r2.backed_up_new === 0 && r2.updated === 0, JSON.stringify(r2));

      // a lead that arrives late-stamped AFTER the first run
      const E = await contact("+15550000005"); await lead(E, "zz-rep", "aca", T0); await member(E, gAca, "2026-10-01T12:00:05Z");
      const r3 = await repair(tx);
      check("4 a later run appends the new row and repairs it", r3.backed_up_new === 1 && r3.updated === 1, JSON.stringify(r3));
      const bkA = (await tx.execute(sql`SELECT old_created_at::text AS o FROM drip_membership_stamp_backup WHERE contact_id = ${A}::uuid`)) as unknown as { o: string }[];
      check("4b A's old_created_at in the backup was NOT overwritten (append-only)", bkA[0].o.startsWith("2026-10-01 12:50:00"), JSON.stringify(bkA));

      const n = await revert(tx);
      check("5 revert restores every backed-up stamp", n >= 2, `${n}`);
      check("5b A is back at 12:50", (await stamp(A, gAca)).startsWith("2026-10-01 12:50:00"));
      check("5c E is back at 12:00:05", (await stamp(E, gAca)).startsWith("2026-10-01 12:00:05"));
      const c3 = await countRepairable(tx);
      check("5d the count query sees them as repairable again", c3.rows_to_repair === base.rows_to_repair + 2, JSON.stringify(c3));
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  console.log(failed === 0 ? "\nAll checks passed. (rolled back — the backup table does not exist on the preview)" : `\n${failed} check(s) FAILED.`);
  await pgConn.end();
  if (failed > 0) process.exitCode = 1;
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
