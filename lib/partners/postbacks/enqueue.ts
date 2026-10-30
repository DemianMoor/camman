import "server-only";

import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/intake/partner-key";

// Queue partner sales postbacks FROM THE LEDGER (spec R3: journey state is not a
// usable trigger — the lifecycle sweep skips posture-off orgs and never
// reclassifies opted_out). One idempotent INSERT … SELECT across every org,
// run by the drip-monitors cron after the lifecycle sweep. Never from the send
// path.
//
// A row is queued for a conversion_events row that is:
//   • a PURCHASE event type (event_types.is_purchase; upsell/registration never),
//   • status exactly 'approved' (owner decision 2: approved only),
//   • created at/after the key's postback_active_since (decision 4: never backfill —
//     a row created pending before enable and approved after does NOT fire),
// on the drip journey it belongs to (anchor below), whose lead came in on a key
// with postbacks enabled. NO journey-state predicate (decision 4: fires whatever
// the journey ended as, including opted_out) and NO drip-posture check.
//
// Idempotency is the partial unique (partner_key_id, conversion_event_id) WHERE
// NOT is_test + ON CONFLICT DO NOTHING; an in-place ledger update (revenue,
// status) therefore never queues a second row. First-only keys additionally need
// "no real row for this journey yet" and pick the journey's earliest approved
// purchase by (occurred_at, id).
//
// Every join is org-matched. The statement takes no parameters.
export async function enqueuePartnerPostbacks(dbc: DbOrTx): Promise<{ queued: number }> {
  const rows = (await dbc.execute(sql`
    INSERT INTO partner_postbacks
      (org_id, partner_key_id, conversion_event_id, drip_journey_id, lead_event_id, payload)
    SELECT ce.org_id, k.id, ce.id, j.id, le.id,
           jsonb_build_object(
             'event', 'purchase'::text,
             'status', ce.status,
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
     AND k.postback_enabled
     AND 'purchase' = ANY (k.postback_event_keys)
     AND ce.created_at >= k.postback_active_since
    WHERE ce.status = 'approved'
      AND ce.created_at > now() - interval '30 days'
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
            WHERE p.drip_journey_id = j.id AND NOT p.is_test
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
  return { queued: rows.length };
}
