import "./_env-preload";

// SIZING THE GROUP × LIFECYCLE BREAKDOWN — read-only, production.
//
// Answers the design question before any code is written: does the whole table
// fit inside the 2s bar with the "available today" columns joined in, or do
// those have to be computed per row on demand?
//
// ⚠️ EACH SHAPE IS RUN REPEATEDLY AND INTERLEAVED, AND REPORTED AS A SPREAD. A
// single run on a live database measures the cache as much as the query: the
// all-in-one shape first timed out, then measured 15.9s, then 2.1s, with no
// code change between them. Only a difference bigger than a shape's own spread
// means anything. Interleaving stops whichever shape ran first from paying the
// cold-cache cost for the others.
//
// Every statement is a SELECT. Nothing is written.
//
// Run: npx tsx --conditions=react-server scripts/measure-group-lifecycle.ts
//      npx tsx --conditions=react-server scripts/measure-group-lifecycle.ts --runs 5

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const RUNS = Number(arg("runs") ?? "4");
const N_DAYS = Number(arg("days") ?? "3");
const BAR_MS = 2000;

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { inUseSetBody, isDripPostureOn } = await import("@/lib/drip/in-use");

  const all = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const orgs = await all<{ id: string }>(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  );
  const orgId = orgs[0].id;
  const org = sql`${orgId}::uuid`;
  const posture = await isDripPostureOn(orgId);
  console.log(
    `read-only against ${new URL(process.env.DATABASE_URL!).hostname}\n` +
      `drip posture: ${posture} · N=${N_DAYS} days · ${RUNS} runs per shape\n`,
  );

  const scale = (
    await all<Record<string, string>>(sql`
      SELECT (SELECT count(*) FROM contact_groups WHERE org_id = ${org} AND archived_at IS NULL)::text AS groups_active,
             (SELECT count(*) FROM contact_contact_groups WHERE org_id = ${org})::text AS memberships,
             (SELECT count(*) FROM contacts WHERE org_id = ${org} AND archived_at IS NULL)::text AS contacts_active,
             (SELECT count(*) FROM campaign_audience_pool p JOIN campaigns c ON c.id = p.campaign_id
               WHERE p.org_id = ${org} AND c.status = 'active')::text AS in_use_rows
    `)
  )[0];
  console.log("SCALE");
  for (const [k, v] of Object.entries(scale)) {
    console.log(`  ${k.padEnd(20)} ${Number(v).toLocaleString().padStart(12)}`);
  }

  const inUse = sql`in_use AS (${inUseSetBody(orgId, posture)})`;
  const blocked = sql`blocked AS (
      SELECT contact_id FROM contact_engagement
      WHERE org_id = ${org}
        AND (
          (status = 'freeze'
            AND last_sent_at > now() - make_interval(days => freeze_cadence_days))
          OR last_sent_at > now() - make_interval(days => ${N_DAYS}::int)
        )
    )`;
  const opted = sql`opted AS (
      SELECT DISTINCT contact_id FROM opt_outs
      WHERE org_id = ${org} AND contact_id IS NOT NULL
    )`;

  // BASE — sendable only, per group × status.
  const base = sql`
    WITH ${opted}
    SELECT ccg.contact_group_id AS gid, c.lifecycle_status AS st, count(*)::int AS n
    FROM contact_contact_groups ccg
    JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
    JOIN contacts c
      ON c.id = ccg.contact_id AND c.org_id = ${org}
     AND c.archived_at IS NULL AND c.messaging_status = 'eligible'
    LEFT JOIN opted o ON o.contact_id = ccg.contact_id
    WHERE ccg.org_id = ${org} AND o.contact_id IS NULL
    GROUP BY 1, 2`;

  // PER-MEMBERSHIP — availability decided for every membership row.
  const perMembership = sql`
    WITH ${inUse}, ${blocked}, ${opted},
    elig AS (
      SELECT ccg.contact_group_id AS gid, c.id AS contact_id, c.lifecycle_status AS st
      FROM contact_contact_groups ccg
      JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
      JOIN contacts c
        ON c.id = ccg.contact_id AND c.org_id = ${org}
       AND c.archived_at IS NULL AND c.messaging_status = 'eligible'
      LEFT JOIN opted o ON o.contact_id = ccg.contact_id
      WHERE ccg.org_id = ${org} AND o.contact_id IS NULL
    )
    SELECT e.gid, e.st, count(*)::int AS sendable,
           count(*) FILTER (WHERE u.contact_id IS NULL AND b.contact_id IS NULL)::int AS available_today
    FROM elig e
    LEFT JOIN in_use u ON u.contact_id = e.contact_id
    LEFT JOIN blocked b ON b.contact_id = e.contact_id
    GROUP BY 1, 2`;

  // FAN-OUT — availability decided ONCE per contact, then joined to memberships.
  const fanOut = sql`
    WITH ${inUse}, ${blocked}, ${opted},
    flags AS (
      SELECT c.id, c.lifecycle_status AS st,
             (u.contact_id IS NULL AND b.contact_id IS NULL) AS avail
      FROM contacts c
      LEFT JOIN opted o ON o.contact_id = c.id
      LEFT JOIN in_use u ON u.contact_id = c.id
      LEFT JOIN blocked b ON b.contact_id = c.id
      WHERE c.org_id = ${org} AND c.archived_at IS NULL
        AND c.messaging_status = 'eligible' AND o.contact_id IS NULL
    )
    SELECT ccg.contact_group_id AS gid, f.st,
           count(*)::int AS sendable,
           count(*) FILTER (WHERE f.avail)::int AS available_today
    FROM contact_contact_groups ccg
    JOIN contact_groups g ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
    JOIN flags f ON f.id = ccg.contact_id
    WHERE ccg.org_id = ${org}
    GROUP BY 1, 2`;

  const shapes: [string, ReturnType<typeof sql>][] = [
    ["base (sendable only)", base],
    ["per-membership + available", perMembership],
    ["fan-out + available", fanOut],
  ];

  console.log(
    `\nTIMINGS — ${RUNS} runs each, interleaved so no shape owns the warm cache`,
  );
  const results = new Map<string, number[]>(shapes.map(([n]) => [n, []]));
  let rowCount = 0;
  for (let r = 0; r < RUNS; r++) {
    for (const [name, q] of shapes) {
      const t0 = Date.now();
      const rows = await all(q);
      results.get(name)!.push(Date.now() - t0);
      rowCount = rows.length;
    }
  }
  console.log(`  (each returns ${rowCount} rows)\n`);
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  };
  for (const [name] of shapes) {
    const { min, med, max } = stat(results.get(name)!);
    console.log(
      `  ${name.padEnd(28)} min ${String(min).padStart(6)}  med ${String(med).padStart(6)}  max ${String(max).padStart(6)} ms   [${results.get(name)!.join(", ")}]`,
    );
  }

  console.log("\nVERDICT");
  for (const [name] of shapes) {
    const { med, max } = stat(results.get(name)!);
    console.log(
      `  ${name.padEnd(28)} median ${med} ms, worst ${max} ms → ` +
        `${max < BAR_MS ? "INSIDE the bar even at its worst" : med < BAR_MS ? "median inside, worst OVER" : "OVER"}`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
