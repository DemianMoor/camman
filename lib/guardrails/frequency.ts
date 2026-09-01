import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Cross-campaign frequency collision (ClickUp 869et3vm1, Phase 3).
//
// Rule (Dmytro, 2026-08-31): a contact may receive more than one message within
// 3 days ONLY inside the same campaign. A second CAMPAIGN reaching the same
// contact inside that window is a WARN — "NOT a block; do not touch the send
// path".
//
// ⚠️ DETECTED IN THE PREFLIGHT CRON, NOT AT SEND TIME. The cron already runs
// every 5 minutes and is off the fire path, so the alert lands before the send
// without adding a single condition to materialize or the drain.
//
// ONE MESSAGE PER RUN, listing the count and the campaigns involved — not one
// per contact. Measured at ~630ms with 54 contacts currently in that state; at
// one Telegram message each that would be 54 notifications nobody reads.

export interface FrequencyCollision {
  contacts: number;
  campaigns: number[];
}

export async function findFrequencyCollisions(
  orgId: string,
): Promise<FrequencyCollision> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS contacts,
           coalesce(array_agg(DISTINCT c) FILTER (WHERE c IS NOT NULL), '{}') AS campaigns
    FROM (
      SELECT contact_id, unnest(array_agg(DISTINCT campaign_id)) AS c
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid
        AND status = 'sent'
        AND sent_at >= now() - interval '3 days'
        AND contact_id IS NOT NULL
      GROUP BY contact_id
      HAVING count(DISTINCT campaign_id) > 1
    ) x
  `)) as unknown as { contacts: number; campaigns: number[] }[];

  return {
    contacts: rows[0]?.contacts ?? 0,
    campaigns: rows[0]?.campaigns ?? [],
  };
}
