import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import type { DbOrTx } from "@/lib/intake/partner-key";
import { anyPostbackKeyEnabled, deliveryEnabled } from "./deliver";
import { eventLive, requiredFieldsPresent, statusWord } from "./enqueue";
import { postbacksLive } from "./heartbeat-gate";

export const INVALID_POSTBACK_ALERT_KEY = "partner-postbacks-invalid-failed";

type InvalidInput = {
  orgId: string;
  partnerKeyId: number;
  /** lead_inbox.id — the row is deleted in the same transaction, hence no FK (0234). */
  leadInboxId: string;
  partnerData: Record<string, unknown> | null;
  /** Enrichment time: checked against the key's invalid since, and the payload's occurred_at. */
  at: Date;
};

// Queue an `invalid` postback for a lead discarded as a LANDLINE at enrichment
// (owner decision 1: landline only — voip/unknown stay sendable and are never
// reported invalid, G19). Called from the enrichment landline branch, before the
// inbox row is deleted. One INSERT … SELECT from the lead's key: the shared
// eventLive rule (enabled, `invalid` in the key's events, NOT sandbox — decision
// 7 — and `at` at/after the invalid since) plus the required-fields rule (#422).
// Payload: status = the key's invalid word (default 'invalid'); event_id =
// 'invalid-<lead_inbox.id>'; occurred_at = enrichment time; conversion_id '',
// currency/payout null. Idempotent on partner_postbacks_key_inbox_invalid_uniq.
// Returns whether a row was queued.
export async function enqueueInvalidPostback(tx: DbOrTx, o: InvalidInput): Promise<boolean> {
  const at = sql`${o.at.toISOString()}::timestamptz`;
  const partnerData = sql`${o.partnerData ? JSON.stringify(o.partnerData) : null}::jsonb`;
  const rows = (await tx.execute(sql`
    INSERT INTO partner_postbacks
      (org_id, partner_key_id, conversion_event_id, drip_journey_id, lead_event_id, lead_inbox_id, event, payload)
    SELECT k.org_id, k.id, NULL, NULL, NULL, ${o.leadInboxId}::uuid, 'invalid',
           jsonb_build_object(
             'event', 'invalid'::text,
             'event_id', 'invalid-' || ${o.leadInboxId}::uuid::text,
             'status', ${statusWord("invalid")},
             'conversion_id', ''::text,
             'occurred_at', to_char(${at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'currency', NULL::text,
             'payout', NULL::text,
             'fields', coalesce(${partnerData}, '{}'::jsonb))
    FROM partner_keys k
    WHERE k.id = ${o.partnerKeyId}::int
      AND k.org_id = ${o.orgId}::uuid
      AND ${eventLive("invalid", at)}
      AND ${requiredFieldsPresent(partnerData)}
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as { id: number }[];
  return rows.length > 0;
}

// Postbacks must never block intake: the insert runs in a SAVEPOINT
// (tx.transaction nests as one on postgres-js), so a failure rolls back only the
// postback and leaves the enrichment transaction usable. The failure is logged
// and latches one Telegram alert, only once postbacks are live (same go-live
// predicate as the other postback alerts); a later queued row clears it. The
// alert state is written on the pooled client, never on `tx`, so it holds no
// alert_state row lock across the enrichment batch. Never throws.
export async function tryEnqueueInvalidPostback(
  tx: DbOrTx,
  o: InvalidInput,
  insert: (tx: DbOrTx, o: InvalidInput) => Promise<boolean> = enqueueInvalidPostback,
): Promise<void> {
  try {
    const queued = await tx.transaction((sp) => insert(sp, o));
    if (queued) await clearAlert(db, { alertKey: INVALID_POSTBACK_ALERT_KEY });
  } catch (err) {
    console.error("[enrichment] invalid postback enqueue failed (swallowed):", err instanceof Error ? err.message.split("\n")[0] : err);
    await alertInvalidFailed(err);
  }
}

async function alertInvalidFailed(err: unknown): Promise<void> {
  try {
    const switchOn = deliveryEnabled();
    const anyKeyEnabled = switchOn ? false : await anyPostbackKeyEnabled();
    if (!postbacksLive({ deliveryEnabled: switchOn, anyKeyEnabled })) return;
    // Drizzle wraps the driver error ("Failed query: <sql>…") — name the cause; never forward SQL text.
    const e = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const name = e instanceof Error ? e.name : typeof e;
    const message = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);
    await notifyOnTransition(db, {
      alertKey: INVALID_POSTBACK_ALERT_KEY,
      text:
        `🔴 Partner postbacks: queueing an invalid-number postback failed (${name}: ${message}). ` +
        `Landline leads are still discarded, but their partners are not being told. ` +
        `Check the /api/cron/lead-enrichment logs in Vercel.`,
    });
  } catch (alertErr) {
    console.error("[enrichment] invalid postback alert failed (swallowed):", alertErr instanceof Error ? alertErr.message : alertErr);
  }
}
