import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY recon on the stage(s) just re-prepared.
//   1. stage_sends counts by status
//   2. any contact_id appearing >1 across pending/sending/sent (expect zero)
//   3. what the Prepare progress counter reports (bare count, no status filter)
//
// Run: npx tsx scripts/probe-reprepared-stage-recon.ts

const ET = "America/New_York";

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) =>
    (await d.execute(query)) as unknown as T[];

  console.log("=== stages materialized in the last 24h ===");
  const recent = await q<{ stage_id: number }>(sql`
    SELECT s.id AS stage_id, s.campaign_id, cm.name AS campaign, s.stage_number,
           to_char(s.materialized_at AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS materialized_et,
           to_char(s.scheduled_at   AT TIME ZONE ${ET}, 'MM-DD HH24:MI')    AS scheduled_et,
           s.send_approved, cm.send_paused AS campaign_paused
    FROM campaign_stages s JOIN campaigns cm ON cm.id = s.campaign_id
    WHERE s.materialized_at > now() - interval '24 hours'
    ORDER BY s.materialized_at DESC
  `);
  console.table(recent);
  if (recent.length === 0) {
    console.log("No stage materialized in the last 24h.");
    await c.end();
    return;
  }

  for (const r of recent) {
    const id = Number(r.stage_id);
    console.log(`\n\n########## STAGE ${id} ##########`);

    console.log("\n--- (1) counts by status ---");
    console.table(
      await q(sql`
        SELECT status, count(*)::int AS n,
               to_char(min(created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS first_created_et,
               to_char(max(created_at) AT TIME ZONE ${ET}, 'MM-DD HH24:MI:SS') AS last_created_et
        FROM stage_sends WHERE stage_id = ${id}
        GROUP BY status ORDER BY status
      `),
    );

    console.log("--- (1b) live vs audit split ---");
    console.table(
      await q(sql`
        SELECT count(*) FILTER (WHERE status IN ('pending','sending','sent'))::int AS live,
               count(*) FILTER (WHERE status = 'pending')::int AS pending,
               count(*) FILTER (WHERE status IN ('rejected','skipped_opted_out'))::int AS audit,
               count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
               count(*) FILTER (WHERE status = 'skipped_opted_out')::int AS skipped_opted_out,
               count(*)::int AS all_rows,
               count(*) FILTER (WHERE status NOT IN ('rejected','skipped_opted_out'))::int AS total_after_pr27
        FROM stage_sends WHERE stage_id = ${id}
      `),
    );

    console.log("--- (2) contact_id appearing >1 across pending/sending/sent ---");
    const dupes = await q<Record<string, unknown>>(sql`
      SELECT contact_id, count(*)::int AS n, string_agg(DISTINCT status, ',') AS statuses
      FROM stage_sends
      WHERE stage_id = ${id} AND status IN ('pending','sending','sent')
      GROUP BY contact_id HAVING count(*) > 1
      ORDER BY count(*) DESC LIMIT 20
    `);
    if (dupes.length === 0) console.log("  NONE — zero duplicate live rows OK");
    else {
      console.log("  *** DUPLICATES FOUND ***");
      console.table(dupes);
    }

    console.log("--- (2b) live rows vs DISTINCT live contacts (must be equal) ---");
    console.table(
      await q(sql`
        SELECT count(*)::int AS live_rows,
               count(DISTINCT contact_id)::int AS distinct_contacts,
               (count(*) = count(DISTINCT contact_id)) AS ok
        FROM stage_sends WHERE stage_id = ${id} AND status IN ('pending','sending','sent')
      `),
    );

    console.log("--- (2c) contacts holding BOTH a live row and an audit row from the aborted run ---");
    console.table(
      await q(sql`
        SELECT count(*)::int AS contacts_relisted FROM (
          SELECT contact_id FROM stage_sends WHERE stage_id = ${id}
          GROUP BY contact_id
          HAVING count(*) FILTER (WHERE status IN ('pending','sending','sent')) > 0
             AND count(*) FILTER (WHERE status IN ('rejected','skipped_opted_out')) > 0
        ) t
      `),
    );

    console.log("--- (3) Prepare progress counter (materialize-progress route) ---");
    console.table(
      await q(sql`
        SELECT (SELECT count(*)::int FROM stage_sends ss
                 WHERE ss.stage_id = s.id AND ss.org_id = s.org_id) AS progress_counter_reports,
               (SELECT count(*)::int FROM stage_sends ss
                 WHERE ss.stage_id = s.id AND ss.org_id = s.org_id
                   AND ss.status IN ('pending','sending','sent')) AS actual_new_recipients,
               (s.materialized_at IS NOT NULL) AS complete
        FROM campaign_stages s WHERE s.id = ${id}
      `),
    );
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
