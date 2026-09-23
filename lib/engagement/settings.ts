import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

/**
 * Orgs whose engagement job is switched on (lifecycle_settings.engine_mode =
 * 'write'). No row, or 'off', means the cron skips that org entirely — which is
 * how this ships inert and stays inert until the one-off backfill flips it.
 *
 * Trusted context: the cron iterates orgs explicitly and passes each org_id down,
 * exactly like the other per-org jobs.
 */
export async function orgsWithEngineOn(dbc: DbOrTx): Promise<string[]> {
  const rows = (await dbc.execute(sql`
    SELECT org_id FROM lifecycle_settings WHERE engine_mode = 'write' ORDER BY org_id
  `)) as unknown as { org_id: string }[];
  return rows.map((r) => r.org_id);
}
