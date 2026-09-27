import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE LIFECYCLE COHORT REPORT (PR 5 Task 2) against the PREVIEW DB.
//
// Every bar here is a number a reader would act on, so the fixtures are built
// so that a wrong answer is a DIFFERENT number rather than a missing one.
//
// ⭐ B1 IS THE BAR THAT CAUGHT A REAL DEFECT. The click join first read
// `links.contact_id = sent.contact_id` alone, with no stage. That counts every
// link the contact ever clicked, org-wide — so a Hot contact imports their
// whole click history into whichever cohort they sit in, and the cohort CTR
// measures the CONTACT instead of the send. Cohort CTR is the number the whole
// report exists to produce, and it would have been inflated in exactly the
// cohorts defined by clicking. B1 fails if the stage join is ever dropped.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-report.ts

import { fromZonedTime } from "date-fns-tz";
import { sql, type SQL } from "drizzle-orm";

const MARKER = "__LIFECYCLE_REPORT_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { getLifecycleReport, LIFECYCLE_COHORTS } =
    await import("@/lib/reporting/lifecycle-report");
  const { formatInCampaignTimezone } = await import("@/lib/campaign-timezone");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `lcrep-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const net = await one<{ id: number }>(sql`
      INSERT INTO affiliate_networks (org_id, network_id, name)
      VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`);
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);
    const offer = await one<{ id: number }>(sql`
      INSERT INTO offers (org_id, offer_id, network_id, name)
      VALUES (${org}, ${`o-${tag}`}, ${net.id}, ${`O ${tag}`}) RETURNING id`);
    const dom = await one<{ id: number }>(sql`
      INSERT INTO short_domains (org_id, brand_id, domain)
      VALUES (${org}, ${brand.id}, ${`${tag}.example`}) RETURNING id`);
    const dest = await one<{ id: number }>(sql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${org}, 'https://example.com/x', ${`h-${tag}`}) RETURNING id`);
    const etSale = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
      VALUES (${org}, ${`lr-${tag}`}, ${`LR ${tag}`}, 'completed', 'manual',
              ${brand.id}, ${offer.id}) RETURNING id`);

    // Two stages. STAGE A carries every send under test; STAGE B exists only to
    // hold the foreign link in B1, and its own send list stays empty.
    const mkStage = async (n: number, cost: string, optOuts: number) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, stop_text,
             total_cost, sms_count, opt_out_count)
          VALUES (${org}, ${camp.id}, ${n}, 'STOP', ${cost}, 0, ${optOuts})
          RETURNING id`)
      ).id;
    // Shaped like a real API stage: sms_count 0, one row per recipient. The
    // denominator is therefore greatest(0, 9 sent rows) + opt_out_count 1 = 10,
    // so total_cost 0.20 implies a rate of exactly 0.02 per send.
    const stageA = await mkStage(1, "0.2000", 1);
    const stageB = await mkStage(2, "0.2000", 0);

    const N = 9;
    const phones = fictionalPhones(N);
    await refuseIfPhonesInUse(db, phones);
    const contacts: string[] = [];
    for (let i = 0; i < N; i++) {
      contacts.push(
        (
          await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number, line_type)
            VALUES (${org}, ${phones[i]}, 'mobile') RETURNING id`)
        ).id,
      );
    }

    // Every send is stamped "yesterday noon ET" so one 3-day window holds them
    // all and no fixture can fall out of range on a timezone boundary.
    const sentAt = sql`(now() - interval '1 day')`;
    const mkSend = async (
      i: number,
      stageId: number,
      costPerSms: string | null,
      saleStatus: string | null,
    ) =>
      (
        await one<{ id: string }>(sql`
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text,
             status, sent_at, cost_per_sms, sale_status)
          VALUES (${org}, ${camp.id}, ${stageId}, ${contacts[i]}::uuid, ${phones[i]},
                  'hi', 'sent', ${sentAt}, ${costPerSms}, ${saleStatus})
          RETURNING id`)
      ).id;

    //  i  cohort        role
    //  0  hot           clicks its OWN link            ⇒ clicker
    //  1  hot           clicks ANOTHER stage's link    ⇒ NOT a clicker (B1)
    //  2  warm          click is a bot                 ⇒ NOT a clicker
    //  3  cold          approved ledger sale, $30
    //  4  cold          sale_status only, no ledger    ⇒ fallback sale
    //  5  cold          BOTH: ledger $12 + sale_status ⇒ revenue 12, not 12+x
    //  6  freeze        opted out                      ⇒ cost doubles
    //  7  freeze        cost_per_sms 0.05 explicit
    //  8  (no stamp)    ⇒ Unclassified
    const send: string[] = [];
    for (const [i, cost] of [
      null, null, null, null, null, null, null, "0.0500", null,
    ].entries()) {
      send.push(
        await mkSend(i, stageA, cost, i === 4 || i === 5 ? "sale" : null),
      );
    }

    const stamp = async (i: number, status: string, reconstructed = false) =>
      db.execute(sql`
        INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, reconstructed)
        VALUES (${send[i]}::uuid, ${org}, ${status}, ${reconstructed})`);
    await stamp(0, "hot");
    await stamp(1, "hot");
    await stamp(2, "warm");
    await stamp(3, "cold");
    await stamp(4, "cold");
    await stamp(5, "cold", true); // the only reconstructed row
    await stamp(6, "freeze");
    await stamp(7, "freeze");
    // i = 8 deliberately unstamped.

    // ── links + clicks ──────────────────────────────────────────────────────
    const mkLink = async (i: number, stageId: number, suffix: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO links (org_id, code, short_domain_id, destination_id,
                             campaign_id, stage_id, contact_id, send_token,
                             campaign_tracking_id, stage_tracking_id)
          VALUES (${org}, ${`${tag}-${suffix}`}, ${dom.id}, ${dest.id},
                  ${camp.id}, ${stageId}, ${contacts[i]}::uuid,
                  ${`t-${tag}-${suffix}`},
                  ${`ct-${tag}`}, ${`st-${tag}`}) RETURNING id`)
      ).id;
    const mkClick = async (linkId: number, classification: string, scored: boolean) =>
      db.execute(sql`
        INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at)
        VALUES (${org}, ${linkId}, now(), ${classification},
                ${scored ? sql`now()` : sql`NULL::timestamptz`})`);

    await mkClick(await mkLink(0, stageA, "own"), "human", true);
    // ⭐ contact 1's click is on STAGE B's link — a different send entirely.
    await mkClick(await mkLink(1, stageB, "foreign"), "human", true);
    await mkClick(await mkLink(2, stageA, "bot"), "bot", true);

    // ── sales ───────────────────────────────────────────────────────────────
    const mkConv = async (
      i: number,
      status: string,
      revenue: string,
      suffix: string,
    ) =>
      db.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, stage_send_id,
           contact_id, campaign_id, stage_id, offer_id, event_type_id, status,
           revenue, occurred_at)
        VALUES (${org}, ${`${tag}-${suffix}`}, 'sale', 'sale', ${send[i]}::uuid,
                ${contacts[i]}::uuid, ${camp.id}, ${stageA}, ${offer.id},
                ${etSale.id}, ${status}, ${revenue}, now())`);
    await mkConv(3, "approved", "30.0000", "s3");
    await mkConv(5, "approved", "12.0000", "s5");

    // ── the opt-out ─────────────────────────────────────────────────────────
    const optOut = await one<{ id: number }>(sql`
      INSERT INTO opt_outs (org_id, phone_number, contact_id, source)
      VALUES (${org}, ${phones[6]}, ${contacts[6]}::uuid, 'inbound') RETURNING id`);
    await db.execute(sql`
      INSERT INTO opt_out_attributions
        (org_id, opt_out_id, stage_send_id, stage_id, campaign_id)
      VALUES (${org}, ${optOut.id}, ${send[6]}::uuid, ${stageA}, ${camp.id})`);

    // ── the report ──────────────────────────────────────────────────────────
    const day = (offsetDays: number) =>
      formatInCampaignTimezone(
        new Date(Date.now() + offsetDays * 86_400_000),
        "yyyy-MM-dd",
      );
    const rep = await getLifecycleReport({
      orgId,
      from: day(-2),
      to: day(0),
    });
    const row = (k: string) => rep.rows.find((r) => r.row === k)!;
    const hot = row("hot");
    const warm = row("warm");
    const cold = row("cold");
    const freeze = row("freeze");
    const total = row("total");
    const unclass = row("unclassified");

    console.log("PART A — composition");
    const cohortSum = (f: (r: typeof hot) => number) =>
      LIFECYCLE_COHORTS.reduce((a, c) => a + f(row(c)), 0);
    bar(
      "A1 the six cohorts sum to Total on every counted column",
      cohortSum((r) => r.sends) === total.sends &&
        cohortSum((r) => r.clickers) === total.clickers &&
        cohortSum((r) => r.sales) === total.sales &&
        cohortSum((r) => r.opt_outs) === total.opt_outs &&
        near(cohortSum((r) => Number(r.revenue)), Number(total.revenue)) &&
        near(cohortSum((r) => Number(r.cost)), Number(total.cost)),
      `sends ${cohortSum((r) => r.sends)} vs total ${total.sends}`,
    );
    bar(
      "A2 ⭐ an unstamped send lands in Unclassified, not nowhere",
      unclass.sends === 1,
      `${unclass.sends} send(s)`,
    );
    bar(
      "A3 …and Unclassified is OUTSIDE Total, so the eight stamped rows foot",
      total.sends === 8,
      `total ${total.sends}, 9 sends exist`,
    );
    bar(
      "A4 Clickers = hot + warm, Non-clickers = the other four",
      row("clickers").sends === hot.sends + warm.sends &&
        row("non_clickers").sends ===
          row("new").sends + cold.sends + freeze.sends + row("suppressed").sends,
    );

    console.log("\nPART B — the click join");
    bar(
      "B1 ⭐ a click on ANOTHER stage's link does not count for this send",
      hot.clickers === 1,
      `hot clickers ${hot.clickers} of ${hot.sends} sends (2 contacts clicked, 1 on this stage)`,
    );
    bar(
      "B2 …and the click on its own link does",
      near(hot.ctr ?? -1, 0.5),
      `ctr ${hot.ctr}`,
    );
    bar(
      "B3 a bot click is not a human click",
      warm.clickers === 0,
      `warm clickers ${warm.clickers}`,
    );

    console.log("\nPART C — sales, ledger-primary");
    bar(
      "C1 an approved ledger sale counts, with the ledger's revenue",
      cold.sales === 3 && near(Number(cold.revenue), 42),
      `sales ${cold.sales}, revenue ${cold.revenue} (expect 3 / 42 = 30 + 12 + 0)`,
    );
    bar(
      "C2 ⭐ sale_status counts ONLY where no ledger row exists",
      cold.sales === 3,
      "contact 4 has no ledger row and is counted; 3 and 5 come from the ledger",
    );
    bar(
      "C3 ⭐ a send in BOTH takes the ledger's revenue, never both sources",
      near(Number(cold.revenue), 42),
      "12 from contact 5's ledger row, nothing added for its sale_status",
    );
    bar(
      "C4 CR divides sales by CLICKERS, and is null when nobody clicked",
      cold.cr === null && cold.clickers === 0,
      `cold cr ${cold.cr}`,
    );

    console.log("\nPART D — opt-outs and cost");
    bar(
      "D1 opt-out rate is per send in the cohort",
      freeze.opt_outs === 1 && near(freeze.opt_out_rate ?? -1, 0.5),
      `${freeze.opt_outs}/${freeze.sends} = ${freeze.opt_out_rate}`,
    );
    // contact 6: stage rate 0.02, opted out ⇒ 0.04. contact 7: 0.05, no opt-out.
    bar(
      "D2 ⭐ cost includes opt-out cost — an opt-out doubles that send",
      near(Number(freeze.cost), 0.09),
      `${freeze.cost} (expect 0.02×2 + 0.05)`,
    );
    bar(
      "D3 cost falls back to the stage rate when cost_per_sms is null",
      near(Number(hot.cost), 0.04),
      `${hot.cost} (expect 2 × 0.20/10)`,
    );
    // ⭐ The whole cost formula in one number: 7 rate-priced sends at 0.02, one
    // of them billed twice for its opt-out, plus contact 7's own 0.05.
    bar(
      "D4 ⭐ Total cost is 0.21 — rate, opt-out and per-send override together",
      near(Number(total.cost), 0.21),
      `${total.cost}`,
    );
    bar(
      "D5 the unstamped send's cost is in Unclassified, not lost",
      near(Number(unclass.cost), 0.02),
      `${unclass.cost}`,
    );

    console.log("\nPART E — null is not zero");
    const suppressed = row("suppressed");
    bar(
      "E1 ⭐ a cohort with no sends has ctr null, not 0%",
      suppressed.sends === 0 && suppressed.ctr === null,
      `sends ${suppressed.sends}, ctr ${suppressed.ctr}`,
    );
    bar(
      "E2 …and its opt-out rate is null too",
      suppressed.opt_out_rate === null,
    );
    bar(
      "E3 every cohort is present as a row even at zero",
      LIFECYCLE_COHORTS.every((c) => rep.rows.some((r) => r.row === c)),
    );

    console.log("\nPART F — the reconstruction marker");
    bar(
      "F1 a period containing a reconstructed row is flagged",
      rep.has_reconstructed === true,
    );
    bar(
      "F2 …on the cohort that holds it, not on the others",
      cold.reconstructed === true && hot.reconstructed === false,
      `cold ${cold.reconstructed}, hot ${hot.reconstructed}`,
    );
    bar(
      "F3 Total inherits the flag, so the page marks the period",
      total.reconstructed === true,
    );

    console.log("\nPART G — the window");
    const outside = await getLifecycleReport({
      orgId,
      from: day(-30),
      to: day(-20),
    });
    bar(
      "G1 a window that excludes the sends reports nothing, not everything",
      outside.rows.find((r) => r.row === "total")!.sends === 0,
    );
    bar(
      "G2 …and says the period holds no reconstructed rows",
      outside.has_reconstructed === false,
    );
    // ── PART H — the ET day boundary ────────────────────────────────────────
    //
    // ⭐ THE BAR THAT WAS MISSING. Every fixture above sits in the MIDDLE of its
    // window, and the window was wrong by 8 hours: `<date> AT TIME ZONE
    // 'America/New_York'` casts the date to timestamptz in the session zone
    // FIRST, then converts TO ET and returns a naive timestamp compared as UTC.
    // A mid-window fixture is still inside a window displaced by 8 hours, so 24
    // green bars said nothing about it. Only a fixture ON the boundary can.
    //
    // These two sends are 2 minutes apart across ET midnight, on their own stage
    // and 40 days back so they cannot disturb the assertions above. Under the
    // old boundary H1 saw 0 instead of 1 and H2 saw 2 instead of 1 — both red.
    console.log("\nPART H — the ET day boundary");
    const stageC = await mkStage(3, "0.0000", 0);
    const bPhones = fictionalPhones(2);
    await refuseIfPhonesInUse(db, bPhones);
    const dayB = formatInCampaignTimezone(
      new Date(Date.now() - 40 * 86_400_000),
      "yyyy-MM-dd",
    );
    // +36h from ET MIDNIGHT lands at ~noon the NEXT ET day (a day is 23-25h),
    // so this is DST-safe rather than a naive +1. Measuring from noon instead
    // overshoots by a whole day, and the two sends stop being adjacent — which
    // leaves H1/H2 green while testing nothing at all.
    const dayBNext = formatInCampaignTimezone(
      new Date(
        fromZonedTime(`${dayB}T00:00:00`, "America/New_York").getTime() +
          36 * 3_600_000,
      ),
      "yyyy-MM-dd",
    );
    // 23:59 on dayB and 00:01 on the next ET day — 2 minutes apart.
    const lateIso = fromZonedTime(`${dayB}T23:59:00`, "America/New_York").toISOString();
    const earlyIso = fromZonedTime(`${dayBNext}T00:01:00`, "America/New_York").toISOString();

    const boundarySend = async (phone: string, iso: string) => {
      const cid = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, line_type)
          VALUES (${org}, ${phone}, 'mobile') RETURNING id`)
      ).id;
      const sid = (
        await one<{ id: string }>(sql`
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text,
             status, sent_at)
          VALUES (${org}, ${camp.id}, ${stageC}, ${cid}::uuid, ${phone}, 'hi',
                  'sent', ${iso}::timestamptz)
          RETURNING id`)
      ).id;
      await db.execute(sql`
        INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, reconstructed)
        VALUES (${sid}::uuid, ${org}, 'cold', false)`);
      return sid;
    };
    await boundarySend(bPhones[0], lateIso);
    await boundarySend(bPhones[1], earlyIso);

    const repB = await getLifecycleReport({ orgId, from: dayB, to: dayB });
    const repBNext = await getLifecycleReport({
      orgId,
      from: dayBNext,
      to: dayBNext,
    });
    const totalOf = (r: typeof repB) =>
      r.rows.find((x) => x.row === "total")!.sends;

    // ⚠️ The fixture's own precondition. If these two stop being 2 minutes
    // apart, H1/H2 pass without testing a boundary at all.
    bar(
      "H0 the two fixtures really are minutes apart across ET midnight",
      Date.parse(earlyIso) - Date.parse(lateIso) === 2 * 60_000,
      `${lateIso} → ${earlyIso}`,
    );
    bar(
      "H1 ⭐ a send at 23:59 ET belongs to THAT ET day",
      totalOf(repB) === 1,
      `${dayB} → ${totalOf(repB)} send(s), expected 1`,
    );
    bar(
      "H2 ⭐ …and one 2 minutes later belongs to the NEXT day, alone",
      totalOf(repBNext) === 1,
      `${dayBNext} → ${totalOf(repBNext)} send(s), expected 1`,
    );
    bar(
      "H3 a two-day window holds both, so neither was simply dropped",
      totalOf(await getLifecycleReport({ orgId, from: dayB, to: dayBNext })) === 2,
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
        console.error(
          `REFUSING TEARDOWN: org ${orgId} lacks the marker (${JSON.stringify(name)})`,
        );
        fail++;
      } else {
        await db.execute(
          sql`DELETE FROM conversion_events WHERE org_id = ${orgId}::uuid`,
        );
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_send_lifecycle WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM clicks WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM opt_outs WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM conversion_events WHERE org_id = ${orgId}::uuid)
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
