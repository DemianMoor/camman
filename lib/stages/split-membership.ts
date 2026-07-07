import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Any drizzle executor — the top-level client or a transaction handle.
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Count OTHER non-archived stages in the campaign that are part of an A/B split
// (split_total set). These are `stageId`'s "live partners" — re-splitting it
// while any exist would orphan them, so the /split guard blocks on count > 0.
export async function liveSplitPartnerCount(
  exec: Executor,
  opts: { orgId: string; campaignId: number; stageId: number },
): Promise<number> {
  const rows = (await exec.execute(sql`
    SELECT count(*)::int AS n
    FROM campaign_stages
    WHERE org_id = ${opts.orgId}::uuid
      AND campaign_id = ${opts.campaignId}
      AND id <> ${opts.stageId}
      AND split_total IS NOT NULL
      AND status <> 'archived'
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// After a delete, if EXACTLY ONE non-archived A/B-split member remains in the
// campaign, dissolve the split on it (revert to a normal stage). Returns the id
// reset, or null (zero or >1 remaining, or none). Call inside the delete tx.
export async function resetLoneSplitSurvivor(
  exec: Executor,
  opts: { orgId: string; campaignId: number },
): Promise<number | null> {
  const survivors = (await exec.execute(sql`
    SELECT id
    FROM campaign_stages
    WHERE org_id = ${opts.orgId}::uuid
      AND campaign_id = ${opts.campaignId}
      AND split_total IS NOT NULL
      AND status <> 'archived'
  `)) as unknown as { id: number }[];
  if (survivors.length !== 1) return null;
  await exec.execute(sql`
    UPDATE campaign_stages
    SET split_index = NULL, split_total = NULL
    WHERE id = ${survivors[0].id}
  `);
  return survivors[0].id;
}
