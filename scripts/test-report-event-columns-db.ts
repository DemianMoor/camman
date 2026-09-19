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
// ⭐ A SECOND CLOSED DAY, DELIBERATELY OUTSIDE EVERY R BAR'S RANGE. The R bars
// call the readers with from = to = DAY, which filter on stat_date, so the rows
// below are invisible to them — while the campaign page's stage aggregate has NO
// date filter at all (it is keyed on campaign_id) and sees both days. That is
// what makes K1/K3 a SUM across a stage's days rather than a restatement of one
// row, and it is why adding these fixtures cannot move R1-R14.
const DAY2 = "2026-05-13";

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const { getPerformanceReport } = await import("@/lib/reporting/performance-report");
  const { getStageKeitaroTotals } = await import("@/lib/reporting/stage-keitaro-aggregate");

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
  // EXACT equality, for figures no code path rounds: the stage dimensions carry
  // the projection's own numbers through addition only, and a double adds
  // 50.0000 + 20.0000 exactly. 1e-6 here is slack against nothing.
  const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
  // ⚠️ THE By-Group SPLIT IS ROUNDED, SO ITS TOLERANCE IS NOT A FUDGE FACTOR — it
  // is the rounding, stated. distributeToGroups() round2()s every field of every
  // group row (lib/reporting/performance-report.ts), so Σ rows can differ from
  // the whole by up to half a cent PER ROW, in either direction. A 1e-6 epsilon
  // over those sums passed only because this fixture's shares happen to land on
  // exact hundredths; three groups splitting one purchase 1/3 each would have
  // failed it while nothing was wrong. What is guaranteed is agreement WITHIN THE
  // ROUNDING — never exactness — and that is what these bars assert.
  const ROUND2_HALF = 0.005;
  const nearRounded = (a: number, b: number, rows: number) =>
    Math.abs(a - b) <= ROUND2_HALF * rows + 1e-9;
  const sumRev = (m: EventMap | undefined) =>
    Object.values(m ?? {}).reduce((s, t) => s + t.revenue, 0);
  // ⭐ A MISSING ENTRY IS A SENTINEL, NOT A CRASH — AND SO IS A MISSING MAP.
  // Every bar below reads a key that the mutation it exists to catch would
  // REMOVE, and `m.purchase.n` on a missing key throws a TypeError — which fails
  // the run without ever printing which bar went red. The map ITSELF is just as
  // droppable (deleting `events` from a metrics object is the obvious red proof
  // for "the breakdown is carried"), and `row.events.purchase` then throws one
  // level earlier, so these take the MAP and the key rather than an entry: a
  // red proof prints a wrong number instead of a stack trace. -1 can never be a
  // legitimate count or a revenue here.
  const N = (m: EventMap | undefined, k: string) => m?.[k]?.n ?? -1;
  /** …but a SUM over rows needs the zero, not the sentinel: one -1 would poison it. */
  const N0 = (m: EventMap | undefined, k: string) => m?.[k]?.n ?? 0;
  const R = (m: EventMap | undefined, k: string) => m?.[k]?.revenue ?? -1;
  const PR = (m: EventMap | undefined, k: string) => m?.[k]?.pending_revenue ?? -1;
  const sumPending = (m: EventMap | undefined) =>
    Object.values(m ?? {}).reduce((s, t) => s + t.pending_revenue, 0);

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

    const stage = async (n: number, day = DAY) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at, sms_count, total_cost)
          VALUES (${orgId}::uuid, ${campaignId}, ${n}, ${`trk-${tag}-s${n}`},
                  ${`${day} 12:00`}::timestamp AT TIME ZONE 'America/New_York', 2, 0)
          RETURNING id
        `)
      ).id;
    const stageA = await stage(1);
    const stageB = await stage(2);
    // ⭐ A STAGE WITH CLICKS AND NO CONVERSIONS — the ordinary case, and the one
    // the aggregate's shape exists to protect. Sent on DAY2 so it is outside the
    // R bars' cohort as well as outside their stat_date range.
    const stageClicksOnly = await stage(3, DAY2);

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
    const ksr = async (
      stageId: number,
      n: number,
      sales: number,
      revenue: string,
      events: string,
      unmapped: number,
      // Defaults reproduce the pre-Task-6 fixture exactly, so every row written
      // before this parameter existed is byte-for-byte the row it was.
      o: { date?: string; pendingRevenue?: string; visitsRaw?: number; visitsClean?: number } = {},
    ) =>
      db.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue, pending_revenue,
           visit_clicks_raw, visit_clicks_clean, events, unmapped_conversions, cost)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${`trk-${tag}-s${n}`}, ${o.date ?? DAY}::date,
                ${sales}, ${revenue}::numeric, ${o.pendingRevenue ?? "0"}::numeric,
                ${o.visitsRaw ?? 0}, ${o.visitsClean ?? 0},
                ${events}::jsonb, ${unmapped}, 0)
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
    // ── ⭐ A SECOND DAY FOR STAGE A, for the campaign page's aggregate ───────
    // The same event key again (3 more purchases) and 2 more unmapped rows, on
    // DAY2. Nothing in the R bars' window changes; the stage aggregate must
    // report 5 and 3, which it can only do by SUMMING a jsonb object across
    // rows. A one-day fixture would pass against an aggregate that simply picked
    // one row's object.
    await ksr(
      stageA, 1, 3, "0.0000",
      JSON.stringify({ purchase: { n: 3, pending_n: 0, revenue: 0, pending_revenue: 0 } }),
      2,
      { date: DAY2 },
    );
    // ── ⭐ CLICKS, HELD MONEY, AND NO CONVERSIONS AT ALL ─────────────────────
    // ONE-SIDED: `events` is '{}' and unmapped is 0 while the visit columns and
    // pending_revenue are non-zero, so a row that vanishes from the aggregate
    // (jsonb_each('{}') yields NO rows) takes REAL figures with it. $41.5000 is
    // held money nothing else in this fixture carries on the projection, so K4
    // cannot be satisfied by another row's pending_revenue.
    await ksr(stageClicksOnly, 3, 0, "0.0000", "{}", 0, {
      date: DAY2,
      pendingRevenue: "41.5000",
      visitsRaw: 90,
      visitsClean: 11,
    });
    // ── ⭐ TWO MALFORMED ROWS, FOR THE TWO GUARD LEVELS (K6, K7) ─────────────
    //
    // `events` is jsonb NOT NULL DEFAULT '{}' with NO CHECK constraint (0185),
    // so both object-ness and number-ness are conventions of the writer. Each
    // failure kills the STATEMENT, not the row — which on this query means
    // every stage on the campaign page reads nothing:
    //
    //   stageBadObject — a jsonb scalar. jsonb_each raises 22023.
    //   stageBadValue  — a well-formed OBJECT holding rotten values. The
    //                    top-level guard waves it through and the numeric cast
    //                    raises 22P02 (measured on camman-v2).
    //
    // Both sit on DAY2, on their OWN stages, so nothing the R bars read moves.
    // The second row is MIXED on purpose: a good entry beside the rotten ones,
    // so "it survived by returning nothing" fails.
    const stageBadObject = await stage(4, DAY2);
    const stageBadValue = await stage(5, DAY2);
    await ksr(stageBadObject, 4, 0, "0.0000", '"not an object"', 0, { date: DAY2 });
    await ksr(
      stageBadValue, 5, 0, "0.0000",
      JSON.stringify({
        purchase: { n: 4, pending_n: 0, revenue: 0, pending_revenue: 0 },
        bare_string_entry: "not an object",
        word_count: { n: "abc", pending_n: 0, revenue: "xyz", pending_revenue: 0 },
      }),
      0,
      { date: DAY2 },
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
    // ── Hour 16: HELD money and NOTHING ELSE ────────────────────────────────
    // Two PENDING purchases, $25 + $15, and no approved conversion anywhere in
    // the hour. ONE-SIDED on purpose: the hour's approved `revenue` is 0, so a
    // bar that reads $40 out of it cannot be satisfied by revenue leaking across
    // the status boundary, and a `pending_revenue` that reads 0 is unambiguously
    // the not-computed sentinel rather than a measurement.
    await ledger({ hourEt: "16:00", typeId: purchaseType, status: "pending", revenue: 25, stageId: stageA, sendId: sendA1, keitaroType: "lead" });
    await ledger({ hourEt: "16:00", typeId: purchaseType, status: "pending", revenue: 15, stageId: stageA, sendId: sendA1, keitaroType: "lead" });
    // ── Hour 11: a REJECTED purchase, alone ─────────────────────────────────
    // It counts as NOTHING — not a sale, not revenue, not pending, not unmapped
    // (it has a key and a status) — so its (hour, key) group is all zeros. The
    // stage-day projection FILTERs such an entry out of its jsonb; the hourly
    // path must too, or hourly shows a column of zeros where By Offer shows none.
    await ledger({ hourEt: "11:00", typeId: purchaseType, status: "rejected", revenue: 99, stageId: stageA, sendId: sendA1, keitaroType: "rejected" });

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
      N(st.tally.events, "purchase") + st.tally.manual_topup === st.tally.sales,
      `${N(st.tally.events, "purchase")} + ${st.tally.manual_topup} vs ${st.tally.sales}`,
    );
    check(
      "R3 ⭐ Σ per-event revenue = tally.revenue, exactly",
      near(sumRev(st.tally.events), st.tally.revenue),
      `${sumRev(st.tally.events)} vs ${st.tally.revenue}`,
    );
    check(
      "R4 ⭐ the grand tally sums the stage tallies (mergeFunnel)",
      N(grand.events, "registration") === stages.reduce((s, x) => s + N0(x.tally.events, "registration"), 0) &&
        N(grand.events, "registration") === 4,
      `${N(grand.events, "registration")}`,
    );
    check(
      "R4b ⭐ the grand tally carries the unmapped count too (it is in no other field)",
      grand.unmapped === 2 && stages.reduce((s, x) => s + x.tally.unmapped, 0) === 2,
      `${grand.unmapped}`,
    );
    // ── ⭐ R12: THE THIRD TERM, AT THE GRAIN THE OVERVIEW TAB EMITS ──────────
    //
    // manual_topup is a field of the TALLY (lib/keitaro/funnel.ts), so it rides
    // mergeFunnel and withFunnelDerived's spread exactly like `events` and
    // `unmapped`. It used to be a sibling field on StageMetrics, which meant
    // /api/keitaro/reports had to re-roll it by hand at three grains and nothing
    // failed if one was missed — this is the bar that would have failed.
    //
    // NON-ZERO IS HALF THE BAR. A `0 === 0` here would pass on a database with
    // no manual tally at all, which is most of them; the fixture seeds a top-up
    // of 3 precisely so the assertion has something to lose.
    check(
      "R12 ⭐ the grand tally carries manual_topup, it sums the stages, and it is NON-ZERO for the fixture that seeds a manual tally",
      grand.manual_topup === 3 &&
        stages.reduce((s, x) => s + x.tally.manual_topup, 0) === 3,
      `grand=${grand.manual_topup} Σstages=${stages.reduce((s, x) => s + x.tally.manual_topup, 0)}`,
    );
    check(
      "R12b ⭐ …so the breakdown foots on the GRAND tally: Σ (is_purchase) n + manual_topup = sales, with 2 strays in neither",
      N(grand.events, "purchase") + grand.manual_topup === grand.sales &&
        N(grand.events, "purchase") === 3 &&
        grand.sales === 6 &&
        grand.unmapped === 2,
      `Σn=${N(grand.events, "purchase")} topup=${grand.manual_topup} sales=${grand.sales} unmapped=${grand.unmapped}`,
    );

    console.log("\ngetPerformanceReport dimension=offer:");
    const bounds = { from: DAY, to: DAY, providerPhoneId: null };
    const report = await getPerformanceReport(orgId, "offer", bounds);
    const offerRow = report.rows.find((r) => r.key === String(offerId))!;
    check("R5 ⭐ dimension=offer carries the breakdown on the row", N(offerRow.events, "purchase") === 3, JSON.stringify(offerRow.events));
    check("R6 ⭐ and on the totals", N(report.totals.events, "purchase") === 3, JSON.stringify(report.totals.events));
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
      "R8 ⭐ dimension=group SPLITS the breakdown, and the parts sum back to the stage total — within the split's own 2-decimal rounding",
      nearRounded(groupRows.reduce((s, r) => s + N0(r.events, "purchase"), 0), 3, groupRows.length),
      groupRows.map((r) => `${r.label}:${N0(r.events, "purchase")}`).join(" "),
    );
    check(
      "R8b ⭐ the split is on SALE weights, not sent: stage A's ledger purchases all resolved to a G1-only recipient",
      N0(groupRows.find((r) => r.key === String(g1))?.events, "purchase") > 2,
      groupRows.map((r) => `${r.label}:${N0(r.events, "purchase")}`).join(" "),
    );
    check(
      "R8c ⭐ unmapped and manual_topup survive the By-Group split and sum back (same rounding tolerance)",
      nearRounded(groupRows.reduce((s, r) => s + r.unmapped, 0), 2, groupRows.length) &&
        nearRounded(groupRows.reduce((s, r) => s + r.manual_topup, 0), 3, groupRows.length),
      groupRows.map((r) => `${r.label}:u${r.unmapped}/m${r.manual_topup}`).join(" "),
    );

    console.log("\ngetPerformanceReport dimension=hourly:");
    const hourly = await getPerformanceReport(orgId, "hourly", bounds);
    const h14 = hourly.rows.find((r) => r.key === "14")!;
    const h9 = hourly.rows.find((r) => r.key === "9")!;
    const h16 = hourly.rows.find((r) => r.key === "16");
    const h11 = hourly.rows.find((r) => r.key === "11");
    check(
      "R9 ⭐ dimension=hourly builds the breakdown from the LEDGER, in the same hours as `sales`",
      N(h14.events, "purchase") === h14.sales && h14.sales === 3,
      `events ${N(h14?.events, "purchase")} vs sales ${h14?.sales}`,
    );
    check(
      "R9b ⭐ the hourly money follows the same hour, and a registration earns none of it",
      near(R(h14.events, "purchase"), 70) && N(h14.events, "registration") === 4 &&
        near(R(h14.events, "registration"), 0),
      JSON.stringify(h14.events),
    );
    check("R10 ⭐ the hourly unmapped count is non-zero for the fixture that seeds one", hourly.totals.unmapped === 2, `${hourly.totals.unmapped}`);
    check(
      "R10b ⭐ a CROSS-ORG event type is counted by the scalar and placed under NO key — so it must be in `unmapped`",
      h9.sales === 1 && N(h9.events, "purchase") === -1 && h9.unmapped === 1,
      `sales=${h9?.sales} keys=${JSON.stringify(Object.keys(h9?.events ?? {}))} unmapped=${h9?.unmapped}`,
    );
    check(
      "R11 ⭐ a registration is NOT in `sales` on any dimension",
      report.totals.sales === 6 &&
        N(report.totals.events, "registration") === 4 &&
        report.totals.sales === N(report.totals.events, "purchase") + report.totals.manual_topup &&
        h14.sales === 3 && N(h14.events, "registration") === 4,
      `sales=${report.totals.sales} purchase=${N(report.totals.events, "purchase")} manual=${report.totals.manual_topup} reg=${N(report.totals.events, "registration")}`,
    );

    // ── ⭐ R13: ONE ROW, ONE ANSWER FOR HELD MONEY ──────────────────────────
    //
    // The hourly row map used to hard-code `pending_revenue: 0` — a NOT-COMPUTED
    // sentinel — while ledgerHourEventQuery computed the real pending figures
    // into the same row's `events`. The API body then said
    // `pending_revenue: 0` beside `events.purchase.pending_revenue: 40`, and
    // nothing in the payload distinguished that 0 from a measured one. The
    // scalar is now computed off the same ledger and the same occurred_at hour.
    //
    // ⚠️ THE FIXTURE IS WHAT MAKES THIS BAR ABLE TO GO RED. Hour 16 holds two
    // PENDING purchases and no approved conversion at all, so the sentinel value
    // (0) and the true value ($40) are different numbers. A bar written over an
    // hour with no pending money would read 0 === 0 and pass against the
    // sentinel — which is exactly how this shipped.
    check(
      "R13 ⭐ the hourly scalar pending_revenue is COMPUTED, not a not-computed 0: $40 held, $0 approved, in the same hour",
      h16 !== undefined && near(h16.pending_revenue, 40) && near(h16.revenue, 0) && h16.sales === 2,
      `pending=${h16?.pending_revenue} revenue=${h16?.revenue} sales=${h16?.sales}`,
    );
    check(
      "R13b ⭐ …and it AGREES with the per-event map it sits beside, on EVERY hourly row and on the totals",
      hourly.rows.every((r) => near(r.pending_revenue, sumPending(r.events))) &&
        near(hourly.totals.pending_revenue, sumPending(hourly.totals.events)) &&
        // Non-vacuity: at least one of those agreements is over a NON-ZERO
        // figure. Every row reading 0 === 0 would satisfy the line above while
        // the scalar was still a sentinel.
        near(sumPending(hourly.totals.events), 40) &&
        near(PR(h16?.events, "purchase"), 40),
      hourly.rows.map((r) => `${r.key}:${r.pending_revenue}/${sumPending(r.events)}`).join(" "),
    );
    check(
      "R13c ⭐ held money is NOT revenue: the totals carry $140 approved (hour 14's $70 + the stray's $70) and neither the $40 held nor the $99 rejected",
      near(hourly.totals.revenue, 140) && near(R(h16?.events, "purchase"), 0),
      `totals.revenue=${hourly.totals.revenue} h16 event revenue=${R(h16?.events, "purchase")}`,
    );

    // ── ⭐ R14: AN ALL-ZERO ENTRY IS NOT DATA, ON EITHER PATH ───────────────
    //
    // Hour 11 holds ONE rejected purchase and nothing else: it is not a sale,
    // not revenue, not pending, and not unmapped (it has a key AND a status), so
    // its (hour, key) group is zero on every field. The stage-day projection
    // FILTERs exactly that entry out of its jsonb; the hourly path used to emit
    // it, so the same data produced `{"purchase":{0,0,0,0}}` on Hourly and `{}`
    // on By Offer. One-sided against R9, where a NON-zero group IS emitted.
    check(
      "R14 ⭐ the hourly path omits an all-zero per-event entry, exactly as the projection's FILTER does",
      h11 !== undefined && Object.keys(h11.events).length === 0 && h11.sales === 0 && h11.unmapped === 0,
      `h11 keys=${JSON.stringify(Object.keys(h11?.events ?? {}))} sales=${h11?.sales} unmapped=${h11?.unmapped}`,
    );

    // ── ⭐ THE CAMPAIGN PAGE'S STAGE AGGREGATE, EXECUTED FOR REAL ───────────
    //
    // getStageKeitaroTotals is the statement
    // app/api/campaigns/[campaignId]/stages/route.ts runs — imported, never
    // retyped, because a bar that retypes a query proves only that the typist
    // agreed with themselves. It lives in lib/reporting precisely so this script
    // can execute it without standing up requireApiMembership and the rest of
    // the auth chain.
    console.log("\ngetStageKeitaroTotals (the campaign page's stages table):");
    // ⭐ A STATEMENT THAT WILL NOT EXECUTE IS A RED BAR, NOT A STACK TRACE.
    // K5's red proof is `min(o.events)` — PostgreSQL has no min/max for jsonb, so
    // the statement fails with 42883 at EXECUTION time, which an un-caught call
    // turns into a crash that prints no bar at all. Caught here, K5 goes red and
    // says why, and K1-K4 go red on their sentinels beside it.
    let agg: Awaited<ReturnType<typeof getStageKeitaroTotals>> = new Map();
    let aggError = "";
    try {
      agg = await getStageKeitaroTotals(db, orgId, campaignId);
    } catch (e) {
      // Prefer the driver's CAUSE: drizzle's own message is "Failed query:"
      // followed by the whole statement, while the cause carries the SQLSTATE
      // and the one line that says what is wrong ("42883: function min(jsonb)
      // does not exist"). A bar that goes red has to say why in its own line.
      const c = (e as { cause?: unknown }).cause as { code?: string; message?: string } | undefined;
      aggError = c?.code
        ? `${c.code}: ${c.message}`
        : e instanceof Error
          ? `${e.name}: ${e.message}`
          : String(e);
    }
    // ⭐ A MISSING STAGE IS A SENTINEL, NOT A CRASH — the same rule as N() above,
    // and here it is load-bearing for the red proofs themselves. The mutation
    // that reddens K2 (grouping the scalars off the lateral) DELETES the
    // clicks-only stage from the map, so `agg.get(stageClicksOnly)!.pendingRevenue`
    // would throw a TypeError inside K4 and the run would end in a stack trace
    // with nothing printed about which bar failed. -1 can never be a legitimate
    // count, unmapped total or held amount here.
    const KN = (stageId: number, key: string) => agg.get(stageId)?.events[key]?.n ?? -1;
    const KU = (stageId: number) => agg.get(stageId)?.unmapped ?? -1;
    const KPR = (stageId: number) => Number(agg.get(stageId)?.pendingRevenue ?? -1);
    check(
      "K1 ⭐ the stage aggregate SUMS the per-event block across a stage's days",
      KN(stageA, "purchase") === 5, // 2 on day one + 3 on day two
      JSON.stringify(agg.get(stageA)?.events),
    );
    check(
      "K2 ⭐ a stage whose events object is EMPTY still gets a row (the scalars are grouped separately from the jsonb)",
      agg.has(stageClicksOnly) && Object.keys(agg.get(stageClicksOnly)?.events ?? {}).length === 0,
      JSON.stringify(agg.get(stageClicksOnly) ?? null),
    );
    check(
      "K3 ⭐ unmapped_conversions sums across days",
      KU(stageA) === 3,
      `${KU(stageA)}`,
    );
    check(
      "K4 ⭐ pending_revenue SURVIVES the rewrite and still sums — the column this task's first draft silently deleted",
      KPR(stageClicksOnly) === 41.5,
      JSON.stringify(agg.get(stageClicksOnly) ?? null),
    );
    check(
      "K5 ⭐ the query runs at all — no aggregate over jsonb (min(jsonb) does not exist: 42883)",
      aggError === "" && agg.size > 0,
      aggError || `${agg.size} stage(s)`,
    );
    // ⭐ THE TWO MALFORMED ROWS. Both failures are STATEMENT-wide, so the
    // proof is not "the bad stage reads 0" — it is that EVERY OTHER stage on
    // this campaign still reads its real number with the bad row present. K1's
    // 5 is the anchor: unguarded, aggError carries the SQLSTATE and every K bar
    // above goes red beside these two.
    check(
      "K6 ⭐ a stage-day row whose events is a jsonb SCALAR does not abort the campaign page's aggregate (22023 is statement-wide)",
      aggError === "" && KN(stageA, "purchase") === 5 && agg.has(stageBadObject) &&
        Object.keys(agg.get(stageBadObject)?.events ?? {}).length === 0,
      aggError || `stageA purchase=${KN(stageA, "purchase")} badObject=${JSON.stringify(agg.get(stageBadObject) ?? null)}`,
    );
    check(
      "K7 ⭐⭐ a malformed VALUE inside a well-formed object does not abort it either (22P02, which the top-level guard does not catch) — and the good entry on that same row still reads 4",
      aggError === "" &&
        KN(stageA, "purchase") === 5 &&
        KN(stageBadValue, "purchase") === 4 &&
        KN(stageBadValue, "word_count") === 0 &&
        KN(stageBadValue, "bare_string_entry") === 0 &&
        // …and the rotten money field on that entry reads 0 rather than taking
        // the count with it: a field is skipped, never its whole entry.
        Number(agg.get(stageBadValue)?.events.word_count?.revenue ?? -1) === 0,
      aggError ||
        `stageA purchase=${KN(stageA, "purchase")} badValue=${JSON.stringify(agg.get(stageBadValue)?.events)}`,
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
    // ⚠️ SCOPED TO THIS RUN'S TAG, NOT TO THE MARKER. The marker alone is
    // org-WIDE across every run that ever used it, so a CONCURRENT invocation of
    // this script — or one whose teardown is still in flight — would be counted
    // here and reported as a leak this run did not cause. The tag is
    // `p5-${Date.now()}` and appears in both org names, so this counts exactly
    // the two orgs the `try` block created.
    const leftovers = (await db.execute(sql`
      SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`%${MARKER} ${tag}%`}
    `)) as unknown as { n: number }[];
    console.log(`teardown: ${Number(leftovers[0]?.n ?? -1)} org(s) from this run (${tag}) left behind (expected 0)`);
    if (Number(leftovers[0]?.n ?? -1) !== 0) process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
