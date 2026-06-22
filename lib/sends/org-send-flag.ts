import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// The DB-backed master send switch (org_settings.sends_enabled). This is the
// daily operational on/off, distinct from the SEND_ENABLED env backstop and from
// a provider's latching send_paused breaker. Missing row ⇒ never enabled (a
// fresh org cannot send until someone turns it on in Settings). Read it at the
// drain gate alongside the env check — the drain refuses unless BOTH are true.
export async function getOrgSendsEnabled(
  dbc: DbOrTx,
  orgId: string,
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    SELECT sends_enabled FROM org_settings WHERE org_id = ${orgId} LIMIT 1
  `)) as unknown as { sends_enabled: boolean }[];
  return rows[0]?.sends_enabled === true;
}

// The emergency hard-stop (org_settings.sends_paused, migration 0080). A SECOND
// kill-switch independent of sends_enabled: when TRUE, the drain refuses to start
// and an in-flight drain halts at the next batch boundary, so no further message
// is submitted via the provider API until it's cleared ("Proceed"). Missing row
// ⇒ not paused. Read it FRESH each batch (like isProviderPaused) so flipping the
// "Today's sends" hard-stop kills a running drain mid-invocation.
export async function getOrgSendsPaused(
  dbc: DbOrTx,
  orgId: string,
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    SELECT sends_paused FROM org_settings WHERE org_id = ${orgId} LIMIT 1
  `)) as unknown as { sends_paused: boolean }[];
  return rows[0]?.sends_paused === true;
}
