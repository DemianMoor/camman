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
// ⭐ M IS THE BAR FOR THE 2026-11-13 SINGLE-PASS REWRITE: for the fixture org
// and every org on the preview DB with memberships, the frozen two-pass compute
// (scripts/_legacy-group-lifecycle.ts) and the new one — and the rows the new
// refresh actually stores — are diffed row by row inside ONE REPEATABLE READ
// snapshot (so now() and the in-use set cannot move between them), then rolled
// back. O pins the button's lease semantics (reuse / in progress / recompute);
// N pins the wiring (GET writes nothing, the engagement cron no longer refreshes
// the table, the hourly cron is scheduled, tokens cannot POST the refresh).
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-group-lifecycle.ts

import { readFileSync } from "node:fs";

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
  const { computeGroupLifecycle } = await import("@/lib/reporting/group-lifecycle");
  const {
    refreshGroupLifecycleRollup,
    readStoredGroupLifecycle,
    refreshGroupLifecycleOnDemand,
    groupLifecycleLeaseKey,
    rollupRowsOf,
  } = await import("@/lib/reporting/group-lifecycle-store");
  const { legacyGroupLifecycleRows } = await import("./_legacy-group-lifecycle");
  const { GROUP_CLUSTERS } = await import("@/lib/reporting/group-clusters");
  const compute = (orgId: string, recentDays: number) =>
    db.transaction((tx) =>
      computeGroupLifecycle(tx, { orgId, recentDays, deadline: Date.now() + 60_000 }),
    );
  const refreshStored = (orgId: string) =>
    db.transaction((tx) =>
      refreshGroupLifecycleRollup(tx, { orgId, deadline: Date.now() + 60_000 }),
    );
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
          INSERT INTO contact_groups (org_id, contact_group_id, name, allow_voip, allow_unknown, allow_toll_free)
          VALUES (${org}, ${code}, ${name}, true, true, true) RETURNING id`)
      ).id;
    const gA = await mkGroup(wlCodes[0], `A ${tag}`);
    const gB = await mkGroup(wlCodes[1], `B ${tag}`);
    const gOut = await mkGroup(`zz-${tag}`, `Outside ${tag}`);

    const N = 10;
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
    // ⚠️ Group B ends up with one hot (c2) AND one warm (c9), so the separate
    // Hot and Warm columns are each exercised on a real 1 — a bar over 0 and 0
    // proves only that the code did not crash, and could not tell the two apart.
    const c9 = await mk(9, "warm");
    await join(c9, gB);

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

    const t = await compute(orgId, 3);
    const r = t; // grid, clusters and distinct total come from ONE pass now
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
    const wide = await compute(orgId, 1);
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
    // ── PART K — the stored table (migration 0193) ─────────────────────────
    console.log("\nPART K — the stored table");
    const written = await refreshStored(orgId);
    const stored = await readStoredGroupLifecycle({ orgId });
    const sA = stored.groups.find((g) => g.group_id === gA)!;
    bar(
      "K1 ⭐ the stored table reproduces the computed one, cell for cell",
      JSON.stringify(sA.by_status) === JSON.stringify(A.by_status) &&
        JSON.stringify(stored.distinct_total.by_status) ===
          JSON.stringify(r.distinct_total.by_status),
      `${written.rows} rows written in ${written.durationMs} ms`,
    );
    bar(
      "K2 …including the cluster rows, which cannot be recovered by summing",
      JSON.stringify(
        stored.clusters.find((c) => c.key === "weight_loss")!.by_status,
      ) === JSON.stringify(wl.by_status),
    );
    bar(
      "K3 the read reports WHEN it was computed and that it is not live",
      stored.computed_at !== null && stored.live === false,
      `computed_at=${stored.computed_at}, live=${stored.live}`,
    );
    bar(
      "K4 …and which N the stored numbers answer for",
      stored.recent_days === 3,
      `recent_days=${stored.recent_days}`,
    );
    // ⭐ A refresh must REMOVE rows that should no longer exist. An upsert
    // leaves an archived group's row in the table, reported as real forever.
    await db.execute(sql`
      UPDATE contact_groups SET archived_at = now() WHERE id = ${gOut}`);
    await refreshStored(orgId);
    const after = await readStoredGroupLifecycle({ orgId });
    const leftover = (await all<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM group_lifecycle_rollup
      WHERE org_id = ${org} AND row_kind = 'group' AND row_key = ${String(gOut)}`))[0];
    bar(
      "K5 ⭐ a refresh DELETES rows for a group that is now archived",
      Number(leftover.n) === 0 &&
        !after.groups.some((g) => g.group_id === gOut),
      `${leftover.n} stale row(s) left for the archived group`,
    );
    bar(
      "K6 the stored read is fast — it reads rows, not joins",
      after.computed_ms < 500,
      `${after.computed_ms} ms`,
    );

    // K7: the refresh is ONE transaction, so a reader on another connection
    // sees the old rows while it runs — never the empty table that the old
    // autocommitted DELETE-then-INSERT exposed between its two statements.
    {
      const before = Number((await one<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM group_lifecycle_rollup WHERE org_id = ${org}`)).n);
      let seenMid = -1;
      await db.transaction(async (tx) => {
        await refreshGroupLifecycleRollup(tx, { orgId, deadline: Date.now() + 60_000 });
        // `db` is the pool: a different connection, outside this transaction.
        seenMid = Number((await one<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM group_lifecycle_rollup WHERE org_id = ${org}`)).n);
      });
      bar(
        "K7 ⭐ a reader during a refresh sees the old rows, not an empty table",
        before > 0 && seenMid === before,
        `before ${before}, seen mid-refresh from another connection ${seenMid}`,
      );
    }

    // ── PART M — identity with the frozen two-pass compute ──────────────────
    console.log("\nPART M — single pass == the frozen two-pass compute, one snapshot");
    const realOrgs = (await all<{ id: string; name: string }>(sql`
      SELECT o.id::text AS id, o.name FROM organizations o
      WHERE EXISTS (SELECT 1 FROM contact_contact_groups g WHERE g.org_id = o.id)
        AND o.id <> ${org}
      ORDER BY o.name`));
    class Rollback extends Error {}
    const key = (r: { row_kind: string; row_key: string; status: string }) =>
      `${r.row_kind}|${r.row_key}|${r.status}`;
    for (const o of [{ id: orgId, name: "fixture" }, ...realOrgs]) {
      let legacy: Awaited<ReturnType<typeof legacyGroupLifecycleRows>> = [];
      let fresh: ReturnType<typeof rollupRowsOf> = [];
      let stored: { row_kind: string; row_key: string; status: string; sendable: number; available: number }[] = [];
      let nowStable = false;
      const ms = { legacy: 0, single: 0 };
      try {
        await db.transaction(
          async (tx) => {
            const [n0] = (await tx.execute(sql`SELECT now()::text AS t`)) as unknown as { t: string }[];
            let t0 = Date.now();
            legacy = await legacyGroupLifecycleRows(tx, o.id, 3);
            ms.legacy = Date.now() - t0;
            t0 = Date.now();
            fresh = rollupRowsOf(
              await computeGroupLifecycle(tx, { orgId: o.id, recentDays: 3, deadline: Date.now() + 60_000 }),
            );
            ms.single = Date.now() - t0;
            // …and what the refresh actually WRITES, read back in the same snapshot.
            await refreshGroupLifecycleRollup(tx, { orgId: o.id, deadline: Date.now() + 60_000 });
            stored = (await tx.execute(sql`
              SELECT row_kind, row_key, status, sendable, available
              FROM group_lifecycle_rollup WHERE org_id = ${o.id}::uuid`)) as unknown as typeof stored;
            const [n1] = (await tx.execute(sql`SELECT now()::text AS t`)) as unknown as { t: string }[];
            nowStable = n0.t === n1.t;
            throw new Rollback();
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      const lm = new Map(legacy.map((r) => [key(r), r]));
      const sm = new Map(stored.map((r) => [key(r), r]));
      const cell = (a?: { sendable: number; available: number }, b?: { sendable: number; available: number }) =>
        !!a && !!b && Number(a.sendable) === Number(b.sendable) && Number(a.available) === Number(b.available);
      const freshDiff =
        legacy.length !== fresh.length ||
        fresh.some((r, i) => key(r) !== key(legacy[i]) || !cell(r, legacy[i]));
      const storedDiffs = [...lm.keys()].filter((k) => !cell(lm.get(k), sm.get(k))).length +
        [...sm.keys()].filter((k) => !lm.has(k)).length;
      const nonTrivial = legacy.some((r) => r.sendable > 0);
      bar(
        `M1 ⭐ ${o.name}: single pass == two-pass, row for row and in order`,
        !freshDiff && nonTrivial,
        `${legacy.length} legacy rows vs ${fresh.length} single-pass rows; any sendable > 0: ${nonTrivial}; legacy ${ms.legacy} ms, single ${ms.single} ms`,
      );
      bar(
        `M2 ⭐ ${o.name}: the rows the refresh STORES == the two-pass rows`,
        storedDiffs === 0 && stored.length === legacy.length,
        `${stored.length} stored vs ${legacy.length} legacy, ${storedDiffs} differing`,
      );
      bar(`M3 ${o.name}: now() did not move inside the snapshot`, nowStable);
    }

    // ── PART O — the button: reuse, in progress, recompute ──────────────────
    console.log("\nPART O — on-demand refresh and the shared lease");
    const lease = groupLifecycleLeaseKey(orgId);
    try {
      const o1 = await refreshGroupLifecycleOnDemand({ orgId });
      bar(
        "O1 ⭐ a run that finished < 2 min ago is REUSED, not recomputed",
        o1.outcome === "reused",
        `outcome=${o1.outcome}`,
      );
      // Age the stored run past the reuse window, then hold the lease as the
      // cron would.
      await db.execute(sql`
        UPDATE group_lifecycle_rollup SET computed_at = computed_at - interval '5 minutes'
        WHERE org_id = ${org}`);
      const aged = (await readStoredGroupLifecycle({ orgId })).computed_at;
      await db.execute(sql`
        INSERT INTO cron_locks (job_name, lease_until) VALUES (${lease}, now() + interval '1 minute')
        ON CONFLICT (job_name) DO UPDATE SET lease_until = EXCLUDED.lease_until`);
      const o2 = await refreshGroupLifecycleOnDemand({ orgId });
      const afterHeld = (await readStoredGroupLifecycle({ orgId })).computed_at;
      bar(
        "O2 ⭐ while the lease is held, nothing starts: in_progress + the current computed_at",
        o2.outcome === "in_progress" && o2.computed_at === aged && afterHeld === aged,
        `outcome=${o2.outcome}, returned ${o2.computed_at}, stored ${afterHeld}`,
      );
      await db.execute(sql`UPDATE cron_locks SET lease_until = NULL WHERE job_name = ${lease}`);
      const o3 = await refreshGroupLifecycleOnDemand({ orgId });
      const leaseAfter = (await one<{ lease_until: string | null }>(sql`
        SELECT lease_until::text AS lease_until FROM cron_locks WHERE job_name = ${lease}`)).lease_until;
      bar(
        "O3 ⭐ lease free + stale ⇒ recomputed, computed_at advances, lease released",
        o3.outcome === "recomputed" &&
          o3.computed_at !== null && o3.computed_at !== aged && leaseAfter === null,
        `outcome=${o3.outcome}, computed_at ${aged} → ${o3.outcome === "in_progress" ? "-" : o3.computed_at}, lease_until=${leaseAfter}`,
      );
      bar(
        "O4 the recomputed table is the same table",
        o3.outcome === "recomputed" &&
          JSON.stringify(o3.distinct_total.by_status) === JSON.stringify(after.distinct_total.by_status),
      );
    } finally {
      await db.execute(sql`DELETE FROM cron_locks WHERE job_name = ${lease}`);
    }

    // ── PART N — the wiring ─────────────────────────────────────────────────
    console.log("\nPART N — wiring");
    const src = (f: string) => readFileSync(f, "utf8");
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const getRoute = stripComments(src("app/api/reports/group-lifecycle/route.ts"));
    bar(
      "N1 the GET route writes nothing (no refresh path, no store writer)",
      !/refresh\s*=|searchParams\.get\("refresh"\)|refreshGroupLifecycle/.test(getRoute) &&
        !/export async function POST/.test(getRoute),
    );
    bar(
      "N2 the engagement cron no longer refreshes the table",
      !src("app/api/cron/refresh-contact-engagement/route.ts").includes("refreshGroupLifecycleRollup"),
    );
    bar(
      "N3 the hourly cron is scheduled at :13",
      /"path": "\/api\/cron\/refresh-group-lifecycle",\s*"schedule": "13 \* \* \* \*"/.test(src("vercel.json")),
    );
    const { OPERATOR_ROUTE_MAP } = await import("@/lib/authz/route-map");
    const refreshAccess = OPERATOR_ROUTE_MAP["reports/group-lifecycle/refresh"];
    bar(
      "N4 operators may POST the refresh; API tokens may not (owner decision pending)",
      !!refreshAccess && refreshAccess.methods.includes("POST") && !refreshAccess.token?.length &&
        JSON.stringify(OPERATOR_ROUTE_MAP["reports/group-lifecycle"]?.token) === '["GET"]',
      JSON.stringify(refreshAccess),
    );
    const { HEARTBEAT_JOBS } = await import("@/lib/reporting/cron-heartbeat");
    bar(
      "N5 the rollup heartbeat tolerates two missed hourly runs",
      HEARTBEAT_JOBS.contactEngagementGroupRollup.max_age_hours === 2.5,
    );

    // ── PART L — the displayed columns ──────────────────────────────────────
    console.log("\nPART L - the displayed columns");
    const { GROUP_LIFECYCLE_COLUMNS, columnPair, GROUP_LIFECYCLE_STATUSES: STS } =
      await import("@/lib/reporting/group-lifecycle-types");
    const covered = GROUP_LIFECYCLE_COLUMNS.flatMap((c) => [...c.statuses]);
    bar(
      "L1 the columns PARTITION the statuses - each exactly once",
      covered.length === new Set(covered).size &&
        STS.every((st) => covered.includes(st)) &&
        covered.every((st) => (STS as readonly string[]).includes(st)),
      `columns cover [${covered.join(", ")}] against [${STS.join(", ")}]`,
    );
    bar(
      "L2 ...so the visible columns still sum to the Total column",
      GROUP_LIFECYCLE_COLUMNS.reduce(
        (a, c) => a + columnPair(A.by_status, c).sendable,
        0,
      ) === A.total.sendable,
      `${GROUP_LIFECYCLE_COLUMNS.reduce((a, c) => a + columnPair(A.by_status, c).sendable, 0)} vs total ${A.total.sendable}`,
    );
    const hotCol = GROUP_LIFECYCLE_COLUMNS.find((c) => c.key === "hot")!;
    const warmCol = GROUP_LIFECYCLE_COLUMNS.find((c) => c.key === "warm")!;
    const hotB = columnPair(B.by_status, hotCol);
    const warmB = columnPair(B.by_status, warmCol);
    bar(
      "L3 ⭐ Hot and Warm are SEPARATE columns, each its own status on both halves of the cell",
      hotCol.statuses.join() === "hot" &&
        warmCol.statuses.join() === "warm" &&
        !GROUP_LIFECYCLE_COLUMNS.some((c) => c.statuses.includes("hot") && c.statuses.includes("warm")) &&
        hotB.sendable === 1 && warmB.sendable === 1 &&
        hotB.sendable === B.by_status.hot.sendable &&
        warmB.sendable === B.by_status.warm.sendable &&
        hotB.available === B.by_status.hot.available &&
        warmB.available === B.by_status.warm.available,
      `group B: Hot ${hotB.sendable} sendable (${hotB.available} available), Warm ${warmB.sendable} (${warmB.available})`,
    );
    // Summing statuses (the Total column, the cluster rows) is only safe
    // because they are disjoint - a contact has exactly ONE lifecycle_status.
    // If that ever stopped holding, Total would double-count and this bar is
    // where it would show.
    bar(
      "L4 the status sets are DISJOINT, which is what makes summing safe",
      (
        await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM (
            SELECT contact_id FROM contact_contact_groups ccg
            JOIN contacts c ON c.id = ccg.contact_id
            WHERE ccg.org_id = ${org}
            GROUP BY contact_id
            HAVING count(DISTINCT c.lifecycle_status) > 1
          ) x`)
      ).n === 0,
      "no contact carries two lifecycle statuses",
    );
    bar(
      "L5 the order is the one the owner asked for",
      GROUP_LIFECYCLE_COLUMNS.map((c) => c.key).join(",") ===
        "new,hot,warm,cold,freeze,suppressed",
      GROUP_LIFECYCLE_COLUMNS.map((c) => c.label).join(" | "),
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
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM group_lifecycle_rollup WHERE org_id = ${orgId}::uuid)) AS n`);
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
