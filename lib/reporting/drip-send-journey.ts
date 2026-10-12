import { sql, type SQL } from "drizzle-orm";

// A drip send -> the ONE journey it belongs to. The body of a `JOIN LATERAL`
// over a `stage_sends` alias (default `ss`).
//
// stage_sends has no journey column, and a contact can hold several journeys on
// one campaign over time, so a plain join on (org, contact, campaign) can match
// more than one journey and multiply every send (the Offer Group Report's
// 904,926-vs-88,536 failure). This picks exactly one: the most recent journey
// that had already started when the send was created.
//
// SHARED by the partner report (lib/reporting/partner-report.ts) and the drip
// Daily results rollup (lib/reporting/drip-daily-rollup.ts), so the two cannot
// attribute a send to different leads.
export function journeyForSend(alias = "ss"): SQL {
  const ss = sql.raw(alias);
  return sql`
        SELECT j.id, j.lead_event_id, j.first_send_id, j.carried_days
        FROM drip_journeys j
        WHERE j.org_id = ${ss}.org_id
          AND j.contact_id = ${ss}.contact_id
          AND j.campaign_id = ${ss}.campaign_id
          AND (j.first_send_at IS NULL OR j.first_send_at <= ${ss}.created_at)
        ORDER BY j.routed_at DESC
        LIMIT 1`;
}
