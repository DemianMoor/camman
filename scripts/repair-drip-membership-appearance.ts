import "./_env-preload";
import { sql, type SQL } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";

// Appearance = delivery (ruling Q2) for drip partner×tag memberships — the
// Phase 2 data repair. PRODUCTION-WRITING ON PURPOSE (owner fix F1: a script,
// not a migration; listed in scripts/test-preview-db-guard.ts EXCLUSIONS).
//
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts                    dry run: prints the counts, writes nothing
//   npx tsx --conditions=react-server scripts/repair-drip-membership-appearance.ts --apply            fills the backup, then updates
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
export const FIRST_DELIVERY: SQL = sql`
  SELECT ccg2.contact_id, ccg2.contact_group_id, min(le.received_at) AS first_received
  FROM contact_contact_groups ccg2
  JOIN contact_groups g ON g.id = ccg2.contact_group_id
   AND g.contact_group_id LIKE 'drip:%'
   AND g.contact_group_id NOT IN ('drip-intake', 'drip-sandbox')
  JOIN lead_events le ON le.contact_id = ccg2.contact_id AND le.sandbox = false
   AND lower(le.partner_slug) || '-' || coalesce(nullif(lower(trim(le.interest_tag)), ''), 'untagged') = g.name
  GROUP BY 1, 2`;

export interface Counts {
  rows_to_repair: number;
  backfilled_rows: number;
  max_lag: string | null;
}

/** The before/after count query. */
export async function countRepairable(dbc: DbOrTx): Promise<Counts> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS rows_to_repair,
           count(*) FILTER (WHERE ccg.created_at > fr.first_received + interval '10 minutes')::int AS backfilled_rows,
           max(ccg.created_at - fr.first_received)::text AS max_lag
    FROM contact_contact_groups ccg
    JOIN (${FIRST_DELIVERY}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received`)) as unknown as Counts[];
  return r[0];
}

/** Fill the backup (append-only), then repair. Returns what each step touched. */
export async function repair(dbc: DbOrTx): Promise<{ backed_up_new: number; updated: number }> {
  await dbc.execute(sql`
    CREATE TABLE IF NOT EXISTS public.drip_membership_stamp_backup (
      contact_id       uuid NOT NULL,
      contact_group_id integer NOT NULL,
      old_created_at   timestamptz NOT NULL,
      new_created_at   timestamptz NOT NULL,
      backed_up_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contact_id, contact_group_id))`);
  await dbc.execute(sql`ALTER TABLE public.drip_membership_stamp_backup ENABLE ROW LEVEL SECURITY`);
  const b = (await dbc.execute(sql`
    INSERT INTO public.drip_membership_stamp_backup (contact_id, contact_group_id, old_created_at, new_created_at)
    SELECT ccg.contact_id, ccg.contact_group_id, ccg.created_at, fr.first_received
    FROM contact_contact_groups ccg
    JOIN (${FIRST_DELIVERY}) fr ON fr.contact_id = ccg.contact_id AND fr.contact_group_id = ccg.contact_group_id
    WHERE ccg.created_at > fr.first_received
    ON CONFLICT (contact_id, contact_group_id) DO NOTHING
    RETURNING contact_id`)) as unknown as unknown[];
  const u = (await dbc.execute(sql`
    UPDATE contact_contact_groups ccg
    SET created_at = b.new_created_at
    FROM public.drip_membership_stamp_backup b
    WHERE b.contact_id = ccg.contact_id AND b.contact_group_id = ccg.contact_group_id
      AND ccg.created_at > b.new_created_at
    RETURNING ccg.contact_id`)) as unknown as unknown[];
  return { backed_up_new: b.length, updated: u.length };
}

/** Restore every backed-up stamp. The backup table is kept (dropped only on the owner's say-so). */
export async function revert(dbc: DbOrTx): Promise<number> {
  const r = (await dbc.execute(sql`
    UPDATE contact_contact_groups ccg
    SET created_at = b.old_created_at
    FROM public.drip_membership_stamp_backup b
    WHERE b.contact_id = ccg.contact_id AND b.contact_group_id = ccg.contact_group_id
    RETURNING ccg.contact_id`)) as unknown as unknown[];
  return r.length;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const doRevert = process.argv.includes("--revert");
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "(unknown)";
  console.log(`target project ref: ${ref}   mode: ${doRevert ? "REVERT" : "repair"}${apply ? " (APPLY)" : " (dry run)"}   at ${new Date().toISOString()}`);
  const before = await countRepairable(db);
  console.log(`before: rows_to_repair=${before.rows_to_repair} backfilled_rows(>10 min)=${before.backfilled_rows} max_lag=${before.max_lag}`);
  if (!apply) {
    console.log("dry run — nothing written. Re-run with --apply.");
    await pgConn.end();
    return;
  }
  if (doRevert) {
    const n = await revert(db);
    const after = await countRepairable(db);
    console.log(`reverted ${n} stamp(s); now rows_to_repair=${after.rows_to_repair}`);
  } else {
    const t0 = Date.now();
    const r = await db.transaction((tx) => repair(tx));
    const after = await countRepairable(db);
    console.log(`backed up ${r.backed_up_new} new row(s), updated ${r.updated} in ${Date.now() - t0} ms; now rows_to_repair=${after.rows_to_repair} (expect 0)`);
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
