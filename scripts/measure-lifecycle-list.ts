import "./_env-preload";

// READ-ONLY measurement of the contacts-list lifecycle column and filter
// against production. It answers the question the plan refuses to assume:
// how long does /api/contacts/list take once it carries the lifecycle status?
//
// The owner's acceptance bars (2026-09-23): the PAGE QUERY under 300 ms and
// the CAPPED COUNT under 1 s, for every shape including `new`. It is
// a 20-row page; anything slower is a plan problem, not a tolerable cost.
//
// The queries are built the way app/api/contacts/list/route.ts builds them —
// the same lifecycleStatusCondition, the same correlated scalar expression,
// and the same capped count subquery — so this measures the shipping shape
// and not an approximation of it.
//
// Listed in EXCLUSIONS of scripts/test-preview-db-guard.ts: it reads
// production deliberately. Nothing here writes. Run it off the busy cron
// minutes (:29/:59 pools, :11/:41 fresh counts, :14 creative lifetime, the
// */5 marks, and :10/:25/:40/:55 for the engagement job).
//
// Run: npx tsx --conditions=react-server scripts/measure-lifecycle-list.ts

import { and, desc, eq, sql } from "drizzle-orm";

const PAGE_SIZE = 20;
const COUNT_CAP = 10_000;

async function main() {
  const { db } = await import("@/db/client");
  const { contacts } = await import("@/db/schema");
  const { lifecycleStatusCondition, lifecycleStatusExpr } = await import(
    "@/lib/engagement/list-filter"
  );
  const { ENGAGEMENT_STATUSES } = await import("@/lib/engagement/constants");

  const orgs = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  )) as unknown as { id: string }[];
  if (orgs.length !== 1) throw new Error(`${orgs.length} organizations — this script assumes one`);
  const orgId = orgs[0].id;
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`measuring against ${host}, org ${orgId}\n`);

  // The same expression the route selects, imported rather than retyped.
  const lifecycleStatusSql = lifecycleStatusExpr(orgId);
  const groupsAggSql = sql<string>`(
    select coalesce(json_agg(json_build_object(
      'id', cg."id", 'name', cg."name", 'color', cg."color"
    ) order by cg."name"), '[]'::json)
    from "contact_contact_groups" ccg
    inner join "contact_groups" cg on cg."id" = ccg."contact_group_id"
    where ccg."contact_id" = "contacts"."id"
  )`;
  const statusesAggSql = sql<string[]>`(
    select coalesce(array_agg(distinct oo."reason"), array[]::text[])
    from "opt_outs" oo
    where oo."contact_id" = "contacts"."id" and oo."org_id" = ${orgId}
  )`;

  const explain = async (label: string, bar: number, q: { getSQL(): ReturnType<typeof sql> }) => {
    const rows = (await db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS) ${q.getSQL()}`,
    )) as unknown as Record<string, string>[];
    const lines = rows.map((r) => Object.values(r)[0]);
    const timing = lines.find((l) => l.startsWith("Execution Time:")) ?? "";
    const ms = Number(timing.replace(/[^\d.]/g, "")) || 0;
    const verdict = ms <= bar ? "PASS" : "OVER BAR";
    console.log(`${label}\n  ${timing.trim()}  [bar ${bar} ms] ${verdict}`);
    if (ms > bar) {
      console.log("  --- plan ---");
      for (const l of lines.slice(0, 12)) console.log("  " + l);
    }
    console.log();
    return ms;
  };

  const pageQuery = (cond: ReturnType<typeof lifecycleStatusCondition>) =>
    db
      .select({
        id: contacts.id,
        phone_number: contacts.phone_number,
        created_at: contacts.created_at,
        line_type: contacts.line_type,
        carrier_norm: contacts.carrier_norm,
        messaging_status: contacts.messaging_status,
        groups: groupsAggSql,
        statuses: statusesAggSql,
        lifecycle_status: lifecycleStatusSql,
      })
      .from(contacts)
      .where(cond ? and(eq(contacts.org_id, orgId), cond) : eq(contacts.org_id, orgId))
      .orderBy(desc(contacts.created_at))
      .limit(PAGE_SIZE + 1)
      .offset(0);

  const countQuery = (cond: ReturnType<typeof lifecycleStatusCondition>) =>
    db
      .select({ one: sql`1` })
      .from(contacts)
      .where(cond ? and(eq(contacts.org_id, orgId), cond) : eq(contacts.org_id, orgId))
      .limit(COUNT_CAP + 1);

  // Every status a user can actually pick, plus the combinations, ordered by
  // how many contacts they match. Selectivity is the whole story here.
  const shapes: [string, ReturnType<typeof lifecycleStatusCondition>][] = [
    ["unfiltered", null],
    ["cold (556K)", lifecycleStatusCondition(orgId, ["cold"])],
    ["freeze (143K)", lifecycleStatusCondition(orgId, ["freeze"])],
    ["new (123K)", lifecycleStatusCondition(orgId, ["new"])],
    ["warm (46K)", lifecycleStatusCondition(orgId, ["warm"])],
    ["hot (38K)", lifecycleStatusCondition(orgId, ["hot"])],
    ["hot,warm (84K)", lifecycleStatusCondition(orgId, ["hot", "warm"])],
    ["new,hot (161K)", lifecycleStatusCondition(orgId, ["new", "hot"])],
    ["suppressed (0 — matches nobody until launch+60d)", lifecycleStatusCondition(orgId, ["suppressed"])],
  ];

  let over = 0;
  for (const [label, cond] of shapes) {
    if ((await explain(`PAGE  — ${label}`, 300, pageQuery(cond))) > 300) over++;
    if (cond && (await explain(`COUNT — ${label}`, 1000, countQuery(cond))) > 1000) over++;
  }

  // Sanity: the column agrees with the stored table, and every status is reachable.
  const dist = (await db.execute(sql`
    SELECT coalesce(ce.status, 'new') AS status, count(*)::int AS n
    FROM contacts c
    LEFT JOIN contact_engagement ce ON ce.contact_id = c.id AND ce.org_id = c.org_id
    WHERE c.org_id = ${orgId}
    GROUP BY 1 ORDER BY 2 DESC
  `)) as unknown as { status: string; n: number }[];
  console.log("status distribution:");
  for (const r of dist) console.log(`  ${r.status.padEnd(11)} ${Number(r.n).toLocaleString()}`);
  const missing = ENGAGEMENT_STATUSES.filter((s) => !dist.some((d) => d.status === s));
  if (missing.length > 0) console.log(`  (no contacts currently in: ${missing.join(", ")})`);

  console.log(over === 0 ? "\nAll shapes within the bars." : `\n${over} shape(s) OVER BAR.`);
  process.exit(over === 0 ? 0 : 1);
}

main();
