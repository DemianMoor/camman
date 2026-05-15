// One-shot diagnostic for the time-based segment rules. Runs the exact
// SQL fragment buildSegmentAudienceClause emits for contact_added_in_last_n_days
// and contact_added_more_than_n_days_ago against the live DB, plus a
// few sanity baselines. Read-only.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.DATABASE_URL!;
  const pg = postgres(dbUrl, { prepare: false });
  const db = drizzle(pg);

  try {
    // Pick an org with recent contacts
    const orgs = (await db.execute(drizzleSql`
      SELECT org_id::text AS org_id, count(*)::int AS n
      FROM contacts
      WHERE created_at >= now() - interval '30 days'
      GROUP BY org_id
      ORDER BY n DESC
      LIMIT 3
    `)) as unknown as { org_id: string; n: number }[];
    console.log("Orgs with contacts created in last 30 days:");
    for (const o of orgs) console.log(`  ${o.org_id}: ${o.n}`);
    if (orgs.length === 0) {
      console.log("(no orgs with recent contacts)");
      return;
    }
    const orgId = orgs[0].org_id;

    // Baseline: total contacts in this org
    const total = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid
    `)) as unknown as { n: number }[];
    console.log(`\nTotal contacts in org ${orgId}: ${total[0]?.n}`);

    // Now run the inner queries the rules eval emits — exact SQL.
    const days = 8;
    console.log(`\nRule: contact_added_in_last_n_days, value=${days}`);
    const inLast = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n
      FROM (
        SELECT id AS contact_id
        FROM contacts
        WHERE org_id = ${orgId}::uuid
          AND created_at >= now() - make_interval(days => ${Number(days)})
      ) q
    `)) as unknown as { n: number }[];
    console.log(`  match count: ${inLast[0]?.n}`);

    const moreThan = 1;
    console.log(`\nRule: contact_added_more_than_n_days_ago, value=${moreThan}`);
    const olderThan = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n
      FROM (
        SELECT id AS contact_id
        FROM contacts
        WHERE org_id = ${orgId}::uuid
          AND created_at < now() - make_interval(days => ${Number(moreThan)})
      ) q
    `)) as unknown as { n: number }[];
    console.log(`  match count: ${olderThan[0]?.n}`);

    // Compare to a literal interval (no parameter binding) — eliminates
    // any "make_interval / parameter-type" weirdness.
    const literalIn = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n
      FROM contacts
      WHERE org_id = ${orgId}::uuid
        AND created_at >= now() - interval '8 days'
    `)) as unknown as { n: number }[];
    console.log(`\nLiteral 'interval 8 days' in last 8 days: ${literalIn[0]?.n}`);

    const literalOlder = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n
      FROM contacts
      WHERE org_id = ${orgId}::uuid
        AND created_at < now() - interval '1 day'
    `)) as unknown as { n: number }[];
    console.log(`Literal 'interval 1 day' more than 1 day ago: ${literalOlder[0]?.n}`);

    // Distribution sanity
    const buckets = (await db.execute(drizzleSql`
      SELECT
        sum(case when created_at >= now() - interval '1 day' then 1 else 0 end)::int AS last_1d,
        sum(case when created_at >= now() - interval '3 days' then 1 else 0 end)::int AS last_3d,
        sum(case when created_at >= now() - interval '8 days' then 1 else 0 end)::int AS last_8d,
        sum(case when created_at < now() - interval '1 day' then 1 else 0 end)::int AS older_1d,
        sum(case when created_at < now() - interval '8 days' then 1 else 0 end)::int AS older_8d,
        min(created_at) AS first_seen,
        max(created_at) AS last_seen
      FROM contacts
      WHERE org_id = ${orgId}::uuid
    `)) as unknown as {
      last_1d: number;
      last_3d: number;
      last_8d: number;
      older_1d: number;
      older_8d: number;
      first_seen: string;
      last_seen: string;
    }[];
    console.log("\nDistribution:");
    console.log(`  last 1d: ${buckets[0]?.last_1d}`);
    console.log(`  last 3d: ${buckets[0]?.last_3d}`);
    console.log(`  last 8d: ${buckets[0]?.last_8d}`);
    console.log(`  older than 1d: ${buckets[0]?.older_1d}`);
    console.log(`  older than 8d: ${buckets[0]?.older_8d}`);
    console.log(`  first_seen: ${buckets[0]?.first_seen}`);
    console.log(`  last_seen: ${buckets[0]?.last_seen}`);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
