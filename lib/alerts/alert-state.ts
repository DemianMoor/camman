import { sql } from "drizzle-orm";

import { notifyTelegram } from "@/lib/alerts/telegram";
import type { db } from "@/db/client";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// State-transition gating for alerts (migration 0154).
//
// ⚠️ NOTHING IN THE CODEBASE DID THIS BEFORE. notifyTelegram() is best-effort
// and STATELESS by contract — it fires on every call. There is no
// last_alerted_at column anywhere, and the existing circuit breakers avoid
// alert storms only as a SIDE EFFECT OF LATCHING (send_paused flips true, which
// stops further trips). That is not reusable, so a monitor that simply checks a
// threshold every tick would page on every tick for as long as the condition
// held.
//
// The gate is the `WHERE alert_state.state <> ...` on the DO UPDATE: the row is
// only touched when the state actually CHANGES, so RETURNING yields a row on a
// transition and nothing while the condition persists. Same construction as the
// rate limiter's guarded upsert, for the same reason — the decision belongs in
// the statement, not in a read-then-write the next invocation can race.

export type AlertState = "ok" | "firing";

/**
 * Move an alert to `state`, returning true only if this call CHANGED it.
 *
 * A true return is the caller's licence to notify; false means the condition
 * was already in that state and the human has already been told.
 */
export async function transitionAlert(
  dbc: DbOrTx,
  { alertKey, orgId, state }: { alertKey: string; orgId?: string | null; state: AlertState },
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    INSERT INTO alert_state (alert_key, org_id, state, since, last_notified_at)
    VALUES (${alertKey}, ${orgId ?? null}, ${state}, now(),
            ${state === "firing" ? sql`now()` : sql`NULL`})
    ON CONFLICT (alert_key) DO UPDATE
      SET state = ${state},
          since = now(),
          last_notified_at = CASE WHEN ${state} = 'firing' THEN now()
                                  ELSE alert_state.last_notified_at END
      WHERE alert_state.state <> ${state}
    RETURNING alert_key
  `)) as unknown as { alert_key: string }[];
  return rows.length > 0;
}

/**
 * Notify Telegram only on a transition INTO firing.
 *
 * Best-effort throughout: a failure to record state or to reach Telegram must
 * never propagate into the request that noticed the condition — the same
 * contract notifyTelegram already keeps.
 */
export async function notifyOnTransition(
  dbc: DbOrTx,
  { alertKey, orgId, text }: { alertKey: string; orgId?: string | null; text: string },
): Promise<void> {
  try {
    const changed = await transitionAlert(dbc, { alertKey, orgId, state: "firing" });
    if (changed) await notifyTelegram(text);
  } catch (err) {
    console.error(`[alert-state] transition failed for ${alertKey} (swallowed):`, err);
  }
}

/** Clear an alert so the next occurrence notifies again. Best-effort. */
export async function clearAlert(
  dbc: DbOrTx,
  { alertKey, orgId }: { alertKey: string; orgId?: string | null },
): Promise<void> {
  try {
    await transitionAlert(dbc, { alertKey, orgId, state: "ok" });
  } catch (err) {
    console.error(`[alert-state] clear failed for ${alertKey} (swallowed):`, err);
  }
}
