import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";

import { seedConversionEvent, type SeedConversionEvent } from "./_conversion-fixture";

// THE SHARED STAGE FUNNEL (lib/reporting/stage-funnel.ts getStageMetricsInRange —
// the numbers behind Overview and every /reports dimension), run over a world
// this script builds, checks and tears down itself.
//
// ⚠️ PREVIEW-ONLY, AND IT WRITES. `.env.local` IS PRODUCTION. Run it as:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-stage-funnel.ts
// The `_require-preview-db` import above is the refusal; it is an allowlist and
// it runs before db/client is evaluated.
//
// ⭐ WHY IT BUILDS ITS OWN WORLD (2026-09-21). It used to load `.env.local`
// itself — so a bare run read PRODUCTION — and assert "data only grows" floors
// (clickers >= 2144, redirect >= 257) read off a Jul 20 2026 Overview
// screenshot for Jul 18-19. On camman-v2 that window is empty, so the suite was
// red by design, forever. A suite that is always red trains everyone to ignore
// red. It now seeds exactly what it checks.
//
// ⭐ COMMITTED FIXTURES UNDER A THROWAWAY ORG, NOT A ROLLED-BACK TRANSACTION.
// getStageMetricsInRange binds the MODULE-LEVEL `db` and takes no `tx`, so a
// world seeded inside a transaction is invisible to it and every bar would read
// zero. Same model as scripts/test-report-event-columns-db.ts: an org whose name
// carries MARKER, torn down by org_id in `finally`, then a read that proves no
// row of it is left.
//
// ⭐ THE CONVERSION COLUMNS COME FROM THE REAL PROJECTION, NOT FROM TYPING.
// Click columns are seeded the way the Keitaro aggregate poll writes them.
// Sales / revenue / pending / events / unmapped are NOT typed into
// keitaro_stage_results: ledger rows go into conversion_events and
// syncStageDayConversions (the */5 projection) derives the stage-day row from
// them, as production does. Dropping one ledger row therefore moves the funnel.
//
// ⭐ TWO KINDS OF BAR.
//   F — FOOTING: Σ per-stage == grand, per metric and per event key. Structural
//       and direction-free, and VACUOUS over a zero world (0 == 0).
//   E — EXACT: every grand total equals what the world below seeds. This is what
//       turns a zero world, a dropped row or a leaked decoy red.
// The world is ONE-SIDED, so no bar can pass for the wrong reason: a rejected
// purchase ($99) that must count as nothing, registrations that are not sales,
// an unmapped row in no other field, a manual top-up that exists only in
// stage_manual_sales, a FAILED send that is not "sent", sms_count 100 on tracked
// stages (whose sent total must come from stage_sends), a stage that was sent
// and never clicked, and a DECOY day just outside the window carrying 1000
// clickers and a $500 sale that must not appear.

const MARKER = "__STAGE_FUNNEL_TEST__";
// A CLOSED two-day window in the past that no other suite uses, so nothing that
// happens while this runs can move it and no "today" boundary makes the ET
// range ambiguous.
const FROM = "2026-04-14";
const TO = "2026-04-15";
// The decoy day, one past TO: a reader that ignored the window would count it.
const OUTSIDE = "2026-04-16";

/** What the world below seeds — and therefore what the grand totals must be. */
const EXPECT = {
  stages: 3, // S1 + S2 (Keitaro rows) + S3 (sent in range, no Keitaro row)
  clickers: 72, // 40 + 3 (S1, both days) + 29 (S2); not the decoy's 1000
  redirect: 22, // 13 + 2 + 7
  sales: 8, // tracker 4 (S1: 2 approved + 1 pending; S2: 1) + manual top-up 4
  revenue: 100, // APPROVED only: 50 + 30 + 20 — not the $25 held, not the $99 rejected
  pending_revenue: 25,
  unmapped: 1,
  manual_topup: 4, // S2: 5 manual − 1 tracker
  events: { purchase: 4, registration: 2 } as Record<string, number>,
  opt_outs: 3, // 2 on S1 + 1 on S3
  total_sent: 13, // 6 + 4 + 3 — the failed send is not sent
  cost: 6.4, // 3.25 + 2.10 + 1.05
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const { syncStageDayConversions } = await import("@/lib/keitaro/stage-day-conversions");
  const { CAMPAIGN_TIMEZONE } = await import("@/lib/campaign-timezone");
  const { requireReportingColumns } = await import("./_require-migration");

  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  // NEEDS 0182 *AND* 0185 (same reason as verify-epc-denominator): the funnel
  // selects keitaro_stage_results.pending_revenue, .events and
  // .unmapped_conversions. Say which one is missing, instead of dying on a raw
  // 42703 that reads like a broken report.
  await requireReportingColumns(db, "test-stage-funnel");

  let fail = 0;
  const bar = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
    if (!ok) fail++;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

  const tag = `sf-${Date.now()}`;
  let orgId = "";
  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  /** An ET wall-clock time on `day`, as a UTC instant. */
  const et = (day: string, hhmm: string) => fromZonedTime(`${day}T${hhmm}:00`, CAMPAIGN_TIMEZONE);

  try {
    // ── the world ─────────────────────────────────────────────────────────────
    orgId = (
      await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id
      `)
    ).id;
    // A plain INSERT gets no event types (handle_new_user seeds them on signup).
    for (const [key, purchase] of [["purchase", true], ["registration", false]] as const) {
      await db.execute(sql`
        INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
        VALUES (${orgId}::uuid, ${key}, ${key}, 10, ${purchase}, ${purchase}, ${!purchase})
      `);
    }
    const campaignId = (
      await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, link_mode, status)
        VALUES (${orgId}::uuid, ${`camp-${tag}`}, ${"Stage funnel"}, 'tracked', 'active')
        RETURNING id
      `)
    ).id;

    // sms_count 100 is a trap: a TRACKED stage's sent total comes from stage_sends.
    const stage = async (n: number, sentAt: Date, totalCost: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at, sms_count, total_cost)
          VALUES (${orgId}::uuid, ${campaignId}, ${n}, ${`trk-${tag}-s${n}`},
                  ${sentAt.toISOString()}::timestamptz, 100, ${totalCost}::numeric)
          RETURNING id
        `)
      ).id;
    const s1 = await stage(1, et(FROM, "12:00"), "3.2500");
    const s2 = await stage(2, et(TO, "12:00"), "2.1000");
    const s3 = await stage(3, et(TO, "12:30"), "1.0500"); // sent, never clicked, no ledger

    const contacts: string[] = [];
    for (let n = 1; n <= 7; n++) {
      contacts.push(
        (
          await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1999${tag.slice(-6)}${n}`})
            RETURNING id
          `)
        ).id,
      );
    }
    const send = (stageId: number, contactId: string, status: "sent" | "failed", at: Date) =>
      db.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${contactId}::uuid, ${"+1999"}, ${"x"}, ${status},
                ${at.toISOString()}::timestamptz)
      `);
    for (const c of contacts.slice(0, 6)) await send(s1, c, "sent", et(FROM, "12:00"));
    await send(s1, contacts[6], "failed", et(FROM, "12:00")); // in range, but not sent
    for (const c of contacts.slice(0, 4)) await send(s2, c, "sent", et(TO, "12:00"));
    for (const c of contacts.slice(0, 3)) await send(s3, c, "sent", et(TO, "12:30"));

    const optOut = async (stageId: number, contactId: string, at: Date) => {
      const optOutId = (
        await one<{ id: number }>(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, created_at)
          VALUES (${orgId}::uuid, ${contactId}::uuid, ${"+1999"}, ${at.toISOString()}::timestamptz)
          RETURNING id
        `)
      ).id;
      await db.execute(sql`
        INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_id, campaign_id, created_at)
        VALUES (${orgId}::uuid, ${optOutId}, ${stageId}, ${campaignId}, ${at.toISOString()}::timestamptz)
      `);
    };
    await optOut(s1, contacts[4], et(FROM, "18:00"));
    await optOut(s1, contacts[5], et(FROM, "19:00"));
    await optOut(s3, contacts[2], et(TO, "18:00"));

    // CLICK columns, in the shape the aggregate poll writes (conversion columns
    // at their defaults — the projection below owns them).
    type Clicks = { visitRaw: number; visit: number; redirectRaw: number; redirect: number };
    const clicks = (stageId: number, n: number, day: string, c: Clicks) =>
      db.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
           visit_clicks_raw, visit_clicks_clean, redirect_clicks_raw, redirect_clicks_clean)
        VALUES (${orgId}::uuid, ${campaignId}, ${stageId}, ${`trk-${tag}-s${n}`}, ${day}::date,
                ${c.visitRaw}, ${c.visit}, ${c.redirectRaw}, ${c.redirect})
      `);
    await clicks(s1, 1, FROM, { visitRaw: 55, visit: 40, redirectRaw: 17, redirect: 13 });
    await clicks(s1, 1, TO, { visitRaw: 4, visit: 3, redirectRaw: 2, redirect: 2 });
    await clicks(s2, 2, TO, { visitRaw: 31, visit: 29, redirectRaw: 9, redirect: 7 });
    await clicks(s1, 1, OUTSIDE, { visitRaw: 1200, visit: 1000, redirectRaw: 600, redirect: 500 }); // decoy

    // The LEDGER. Mapped rows default to status 'approved'.
    const ledger = (stageId: number, day: string, hhmm: string, e: Pick<SeedConversionEvent, "eventKey" | "status" | "revenue">) =>
      seedConversionEvent(db, { orgId, campaignId, stageId, occurredAt: et(day, hhmm), ...e });
    await ledger(s1, FROM, "13:00", { eventKey: "purchase", revenue: 50 });
    await ledger(s1, FROM, "13:05", { eventKey: "purchase", revenue: 30 });
    await ledger(s1, FROM, "14:00", { eventKey: "purchase", status: "pending", revenue: 25 });
    await ledger(s1, FROM, "15:00", { eventKey: "purchase", status: "rejected", revenue: 99 }); // nothing
    await ledger(s1, FROM, "16:00", { eventKey: "registration" });
    await ledger(s2, TO, "13:00", { eventKey: "purchase", revenue: 20 });
    await ledger(s2, TO, "14:00", { eventKey: "registration" });
    await ledger(s2, TO, "15:00", {}); // UNMAPPED: no event type, no status
    await ledger(s1, OUTSIDE, "13:00", { eventKey: "purchase", revenue: 500 }); // decoy

    // The MANUAL tally: 5 on S2 against 1 tracker sale ⇒ a top-up of 4. It exists
    // only here — no ledger row, no events entry.
    await db.execute(sql`
      INSERT INTO stage_manual_sales (org_id, campaign_id, stage_id, delta, created_at)
      VALUES (${orgId}::uuid, ${campaignId}, ${s2}, 5, ${et(TO, "18:00").toISOString()}::timestamptz)
    `);

    // ── the real projection: ledger → keitaro_stage_results conversion columns ─
    const proj = await syncStageDayConversions(db, { stageIds: [s1, s2, s3] });
    bar(
      "W0 the real projection derived the conversion columns (3 stage-days: S1 FROM, S2 TO, S1 decoy)",
      proj.refused === null && proj.rowsWritten === 3,
      `refused=${proj.refused} rowsWritten=${proj.rowsWritten}`,
    );

    // ── the real reader ───────────────────────────────────────────────────────
    const { stages, grand, grandOptOuts, grandTotalSent } = await getStageMetricsInRange(orgId, FROM, TO);
    const clickers = grand.visit_clicks_clean, redirect = grand.redirect_clicks_clean;
    console.log(`GRAND ${FROM}..${TO}:`, JSON.stringify({
      clickers, redirect, sales: grand.sales, revenue: grand.revenue.toFixed(2),
      pending: grand.pending_revenue.toFixed(2), cost: grand.cost.toFixed(2),
      opt_outs: grandOptOuts, total_sent: grandTotalSent, unmapped: grand.unmapped,
      manual_topup: grand.manual_topup, stages: stages.length,
    }));
    const grandKeys = Object.keys(grand.events).sort();
    console.log(`EVENTS(grand): ${JSON.stringify(Object.fromEntries(grandKeys.map((k) => [k, grand.events[k].n])))}`);

    // ── E: EXACT — the grand totals are the seeded world, and only it ──────────
    console.log("\nexact (E) — grand == seeded:");
    bar("E1 stages", stages.length === EXPECT.stages, `${stages.length} == ${EXPECT.stages} (incl. the sent-never-clicked stage)`);
    bar("E2 clickers", clickers === EXPECT.clickers, `${clickers} == ${EXPECT.clickers} (decoy day excluded)`);
    bar("E3 offer redirect", redirect === EXPECT.redirect, `${redirect} == ${EXPECT.redirect}`);
    bar("E4 sales", grand.sales === EXPECT.sales, `${grand.sales} == ${EXPECT.sales} (tracker 4 + manual top-up 4; rejected is not a sale)`);
    bar("E5 revenue", near(grand.revenue, EXPECT.revenue), `${grand.revenue.toFixed(4)} == ${EXPECT.revenue} (approved only)`);
    bar("E6 pending_revenue", near(grand.pending_revenue, EXPECT.pending_revenue), `${grand.pending_revenue.toFixed(4)} == ${EXPECT.pending_revenue}`);
    bar("E7 unmapped", grand.unmapped === EXPECT.unmapped, `${grand.unmapped} == ${EXPECT.unmapped}`);
    bar("E8 manual_topup", grand.manual_topup === EXPECT.manual_topup, `${grand.manual_topup} == ${EXPECT.manual_topup}`);
    bar(
      "E9 events: exactly the seeded keys, with the seeded counts",
      JSON.stringify(grandKeys) === JSON.stringify(Object.keys(EXPECT.events).sort()) &&
        grandKeys.every((k) => grand.events[k].n === EXPECT.events[k]),
      `${JSON.stringify(Object.fromEntries(grandKeys.map((k) => [k, grand.events[k].n])))} == ${JSON.stringify(EXPECT.events)}`,
    );
    bar("E10 opt_outs", grandOptOuts === EXPECT.opt_outs, `${grandOptOuts} == ${EXPECT.opt_outs}`);
    bar("E11 total_sent", grandTotalSent === EXPECT.total_sent, `${grandTotalSent} == ${EXPECT.total_sent} (status 'sent' only; not sms_count)`);
    bar("E12 cost", near(grand.cost, EXPECT.cost), `${grand.cost.toFixed(4)} == ${EXPECT.cost}`);

    // ── F: FOOTING — Σ per-stage == grand ─────────────────────────────────────
    // `grand` is accumulated from the ROWS, not by merging the stage tallies, so
    // every field that is carried across by hand (sales, manual_topup) can drift
    // from its stages without any other bar noticing.
    const sum = (f: (s: (typeof stages)[number]) => number) => stages.reduce((a, s) => a + f(s), 0);
    console.log("\nfooting (F) — Σ stages == grand:");
    const eq = (n: string, a: number, b: number) => bar(n, a === b, `Σ ${a} == grand ${b}`);
    const eqMoney = (n: string, a: number, b: number) => bar(n, near(a, b), `Σ ${a.toFixed(4)} == grand ${b.toFixed(4)}`);
    eq("F1 clickers", sum((s) => s.tally.visit_clicks_clean), clickers);
    eq("F2 sales", sum((s) => s.tally.sales), grand.sales);
    eq("F3 opt_outs", sum((s) => s.opt_outs), grandOptOuts);
    eq("F4 total_sent", sum((s) => s.total_sent), grandTotalSent);
    eqMoney("F5 revenue", sum((s) => s.tally.revenue), grand.revenue);
    // Held money foots separately — it is never folded into revenue.
    eqMoney("F6 pending_revenue", sum((s) => s.tally.pending_revenue), grand.pending_revenue);
    eq("F7 unmapped", sum((s) => s.tally.unmapped), grand.unmapped);
    // The THIRD term of the breakdown identity, carried by hand: if
    // getStageMetricsInRange stops copying the top-up onto `grand`, Overview's
    // totals present a breakdown short of the residual that explains them.
    eq("F8 manual_topup", sum((s) => s.tally.manual_topup), grand.manual_topup);
    // mergeFunnel must carry the per-event breakdown per KEY.
    const sumEvents: Record<string, number> = {};
    for (const s of stages) {
      for (const [k, t] of Object.entries(s.tally.events)) sumEvents[k] = (sumEvents[k] ?? 0) + t.n;
    }
    const keys = [...new Set([...grandKeys, ...Object.keys(sumEvents)])];
    eq("F9 event keys", keys.length, grandKeys.length);
    for (const k of keys) eq(`F10 events[${k}].n`, sumEvents[k] ?? 0, grand.events[k]?.n ?? 0);

    console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    // ── teardown: by org_id, and only after re-reading the marker ─────────────
    if (orgId) {
      const name =
        ((await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[])[0]
          ?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the test marker (name=${JSON.stringify(name)})`);
        process.exitCode = 1;
      } else {
        // conversion_events.event_type_id is ON DELETE RESTRICT, so the ledger
        // goes first; everything else cascades from organizations.id.
        await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    // The proof, scoped to THIS run's tag and org id — not to the marker alone,
    // which a concurrent run of this script would share.
    const org = sql`NULLIF(${orgId}, '')::uuid`;
    const left = await one<{ orgs: number; rows: number }>(sql`
      SELECT (SELECT count(*) FROM organizations WHERE name LIKE ${`%${MARKER} ${tag}%`})::int AS orgs,
             ((SELECT count(*) FROM conversion_events     WHERE org_id = ${org})
            + (SELECT count(*) FROM keitaro_stage_results WHERE org_id = ${org})
            + (SELECT count(*) FROM campaign_stages       WHERE org_id = ${org})
            + (SELECT count(*) FROM campaigns             WHERE org_id = ${org})
            + (SELECT count(*) FROM stage_sends           WHERE org_id = ${org})
            + (SELECT count(*) FROM opt_outs              WHERE org_id = ${org})
            + (SELECT count(*) FROM opt_out_attributions  WHERE org_id = ${org})
            + (SELECT count(*) FROM stage_manual_sales    WHERE org_id = ${org})
            + (SELECT count(*) FROM contacts              WHERE org_id = ${org})
            + (SELECT count(*) FROM event_types           WHERE org_id = ${org}))::int AS rows
    `);
    console.log(`teardown: ${left.orgs} org(s) and ${left.rows} row(s) from this run (${tag}) left behind (expected 0 and 0)`);
    if (left.orgs !== 0 || left.rows !== 0) process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
