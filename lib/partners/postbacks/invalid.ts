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

// Per-batch outcome of the invalid enqueues, filled by tryEnqueueInvalidPostback
// and settled ONCE per enrichment batch by settleInvalidPostbackAlert.
export type InvalidTally = { queued: number; skipped: number; failed: number; firstError: unknown };
export const newInvalidTally = (): InvalidTally => ({ queued: 0, skipped: 0, failed: 0, firstError: undefined });

export type InvalidOutcome = "queued" | "skipped" | "failed";

// Postbacks must never block intake: the insert runs in a SAVEPOINT
// (tx.transaction nests as one on postgres-js), so a failure rolls back only the
// postback and leaves the enrichment transaction usable. On failure it logs
// (key id + inbox id, never partner data) and records the outcome in `tally` —
// NOTHING else: no alert, no query, no network call inside the enrichment
// transaction (a Telegram call per failing lead would run the batch past the
// route's maxDuration and roll the intake back). Never throws.
export async function tryEnqueueInvalidPostback(
  tx: DbOrTx,
  o: InvalidInput,
  tally: InvalidTally,
  insert: (tx: DbOrTx, o: InvalidInput) => Promise<boolean> = enqueueInvalidPostback,
): Promise<InvalidOutcome> {
  try {
    const queued = await tx.transaction((sp) => insert(sp, o));
    if (!queued) {
      tally.skipped++;
      return "skipped";
    }
    tally.queued++;
    return "queued";
  } catch (err) {
    tally.failed++;
    if (tally.failed === 1) tally.firstError = err;
    console.error(
      `[enrichment] invalid postback enqueue failed (swallowed) key=${o.partnerKeyId} inbox=${o.leadInboxId}:`,
      errorSummary(err),
    );
    return "failed";
  }
}

// Called ONCE per enrichment batch, AFTER its transaction has ended. Same latch
// semantics as the sales enqueue alert in lib/drip/monitors.ts: any failure ⇒
// latch (one page per transition, first error only); a COMMITTED batch that
// attempted at least one enqueue (queued or skipped — skipped is the normal
// outcome until a key has `invalid` ticked) and failed none ⇒ clear; nothing
// attempted ⇒ leave the latch as it is (no evidence either way). `committed` is false when
// the batch rolled back — its queued rows are gone, so it never clears.
// Best-effort; never throws (it runs in a finally next to the batch's own error).
export async function settleInvalidPostbackAlert(
  tally: InvalidTally,
  committed: boolean,
  deps: { alert: (err: unknown, failed: number) => Promise<void>; clear: () => Promise<void> } = {
    alert: alertInvalidFailed,
    clear: () => clearAlert(db, { alertKey: INVALID_POSTBACK_ALERT_KEY }),
  },
): Promise<void> {
  try {
    if (tally.failed > 0) await deps.alert(tally.firstError, tally.failed);
    else if (committed && tally.queued + tally.skipped > 0) await deps.clear();
  } catch (err) {
    console.error("[enrichment] invalid postback alert settle failed (swallowed):", errorSummary(err));
  }
}

// Drizzle wraps the driver error ("Failed query: <sql>", then a params line) —
// name the cause, first line only: the params line would carry partner data.
function errorSummary(err: unknown): string {
  const e = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const name = e instanceof Error ? e.name : typeof e;
  return `${name}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}`;
}

async function alertInvalidFailed(err: unknown, failed: number): Promise<void> {
  try {
    const switchOn = deliveryEnabled();
    const anyKeyEnabled = switchOn ? false : await anyPostbackKeyEnabled();
    if (!postbacksLive({ deliveryEnabled: switchOn, anyKeyEnabled })) return;
    await notifyOnTransition(db, {
      alertKey: INVALID_POSTBACK_ALERT_KEY,
      text:
        `🔴 Partner postbacks: ${failed} invalid-number postback(s) failed to queue in the last enrichment batch: ${errorSummary(err)}. ` +
        `Check the /api/cron/lead-enrichment logs in Vercel.`,
    });
  } catch (alertErr) {
    console.error("[enrichment] invalid postback alert failed (swallowed):", alertErr instanceof Error ? alertErr.message : alertErr);
  }
}
