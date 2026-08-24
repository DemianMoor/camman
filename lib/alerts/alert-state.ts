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
// The gate is the `WHERE alert_state.state <> ... OR alert_state.last_notified_at
// IS NULL` on the DO UPDATE. For `state: 'ok'` the row is only touched when the
// state actually CHANGES, so RETURNING yields a row on a transition and nothing
// while the condition persists. For `state: 'firing'` that is true UNLESS the
// alert is PENDING (firing with no confirmed delivery yet) — then the row is
// touched, and RETURNING yields a row, on every call until a send succeeds; see
// the pending-state docblock on transitionAlert below. Same construction as the
// rate limiter's guarded upsert, for the same reason — the decision belongs in
// the statement, not in a read-then-write the next invocation can race.

export type AlertState = "ok" | "firing";

/**
 * Move an alert to `state`, returning true only when this call OWES A SEND.
 *
 * For `state: "ok"` that means the state actually changed (unchanged behaviour).
 *
 * For `state: "firing"` it means EITHER a fresh transition into firing OR the
 * alert is already firing and has never been delivered — see the pending state
 * below. A true return is the caller's licence to notify.
 *
 * ⚠️ THE PENDING STATE: `state = 'firing' AND last_notified_at IS NULL` means
 * "breach recorded, notification NOT yet delivered". It is what makes a failed
 * send retry instead of vanishing. Before this, the latch flipped on DETECTION,
 * so a send that failed on the transition tick was lost permanently — the next
 * tick saw no transition and stayed silent, and a condition that never resolves
 * never re-arms.
 *
 * No migration was needed: `last_notified_at` already existed, nothing reads it,
 * and the old code always stamped it when transitioning to firing — so no
 * pre-existing row can be firing-with-NULL and be misread as pending.
 *
 * `since` is PRESERVED on a retry. It records when the breach began, not when
 * the latest delivery attempt ran.
 */
export async function transitionAlert(
  dbc: DbOrTx,
  { alertKey, orgId, state }: { alertKey: string; orgId?: string | null; state: AlertState },
): Promise<boolean> {
  if (state === "ok") {
    const rows = (await dbc.execute(sql`
      INSERT INTO alert_state (alert_key, org_id, state, since, last_notified_at)
      VALUES (${alertKey}, ${orgId ?? null}, 'ok', now(), NULL)
      ON CONFLICT (alert_key) DO UPDATE
        SET state = 'ok',
            since = now(),
            org_id = COALESCE(EXCLUDED.org_id, alert_state.org_id)
        WHERE alert_state.state <> 'ok'
      RETURNING alert_key
    `)) as unknown as { alert_key: string }[];
    return rows.length > 0;
  }

  const rows = (await dbc.execute(sql`
    INSERT INTO alert_state (alert_key, org_id, state, since, last_notified_at)
    VALUES (${alertKey}, ${orgId ?? null}, 'firing', now(), NULL)
    ON CONFLICT (alert_key) DO UPDATE
      SET state = 'firing',
          since = CASE WHEN alert_state.state <> 'firing' THEN now()
                       ELSE alert_state.since END,
          last_notified_at = CASE WHEN alert_state.state <> 'firing' THEN NULL
                                  ELSE alert_state.last_notified_at END,
          org_id = COALESCE(EXCLUDED.org_id, alert_state.org_id)
      WHERE alert_state.state <> 'firing'
         OR alert_state.last_notified_at IS NULL
    RETURNING alert_key
  `)) as unknown as { alert_key: string }[];
  return rows.length > 0;
}

/**
 * Stamp an alert as delivered. Called ONLY after a send is confirmed.
 *
 * The `state = 'firing'` guard matters: if the condition cleared between the
 * send and this stamp, the row is now 'ok' and must not be recorded as
 * delivered-while-firing. The `last_notified_at IS NULL` guard makes it
 * idempotent.
 */
export async function markAlertNotified(dbc: DbOrTx, alertKey: string): Promise<void> {
  await dbc.execute(sql`
    UPDATE alert_state SET last_notified_at = now()
    WHERE alert_key = ${alertKey}
      AND state = 'firing'
      AND last_notified_at IS NULL
  `);
}

/**
 * Notify on a transition into firing, and RETRY until the send is confirmed.
 *
 * Best-effort throughout: a failure to record state or to reach Telegram must
 * never propagate into the request that noticed the condition.
 *
 * ⚠️ A DUPLICATE IS POSSIBLE, deliberately, and the window is open on EVERY
 * claim — not only a post-failure retry. Two overlapping callers on a FRESH
 * transition can both win: the first sets 'firing'/NULL and returns a row; the
 * second blocks on the row lock, then re-reads 'firing' + NULL once the first
 * commits, matches the second disjunct (`last_notified_at IS NULL`), and also
 * returns a row — both send. Under the OLD statement (gated on state change
 * alone) the guarded upsert was atomically exclusive: exactly one winner,
 * always. That single-winner property is deliberately traded away here, for
 * EVERY caller, not just ones recovering from a failed send.
 *
 * This is not a cron-only concern. app/api/intake/leads/[token]/route.ts calls
 * this at PER-REQUEST cadence, on a 401 auth-failure path, once failures >= 5 —
 * two concurrent requests crossing that threshold together is a real case, not
 * a theoretical one.
 *
 * A duplicate delivery beats the silent loss it replaces — that tradeoff is the
 * accepted call. Not closed with a lease (a second time-based concept in this
 * state machine) nor with SELECT FOR UPDATE (a row lock held across a 4s network
 * call on a pooled connection).
 *
 * `send` is injectable ONLY so the guard can force a failure without touching
 * the network. Production callers use the default.
 */
export async function notifyOnTransition(
  dbc: DbOrTx,
  {
    alertKey,
    orgId,
    text,
    send = notifyTelegram,
  }: {
    alertKey: string;
    orgId?: string | null;
    text: string;
    send?: (text: string) => Promise<boolean>;
  },
): Promise<void> {
  try {
    const owesSend = await transitionAlert(dbc, { alertKey, orgId, state: "firing" });
    if (!owesSend) return;
    const delivered = await send(text);
    if (delivered) await markAlertNotified(dbc, alertKey);
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
