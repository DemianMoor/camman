import "./_env-preload";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Partner attribution Phase 2 — measurements and the exit check. READ-ONLY.
//
//   (no flag)  print the core numbers (safe on any schema)
//   --before   same, and write the baseline file — run on the PRE-0201 schema
//              right before the repair (F2: this mode references neither
//              contact_groups.system_role nor contact_groups.partner_id)
//   --after    after the repair: re-measure, compare, and assert the post-0201
//              state (exact links by slug, the markers, the backup table)
//
// ONE predicate for both modes: system groups are contact_group_id IN
// ('drip-intake','drip-sandbox'); drip partner×tag groups are
// contact_group_id LIKE 'drip:%'. The match between a membership and its lead
// events is the naming rule of lib/drip/groups.ts partnerTagGroupName, restated
// in SQL so this script does not import the code it is checking.
//
//   npx tsx --conditions=react-server scripts/partners-phase2-measure.ts [--before|--after]

const FILE = `${process.env.LOCALAPPDATA}/Temp/claude/partners-phase2-before.json`;
type M = Record<string, number | string | null>;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n        ${detail}`}`);
}

const MEMBERS = sql`
  SELECT ccg.contact_id, ccg.contact_group_id, g.name AS group_name, ccg.created_at AS stamped,
         (SELECT min(le.received_at) FROM lead_events le
           WHERE le.contact_id = ccg.contact_id AND le.sandbox = false
             AND lower(le.partner_slug) || '-' || coalesce(nullif(lower(trim(le.interest_tag)), ''), 'untagged') = g.name) AS first_received
  FROM contact_contact_groups ccg
  JOIN contact_groups g ON g.id = ccg.contact_group_id
  WHERE g.contact_group_id LIKE 'drip:%'`;

// R3 (strict <, ruling Q3): a membership in a group that is neither a system
// drip group nor a drip partner×tag group, stamped strictly before `at`.
const r3 = (at: ReturnType<typeof sql>) => sql`count(*) FILTER (WHERE EXISTS (
  SELECT 1 FROM contact_contact_groups o JOIN contact_groups og ON og.id = o.contact_group_id
  WHERE o.contact_id = m.contact_id AND o.contact_group_id <> m.contact_group_id
    AND og.contact_group_id NOT IN ('drip-intake', 'drip-sandbox') AND og.contact_group_id NOT LIKE 'drip:%'
    AND o.created_at < ${at}))::int`;

async function core(): Promise<M> {
  const r = (await db.execute(sql`
    WITH m AS (${MEMBERS})
    SELECT count(*)::int AS members,
           count(*) FILTER (WHERE first_received IS NULL)::int AS no_lead_event,
           count(*) FILTER (WHERE stamped > first_received + interval '10 minutes')::int AS lag_over_10m,
           count(*) FILTER (WHERE stamped > first_received)::int AS lag_positive,
           count(*) FILTER (WHERE stamped = first_received)::int AS stamped_at_delivery,
           count(*) FILTER (WHERE stamped < first_received)::int AS stamped_before_delivery,
           max(stamped - first_received)::text AS max_lag,
           ${r3(sql`m.stamped`)} AS r3_against_stamp,
           ${r3(sql`m.first_received`)} AS r3_against_delivery,
           (SELECT count(*) FROM partner_keys WHERE partner_id IS NULL)::int AS keys_null_partner,
           (SELECT string_agg(id || ':' || contact_group_id || ':' || name, ' | ' ORDER BY id) FROM contact_groups
             WHERE contact_group_id IN ('drip-intake', 'drip-sandbox') OR contact_group_id LIKE 'drip:%') AS drip_groups,
           (SELECT string_agg(id || ':' || slug, ',' ORDER BY id) FROM partners) AS partners
    FROM m
  `)) as unknown as M[];
  return r[0];
}

async function after(): Promise<M> {
  const r = (await db.execute(sql`
    SELECT (SELECT string_agg(g.name || '→' || coalesce(p.slug, 'null'), ',' ORDER BY g.name)
              FROM contact_groups g LEFT JOIN partners p ON p.id = g.partner_id
             WHERE g.contact_group_id LIKE 'drip:%') AS drip_links,
           (SELECT string_agg(contact_group_id || '=' || coalesce(system_role, 'null'), ',' ORDER BY contact_group_id)
              FROM contact_groups WHERE contact_group_id IN ('drip-intake', 'drip-sandbox')) AS markers,
           (SELECT count(*) FROM contact_groups WHERE system_role IS NOT NULL AND partner_id IS NOT NULL)::int AS system_with_partner,
           (SELECT count(*) FROM partner_attribution_recalcs)::int AS recalc_rows,
           (SELECT count(*) FROM drip_membership_stamp_backup)::int AS backup_rows,
           (SELECT count(*) FROM drip_membership_stamp_backup b
              JOIN contact_contact_groups c ON c.contact_id = b.contact_id AND c.contact_group_id = b.contact_group_id
             WHERE c.created_at <> b.new_created_at)::int AS backup_rows_not_applied
  `)) as unknown as M[];
  return r[0];
}

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}   at ${new Date().toISOString()}`);
  const m = await core();
  for (const [k, v] of Object.entries(m)) console.log(`  ${k}: ${v}`);
  if (process.argv.includes("--before")) {
    writeFileSync(FILE, JSON.stringify(m, null, 2));
    console.log(`\nbaseline written (${FILE})`);
  } else if (process.argv.includes("--after")) {
    const b = JSON.parse(readFileSync(FILE, "utf-8")) as M;
    const a = await after();
    for (const [k, v] of Object.entries(a)) console.log(`  ${k}: ${v}`);
    console.log("\n── exit checks ──");
    check("0201 (C2): partner_keys.partner_id has 0 NULLs", m.keys_null_partner === 0);
    check("0201 (C4): drip-intake=drip_intake, drip-sandbox=drip_sandbox", a.markers === "drip-intake=drip_intake,drip-sandbox=drip_sandbox", String(a.markers));
    check("0201: no system group carries a partner", a.system_with_partner === 0);
    check("⭐ 0201 (Q6, F5): exact links — bsd-untagged→bsd, pml-aca→pml", a.drip_links === "bsd-untagged→bsd,pml-aca→pml", String(a.drip_links));
    check("⭐ repair: no drip partner×tag membership is stamped after delivery", m.lag_positive === 0, `lag_positive=${m.lag_positive}`);
    check("⭐ repair: every membership is stamped exactly at first delivery", m.stamped_at_delivery === m.members && m.stamped_before_delivery === 0, `${m.stamped_at_delivery}/${m.members}, before=${m.stamped_before_delivery}`);
    check("⭐ R3 count did NOT move (before == after == against delivery)",
      m.r3_against_stamp === b.r3_against_stamp && m.r3_against_stamp === m.r3_against_delivery && b.r3_against_stamp === b.r3_against_delivery,
      `before: stamp ${b.r3_against_stamp} / delivery ${b.r3_against_delivery}; after: stamp ${m.r3_against_stamp} / delivery ${m.r3_against_delivery}`);
    check("repair: backup rows ≥ the rows that were repairable before, and every backup row is applied",
      Number(a.backup_rows) >= Number(b.lag_positive) && a.backup_rows_not_applied === 0, `backup ${a.backup_rows} vs before lag_positive ${b.lag_positive}; not applied ${a.backup_rows_not_applied}`);
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    if (failures > 0) process.exitCode = 1;
  }
  await pgConn.end();
}
main().catch(async (e) => { console.error(e); await pgConn.end(); process.exit(1); });
