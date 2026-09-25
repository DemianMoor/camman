import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { purchasedOfferContacts } from "@/lib/sale-attribution";
import {
  LIFECYCLE_EXCLUSION_KEYS,
  type LifecycleExclusionKey,
} from "@/lib/sends/eligibility";

export type DbOrTx =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── THE SEND-TIME LIFECYCLE RE-CHECK (spec §8.4, PR 4c) ──────────────────────
//
// The last gate before a message leaves. It runs once per claimed drain batch,
// beside the opt-out and 1-hour-dedup gates that already live there, and marks
// the losers `skipped_ineligible` with the reason in `last_error`.
//
// ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────
// Prepare already removed these people. What Prepare could not know is what
// happens in the window between materialization and dispatch, which is often
// hours long because pacing spreads a stage out. In that window a contact can
// become suppressed, buy the offer, or — the case that actually motivated this
// — be messaged by ANOTHER campaign, putting them back inside their freeze
// cadence.
//
// ⚠️ THE FREEZE CHECK READS `stage_sends`, NOT `contact_engagement`, AND THAT
// IS NOT AN OVERSIGHT. `contact_engagement.last_sent_at` is maintained by a
// cron that runs every 15 minutes, so it is stale by construction: it cannot
// see a message sent ten minutes ago. Reading it here would make the re-check
// agree with Prepare — and agreeing with Prepare is precisely what makes the
// re-check pointless, because Prepare already ran. `stage_sends` is the live
// fact, and the `(org_id, phone, sent_at)` index the 1-hour dedup uses serves
// this query too.
//
// ⚠️ IT MATCHES ON PHONE, NOT contact_id. A phone can carry more than one
// contact row (merges, re-imports); the cadence is a promise to the PERSON
// holding the handset, so the phone is the right key — the same choice the
// 1-hour dedup makes one gate above.
//
// ── ON FAILURE ──────────────────────────────────────────────────────────────
// This function THROWS. It does not swallow its own errors, because it cannot
// know whether the caller can proceed without it. The drain catches and fails
// OPEN (see lib/sends/drain.ts): a handful of contacts getting a message they
// would have been spared is recoverable; a stage that stops dispatching
// mid-drain with rows stuck in 'sending' is not, because 'sending' rows are
// never re-claimed.

/**
 * The `last_error` string written for each reason, derived from the layer keys
 * rather than typed out, so the drain and the surfaces that read the reasons
 * back cannot disagree about the spelling. See lib/sends/eligibility.ts.
 */
export const LIFECYCLE_SKIP_REASONS: Record<
  LifecycleExclusionKey,
  LifecycleExclusionKey
> = Object.fromEntries(LIFECYCLE_EXCLUSION_KEYS.map((k) => [k, k])) as Record<
  LifecycleExclusionKey,
  LifecycleExclusionKey
>;

export interface RecheckRow {
  id: string;
  phone: string;
  contact_id: string;
}

export interface RecheckParams {
  orgId: string;
  campaignId: number;
  // The campaign's offer. Null ⇒ the bought_offer layer cannot apply.
  offerId: number | null;
  // campaigns.lifecycle_rules. False ⇒ NO query runs at all.
  lifecycleRules: boolean;
  rows: RecheckRow[];
}

/**
 * Which of the claimed rows must NOT be sent, and why.
 *
 * Returns an empty map for a legacy campaign or an empty batch WITHOUT
 * touching the database — a legacy drain pays nothing for this feature.
 *
 * Reasons are exclusive and attributed in EXCLUSION_PRIORITY order, so a
 * contact caught by two layers is reported under the first. That ordering is
 * the same one the Prepare-time breakdown uses, so the two sets of numbers are
 * comparable; see lib/sends/eligibility.ts.
 */
export async function recheckLifecycleEligibility(
  dbc: DbOrTx,
  p: RecheckParams,
): Promise<Map<string, LifecycleExclusionKey>> {
  const out = new Map<string, LifecycleExclusionKey>();
  if (!p.lifecycleRules || p.rows.length === 0) return out;

  const ids = sql.join(
    p.rows.map((r) => sql`(${r.id}::uuid, ${r.contact_id}::uuid, ${r.phone})`),
    sql`, `,
  );

  // One pass: the batch as a VALUES relation, one LEFT JOIN per layer.
  // `bought_offer` reuses purchasedOfferContacts() — the SAME definition the
  // segment rule and the Prepare-time layer use, so "has bought this offer"
  // cannot mean three different things in three places.
  const boughtRel =
    p.offerId != null
      ? purchasedOfferContacts(p.orgId, p.offerId)
      : sql`SELECT NULL::uuid AS contact_id WHERE false`;

  const rows = (await dbc.execute(sql`
    WITH batch (send_id, contact_id, phone) AS (VALUES ${ids}),
    bought AS (${boughtRel})
    SELECT
      b.send_id,
      -- Suppressed: the migration-0188 projection, which the engagement job
      -- maintains in the same transaction as the transition row.
      (c.lifecycle_status = 'suppressed') AS hit_suppressed,
      (bo.contact_id IS NOT NULL) AS hit_bought_offer,
      -- In freeze AND messaged inside their OWN cadence, read live from
      -- stage_sends across every campaign in the org.
      (
        ce.status = 'freeze'
        AND ce.freeze_cadence_days IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM stage_sends ss
          WHERE ss.org_id = ${p.orgId}::uuid
            AND ss.phone = b.phone
            AND ss.status = 'sent'
            AND ss.sent_at > now() - make_interval(days => ce.freeze_cadence_days)
        )
      ) AS hit_freeze_not_due
    FROM batch b
    JOIN contacts c ON c.id = b.contact_id AND c.org_id = ${p.orgId}::uuid
    LEFT JOIN contact_engagement ce
      ON ce.contact_id = b.contact_id AND ce.org_id = ${p.orgId}::uuid
    LEFT JOIN bought bo ON bo.contact_id = b.contact_id
  `)) as unknown as {
    send_id: string;
    hit_suppressed: boolean;
    hit_bought_offer: boolean;
    hit_freeze_not_due: boolean;
  }[];

  for (const r of rows) {
    // First hit in priority order wins — iterate the canonical key list rather
    // than writing the order out again here.
    for (const key of LIFECYCLE_EXCLUSION_KEYS) {
      const hit =
        key === "suppressed"
          ? r.hit_suppressed
          : key === "bought_offer"
            ? r.hit_bought_offer
            : r.hit_freeze_not_due;
      if (hit) {
        out.set(r.send_id, key);
        break;
      }
    }
  }
  return out;
}
