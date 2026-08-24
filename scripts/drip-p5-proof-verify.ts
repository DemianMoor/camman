import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Drip Phase 5 production send proof — CLICK and STOP round-trip verification.
//
// ⚠️ WHICH NUMBER REPLIED STOP IS READ FROM THE DATA, NOT ASSUMED. The whole
// point of the STOP leg is that the opt-out was ingested and attributed on its
// own; taking the number as given and then "confirming" it would assert the
// conclusion. Both candidates are checked and the one carrying an opt_out is
// reported, along with the one that does not.

const CAMP = 994;
const CLICKER = "+18262062523";
const STOP_CANDIDATES = ["+18144007479", "+15642155963"];

async function rows(q: ReturnType<typeof sql>) {
  return (await db.execute(q)) as unknown as Record<string, unknown>[];
}
function show(label: string, r: Record<string, unknown>[]) {
  console.log(`\n── ${label} (${r.length})`);
  for (const x of r.slice(0, 10)) console.log("   " + JSON.stringify(x));
  if (r.length === 0) console.log("   (none)");
}

async function main() {
  console.log(`ref: ${/postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1]}`);

  // ── 1. the sends, as the baseline everything else attaches to ────────────
  show(
    "the three sends",
    await rows(sql`
      SELECT ss.phone, ss.status, ss.sent_at, l.code, ss.link_id, ss.id AS send_id
      FROM stage_sends ss LEFT JOIN links l ON l.id = ss.link_id
      WHERE ss.campaign_id = ${CAMP} ORDER BY ss.created_at`),
  );

  // ── 2. CLICK ─────────────────────────────────────────────────────────────
  show(
    `/r/ clicks on this campaign's links`,
    await rows(sql`
      SELECT c.id, l.code, c.clicked_at, c.classification, c.bot_score, c.bot_reasons,
             c.country, c.asn_org, c.seconds_since_send,
             left(c.user_agent, 40) AS ua, ss.phone
      FROM clicks c
      JOIN links l ON l.id = c.link_id
      LEFT JOIN stage_sends ss ON ss.link_id = l.id
      WHERE l.campaign_id = ${CAMP}
      ORDER BY c.clicked_at`),
  );

  show(
    "clickers table (the propagated engagement record)",
    await rows(sql`
      SELECT ck.phone_number, ck.created_at, ck.source, ck.offer_id, ck.provider_phone_id
      FROM clickers ck
      WHERE ck.phone_number = ${CLICKER}
      ORDER BY ck.created_at DESC LIMIT 3`),
  );

  // Keitaro attribution is keyed on the STAGE tracking id (sub_id_3).
  const stage = await rows(sql`
    SELECT tracking_id FROM campaign_stages WHERE campaign_id = ${CAMP} AND drip_active IS TRUE`);
  const tid = (stage[0]?.tracking_id as string) ?? "";
  console.log(`\nstage tracking id (Keitaro sub_id_3): ${tid || "(none)"}`);
  show(
    "keitaro_stage_results for this stage",
    await rows(sql`
      SELECT stage_tracking_id, stat_date, raw_clicks, clean_clicks,
             visit_clicks_raw, visit_clicks_clean, redirect_clicks_raw,
             checkouts, sales, revenue, synced_at
      FROM keitaro_stage_results WHERE stage_tracking_id = ${tid}`),
  );

  // ── 3. STOP — which number actually replied? ─────────────────────────────
  console.log("\n══ STOP leg ══");
  for (const phone of STOP_CANDIDATES) {
    const oo = await rows(sql`
      SELECT o.id, o.phone_number, o.source, o.created_at, o.contact_id
      FROM opt_outs o WHERE o.phone_number = ${phone}`);
    console.log(`\n${phone}: ${oo.length ? "OPTED OUT" : "no opt_out row"}`);
    for (const x of oo) console.log("   " + JSON.stringify(x));
    if (oo.length === 0) continue;

    show(
      `  ↳ attribution for ${phone}`,
      await rows(sql`
        SELECT a.campaign_id, a.stage_id, a.stage_send_id, a.created_at
        FROM opt_out_attributions a
        JOIN opt_outs o ON o.id = a.opt_out_id
        WHERE o.phone_number = ${phone}`),
    );
    show(
      `  ↳ inbound event that carried it (Text Request)`,
      await rows(sql`
        SELECT source_number, destination_number, left(message, 40) AS message,
               received_at, result, matched_stage_send_id IS NOT NULL AS matched
        FROM textrequest_inbound_events
        WHERE source_number LIKE ${"%" + phone.slice(-10)}
        ORDER BY received_at DESC LIMIT 3`),
    );
    show(
      `  ↳ journey state for ${phone}`,
      await rows(sql`
        SELECT j.state, j.first_send_at, j.first_stage_id
        FROM drip_journeys j JOIN contacts c ON c.id = j.contact_id
        WHERE c.phone_number = ${phone} AND j.campaign_id = ${CAMP}`),
    );
  }

  // ── 4. the drip monitor's own counter, per ET day, attributed ────────────
  console.log("\n══ drip opt-out monitor ══");
  show(
    "sends + attributed STOPs today (ET day as a RANGE — the monitor's own shape)",
    await rows(sql`
      WITH d AS (
        SELECT date_trunc('day', now() AT TIME ZONE 'America/New_York')
                 AT TIME ZONE 'America/New_York' AS lo,
               (date_trunc('day', now() AT TIME ZONE 'America/New_York')
                 + interval '1 day') AT TIME ZONE 'America/New_York' AS hi
      )
      SELECT
        (SELECT count(*)::int FROM stage_sends ss, d
          WHERE ss.campaign_id = ${CAMP} AND ss.status = 'sent'
            AND ss.sent_at >= d.lo AND ss.sent_at < d.hi) AS sent_today,
        (SELECT count(*)::int FROM opt_out_attributions a
           JOIN opt_outs o ON o.id = a.opt_out_id, d
          WHERE a.campaign_id = ${CAMP}
            AND o.created_at >= d.lo AND o.created_at < d.hi) AS optouts_today`),
  );
  show(
    "drip alert_state rows for this campaign",
    await rows(sql`
      SELECT alert_key, state, since, last_notified_at FROM alert_state
      WHERE alert_key LIKE ${"%" + CAMP} OR alert_key LIKE ${"%" + CAMP + ":%"}`),
  );

  // ── 5. final posture / pause ─────────────────────────────────────────────
  show(
    "FINAL STATE",
    await rows(sql`
      SELECT (SELECT drip_enabled FROM org_settings) AS posture_on,
             (SELECT status FROM campaigns WHERE id = ${CAMP}) AS campaign_status,
             (SELECT send_paused FROM campaigns WHERE id = ${CAMP}) AS send_paused,
             (SELECT send_paused_reason FROM campaigns WHERE id = ${CAMP}) AS reason,
             (SELECT count(*)::int FROM stage_sends WHERE campaign_id = ${CAMP}) AS total_sends`),
  );
  await pgConn.end();
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
