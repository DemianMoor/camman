import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import type { EventMap } from "@/lib/reporting/event-columns";

// THE REAL-READER PROOF for the per-event report columns (Phase 5 Task 4).
//
// ⭐ WHY A THROWAWAY ORG WITH COMMITTED FIXTURES, AND NOT A ROLLED-BACK
// TRANSACTION. getStageMetricsInRange / getPerformanceReport bind the
// MODULE-LEVEL `db` (db/client.ts) and take no `tx`, so a script that seeds
// inside a transaction it later rolls back gives them a world they cannot see —
// every bar would read zero and pass for the wrong reason. The fixtures are
// therefore COMMITTED under a dedicated org whose name carries the marker below,
// and torn down by org_id in a `finally`. Same model as
// scripts/test-recipients-lanes.ts.
//
// ⭐ EVERY BAR BUILDS ITS OWN WORLD. camman-v2 holds zero rows in
// keitaro_stage_results and conversion_events, so "count == 0" passes for the
// wrong reason everywhere. Every number below is seeded by this script and the
// fixtures are ONE-SIDED: the registrations carry no revenue and no purchase
// flag, the manual top-up exists only in stage_manual_sales, and the unmapped
// rows are in no other column — so a bar cannot be satisfied by the field it is
// meant to distinguish its subject from.
//
// ⚠️ `.env.local` IS PRODUCTION. This script WRITES. Run it as:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-report-event-columns-db.ts
// The `_require-preview-db` import above is the refusal; it is an allowlist and
// it runs before db/client is evaluated.

const MARKER = "__P5_EVENT_COLUMNS_TEST__";
// A CLOSED day in the past, so nothing that happens while the test runs can move
// it, and no "today" boundary can make the ET range ambiguous.
const DAY = "2026-05-12";

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const { getPerformanceReport } = await import("@/lib/reporting/performance-report");

  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) {
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } else {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
  const sumRev = (m: EventMap) => Object.values(m).reduce((s, t) => s + t.revenue, 0);
  // ⭐ A MISSING ENTRY IS A SENTINEL, NOT A CRASH. Every bar below reads a key
  // that the mutation it exists to catch would REMOVE, and `m.purchase.n` on a
  // missing key throws a TypeError — which fails the run without ever printing
  // which bar went red. -1 can never be a legitimate count or a revenue here, so
  // the bar reports a wrong number instead of dying.
  const N = (t: { n: number } | undefined) => t?.n ?? -1;
  const R = (t: { revenue: number } | undefined) => t?.revenue ?? -1;

  const tag = `p5-${Date.now()}`;
  let orgId = "";
  let otherOrgId = "";

  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];

  try {
    // ── the world ───────────────────────────────────────────────────────────
    orgId = (
      await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id
      `)
    ).id;
    // A SECOND org, for the cross-organisation stray below. It exists to make one
    // specific hole impossible, and nothing else.
    otherOrgId = (
      await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag} other`}) RETURNING id
      `)
    ).id;

    const evt = async (org: string, key: string, purchase: boolean, revenue: boolean, signal: boolean) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
          VALUES (${org}::uuid, ${key}, ${key}, 10, ${purchase}, ${revenue}, ${signal})
          RETURNING id
        `)
      ).id;
    const purchaseType = await evt(orgId, "purchase", true, true, false);
    const registrationType = await evt(orgId, "registration", false, false, true);
    // ⭐ ANOTHER ORG'S purchase type. conversion_events.event_type_id has a plain
    // FK to event_types.id with no (id, org_id) composite, so a row of THIS org
    // may carry it — and that is the documented residual: the scalar `sales`
    // resolves is_purchase through the NON-org-scoped PURCHASE_EVENT_TYPE_IDS and
    // counts it, while the per-event join is org-scoped and places it under no
    // key. It must therefore land in `unmapped`.
    const foreignPurchaseType = await evt(otherOrgId, "purchase", true, true, false);

    const networkId = (
      await one<{ id: number }>(sql`
        INSERT INTO affiliate_networks (network_id, org_id, name)
        VALUES (${`net-${tag}`}, ${orgId}::uuid, ${"Net"}) RETURNING id
      `)
    ).id;
    const offerId = (
      await one<{ id: number }>(sql`
        INSERT INTO offers (offer_id, org_id, name, network_id)
        VALUES (${`off-${tag}`}, ${orgId}::uuid, ${"Offer"}, ${networkId}) RETURNING id
      `)
    ).id;

    const group = async (name: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO contact_groups (contact_group_id, org_id, name)
          VALUES (${`${name}-${tag}`}, ${orgId}::uuid, ${name}) RETURNING id
        `)
      ).id;
    const g1 = await group("G1");
    const g2 = await group("G2");

    const contact = async (n: number, groups: number[]) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1999${tag.slice(-6)}${n}`})
          RETURNING id
        `)
      ).id;
      for (const g of groups) {
        await db.execute(sql`
          INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
          VALUES (${id}::uuid, ${g}, ${orgId}::uuid)
        `);
      }
      return id;
    };
    const c1 = await contact(1, [g1]);
    const c2 = await contact(2, [g2]);
    const c3 = await contact(3, [g1, g2]);
    const c4 = await contact(4, [g1]);

    const campaignId = (
      await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, offer_id, link_mode, status, audience_contact_group_ids)
        VALUES (${orgId}::uuid, ${`camp-${tag}`}, ${"P5 events"}, ${offerId}, 'tracked', 'active',
                ${sql`ARRAY[${g1}, ${g2}]::integer[]`})
        RETURNING id
      `)
    ).id;

    const stage = async (n: number) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at, sms_count, total_cost)
          VALUES (${orgId}::uuid, ${campaignId}, ${n}, ${`trk-${tag}-s${n}`},
                  ${`${DAY} 12:00`}::timestamp AT TIME ZONE 'America/New_York', 2, 0)
          RETURNING id
        `)
      ).id;
    const stageA = await stage(1);
    const stageB = await stage(2);

    const send = async (stageId: number, contactId: string) =>
      (
        await one<{ id: string }>(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${contactId}::uuid, ${"+1999"}, ${"x"}, 'sent',
                  ${`${DAY} 12:00`}::timestamp AT TIME ZONE 'America/New_York')
          RETURNING id
        `)
      ).id;
    const sendA1 = await send(stageA, c1); // G1 only
    await send(stageA, c2); //                G2 only
    await send(stageB, c3); //                G1 + G2  (½ each)
    await send(stageB, c4); //                G1 only

    // ── the projection rows the stage dimensions read ───────────────────────
    // Stage A: 2 purchases ($50) + 4 REGISTRATIONS ($0, not a sale) + 1 unmapped.
    // Stage B: 1 purchase ($20) + 1 unmapped.
    // Registrations carry no revenue and no purchase flag, so a bar about `sales`
    // cannot be satisfied by them.
    const ksr = async (stageId: number, n: number, sales: number, revenue: string, events: string, unmapped: number) =>
      db.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue, pending_revenue,
           events, unmapped_conversions, cost)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${`trk-${tag}-s${n}`}, ${DAY}::date,
                ${sales}, ${revenue}::numeric, 0, ${events}::jsonb, ${unmapped}, 0)
      `);
    await ksr(
      stageA, 1, 2, "50.0000",
      JSON.stringify({
        purchase: { n: 2, pending_n: 0, revenue: 50.0, pending_revenue: 0 },
        registration: { n: 4, pending_n: 0, revenue: 0, pending_revenue: 0 },
      }),
      1,
    );
    await ksr(
      stageB, 2, 1, "20.0000",
      JSON.stringify({ purchase: { n: 1, pending_n: 0, revenue: 20.0, pending_revenue: 0 } }),
      1,
    );

    // The MANUAL top-up: 5 manual sales on stage A against 2 tracker sales ⇒ a
    // top-up of 3. It exists ONLY here — no ledger row, no events entry — which
    // is precisely why the per-event columns cannot foot without it.
    await db.execute(sql`
      INSERT INTO stage_manual_sales (org_id, campaign_id, stage_id, delta, created_at)
      VALUES (${orgId}::uuid, ${campaignId}, ${stageA}, 5,
              ${`${DAY} 13:00`}::timestamp AT TIME ZONE 'America/New_York')
    `);

    // ── the ledger the HOURLY tab reads (it does not read the projection) ────
    let seq = 0;
    const ledger = async (o: {
      hourEt: string;
      typeId: number | null;
      status: string | null;
      revenue: number;
      stageId: number;
      sendId?: string | null;
      keitaroType: string;
    }) =>
      db.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
           occurred_at, stage_send_id, campaign_id, stage_id, offer_id)
        VALUES (${orgId}::uuid, ${`${tag}-ce-${seq++}`}, ${o.keitaroType}, ${o.keitaroType},
                ${o.typeId}, ${o.status}, ${o.revenue.toFixed(4)}::numeric,
                ${`${DAY} ${o.hourEt}`}::timestamp AT TIME ZONE 'America/New_York',
                ${o.sendId ?? null}::uuid, ${campaignId}, ${o.stageId}, ${offerId})
      `);
    // Hour 14: 3 purchases, 4 registrations, 1 fully-unmapped row. Nothing
    // foreign, so hour 14's `sales` and its purchase breakdown must agree exactly.
    for (let i = 0; i < 3; i++) {
      await ledger({ hourEt: "14:00", typeId: purchaseType, status: "approved", revenue: i === 0 ? 30 : 20, stageId: stageA, sendId: sendA1, keitaroType: "lead" });
    }
    for (let i = 0; i < 4; i++) {
      await ledger({ hourEt: "14:00", typeId: registrationType, status: "approved", revenue: 0, stageId: stageA, keitaroType: "registration" });
    }
    await ledger({ hourEt: "14:00", typeId: null, status: null, revenue: 0, stageId: stageB, keitaroType: "lead" });
    // Hour 9: the cross-org stray, in its OWN hour so it cannot disturb hour 14.
    await ledger({ hourEt: "09:00", typeId: foreignPurchaseType, status: "approved", revenue: 70, stageId: stageB, keitaroType: "lead" });

    // ── the real readers ────────────────────────────────────────────────────
    console.log("getStageMetricsInRange:");
    const { stages, grand } = await getStageMetricsInRange(orgId, DAY, DAY);
    const st = stages.find((s) => s.stage_id === stageA)!;

    check(
      "R1 ⭐ the per-stage tally carries the breakdown from keitaro_stage_results",
      st.tally.events.registration?.n === 4,
      JSON.stringify(st.tally.events),
    );
    check(
      "R2 ⭐ Σ is_purchase n + manual_topup = tally.sales, exactly",
      N(st.tally.events.purchase) + st.manual_topup === st.tally.sales,
      `${N(st.tally.events.purchase)} + ${st.manual_topup} vs ${st.tally.sales}`,
    );
    check(
      "R3 ⭐ Σ per-event revenue = tally.revenue, exactly",
      near(sumRev(st.tally.events), st.tally.revenue),
      `${sumRev(st.tally.events)} vs ${st.tally.revenue}`,
    );
    check(
      "R4 ⭐ the grand tally sums the stage tallies (mergeFunnel)",
      N(grand.events.registration) === stages.reduce((s, x) => s + (x.tally.events.registration?.n ?? 0), 0) &&
        N(grand.events.registration) === 4,
      `${N(grand.events.registration)}`,
    );
    check(
      "R4b ⭐ the grand tally carries the unmapped count too (it is in no other field)",
      grand.unmapped === 2 && stages.reduce((s, x) => s + x.tally.unmapped, 0) === 2,
      `${grand.unmapped}`,
    );

    console.log("\ngetPerformanceReport dimension=offer:");
    const bounds = { from: DAY, to: DAY, providerPhoneId: null };
    const report = await getPerformanceReport(orgId, "offer", bounds);
    const offerRow = report.rows.find((r) => r.key === String(offerId))!;
    check("R5 ⭐ dimension=offer carries the breakdown on the row", N(offerRow.events.purchase) === 3, JSON.stringify(offerRow.events));
    check("R6 ⭐ and on the totals", N(report.totals.events.purchase) === 3, JSON.stringify(report.totals.events));
    check("R7 ⭐ the unmapped count reaches the totals (the badge's source)", report.totals.unmapped === 2, `${report.totals.unmapped}`);
    check(
      "R7b ⭐ …and the row, and the manual top-up with it — the two numbers that explain the gap to Sales",
      offerRow.unmapped === 2 && offerRow.manual_topup === 3 && report.totals.manual_topup === 3,
      `unmapped=${offerRow.unmapped} manual_topup=${offerRow.manual_topup}`,
    );

    console.log("\ngetPerformanceReport dimension=group:");
    const groupReport = await getPerformanceReport(orgId, "group", bounds);
    const groupRows = groupReport.rows;
    check(
      "R8 ⭐ dimension=group SPLITS the breakdown, and the parts sum back to the stage total",
      near(groupRows.reduce((s, r) => s + (r.events.purchase?.n ?? 0), 0), 3),
      groupRows.map((r) => `${r.label}:${r.events.purchase?.n ?? 0}`).join(" "),
    );
    check(
      "R8b ⭐ the split is on SALE weights, not sent: stage A's ledger purchases all resolved to a G1-only recipient",
      (groupRows.find((r) => r.key === String(g1))!.events.purchase?.n ?? 0) > 2,
      groupRows.map((r) => `${r.label}:${r.events.purchase?.n ?? 0}`).join(" "),
    );
    check(
      "R8c ⭐ unmapped and manual_topup survive the By-Group split and sum back",
      near(groupRows.reduce((s, r) => s + r.unmapped, 0), 2) &&
        near(groupRows.reduce((s, r) => s + r.manual_topup, 0), 3),
      groupRows.map((r) => `${r.label}:u${r.unmapped}/m${r.manual_topup}`).join(" "),
    );

    console.log("\ngetPerformanceReport dimension=hourly:");
    const hourly = await getPerformanceReport(orgId, "hourly", bounds);
    const h14 = hourly.rows.find((r) => r.key === "14")!;
    const h9 = hourly.rows.find((r) => r.key === "9")!;
    check(
      "R9 ⭐ dimension=hourly builds the breakdown from the LEDGER, in the same hours as `sales`",
      N(h14.events.purchase) === h14.sales && h14.sales === 3,
      `events ${N(h14?.events?.purchase)} vs sales ${h14?.sales}`,
    );
    check(
      "R9b ⭐ the hourly money follows the same hour, and a registration earns none of it",
      near(R(h14.events.purchase), 70) && N(h14.events.registration) === 4 &&
        near(R(h14.events.registration), 0),
      JSON.stringify(h14.events),
    );
    check("R10 ⭐ the hourly unmapped count is non-zero for the fixture that seeds one", hourly.totals.unmapped === 2, `${hourly.totals.unmapped}`);
    check(
      "R10b ⭐ a CROSS-ORG event type is counted by the scalar and placed under NO key — so it must be in `unmapped`",
      h9.sales === 1 && h9.events.purchase === undefined && h9.unmapped === 1,
      `sales=${h9?.sales} keys=${JSON.stringify(Object.keys(h9?.events ?? {}))} unmapped=${h9?.unmapped}`,
    );
    check(
      "R11 ⭐ a registration is NOT in `sales` on any dimension",
      report.totals.sales === 6 &&
        N(report.totals.events.registration) === 4 &&
        report.totals.sales === N(report.totals.events.purchase) + report.totals.manual_topup &&
        h14.sales === 3 && N(h14.events.registration) === 4,
      `sales=${report.totals.sales} purchase=${N(report.totals.events.purchase)} manual=${report.totals.manual_topup} reg=${N(report.totals.events.registration)}`,
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    // ── teardown: by org_id, and only after re-reading the marker ───────────
    for (const id of [orgId, otherOrgId]) {
      if (!id) continue;
      const row = (await db.execute(sql`
        SELECT name FROM organizations WHERE id = ${id}::uuid
      `)) as unknown as { name: string }[];
      const name = row[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${id} does not carry the test marker (name=${JSON.stringify(name)})`);
        process.exitCode = 1;
        continue;
      }
      // Everything else cascades from organizations.id, except the ledger's
      // SET NULL references — which belong to this org and go with it.
      await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${id}::uuid`);
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}::uuid`);
    }
    const leftovers = (await db.execute(sql`
      SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`%${MARKER}%`}
    `)) as unknown as { n: number }[];
    console.log(`teardown: ${Number(leftovers[0]?.n ?? -1)} marked org(s) left behind (expected 0)`);
    if (Number(leftovers[0]?.n ?? -1) !== 0) process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
