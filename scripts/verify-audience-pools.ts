// Lib-level verification for GET /api/audience/pools. READ-ONLY against the
// database in .env.local (production).
//
// ⚠️ The rollup statement and an INDEPENDENT per-contact recount (per-offer
// sets + a NOT EXISTS probe on the (org_id, phone, sent_at) index — no rest
// buckets) run inside ONE REPEATABLE READ, READ ONLY transaction, so both see
// the same rows and the same now(). Live sends cannot race the comparison.
// Run: npx tsx --conditions=react-server scripts/verify-audience-pools.ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { poolCounts, restedCount, type PoolCounts } from "@/lib/audience/pool-math";
import { computeAudiencePools } from "@/lib/audience/pools";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const FIELDS: (keyof PoolCounts)[] = [
  "group_total_eligible",
  "never_received",
  "never_received_rested",
  "received_not_clicked_rested",
  "clickers_non_buyers",
  "clickers_non_buyers_rested",
];
const REST_CHECKS = [0, 7, 30] as const;

async function main() {
  const [{ org_id: orgId }] = (await db.execute(sql`
    SELECT org_id FROM campaigns GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`)) as unknown as {
    org_id: string;
  }[];

  await db.transaction(
    async (tx) => {
      // The rollup alone is ~40s; the recount probes per contact.
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '600s'"));

      console.log("A. computeAudiencePools");
      const t = Date.now();
      const { snapshot, snapshotAt } = await computeAudiencePools(tx, orgId);
      console.log(
        `    ${Date.now() - t}ms at ${snapshotAt}: ${snapshot.groups.length} active groups, ${Object.keys(snapshot.offers).length} offers with sends`,
      );

      const [{ n: eligibleTruth }] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM contacts ct
        WHERE ct.org_id = ${orgId}::uuid AND ct.is_archived = false
          AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.org_id = ${orgId}::uuid AND o.contact_id = ct.id)`)) as unknown as {
        n: number;
      }[];
      const totalEligible = poolCounts(snapshot.base, undefined, "total", 0).group_total_eligible;
      check(
        "totals: group_total_eligible = an independent eligible count",
        totalEligible === Number(eligibleTruth),
        { got: totalEligible, want: eligibleTruth },
      );

      console.log("\nB. invariants over every offer × group × rest_days 0..30");
      let violations = 0;
      let clickerCells = 0;
      let retouchCells = 0;
      const keys = ["total", ...snapshot.groups.map((g) => String(g.id))];
      for (const offer of Object.values(snapshot.offers)) {
        for (const key of keys) {
          const received = restedCount(offer.received[key], 0);
          let prev: PoolCounts | null = null;
          for (let n = 0; n <= 30; n++) {
            const c = poolCounts(snapshot.base, offer, key, n);
            if (c.never_received < 0 || c.never_received_rested < 0) violations++;
            if (c.clickers_non_buyers + restedCount(offer.received_not_clicked[key], 0) > received) violations++;
            if (
              n === 0 &&
              (c.never_received_rested !== c.never_received ||
                c.clickers_non_buyers_rested !== c.clickers_non_buyers)
            ) {
              violations++;
            }
            if (
              prev &&
              (c.never_received_rested > prev.never_received_rested ||
                c.received_not_clicked_rested > prev.received_not_clicked_rested ||
                c.clickers_non_buyers_rested > prev.clickers_non_buyers_rested)
            ) {
              violations++;
            }
            prev = c;
          }
          const at7 = poolCounts(snapshot.base, offer, key, 7);
          if (key !== "total" && at7.clickers_non_buyers > 0) clickerCells++;
          if (key !== "total" && at7.received_not_clicked_rested > 0) retouchCells++;
        }
      }
      check("no negative, over-received, rest_days-0 or monotonicity violation", violations === 0, violations);
      check("control: some offer × group has clickers_non_buyers", clickerCells > 0, clickerCells);
      check("control: some offer × group has received_not_clicked_rested at 7", retouchCells > 0, retouchCells);

      console.log("\nC. independent recount — two offers × two groups × rest_days 0 / 7 / 30");
      const groups = snapshot.groups
        .map((g) => ({ ...g, eligible: restedCount(snapshot.base[String(g.id)], 0) }))
        .filter((g) => g.eligible >= 1_000 && g.eligible <= 60_000)
        .sort((a, b) => b.eligible - a.eligible)
        .slice(0, 2);
      const offers = Object.entries(snapshot.offers)
        .map(([id, o]) => ({ id: Number(id), received: restedCount(o.received.total, 0) }))
        .sort((a, b) => b.received - a.received)
        .slice(0, 2);
      check(
        "control: two mid-size active groups and two offers to recount",
        groups.length === 2 && offers.length === 2,
        { groups, offers },
      );
      let recentSeen = false;
      for (const o of offers) {
        for (const g of groups) {
          const [truth] = (await tx.execute(sql`
            WITH e AS MATERIALIZED (
              SELECT ct.id, ct.phone_number FROM contacts ct
              JOIN contact_contact_groups j ON j.contact_id = ct.id AND j.contact_group_id = ${g.id}
              WHERE ct.org_id = ${orgId}::uuid AND ct.is_archived = false
                AND NOT EXISTS (SELECT 1 FROM opt_outs x WHERE x.org_id = ${orgId}::uuid AND x.contact_id = ct.id)
            ),
            rc AS MATERIALIZED (
              SELECT s.contact_id, bool_or(s.converted_at IS NOT NULL) AS converted
              FROM stage_sends s JOIN campaigns c ON c.id = s.campaign_id
              WHERE s.org_id = ${orgId}::uuid AND c.org_id = ${orgId}::uuid
                AND c.offer_id = ${o.id} AND s.status = 'sent'
              GROUP BY 1
            ),
            ck AS MATERIALIZED (
              SELECT DISTINCT cc.contact_id FROM counted_clickers cc
              JOIN campaigns c ON c.id = cc.campaign_id
              WHERE cc.org_id = ${orgId}::uuid AND c.offer_id = ${o.id}
            ),
            f AS MATERIALIZED (
              SELECT e.id,
                     rc.contact_id IS NOT NULL AS received,
                     coalesce(rc.converted, false) AS converted,
                     ck.contact_id IS NOT NULL AS clicked,
                     NOT EXISTS (SELECT 1 FROM stage_sends s WHERE s.org_id = ${orgId}::uuid AND s.phone = e.phone_number
                                 AND s.contact_id = e.id AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => 0)) AS rested0,
                     NOT EXISTS (SELECT 1 FROM stage_sends s WHERE s.org_id = ${orgId}::uuid AND s.phone = e.phone_number
                                 AND s.contact_id = e.id AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => 7)) AS rested7,
                     NOT EXISTS (SELECT 1 FROM stage_sends s WHERE s.org_id = ${orgId}::uuid AND s.phone = e.phone_number
                                 AND s.contact_id = e.id AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => 30)) AS rested30
              FROM e
              LEFT JOIN rc ON rc.contact_id = e.id
              LEFT JOIN ck ON ck.contact_id = e.id
            )
            SELECT count(*)::int AS eligible,
                   count(*) FILTER (WHERE NOT received)::int AS never_received,
                   count(*) FILTER (WHERE clicked AND NOT converted)::int AS clickers_non_buyers,
                   count(*) FILTER (WHERE NOT received AND rested0)::int AS nr0,
                   count(*) FILTER (WHERE NOT received AND rested7)::int AS nr7,
                   count(*) FILTER (WHERE NOT received AND rested30)::int AS nr30,
                   count(*) FILTER (WHERE received AND NOT clicked AND NOT converted AND rested0)::int AS rt0,
                   count(*) FILTER (WHERE received AND NOT clicked AND NOT converted AND rested7)::int AS rt7,
                   count(*) FILTER (WHERE received AND NOT clicked AND NOT converted AND rested30)::int AS rt30,
                   count(*) FILTER (WHERE clicked AND NOT converted AND rested0)::int AS cb0,
                   count(*) FILTER (WHERE clicked AND NOT converted AND rested7)::int AS cb7,
                   count(*) FILTER (WHERE clicked AND NOT converted AND rested30)::int AS cb30,
                   count(*) FILTER (WHERE NOT rested7)::int AS sent_within_7
            FROM f`)) as unknown as Record<string, number>[];
          if (Number(truth.sent_within_7) > 0) recentSeen = true;
          for (const n of REST_CHECKS) {
            const got = poolCounts(snapshot.base, snapshot.offers[String(o.id)], String(g.id), n);
            const want: PoolCounts = {
              group_total_eligible: Number(truth.eligible),
              never_received: Number(truth.never_received),
              never_received_rested: Number(truth[`nr${n}`]),
              received_not_clicked_rested: Number(truth[`rt${n}`]),
              clickers_non_buyers: Number(truth.clickers_non_buyers),
              clickers_non_buyers_rested: Number(truth[`cb${n}`]),
            };
            check(
              `offer ${o.id} × group "${g.name}" rest_days=${n}: all six counts = the recount`,
              FIELDS.every((f) => got[f] === want[f]),
              { got, want },
            );
          }
        }
      }
      check("control: the recount saw sends inside 7 days (the phone probe works)", recentSeen);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  console.log(failures === 0 ? "\nverify-audience-pools OK." : `\nFAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
