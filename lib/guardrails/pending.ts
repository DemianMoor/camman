import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { stage_sends } from "@/db/schema";

/**
 * Recipients this stage is about to push through the drain — i.e. its rows that
 * are materialized but not yet sent.
 *
 * This is the "requested" side of the aggregate cap for a send action. It is NOT
 * the stage's whole audience: rows already sent have been counted by
 * `sentInLastHour`, and counting them again would refuse a retry for volume it
 * has already been charged for.
 */
export async function pendingForStage(
  orgId: string,
  stageId: number,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stage_sends)
    .where(
      and(
        eq(stage_sends.org_id, orgId),
        eq(stage_sends.stage_id, stageId),
        sql`${stage_sends.status} IN ('pending', 'failed')`,
      ),
    );
  return rows[0]?.n ?? 0;
}
