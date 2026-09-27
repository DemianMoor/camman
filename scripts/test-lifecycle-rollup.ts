import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE LIFECYCLE DAY ROLLUP (migration 0192) against the PREVIEW DB.
//
// ⭐ P1 IS THE BAR THE WHOLE TABLE RESTS ON: the rollup must produce the SAME
// numbers as the per-recipient query it replaces. A rollup that is merely fast
// is worthless — the report's entire claim is that these ARE the per-recipient
// numbers, summed.
//
// ⚠️ WHAT P1 CAN AND CANNOT PROVE. `lifecycleDayRowsSql` is `lifecycleReportSql`
// with one extra GROUP BY column, so P1 is NOT an independent check of what a
// clicker is — that definition is shared on purpose, precisely so it cannot
// drift. What P1 does test is everything the rollup adds around it: the day
// split, the store, the delete-then-insert, and the summation back across days.
// Those are the parts that can be wrong, and P3 and P4 attack them directly.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-rollup.ts

import { fromZonedTime } from "date-fns-tz";
import { sql, type SQL } from "drizzle-orm";

const MARKER = "__LIFECYCLE_ROLLUP_TEST__";
const TZ = "America/New_York";

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
  const { getLifecycleReport } = await import("@/lib/reporting/lifecycle-report");
  const { refreshLifecycleDayRollup, getLifecycleReportHybrid } =
    await import("@/lib/reporting/lifecycle-rollup");
  const { formatInCampaignTimezone } = await import("@/lib/campaign-timezone");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `lcr-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);
    const dom = await one<{ id: number }>(sql`
      INSERT INTO short_domains (org_id, brand_id, domain)
      VALUES (${org}, ${brand.id}, ${`${tag}.example`}) RETURNING id`);
    const dest = await one<{ id: number }>(sql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${org}, 'https://example.com/x', ${`h-${tag}`}) RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id)
      VALUES (${org}, ${`c-${tag}`}, ${`C ${tag}`}, 'completed', 'manual', ${brand.id})
      RETURNING id`);
    const mkStage = async (n: number) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, stop_text, total_cost, sms_count, opt_out_count)
          VALUES (${org}, ${camp.id}, ${n}, 'STOP', '1.0000', 0, 0) RETURNING id`)
      ).id;

    // Three ET days: two closed (D1, D2) and today.
    const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
    const dayN = (back: number) =>
      formatInCampaignTimezone(
        new Date(Date.now() - back * 86_400_000),
        "yyyy-MM-dd",
      );
    const D1 = dayN(5);
    const D2 = dayN(4);

    const stageFor: Record<string, number> = {
      [D1]: await mkStage(1),
      [D2]: await mkStage(2),
      [today]: await mkStage(3),
    };

    // 12 contacts spread across the three days; day 1 clicks a lot, day 2 barely.
    const plan: { day: string; status: string; clicks: boolean }[] = [
      { day: D1, status: "hot", clicks: true },
      { day: D1, status: "hot", clicks: true },
      { day: D1, status: "hot", clicks: true },
      { day: D1, status: "cold", clicks: false },
      { day: D2, status: "hot", clicks: false },
      { day: D2, status: "hot", clicks: false },
      { day: D2, status: "hot", clicks: false },
      { day: D2, status: "hot", clicks: true },
      { day: D2, status: "cold", clicks: false },
      { day: today, status: "warm", clicks: true },
      { day: today, status: "cold", clicks: false },
      { day: today, status: "cold", clicks: false },
    ];
    const phones = fictionalPhones(plan.length + 1);
    await refuseIfPhonesInUse(db, phones);

    const sendIds: string[] = [];
    for (const [i, row] of plan.entries()) {
      const cid = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, line_type)
          VALUES (${org}, ${phones[i]}, 'mobile') RETURNING id`)
      ).id;
      // Mid-afternoon ET, safely inside the day from either direction.
      const at = fromZonedTime(`${row.day}T14:30:00`, TZ).toISOString();
      const sid = (
        await one<{ id: string }>(sql`
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text,
             status, sent_at, cost_per_sms)
          VALUES (${org}, ${camp.id}, ${stageFor[row.day]}, ${cid}::uuid,
                  ${phones[i]}, 'hi', 'sent', ${at}::timestamptz, '0.0100')
          RETURNING id`)
      ).id;
      sendIds.push(sid);
      await db.execute(sql`
        INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, reconstructed)
        VALUES (${sid}::uuid, ${org}, ${row.status}, false)`);
      if (row.clicks) {
        const link = await one<{ id: number }>(sql`
            INSERT INTO links (org_id, code, short_domain_id, destination_id,
                               campaign_id, stage_id, contact_id, send_token,
                               campaign_tracking_id, stage_tracking_id)
            VALUES (${org}, ${`${tag}-${i}`}, ${dom.id}, ${dest.id}, ${camp.id},
                    ${stageFor[row.day]}, ${cid}::uuid, ${`t-${tag}-${i}`},
                    ${`ct-${tag}`}, ${`st-${tag}`}) RETURNING id`);
        await db.execute(sql`
          INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at)
          VALUES (${org}, ${link.id}, ${at}::timestamptz, 'human', ${at}::timestamptz)`);
      }
    }

    // ── PART P — the rollup equals the direct query ─────────────────────────
    console.log("PART P — rollup vs the per-recipient query");
    await refreshLifecycleDayRollup(db, { orgId, from: D1, to: today });

    const cmp = async (label: string, from: string, to: string) => {
      const direct = await getLifecycleReport({ orgId, from, to });
      const rows = await all<Record<string, string>>(sql`
        SELECT cohort AS row, sum(sends)::int AS sends,
               sum(clickers)::int AS clickers, sum(sales)::int AS sales,
               sum(revenue)::text AS revenue, sum(opt_outs)::int AS opt_outs,
               sum(cost)::text AS cost
        FROM lifecycle_day_rollup
        WHERE org_id = ${org} AND et_day BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1`);
      const roll = new Map(rows.map((r) => [r.row, r]));
      const diffs: string[] = [];
      for (const c of ["new", "cold", "hot", "warm", "freeze", "suppressed", "__unclassified__"]) {
        const d = direct.rows.find(
          (x) => x.row === (c === "__unclassified__" ? "unclassified" : c),
        );
        const r = roll.get(c);
        const dv = {
          sends: d?.sends ?? 0,
          clickers: d?.clickers ?? 0,
          sales: d?.sales ?? 0,
          opt_outs: d?.opt_outs ?? 0,
          revenue: Number(d?.revenue ?? 0),
          cost: Number(d?.cost ?? 0),
        };
        const rv = {
          sends: Number(r?.sends ?? 0),
          clickers: Number(r?.clickers ?? 0),
          sales: Number(r?.sales ?? 0),
          opt_outs: Number(r?.opt_outs ?? 0),
          revenue: Number(r?.revenue ?? 0),
          cost: Number(r?.cost ?? 0),
        };
        for (const k of Object.keys(dv) as (keyof typeof dv)[]) {
          if (Math.abs(dv[k] - rv[k]) > 1e-6) {
            diffs.push(`${c}.${k}: direct ${dv[k]} vs rollup ${rv[k]}`);
          }
        }
      }
      return diffs;
    };

    const d1 = await cmp("D1", D1, D1);
    bar(
      "P1 ⭐ a sampled CLOSED day agrees on every column",
      d1.length === 0,
      d1.length ? d1.join(" · ") : `${D1}: identical`,
    );
    const span = await cmp("span", D1, D2);
    bar(
      "P2 …and so does a multi-day span, summed",
      span.length === 0,
      span.length ? span.join(" · ") : `${D1}..${D2}: identical`,
    );

    // ── PART Q — ratios are DERIVED, not stored and averaged ────────────────
    console.log("\nPART Q — pooled ratios, not averaged ones");
    const hot2 = await getLifecycleReportHybrid({ orgId, from: D1, to: D2 });
    const hotRow = hot2.rows.find((r) => r.row === "hot")!;
    // D1 hot: 3 sends, 3 clickers (100%). D2 hot: 4 sends, 1 clicker (25%).
    // Pooled = 4/7 = 57.14%. The average of the two days would be 62.5%.
    bar(
      "Q1 ⭐ CTR is the pooled numerator over the pooled denominator",
      Math.abs((hotRow.ctr ?? 0) - 4 / 7) < 1e-9,
      `${((hotRow.ctr ?? 0) * 100).toFixed(2)}% (pooled 57.14%; averaging the two days would give 62.50%)`,
    );

    // ── PART R — the delete-then-insert removes a stale cell ────────────────
    console.log("\nPART R — a cell that should disappear, does");
    const extraPhone = phones[plan.length];
    const cidX = (
      await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type)
        VALUES (${org}, ${extraPhone}, 'mobile') RETURNING id`)
    ).id;
    const atX = fromZonedTime(`${D1}T15:00:00`, TZ).toISOString();
    const sidX = (
      await one<{ id: string }>(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text,
           status, sent_at, cost_per_sms)
        VALUES (${org}, ${camp.id}, ${stageFor[D1]}, ${cidX}::uuid, ${extraPhone},
                'hi', 'sent', ${atX}::timestamptz, '0.0100') RETURNING id`)
    ).id;
    await refreshLifecycleDayRollup(db, { orgId, from: D1, to: D1 });
    const unclassBefore = await one<{ n: number }>(sql`
      SELECT coalesce(sum(sends), 0)::int AS n FROM lifecycle_day_rollup
      WHERE org_id = ${org} AND et_day = ${D1}::date AND cohort = '__unclassified__'`);
    bar(
      "R1 an unstamped send rolls up as __unclassified__",
      Number(unclassBefore.n) === 1,
      `${unclassBefore.n}`,
    );
    // Now stamp it — as the reconstruction would — and recompute the day.
    await db.execute(sql`
      INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, reconstructed)
      VALUES (${sidX}::uuid, ${org}, 'cold', true)`);
    await refreshLifecycleDayRollup(db, { orgId, from: D1, to: D1 });
    const unclassAfter = await all<{ n: string }>(sql`
      SELECT sends::text AS n FROM lifecycle_day_rollup
      WHERE org_id = ${org} AND et_day = ${D1}::date AND cohort = '__unclassified__'`);
    bar(
      "R2 ⭐ once stamped, the __unclassified__ CELL IS GONE, not left at its old value",
      unclassAfter.length === 0,
      unclassAfter.length ? `still ${unclassAfter[0].n}` : "row removed",
    );
    bar(
      "R3 …and the reconstructed flag reached the rollup",
      (
        await one<{ r: boolean }>(sql`
          SELECT bool_or(reconstructed) AS r FROM lifecycle_day_rollup
          WHERE org_id = ${org} AND et_day = ${D1}::date`)
      ).r === true,
    );

    // ── PART S — the hybrid: today is live ──────────────────────────────────
    console.log("\nPART S — today is counted live, not from the rollup");
    await db.execute(sql`
      DELETE FROM lifecycle_day_rollup
      WHERE org_id = ${org} AND et_day = ${today}::date`);
    const hyb = await getLifecycleReportHybrid({ orgId, from: D1, to: today });
    const total = hyb.rows.find((r) => r.row === "total")!;
    const directAll = await getLifecycleReport({ orgId, from: D1, to: today });
    const directTotal = directAll.rows.find((r) => r.row === "total")!;
    bar(
      "S1 ⭐ today's sends appear with NO rollup row for today at all",
      total.sends === directTotal.sends,
      `hybrid ${total.sends} vs direct ${directTotal.sends}`,
    );
    bar(
      "S2 …and the read says the closed half is one live day short of the window",
      hyb.live_days === 1 && hyb.rollup_computed_at !== null,
      `live_days=${hyb.live_days}, computed_at=${hyb.rollup_computed_at}`,
    );
    // ⭐ Proves the closed half really comes FROM the rollup rather than being
    // quietly recomputed: delete a closed day's rows and its sends must vanish
    // from the total. If they survived, the "rollup" would be decorative and
    // the 92-day cap would be resting on nothing.
    const d2Sends = (
      await one<{ n: number }>(sql`
        SELECT coalesce(sum(sends), 0)::int AS n FROM lifecycle_day_rollup
        WHERE org_id = ${org} AND et_day = ${D2}::date`)
    ).n;
    await db.execute(sql`
      DELETE FROM lifecycle_day_rollup
      WHERE org_id = ${org} AND et_day = ${D2}::date`);
    const hyb2 = await getLifecycleReportHybrid({ orgId, from: D1, to: today });
    const total2 = hyb2.rows.find((r) => r.row === "total")!;
    bar(
      "S3 ⭐ the closed half is READ from the rollup, not recomputed behind it",
      total2.sends === total.sends - Number(d2Sends) && Number(d2Sends) > 0,
      `${total.sends} − ${d2Sends} (deleted ${D2}) = ${total2.sends}`,
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
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM lifecycle_day_rollup WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM clicks WHERE org_id = ${orgId}::uuid)) AS n`);
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
