import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";
import { loadLifecycleSettings } from "@/lib/engagement/settings-io";

/**
 * Should a campaign being created RIGHT NOW use the lifecycle chips?
 *
 * The one answer to that question. `campaigns.lifecycle_rules` is what a
 * campaign that already exists is; this is what a campaign that does not exist
 * yet WILL be, and the two are different questions with the same answer only
 * because this function decides both.
 *
 * ⚠️ IT EXISTS BECAUSE THE ANSWER WAS BEING COMPUTED IN ONE PLACE AND NEEDED
 * IN FOUR. The create route decided it inline and wrote it to the row; the
 * create-mode audience PREVIEW had no row to read and silently fell back to
 * the legacy predicate, so the chips changed nothing on screen. Worse, the
 * activation snapshot had the same gap: a campaign written with
 * lifecycle_rules = true would have frozen its pool with the LEGACY predicate.
 * One function, called by every path that has to decide.
 *
 * Callers that DO have a campaign row must read `lifecycle_rules` off it
 * instead — a campaign keeps the semantics it was created under, even if the
 * engine has been switched off since.
 */
export async function newCampaignUsesLifecycleRules(
  dbc: DbOrTx,
  orgId: string,
): Promise<boolean> {
  const settings = await loadLifecycleSettings(dbc, orgId);
  return settings.engine_mode === "write";
}
