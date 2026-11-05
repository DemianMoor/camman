import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/intake/partner-key";
import { DEFAULT_STATUS_WORDS, type PostbackEvent } from "./template";

// Transaction-scoped advisory lock key that SERIALISES enqueuePartnerPostbacks
// runs. Guards first-only mode: two overlapping runs (the cron and the manual
// drip-monitors trigger, which runs without the cron lease) can each pick a
// DIFFERENT "earliest approved purchase" for one journey when an earlier sale is
// approved between their snapshots — neither sees the other's uncommitted row,
// and the unique keys differ, so the partner would get two "first" postbacks.
// Holding this lock, the second run's INSERT starts after the first commits and
// its NOT EXISTS sees that row. Fixed and outside the int4 range of the
// hashtext()-derived keys used elsewhere, so it cannot collide with them.
export const ENQUEUE_LOCK_KEY = 7_228_000_000_001; // < 2^53, exact as a JS number

// The key is live for `event` at `sourceTime`: postbacks enabled, the event in
// the key's event list, not a sandbox key, and the source time (sale created_at,
// journey closed_at, …) at/after the event's OWN since (0234
// postback_event_since — stamped when the event became live, so turning an
// event on later never backfills it). Predicate over the alias `k`
// (partner_keys). The event is a bound parameter, never spliced into the SQL.
// The since is stamped with the app clock and compared to DB times; `>=` is
// deliberate (Task 3 review note — do not "fix" the clocks here).
export function eventLive(event: PostbackEvent, sourceTime: SQL): SQL {
  return sql`(k.postback_enabled
    AND ${event}::text = ANY (k.postback_event_keys)
    AND NOT k.sandbox
    AND (k.postback_event_since ->> ${event}::text) IS NOT NULL
    AND ${sourceTime} >= (k.postback_event_since ->> ${event}::text)::timestamptz)`;
}

// Required fields (#422): every passthrough field the key's TEMPLATE references
// must be non-empty in `partnerData`, else the event is skipped silently (never
// queued). Derived from the template, never configured: a partner that sends the
// field in only some of its feeds gets no postback with an empty value. System
// placeholders ({status}, {payout}, …) are not passthrough fields, so they are
// never required. partner_data is fixed at intake, so a skip is final.
// Predicate over the alias `k`.
export function requiredFieldsPresent(partnerData: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(k.passthrough_fields) AS f(name)
    WHERE strpos(k.postback_url_template, '{' || f.name || '}') > 0
      AND coalesce(btrim(${partnerData} ->> f.name), '') = ''
  )`;
}

// The key's status word for `event` (validated on write, so no regex here),
// else the default from template.ts.
export function statusWord(event: PostbackEvent): SQL {
  return sql`coalesce(k.postback_status_words ->> ${event}::text, ${DEFAULT_STATUS_WORDS[event]}::text)`;
}

export type EnqueueResult = { queued: number; queuedByEvent: { purchase: number; opt_out: number } };

// Queue partner postbacks. Spec R3: journey state is not a usable trigger for a
// SALE (the lifecycle sweep skips posture-off orgs and never reclassifies
// opted_out), so purchases come FROM THE LEDGER. Two idempotent INSERT … SELECTs
// across every org, under one advisory lock in one transaction, run by the
// drip-monitors cron after the lifecycle sweep. Never from the send path.
//
// PURCHASE — a row is queued for a conversion_events row that is:
//   • a PURCHASE event type (event_types.is_purchase; upsell/registration never),
//   • status exactly 'approved' (owner decision 2: approved only),
//   • created at/after the key's purchase since (decision 4: never backfill —
//     a row created pending before enable and approved after does NOT fire),
// on the drip journey it belongs to (anchor below), whose lead came in on a key
// with `purchase` live (eventLive — incl. NOT sandbox), and whose stored
// partner_data has every required field (requiredFieldsPresent). NO
// journey-state predicate (decision 4: fires whatever the journey ended as,
// including opted_out) and NO drip-posture check. Payload status = the key's
// purchase word (default 'sold'); event_id = 'purchase-<conversion_events.id>'.
//
// Idempotency is the partial unique (partner_key_id, conversion_event_id) WHERE
// NOT is_test + ON CONFLICT DO NOTHING; an in-place ledger update (revenue,
// status) therefore never queues a second row. First-only keys additionally need
// "no real PURCHASE row for this journey yet" and pick the journey's earliest
// approved purchase by (occurred_at, id). The guard counts purchase rows only:
// first-only is a purchase rule, so an opt_out queued earlier must not block it.
//
// OPT_OUT — a row per drip journey closed `opted_out` (closeJourneyOnOptOut:
// at most once, never reverts) within 30 days and at/after the key's opt_out
// since, same eventLive + requiredFieldsPresent. Payload status = the opt_out
// word (default 'opt_out'); event_id = 'opt_out-<drip_journeys.id>';
// occurred_at = closed_at (processing time); conversion_id '', currency/payout
// null. Idempotency: partner_postbacks_key_journey_optout_uniq. First-only does
// not apply.
//
// Every join is org-matched.
export async function enqueuePartnerPostbacks(dbc: DbOrTx): Promise<EnqueueResult> {
  // Pooled client ⇒ open a transaction; a caller's transaction is used as-is
  // (the xact lock is then held until the caller commits).
  return dbc === db ? db.transaction((tx) => enqueueLocked(tx)) : enqueueLocked(dbc);
}

async function enqueueLocked(t: DbOrTx): Promise<EnqueueResult> {
  await t.execute(sql`SELECT pg_advisory_xact_lock(${ENQUEUE_LOCK_KEY}::bigint)`);
  const purchase = (await t.execute(sql`
    INSERT INTO partner_postbacks
      (org_id, partner_key_id, conversion_event_id, drip_journey_id, lead_event_id, event, payload)
    SELECT ce.org_id, k.id, ce.id, j.id, le.id, 'purchase',
           jsonb_build_object(
             'event', 'purchase'::text,
             'event_id', 'purchase-' || ce.id::text,
             'status', ${statusWord("purchase")},
             'conversion_id', ce.id::text,
             'occurred_at', to_char(ce.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'currency', ce.currency,
             'payout', ce.revenue::text,
             'fields', coalesce(le.partner_data, '{}'::jsonb))
    FROM conversion_events ce
    JOIN event_types et
      ON et.id = ce.event_type_id AND et.org_id = ce.org_id AND et.is_purchase
    JOIN drip_journeys j
      ON j.org_id = ce.org_id
     AND j.campaign_id = ce.campaign_id
     AND j.contact_id = ce.contact_id
     AND ce.occurred_at >= j.routed_at
    JOIN lead_events le
      ON le.id = j.lead_event_id AND le.org_id = j.org_id
    JOIN partner_keys k
      ON k.id = le.partner_key_id AND k.org_id = le.org_id
     AND ${eventLive("purchase", sql`ce.created_at`)}
    WHERE ce.status = 'approved'
      AND ce.created_at > now() - interval '30 days'
      AND ${requiredFieldsPresent(sql`le.partner_data`)}
      -- Journey anchor: the SAME rule as reclassifyCompletedJourneysOnPurchase in
      -- lib/drip/lifecycle.ts — the sale belongs to j iff it happened at/after j
      -- was routed and before the contact's NEXT journey on this campaign was
      -- routed. Keep the two in step.
      AND NOT EXISTS (
        SELECT 1 FROM drip_journeys nxt
        WHERE nxt.org_id = j.org_id
          AND nxt.campaign_id = j.campaign_id
          AND nxt.contact_id = j.contact_id
          AND nxt.routed_at > j.routed_at
          AND nxt.routed_at <= ce.occurred_at
      )
      AND (
        NOT k.postback_first_purchase_only
        OR (
          NOT EXISTS (
            SELECT 1 FROM partner_postbacks p
            WHERE p.drip_journey_id = j.id AND NOT p.is_test AND p.event = 'purchase'
          )
          -- the journey's earliest approved purchase, same anchor
          AND ce.id = (
            SELECT ce2.id
            FROM conversion_events ce2
            JOIN event_types et2
              ON et2.id = ce2.event_type_id AND et2.org_id = ce2.org_id AND et2.is_purchase
            WHERE ce2.org_id = j.org_id
              AND ce2.campaign_id = j.campaign_id
              AND ce2.contact_id = j.contact_id
              AND ce2.status = 'approved'
              AND ce2.occurred_at >= j.routed_at
              AND NOT EXISTS (
                SELECT 1 FROM drip_journeys nxt2
                WHERE nxt2.org_id = j.org_id
                  AND nxt2.campaign_id = j.campaign_id
                  AND nxt2.contact_id = j.contact_id
                  AND nxt2.routed_at > j.routed_at
                  AND nxt2.routed_at <= ce2.occurred_at
              )
            ORDER BY ce2.occurred_at, ce2.id
            LIMIT 1
          )
        )
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as { id: number }[];

  const optOut = (await t.execute(sql`
    INSERT INTO partner_postbacks
      (org_id, partner_key_id, conversion_event_id, drip_journey_id, lead_event_id, event, payload)
    SELECT j.org_id, k.id, NULL, j.id, le.id, 'opt_out',
           jsonb_build_object(
             'event', 'opt_out'::text,
             'event_id', 'opt_out-' || j.id::text,
             'status', ${statusWord("opt_out")},
             'conversion_id', ''::text,
             'occurred_at', to_char(j.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'currency', NULL::text,
             'payout', NULL::text,
             'fields', coalesce(le.partner_data, '{}'::jsonb))
    FROM drip_journeys j
    JOIN lead_events le
      ON le.id = j.lead_event_id AND le.org_id = j.org_id
    JOIN partner_keys k
      ON k.id = le.partner_key_id AND k.org_id = le.org_id
     AND ${eventLive("opt_out", sql`j.closed_at`)}
    WHERE j.state = 'opted_out'
      AND j.closed_at > now() - interval '30 days'
      AND ${requiredFieldsPresent(sql`le.partner_data`)}
    ON CONFLICT DO NOTHING
    RETURNING id
  `)) as unknown as { id: number }[];

  return {
    queued: purchase.length + optOut.length,
    queuedByEvent: { purchase: purchase.length, opt_out: optOut.length },
  };
}
