import "./_env-preload";
import { sql, type SQL } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";

// Appearance = delivery (ruling Q2) for drip partner×tag memberships — the
// Phase 2 data repair. PRODUCTION-WRITING ON PURPOSE (owner fix F1: a script,
// not a migration; listed in scripts/test-preview-db-guard.ts EXCLUSIONS).
//
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts                    dry run: prints the counts, writes nothing
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts --apply            per group: fills the backup, then updates (one transaction each)
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts --revert --apply   restores every backed-up stamp
//
// Why: the #311 backfill stamped 8,171 pml-aca memberships up to 1 h 24 m after
// the lead arrived, and enrichment stamped processing time (seconds after) for
// every other one — 16,182 of 16,182 on 2026-10-09. R4 reads "appeared" off
// this stamp, so it must carry the lead's FIRST DELIVERY from that partner×tag.
//
// Scope: memberships of groups keyed 'drip:%' that are not the system groups
// ('drip-intake' / 'drip-sandbox' by key — no dependency on 0201's marker),
// stamped later than the first matching lead_events.received_at. The match is
// the naming rule of lib/drip/groups.ts partnerTagGroupName, restated in SQL so
// this script does not import the code whose output it corrects.
//
// Re-runnable: the backup takes ON CONFLICT DO NOTHING (an old_created_at is
// never overwritten), the UPDATE touches only rows still stamped after their
// delivery, so a later run appends the rows that arrived meanwhile and changes
// nothing it already fixed. Runs on prod only AFTER the enrichment code that
// stamps delivery time is deployed and one fresh pml lead is confirmed stamped
// at received_at — otherwise new leads keep arriving late-stamped.

export const BACKUP_TABLE = "drip_membership_stamp_backup";

/** Membership → first delivery for exactly that partner×tag group. */
/**
 * Membership → first delivery for exactly that partner×tag group. `le.org_id = g.org_id`
 * is for the planner as much as for tenancy: lead_events has no bare contact_id index, only
 * (org_id, contact_id, received_at) — the same fix the measurement script needed on
 * 2026-10-10 when the member count doubled overnight. With `groupId` the set is one group's.
 */
export function firstDelivery(groupId?: number): SQL {
  return sql`
  SELECT ccg2.contact_id, ccg2.contact_group_id, min(le.received_at) AS first_received
  FROM contact_contact_groups ccg2
  JOIN contact_groups g ON g.id = ccg2.contact_group_id
   AND g.contact_group_id LIKE 'drip:%'
   AND g.contact_group_id NOT IN ('drip-intake', 'drip-sandbox')
  JOIN lead_events le ON le.org_id = g.org_id AND le.contact_id = ccg2.contact_id AND le.sandbox = false
   AND lower(le.partner_slug) || '-' || coalesce(nullif(lower(trim(le.interest_tag)), ''), 'untagged') = g.name
  ${groupId === undefined ? sql`` : sql`WHERE ccg2.contact_group_id = ${groupId}`}
  GROUP BY 1, 2`;
}
export const FIRST_DELIVERY: SQL = firstDelivery();

export interface Counts {
  rows_to_repair: number;
  backfilled_rows: number;
  max_lag: string | null;
}

/** The before/after count query (all groups, or one). */
export async function countRepairable(dbc: DbOrTx, groupId?: number): Promise<Counts> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS rows_to_repair,
           count(*) FILTER (WHERE ccg.created_at > fr.first_received + interval '10 minutes')::int AS backfilled_rows,
           max(ccg.created_at - fr.first_received)::text AS max_lag
    FROM contact_contact_groups ccg
    JOIN (${firstDelivery(groupId)}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received`)) as unknown as Counts[];
  return r[0];
}

/** The batches: every drip partner×tag group that still has a repairable row, with its count. Ordered by id. */
export async function listRepairGroups(dbc: DbOrTx): Promise<{ id: number; name: string; rows: number }[]> {
  return (await dbc.execute(sql`
    SELECT g.id, g.name, count(*)::int AS rows
    FROM contact_contact_groups ccg
    JOIN contact_groups g ON g.id = ccg.contact_group_id
    JOIN (${firstDelivery()}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received
    GROUP BY g.id, g.name ORDER BY g.id`)) as unknown as { id: number; name: string; rows: number }[];
}

export interface Status {
  /** rows already in the backup table; null = the table does not exist yet (first run) */
  rows_in_backup: number | null;
  /** R3 per drip partner×tag group, e.g. "pml-aca=74"; null = no members */
  r3_by_group: string | null;
}

/**
 * The two gate B proposal numbers the counts above do not carry. R3 (strict <,
 * ruling Q3) is restated from scripts/partners-phase2-measure.ts: a drip
 * partner×tag member with a membership in a non-drip group stamped BEFORE this
 * one. Read before and after so the proposal and the exit check quote the same query.
 */
export async function dryRunStatus(dbc: DbOrTx): Promise<Status> {
  const t = (await dbc.execute(sql`SELECT to_regclass('public.drip_membership_stamp_backup') IS NOT NULL AS present`)) as unknown as { present: boolean }[];
  const rows_in_backup = t[0].present
    ? ((await dbc.execute(sql`SELECT count(*)::int AS n FROM public.drip_membership_stamp_backup`)) as unknown as { n: number }[])[0].n
    : null;
  const r = (await dbc.execute(sql`
    SELECT string_agg(name || '=' || n, ', ' ORDER BY name) AS s FROM (
      SELECT g.name, count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM contact_contact_groups o JOIN contact_groups og ON og.id = o.contact_group_id
        WHERE o.contact_id = ccg.contact_id AND o.contact_group_id <> ccg.contact_group_id
          AND og.contact_group_id NOT IN ('drip-intake', 'drip-sandbox') AND og.contact_group_id NOT LIKE 'drip:%'
          AND o.created_at < ccg.created_at))::int AS n
      FROM contact_contact_groups ccg
      JOIN contact_groups g ON g.id = ccg.contact_group_id
      WHERE g.contact_group_id LIKE 'drip:%'
      GROUP BY g.name) x`)) as unknown as { s: string | null }[];
  return { rows_in_backup, r3_by_group: r[0].s };
}

/** The append-only backup table (created on the first run, kept until the owner says drop). */
export async function ensureBackupTable(dbc: DbOrTx): Promise<void> {
  await dbc.execute(sql`
    CREATE TABLE IF NOT EXISTS public.drip_membership_stamp_backup (
      contact_id       uuid NOT NULL,
      contact_group_id integer NOT NULL,
      old_created_at   timestamptz NOT NULL,
      new_created_at   timestamptz NOT NULL,
      backed_up_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contact_id, contact_group_id))`);
  await dbc.execute(sql`ALTER TABLE public.drip_membership_stamp_backup ENABLE ROW LEVEL SECURITY`);
}

/**
 * ONE batch = one group: back up its repairable rows (append-only), then re-date them.
 * Run inside a transaction so a failed UPDATE leaves no half-backed-up batch; the CLI
 * opens one transaction per group (owner, 2026-10-10: batched, each batch backed up
 * before it is updated — one statement over every group would carry 38K+ rows).
 */
export async function repairGroup(dbc: DbOrTx, groupId: number): Promise<{ backed_up_new: number; updated: number }> {
  const b = (await dbc.execute(sql`
    INSERT INTO public.drip_membership_stamp_backup (contact_id, contact_group_id, old_created_at, new_created_at)
    SELECT ccg.contact_id, ccg.contact_group_id, ccg.created_at, fr.first_received
    FROM contact_contact_groups ccg
    JOIN (${firstDelivery(groupId)}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received
    ON CONFLICT (contact_id, contact_group_id) DO NOTHING
    RETURNING contact_id`)) as unknown as unknown[];
  const u = (await dbc.execute(sql`
    UPDATE contact_contact_groups ccg
    SET created_at = b.new_created_at
    FROM public.drip_membership_stamp_backup b
    WHERE b.contact_id = ccg.contact_id AND b.contact_group_id = ccg.contact_group_id
      AND b.contact_group_id = ${groupId}
      AND ccg.created_at > b.new_created_at
    RETURNING ccg.contact_id`)) as unknown as unknown[];
  return { backed_up_new: b.length, updated: u.length };
}

/** Every group, sequentially, on the given executor (the test's rolled-back transaction). */
export async function repair(dbc: DbOrTx): Promise<{ backed_up_new: number; updated: number }> {
  await ensureBackupTable(dbc);
  const total = { backed_up_new: 0, updated: 0 };
  for (const g of await listRepairGroups(dbc)) {
    const r = await repairGroup(dbc, g.id);
    total.backed_up_new += r.backed_up_new;
    total.updated += r.updated;
  }
  return total;
}

/** Restore every backed-up stamp (all groups, or one). The backup table is kept. */
export async function revert(dbc: DbOrTx, groupId?: number): Promise<number> {
  const r = (await dbc.execute(sql`
    UPDATE contact_contact_groups ccg
    SET created_at = b.old_created_at
    FROM public.drip_membership_stamp_backup b
    WHERE b.contact_id = ccg.contact_id AND b.contact_group_id = ccg.contact_group_id
      ${groupId === undefined ? sql`` : sql`AND b.contact_group_id = ${groupId}`}
    RETURNING ccg.contact_id`)) as unknown as unknown[];
  return r.length;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const doRevert = process.argv.includes("--revert");
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}   mode: ${doRevert ? "REVERT" : "repair"}${apply ? " (APPLY)" : " (dry run)"}   at ${new Date().toISOString()}`);
  const fmt = (s: Status) => `rows_in_backup=${s.rows_in_backup ?? "0 (no backup table yet)"} R3=${s.r3_by_group ?? "(no members)"}`;
  const t0 = Date.now();
  const before = await countRepairable(db);
  const tCount = Date.now() - t0;
  const groups = await listRepairGroups(db);
  console.log(`before: rows_to_repair=${before.rows_to_repair} backfilled_rows(>10 min)=${before.backfilled_rows} max_lag=${before.max_lag}   (count query ${tCount} ms)`);
  console.log(`        ${fmt(await dryRunStatus(db))}`);
  console.log(`        batches (one transaction per group, backup then update): ${groups.map((g) => `${g.name}#${g.id}=${g.rows}`).join(", ") || "(none)"}   dry run total ${Date.now() - t0} ms`);
  if (!apply) {
    console.log("dry run — nothing written. Re-run with --apply.");
    await pgConn.end();
    return;
  }
  if (doRevert) {
    const backed = (await db.execute(sql`SELECT contact_group_id AS id, count(*)::int AS rows FROM public.drip_membership_stamp_backup GROUP BY 1 ORDER BY 1`)) as unknown as { id: number; rows: number }[];
    let n = 0;
    for (const g of backed) {
      const t = Date.now();
      const r = await db.transaction((tx) => revert(tx, g.id));
      n += r;
      console.log(`  reverted group ${g.id}: ${r} stamp(s) in ${Date.now() - t} ms`);
    }
    const after = await countRepairable(db);
    console.log(`reverted ${n} stamp(s); now rows_to_repair=${after.rows_to_repair}`);
    console.log(`        ${fmt(await dryRunStatus(db))}`);
  } else {
    await db.transaction((tx) => ensureBackupTable(tx));
    const total = { backed_up_new: 0, updated: 0 };
    for (const g of groups) {
      const t = Date.now();
      const r = await db.transaction((tx) => repairGroup(tx, g.id));
      total.backed_up_new += r.backed_up_new;
      total.updated += r.updated;
      console.log(`  batch ${g.name}#${g.id}: backed up ${r.backed_up_new} new row(s), updated ${r.updated} in ${Date.now() - t} ms`);
    }
    const after = await countRepairable(db);
    console.log(`backed up ${total.backed_up_new} new row(s), updated ${total.updated} in ${Date.now() - t0} ms total; now rows_to_repair=${after.rows_to_repair} (expect 0)`);
    console.log(`        ${fmt(await dryRunStatus(db))}   (R3 must equal the before line)`);
    if (after.rows_to_repair !== 0) process.exitCode = 1;
  }
  await pgConn.end();
}

// Importable by the test without running; the CLI only when executed directly.
if (process.argv[1] && /repair-drip-membership-appearance\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch(async (e) => {
    console.error(e);
    await pgConn.end();
    process.exit(1);
  });
}
