import { sql } from "drizzle-orm";

import { isOutsideSendWindow, type ProviderSendWindow } from "@/lib/quiet-hours";
import type { DbOrTx } from "@/lib/sends/drain";

// DB-backed send-window lookup for a stage.
//
// Deliberately NOT in lib/quiet-hours.ts: that module is pure (no DB, no
// imports beyond date helpers), which is what lets decideScheduledSend and
// child-slip be exhaustively unit-tested without a database. Adding a query
// there would have infected every one of those tests.
//
// A stage with no provider row — or a provider with no window configured —
// falls through to the same DEFAULT window every other caller uses, so "unset"
// never silently means "unrestricted".
export async function isStageOutsideSendWindow(
  dbc: DbOrTx,
  stageId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    SELECT p.send_window_weekday_start AS send_window_weekday_start,
           p.send_window_weekday_end   AS send_window_weekday_end,
           p.send_window_weekend_start AS send_window_weekend_start,
           p.send_window_weekend_end   AS send_window_weekend_end
    FROM campaign_stages s
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE s.id = ${stageId}
    LIMIT 1
  `)) as unknown as ProviderSendWindow[];
  const cfg = rows[0];
  // No stage row ⇒ stay quiet and let the drain's own `not_found` refusal speak.
  if (!cfg) return false;
  return isOutsideSendWindow(cfg, now);
}
