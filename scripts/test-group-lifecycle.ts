import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// CONTACT GROUP × LIFECYCLE BREAKDOWN against the PREVIEW DB.
//
// ⭐ G6 IS THE BAR THE WHOLE TABLE RESTS ON: a cluster is the DISTINCT union of
// its groups, not the sum of their rows. A contact in Weight Loss AND Weight
// Loss Y is ONE person to send to, and the cluster figure is what an operator
// sizes a campaign from — summing would overstate it by exactly the overlap.
// On production the group rows sum to 765,566 against 667,141 distinct, so this
// is a 98,425-contact error waiting to be made.
//
// ⭐ G7 is its counterpart: the per-group rows DO count that contact twice, by
// design, because "how big is this group" is a different question. Both bars
// are needed — either alone is satisfied by a wrong implementation.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-group-lifecycle.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__GROUP_LIFECYCLE_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { getGroupLifecycleBreakdown, getGroupLifecycleRollups } =
    await import("@/lib/reporting/group-lifecycle");
  const { GROUP_CLUSTERS } = await import("@/lib/reporting/group-clusters");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `gl-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    // Two groups from the SAME cluster, so overlap is exercised, plus one
    // outside every cluster.
    const wlCodes = GROUP_CLUSTERS.find((c) => c.key === "weight_loss")!.codes;
    const mkGroup = async (code: string, name: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO contact_groups (org_id, contact_group_id, name)
          VALUES (${org}, ${code}, ${name}) RETURNING id`)
      ).id;
    const gA = await mkGroup(wlCodes[0], `A ${tag}`);
    const gB = await mkGroup(wlCodes[1], `B ${tag}`);
    const gOut = await mkGroup(`zz-${tag}`, `Outside ${tag}`);

    const N = 9;
    const phones = fictionalPhones(N);
    await refuseIfPhonesInUse(db, phones);

    const mk = async (
      i: number,
      status: string,
      opts: {
        archived?: boolean;
        notEligible?: boolean;
        optedOut?: boolean;
      } = {},
    ) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, line_type, lifecycle_status,
                                archived_at, messaging_status)
          VALUES (${org}, ${phones[i]}, ${opts.notEligible ? "landline" : "mobile"},
                  ${status},
                  ${opts.archived ? sql`now()` : sql`NULL::timestamptz`},
                  ${opts.notEligible ? "not_applicable" : "eligible"})
          RETURNING id`)
      ).id;
      if (opts.optedOut) {
        await db.execute(sql`
          INSERT INTO opt_outs (org_id, phone_number, contact_id, source)
          VALUES (${org}, ${phones[i]}, ${id}::uuid, 'inbound')`);
      }
      return id;
    };
    const join = async (cid: string, gid: number) =>
      db.execute(sql`
        INSERT INTO contact_contact_groups (org_id, contact_id, contact_group_id)
        VALUES (${org}, ${cid}::uuid, ${gid})`);

    // 0  cold, in A AND B          — the overlap case
    // 1  cold, in A only
    // 2  hot,  in B only
    // 3  cold, in A, ARCHIVED      — not sendable
    // 4  cold, in A, not eligible  — not sendable
    // 5  cold, in A, opted out     — not sendable
    // 6  cold, in A, in use        — sendable, NOT available
    // 7  freeze, in A, inside cadence — sendable, NOT available
    // 8  cold, in gOut, messaged 1 day ago — sendable, NOT available at N=3
    const c0 = await mk(0, "cold");
    await join(c0, gA);
    await join(c0, gB);
    const c1 = await mk(1, "cold");
    await join(c1, gA);
    const c2 = await mk(2, "hot");
    await join(c2, gB);
    const c3 = await mk(3, "cold", { archived: true });
    await join(c3, gA);
    const c4 = await mk(4, "cold", { notEligible: true });
    await join(c4, gA);
    const c5 = await mk(5, "cold", { optedOut: true });
    await join(c5, gA);
    const c6 = await mk(6, "cold");
    await join(c6, gA);
    const c7 = await mk(7, "freeze");
    await join(c7, gA);
    const c8 = await mk(8, "cold");
    await join(c8, gOut);

    // c6 is in an ACTIVE campaign's pool.
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id)
      VALUES (${org}, ${`c-${tag}`}, ${`C ${tag}`}, 'active', 'manual', ${brand.id})
      RETURNING id`);
    await db.execute(sql`
      INSERT INTO campaign_audience_pool (campaign_id, contact_id, org_id)
      VALUES (${camp.id}, ${c6}::uuid, ${org})`);

    // c7 froze and was messaged 2 days ago with a 14-day cadence → not due.
    // c8 was messaged 1 day ago → inside the default 3-day rest window.
    const eng = async (cid: string, status: string, daysAgo: number, cadence: number) =>
      db.execute(sql`
        INSERT INTO contact_engagement
          (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
           msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, freeze_cadence_days, thresholds)
        VALUES (${cid}::uuid, ${org}, ${status}, now(), 5, 5, 0, 0, 0, 0,
                now() - make_interval(days => ${daysAgo}::int), ${cadence}, '{}'::jsonb)`);
    await eng(c7, "freeze", 2, 14);
    await eng(c8, "cold", 1, 14);

    const t = await getGroupLifecycleBreakdown({ orgId, recentDays: 3 });
    const r = await getGroupLifecycleRollups({ orgId, recentDays: 3 });
    const row = (gid: number) => t.groups.find((g) => g.group_id === gid)!;
    const A = row(gA);
    const B = row(gB);
    const OUT = row(gOut);

    console.log("PART G — sendable and available today");
    bar(
      "G1 sendable excludes archived, not-eligible and opted-out contacts",
      A.by_status.cold.sendable === 3,
      `A cold sendable ${A.by_status.cold.sendable}, expected 3 — c0, c1, c6; c3 archived, c4 not eligible, c5 opted out`,
    );
    bar(
      "G2 ⭐ a contact in an ACTIVE campaign is sendable but NOT available",
      A.by_status.cold.available === 2,
      `A cold available ${A.by_status.cold.available}, expected 2 (c0, c1 — c6 is in use)`,
    );
    bar(
      "G3 ⭐ a Freeze contact inside its cadence is sendable but NOT available",
      A.by_status.freeze.sendable === 1 && A.by_status.freeze.available === 0,
      `A freeze ${A.by_status.freeze.available}/${A.by_status.freeze.sendable}`,
    );
    bar(
      "G4 ⭐ someone messaged inside the rest window is sendable but NOT available",
      OUT.by_status.cold.sendable === 1 && OUT.by_status.cold.available === 0,
      `outside-group cold ${OUT.by_status.cold.available}/${OUT.by_status.cold.sendable} at N=3`,
    );
    const wide = await getGroupLifecycleBreakdown({ orgId, recentDays: 1 });
    const OUT1 = wide.groups.find((g) => g.group_id === gOut)!;
    bar(
      "G5 …and N is what decides it: at N=1 the same contact IS available",
      OUT1.by_status.cold.available === 1,
      `at N=1 → ${OUT1.by_status.cold.available}/${OUT1.by_status.cold.sendable}`,
    );

    console.log("\nPART H — counting a contact in several groups");
    const wl = r.clusters.find((c) => c.key === "weight_loss")!;
    bar(
      "H1 ⭐ the cluster counts the overlapping contact ONCE",
      wl.by_status.cold.sendable === 3,
      `Weight Loss cold sendable ${wl.by_status.cold.sendable}, expected 3 (c0, c1, c6 — c0 only once)`,
    );
    bar(
      "H2 ⭐ …while the GROUP rows count it in each, which is the point of the footer",
      A.by_status.cold.sendable + B.by_status.cold.sendable === 4,
      `A ${A.by_status.cold.sendable} + B ${B.by_status.cold.sendable} = 4 for 3 people`,
    );
    bar(
      "H3 the distinct total counts every contact once across all groups",
      r.distinct_total.by_status.cold.sendable === 4,
      `${r.distinct_total.by_status.cold.sendable}, expected 4 (c0, c1, c6, c8)`,
    );
    bar(
      "H4 a group outside every cluster is still reported",
      OUT.total.sendable === 1 && !OUT.clustered,
      `${OUT.label}: sendable ${OUT.total.sendable}, clustered ${OUT.clustered}`,
    );
    bar(
      "H5 …and is excluded from the cluster rows",
      wl.by_status.cold.sendable === 3,
      "the outside group's contact is not in Weight Loss",
    );

    console.log("\nPART J — the shape");
    bar(
      "J1 every active group appears, even with nothing sendable",
      t.groups.length === 3,
      `${t.groups.length} group rows`,
    );
    bar(
      "J2 a cluster with no matching groups is still a row, at zero",
      r.clusters.length === GROUP_CLUSTERS.length &&
        r.clusters.some((c) => c.total.sendable === 0),
      `${r.clusters.length} cluster rows`,
    );
    bar(
      "J3 totals are the sum of the statuses on the same row",
      A.total.sendable ===
        Object.values(A.by_status).reduce((a, p) => a + p.sendable, 0),
    );
  } finally {
    if (orgId) {
      const name =
        (
          await all<{ name: string }>(
            sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`,
          )
        )[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_groups WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM opt_outs WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
