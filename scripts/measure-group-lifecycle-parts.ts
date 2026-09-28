import "./_env-preload";

// WHERE THE GROUP × LIFECYCLE REPORT SPENDS ITS TIME — read-only, production.
//
// The report loads too slowly. Before storing anything, find out WHICH part
// costs the time, because the answer decides what is worth precomputing:
//
//   A  base            sendable per group × status; no availability at all
//   B  base + rested   adds only the contact_engagement blocked set
//                      (freeze-inside-cadence OR messaged within N days)
//   C  base + in use   adds only the campaign_audience_pool anti-join
//   D  full table      both — what the page runs today
//   E  rollups         clusters + distinct total, the second request
//
// B and C are each D minus one subtraction, so D − B isolates the in-use join
// and D − C isolates the engagement join. Reporting only D would say the page
// is slow without saying which half to fix.
//
// ⚠️ SHAPES ARE INTERLEAVED AND REPEATED. A single run measures the cache as
// much as the query — earlier in this work the same statement measured 2.1s,
// 15.9s and a statement timeout with no code change.
//
// Every statement is a SELECT. Nothing is written.
//
// Run: npx tsx --conditions=react-server scripts/measure-group-lifecycle-parts.ts
//      npx tsx --conditions=react-server scripts/measure-group-lifecycle-parts.ts --runs 5

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const RUNS = Number(arg("runs") ?? "4");
const N_DAYS = Number(arg("days") ?? "3");

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { inUseSetBody, isDripPostureOn } = await import("@/lib/drip/in-use");
  const { GROUP_CLUSTERS } = await import("@/lib/reporting/group-clusters");

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
      `N=${N_DAYS} days · ${RUNS} runs per shape, interleaved\n`,
  );

  const opted = sql`opted AS (
      SELECT DISTINCT contact_id FROM opt_outs
      WHERE org_id = ${org} AND contact_id IS NOT NULL
    )`;
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

  // `flags` with whichever subtractions this shape includes.
  const shape = (opts: { useInUse: boolean; useBlocked: boolean }) => {
    const ctes = [opted];
    if (opts.useInUse) ctes.push(inUse);
    if (opts.useBlocked) ctes.push(blocked);
    const joins = sql`${
      opts.useInUse ? sql`
      LEFT JOIN in_use u ON u.contact_id = c.id` : sql``
    }${
      opts.useBlocked ? sql`
      LEFT JOIN blocked b ON b.contact_id = c.id` : sql``
    }`;
    const availExpr =
      opts.useInUse && opts.useBlocked
        ? sql`(u.contact_id IS NULL AND b.contact_id IS NULL)`
        : opts.useInUse
          ? sql`(u.contact_id IS NULL)`
          : opts.useBlocked
            ? sql`(b.contact_id IS NULL)`
            : sql`true`;
    return sql`
      WITH ${sql.join(ctes, sql`, `)},
      flags AS (
        SELECT c.id, c.lifecycle_status AS st, ${availExpr} AS avail
        FROM contacts c
        LEFT JOIN opted o ON o.contact_id = c.id${joins}
        WHERE c.org_id = ${org} AND c.archived_at IS NULL
          AND c.messaging_status = 'eligible' AND o.contact_id IS NULL
      )
      SELECT ccg.contact_group_id AS gid, f.st,
             count(*)::int AS sendable,
             count(*) FILTER (WHERE f.avail)::int AS available
      FROM contact_contact_groups ccg
      JOIN contact_groups g
        ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
      JOIN flags f ON f.id = ccg.contact_id
      WHERE ccg.org_id = ${org}
      GROUP BY 1, 2`;
  };

  const rows = GROUP_CLUSTERS.flatMap((c) =>
    c.codes.map((code) => sql`(${code}, ${c.key})`),
  );
  const clusterVals = sql`(VALUES ${sql.join(rows, sql`, `)}) AS cm(code, ck)`;
  const rollups = sql`
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
    ),
    membership AS (
      SELECT g.contact_group_id AS code, f.id AS contact_id, f.st, f.avail
      FROM contact_contact_groups ccg
      JOIN contact_groups g
        ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
      JOIN flags f ON f.id = ccg.contact_id
      WHERE ccg.org_id = ${org}
    ),
    cluster_member AS (
      SELECT DISTINCT cm.ck, m.contact_id, m.st, m.avail
      FROM membership m JOIN ${clusterVals} ON cm.code = m.code
    ),
    any_member AS (SELECT DISTINCT contact_id, st, avail FROM membership)
    SELECT ck AS key, st, count(*)::int AS sendable,
           count(*) FILTER (WHERE avail)::int AS available
    FROM cluster_member GROUP BY 1, 2
    UNION ALL
    SELECT '__all__', st, count(*)::int, count(*) FILTER (WHERE avail)::int
    FROM any_member GROUP BY 1, 2`;

  // F — the SAME blocked set written as a UNION of two indexable branches
  // instead of one OR. §10e: `x IN (a) OR x IN (b)` picks a seq scan, while
  // each UNION branch can use its own index — (org_id, last_sent_at) for the
  // rested half, (org_id, status) for the freeze half.
  const blockedUnion = sql`blocked AS (
      SELECT contact_id FROM contact_engagement
      WHERE org_id = ${org}
        AND last_sent_at > now() - make_interval(days => ${N_DAYS}::int)
      UNION
      SELECT contact_id FROM contact_engagement
      WHERE org_id = ${org} AND status = 'freeze'
        AND last_sent_at > now() - make_interval(days => freeze_cadence_days)
    )`;
  const fullUnion = sql`
    WITH ${opted}, ${inUse}, ${blockedUnion},
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
           count(*) FILTER (WHERE f.avail)::int AS available
    FROM contact_contact_groups ccg
    JOIN contact_groups g
      ON g.id = ccg.contact_group_id AND g.archived_at IS NULL
    JOIN flags f ON f.id = ccg.contact_id
    WHERE ccg.org_id = ${org}
    GROUP BY 1, 2`;

  const shapes: [string, ReturnType<typeof sql>][] = [
    ["A base (no availability)", shape({ useInUse: false, useBlocked: false })],
    ["B base + rested only", shape({ useInUse: false, useBlocked: true })],
    ["C base + in-use only", shape({ useInUse: true, useBlocked: false })],
    ["D full table (what ships)", shape({ useInUse: true, useBlocked: true })],
    ["E rollups (2nd request)", rollups],
    ["F full table, blocked as UNION", fullUnion],
  ];

  const res = new Map<string, number[]>(shapes.map(([n]) => [n, []]));
  for (let r = 0; r < RUNS; r++) {
    for (const [name, q] of shapes) {
      const t0 = Date.now();
      await all(q);
      res.get(name)!.push(Date.now() - t0);
    }
  }
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  };
  console.log("TIMINGS");
  for (const [name] of shapes) {
    const { min, med, max } = stat(res.get(name)!);
    console.log(
      `  ${name.padEnd(28)} min ${String(min).padStart(6)}  med ${String(med).padStart(6)}  max ${String(max).padStart(6)} ms   [${res.get(name)!.join(", ")}]`,
    );
  }

  const m = (k: string) => stat(res.get(k)!).med;
  const A = m("A base (no availability)");
  const B = m("B base + rested only");
  const C = m("C base + in-use only");
  const D = m("D full table (what ships)");
  const E = m("E rollups (2nd request)");
  console.log("\nATTRIBUTION (medians)");
  console.log(`  base counts alone                    ${A} ms`);
  console.log(`  cost of the ENGAGEMENT join (D - C)  ${D - C} ms`);
  console.log(`  cost of the IN-USE join      (D - B) ${D - B} ms`);
  console.log(`  full table                           ${D} ms`);
  console.log(`  rollups, second request              ${E} ms`);
  const F = m("F full table, blocked as UNION");
  console.log(`  what the page waits for today        ${D + E} ms (both requests)`);
  console.log(`
  full table with blocked as a UNION   ${F} ms  (vs ${D} ms as an OR)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
