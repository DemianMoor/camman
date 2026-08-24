import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// D2 backfill — close the journeys that are ALREADY terminal in fact but were
// never marked, because until Phase 6 nothing closed a journey.
//
// ⚠️ A SCRIPT, NOT A MIGRATION (ruling D2). It reads live opt-out and sale data
// to decide, so it is not a fixed DDL step: re-running it later legitimately
// closes journeys that have since become terminal. A migration would have
// frozen one moment's answer into the chain.
//
// ⚠️ IDEMPOTENT AND SIGNATURE-CHECKED. Every UPDATE is guarded by
// state IN ('routed','active'), so a second run is a no-op and no closed_at is
// ever moved. --apply is required; the default is a dry run that shows exactly
// which rows would change and why.
//
// ⚠️ IT NEVER CLOSES BY PATTERN. Each row is matched on a POSITIVE fact — an
// opt_outs row for that contact, or a purchase per purchasedClause() — never on
// a name, a date range, or "looks like a test". Closing a live journey wrongly
// would free a contact's slot and let a second campaign message them.

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`ref: ${/postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1]}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: dry run (pass --apply to write)\n");

  const preview = (await db.execute(sql`
    SELECT j.id, ct.phone_number, j.state, j.campaign_id,
           EXISTS (SELECT 1 FROM opt_outs o
                    WHERE o.contact_id = j.contact_id AND o.org_id = j.org_id) AS opted_out,
           (SELECT min(o.created_at) FROM opt_outs o
             WHERE o.contact_id = j.contact_id AND o.org_id = j.org_id) AS opted_out_at,
           EXISTS (SELECT 1 FROM stage_sends ss
                    WHERE ss.contact_id = j.contact_id AND ss.campaign_id = j.campaign_id
                      AND ss.org_id = j.org_id
                      AND ss.sale_status IN ('lead','sale')) AS purchased
    FROM drip_journeys j
    JOIN contacts ct ON ct.id = j.contact_id
    WHERE j.state IN ('routed','active')
    ORDER BY j.routed_at
  `)) as unknown as Record<string, unknown>[];

  console.log(`live journeys: ${preview.length}`);
  for (const r of preview) {
    const verdict = r.purchased ? "→ converted" : r.opted_out ? "→ opted_out" : "stays active";
    console.log(
      `   ${r.phone_number}  state=${r.state}  opted_out=${r.opted_out} ` +
        `purchased=${r.purchased}  ${verdict}`,
    );
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    await pgConn.end();
    return;
  }

  // Purchase first: a lead who both bought and opted out reads as 'converted',
  // matching the sweeper's precedence exactly.
  const conv = (await db.execute(sql`
    UPDATE drip_journeys j
    SET state = 'converted', closed_at = now(), close_reason = 'backfill_purchased'
    WHERE j.state IN ('routed','active')
      AND EXISTS (SELECT 1 FROM stage_sends ss
                   WHERE ss.contact_id = j.contact_id AND ss.campaign_id = j.campaign_id
                     AND ss.org_id = j.org_id AND ss.sale_status IN ('lead','sale'))
    RETURNING j.id
  `)) as unknown as { id: string }[];

  // ⚠️ closed_at is the OPT-OUT's own time, not now(): the journey ended when
  // the STOP arrived, and stamping now() would misdate every one of them.
  const opted = (await db.execute(sql`
    UPDATE drip_journeys j
    SET state = 'opted_out',
        closed_at = (SELECT min(o.created_at) FROM opt_outs o
                      WHERE o.contact_id = j.contact_id AND o.org_id = j.org_id),
        close_reason = 'backfill_stop_received'
    WHERE j.state IN ('routed','active')
      AND EXISTS (SELECT 1 FROM opt_outs o
                   WHERE o.contact_id = j.contact_id AND o.org_id = j.org_id)
    RETURNING j.id
  `)) as unknown as { id: string }[];

  console.log(`\nclosed: ${conv.length} converted, ${opted.length} opted_out`);

  const after = (await db.execute(sql`
    SELECT state, count(*)::int AS n, count(closed_at)::int AS with_closed_at
    FROM drip_journeys GROUP BY state ORDER BY state
  `)) as unknown as Record<string, unknown>[];
  console.log("final:");
  for (const r of after) console.log("   " + JSON.stringify(r));

  // The invariant the CHECK enforces going forward, asserted over the whole
  // table — a terminal row without closed_at would be invisible to every
  // consumer that reads closed_at rather than state.
  const bad = (await db.execute(sql`
    SELECT count(*)::int AS n FROM drip_journeys
    WHERE (state IN ('routed','active')) <> (closed_at IS NULL)
  `)) as unknown as { n: number }[];
  console.log(`\nstate/closed_at disagreements: ${bad[0].n}${bad[0].n === 0 ? " ✓" : " ⚠️"}`);

  await pgConn.end();
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
