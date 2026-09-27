import "./_env-preload";

// Why some sends reconstruct to NOTHING — read-only, ONE ET day, rolled back.
//
// The 53-day dry run reported 10,364 "unclassified": rows in a day's target set
// with no matching row in the evaluated output. Those would stay Unclassified
// on the report forever after the backfill, so the cause matters before anyone
// runs --apply.
//
// This rebuilds the same two stages the backfill builds and reports where rows
// are lost, with a sample. Everything happens inside a transaction that throws
// at the end, so nothing is written.
//
// Run: npx tsx --conditions=react-server scripts/q-lifecycle-unclassified.ts 2026-08-22

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { etDayBounds } = await import("@/lib/reporting/delivery-rollup");
  const day = process.argv[2];
  if (!day) throw new Error("pass an ET day, e.g. 2026-08-22");

  const orgs = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  )) as unknown as { id: string }[];
  const org = sql`${orgs[0].id}::uuid`;
  // Same boundary fix as the backfill: the SQL form lands 8h early.
  const asOf = sql`${etDayBounds({ from: day, to: day }).toExclusiveUtc.toISOString()}::timestamptz`;

  await db
    .transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      await tx.execute(sql`
        CREATE TEMP TABLE q_target ON COMMIT DROP AS
        SELECT ss.id AS stage_send_id, ss.contact_id, ss.sent_at
        FROM stage_sends ss
        WHERE ss.org_id = ${org} AND ss.status = 'sent'
          AND (ss.sent_at AT TIME ZONE 'America/New_York')::date = ${day}::date
          AND NOT EXISTS (
            SELECT 1 FROM stage_send_lifecycle l WHERE l.stage_send_id = ss.id
          )`);
      await tx.execute(sql`ANALYZE q_target`);

      // The backfill's rc_facts, minus the click join (which cannot drop rows).
      await tx.execute(sql`
        CREATE TEMP TABLE q_facts ON COMMIT DROP AS
        SELECT ss.contact_id, count(*)::int AS msgs_total
        FROM stage_sends ss
        WHERE ss.org_id = ${org} AND ss.status = 'sent' AND ss.sent_at <= ${asOf}
          AND ss.contact_id IN (SELECT contact_id FROM q_target)
        GROUP BY ss.contact_id`);
      await tx.execute(sql`ANALYZE q_facts`);

      const counts = (await tx.execute(sql`
        SELECT (SELECT count(*) FROM q_target)::int AS target_rows,
               (SELECT count(DISTINCT contact_id) FROM q_target)::int AS target_contacts,
               (SELECT count(*) FROM q_facts)::int AS fact_contacts,
               (SELECT count(*) FROM q_target t
                 WHERE NOT EXISTS (SELECT 1 FROM q_facts f WHERE f.contact_id = t.contact_id)
               )::int AS lost_rows,
               (SELECT count(*) FROM q_target WHERE contact_id IS NULL)::int AS null_contact
        `)) as unknown as Record<string, number>[];
      console.log(`\n${day}`);
      for (const [k, v] of Object.entries(counts[0])) {
        console.log(`  ${k.padEnd(16)} ${Number(v).toLocaleString()}`);
      }

      // A sample of the lost rows, with the facts that should have matched.
      const sample = (await tx.execute(sql`
        SELECT t.stage_send_id, t.contact_id::text AS contact_id,
               t.sent_at::text AS sent_at,
               (SELECT count(*) FROM stage_sends s2
                 WHERE s2.contact_id = t.contact_id AND s2.status = 'sent')::int AS sent_rows_any_org,
               (SELECT count(*) FROM stage_sends s3
                 WHERE s3.contact_id = t.contact_id AND s3.status = 'sent'
                   AND s3.org_id = ${org})::int AS sent_rows_this_org,
               (SELECT count(*) FROM stage_sends s4
                 WHERE s4.contact_id = t.contact_id AND s4.status = 'sent'
                   AND s4.org_id = ${org} AND s4.sent_at <= ${asOf})::int AS sent_rows_in_scope
        FROM q_target t
        WHERE NOT EXISTS (SELECT 1 FROM q_facts f WHERE f.contact_id = t.contact_id)
        LIMIT 5`)) as unknown as Record<string, unknown>[];
      console.log("\n  sample of lost rows:");
      for (const r of sample) console.log("   ", JSON.stringify(r));

      throw new Error("__ROLLBACK__");
    })
    .catch((e) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
