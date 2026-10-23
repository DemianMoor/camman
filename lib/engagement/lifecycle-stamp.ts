import { sql, type SQL } from "drizzle-orm";

/**
 * THE status-at-send stamp, as ONE INSERT over a relation of freshly inserted
 * sends. Every path that creates a stage_sends row that can be SENT uses it:
 * kickoff's bulk materialization and both drip producers (scheduler first
 * sends, send-one follow-ups). Drip sends were not stamped until 2026-10-23,
 * which is why the whole drip programme sat in the Lifecycle report's
 * Unclassified row — 233,240 sends in 09-23→10-22, every one of them drip.
 *
 * `ins` must expose `id`, `org_id`, `contact_id` — in practice the name of a
 * data-modifying CTE (`WITH ins AS (INSERT … RETURNING id, org_id,
 * contact_id)`), so the stamp is part of the SAME statement as the send: a
 * stamp can never exist without its send or vice versa, at no extra round trip.
 *
 * `coalesce(ce.status, 'new')` is the documented contract for a contact the
 * engagement job has not evaluated yet. `last_click_at` is read from the same
 * contact_engagement row as the status (0220), so the two always agree about
 * when they were true — that is what the report's Warm split reads.
 *
 * Skipped rows (`skipped_ineligible`, lib/drip/skip-send.ts) are never sent and
 * are deliberately not stamped.
 */
export function lifecycleStampInsertSql(ins: SQL): SQL {
  return sql`
    INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, last_click_at)
    SELECT i.id, i.org_id, coalesce(ce.status, 'new'), ce.last_click_at
    FROM ${ins} i
    LEFT JOIN contact_engagement ce
      ON ce.contact_id = i.contact_id AND ce.org_id = i.org_id
    ON CONFLICT (stage_send_id) DO NOTHING`;
}
