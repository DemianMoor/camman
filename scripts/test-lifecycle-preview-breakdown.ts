import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The PR 4b audience-preview breakdown (Task 4) against the PREVIEW DB:
// by-status counts, freeze-not-due, and the EXCLUSIVE exclusion buckets.
//
// Goes through previewAudience — the function the campaign form calls — not a
// rebuilt aggregate. The bars that matter are the exclusivity ones: a lead who
// is suppressed AND in use elsewhere must appear under exactly one bucket, and
// the buckets plus the sending audience must account for the whole base with
// nothing double-counted and nothing lost.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-preview-breakdown.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const NOW = Date.now();
const MARKER = "__LIFECYCLE_BREAKDOWN_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { previewAudience } = await import("@/lib/audience-snapshot");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `bkdn-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const net = await one<{ id: number }>(
      sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`,
    );
    const brand = await one<{ id: number }>(
      sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
    );
    const offer = await one<{ id: number }>(
      sql`INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`o-${tag}`}, ${net.id}, ${`O ${tag}`}) RETURNING id`,
    );
    const etSale = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);
    // The campaign the purchase happened in, and an ACTIVE one whose frozen
    // pool makes a contact "in use elsewhere".
    const campPast = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
      VALUES (${org}, ${`bk-past-${tag}`}, ${`past ${tag}`}, 'completed', 'manual',
              ${brand.id}, ${offer.id}) RETURNING id`);
    const campActive = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
      VALUES (${org}, ${`bk-act-${tag}`}, ${`act ${tag}`}, 'active', 'manual',
              ${brand.id}, ${offer.id}) RETURNING id`);

    // One segment holding every contact, so segment membership is never the
    // thing under test.
    const segId = (
      await one<{ id: number }>(sql`
        INSERT INTO segments (org_id, segment_id, name)
        VALUES (${org}, ${`s-${tag}`}, ${`seg ${tag}`}) RETURNING id`)
    ).id;

    const phones = fictionalPhones(11);
    await refuseIfPhonesInUse(db, phones);

    const mk = async (
      i: number,
      lifecycle: string,
      eng?: { last_sent_at: string | null; freeze_cadence_days: number },
    ) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
          VALUES (${org}, ${phones[i]}, ${lifecycle}, 'mobile') RETURNING id`)
      ).id;
      await db.execute(
        sql`INSERT INTO segment_contacts (org_id, segment_id, contact_id) VALUES (${org}, ${segId}, ${id}::uuid)`,
      );
      if (eng) {
        await db.execute(sql`
          INSERT INTO contact_engagement
            (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
             msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at,
             freeze_cadence_days, thresholds)
          VALUES (${id}::uuid, ${org}, ${lifecycle}, now(), 5, 5, 0, 0, 0, 0,
                  ${eng.last_sent_at}::timestamptz, null, ${eng.freeze_cadence_days}, '{}'::jsonb)`);
      }
      return id;
    };

    const cNew = await mk(0, "new");
    const cHot = await mk(1, "hot");
    const cWarm = await mk(2, "warm");
    const cCold1 = await mk(3, "cold");
    const cCold2 = await mk(4, "cold");
    // Freeze, inside its own cadence ⇒ in the audience but not due.
    const cFreezeNotDue = await mk(5, "freeze", {
      last_sent_at: ago(10),
      freeze_cadence_days: 30,
    });
    // Freeze, past its cadence ⇒ in the audience and due.
    const cFreezeDue = await mk(6, "freeze", {
      last_sent_at: ago(60),
      freeze_cadence_days: 30,
    });
    const cOptedOut = await mk(7, "cold");
    // ⭐ Suppressed AND in an active pool AND a buyer: three reasons at once.
    // Exactly one bucket may claim it.
    const cTriple = await mk(8, "suppressed");
    const cInUse = await mk(9, "cold");
    // A buyer with a SELECTED status: in the audience, skipped at send time.
    // Without this one the send_time.bought_offer bar would pass at zero.
    const cBuyer = await mk(10, "cold");

    await db.execute(
      sql`INSERT INTO opt_outs (org_id, contact_id, phone_number) VALUES (${org}, ${cOptedOut}::uuid, ${phones[7]})`,
    );
    for (const cid of [cTriple, cInUse]) {
      await db.execute(sql`
        INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id)
        VALUES (${org}, ${campActive.id}, ${cid}::uuid)`);
    }
    await db.execute(sql`
      INSERT INTO conversion_events
        (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
         campaign_id, event_type_id, status, revenue, occurred_at)
      VALUES (${org}, ${`${tag}-triple`}, 'sale', 'sale', ${cTriple}::uuid,
              ${campPast.id}, ${etSale.id}, 'approved', '10.0000', now())`);
    await db.execute(sql`
      INSERT INTO conversion_events
        (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
         campaign_id, event_type_id, status, revenue, occurred_at)
      VALUES (${org}, ${`${tag}-buyer`}, 'sale', 'sale', ${cBuyer}::uuid,
              ${campPast.id}, ${etSale.id}, 'approved', '10.0000', now())`);

    const names: Record<string, string> = {
      [cNew]: "new",
      [cHot]: "hot",
      [cWarm]: "warm",
      [cCold1]: "cold1",
      [cCold2]: "cold2",
      [cFreezeNotDue]: "freeze-notdue",
      [cFreezeDue]: "freeze-due",
      [cOptedOut]: "optedout",
      [cTriple]: "triple",
      [cInUse]: "inuse",
      [cBuyer]: "buyer",
    };
    void names;

    const preview = (chips: string[], excludeInUse: boolean) =>
      previewAudience({
        orgId,
        lifecycleRules: true,
        segmentIds: [segId],
        filters: { lifecycle_statuses: chips },
        offerId: offer.id,
        excludeInUse,
      });

    console.log("PART F — the lifecycle preview breakdown");

    // Chips: every status EXCEPT hot. cHot then lands in status_not_selected.
    const r = await preview(["new", "warm", "cold", "freeze"], false);
    const lc = r.lifecycle!;
    bar("F1 a lifecycle campaign gets a lifecycle breakdown", !!lc);

    const bs = lc.by_status;
    bar(
      "F2 by_status counts the SENDING audience per status",
      // cold is 3, not 2: cInUse is cold and exclude_in_use is OFF here, so it
      // sends. cOptedOut is cold too but opted out, so it does not.
      bs.new === 1 && bs.warm === 1 && bs.cold === 4 && bs.freeze === 2,
      JSON.stringify(bs),
    );
    bar(
      "F3 an unselected status contributes 0, and the key is still present",
      bs.hot === 0 && "hot" in bs,
      `hot=${bs.hot}`,
    );
    bar(
      "F4 by_status sums to total_matching",
      Object.values(bs).reduce((a, b) => a + b, 0) === r.total_matching,
      `${Object.values(bs).reduce((a, b) => a + b, 0)} vs ${r.total_matching}`,
    );

    // The freeze pair differs ONLY in last_sent_at vs its cadence.
    // send_time numbers OVERLAY the audience — these leads are in it.
    bar(
      "F5 freeze_not_due counts the frozen-but-not-due half of Freeze",
      lc.send_time.freeze_not_due === 1 && bs.freeze === 2,
      `${lc.send_time.freeze_not_due} of ${bs.freeze} freeze`,
    );

    // ── the exclusive buckets ──────────────────────────────────────────────
    const ex = lc.excluded;
    bar(
      "F6 opted out is its own bucket",
      ex.opted_out === 1,
      JSON.stringify(ex),
    );
    // ⭐ cTriple is suppressed AND a buyer AND in an active pool. Priority says
    // suppressed wins; no other bucket may also count it.
    bar(
      "F7 a lead with THREE reasons is counted once, under the first",
      ex.suppressed === 1 && ex.in_use_elsewhere === 0,
      `suppressed=${ex.suppressed} in_use=${ex.in_use_elsewhere}`,
    );
    bar(
      "F8 an unselected status is its own bucket (hot)",
      ex.status_not_selected === 1,
      `${ex.status_not_selected}`,
    );
    // With the toggle OFF these leads send, so calling them excluded would be
    // a lie — the bucket must be empty.
    bar(
      "F9 in_use_elsewhere is 0 while exclude_in_use is OFF (they send)",
      ex.in_use_elsewhere === 0,
      `${ex.in_use_elsewhere}`,
    );
    // With it ON, cInUse leaves the audience and lands in the bucket; cTriple
    // is still claimed by suppressed, one bucket earlier.
    const rOn = await preview(["new", "warm", "cold", "freeze"], true);
    bar(
      "F9b with exclude_in_use ON the bucket fills and the audience shrinks",
      rOn.lifecycle!.excluded.in_use_elsewhere === 1 &&
        rOn.total_matching === r.total_matching - 1,
      `bucket=${rOn.lifecycle!.excluded.in_use_elsewhere}, ${r.total_matching} → ${rOn.total_matching}`,
    );
    // The send-time overlay is a SUBSET of the audience, never a bucket.
    bar(
      "F9c bought_offer is a send-time OVERLAY: in the audience, skipped later",
      lc.send_time.bought_offer === 1 &&
        !(Object.keys(ex) as string[]).includes("bought_offer"),
      `send_time.bought_offer=${lc.send_time.bought_offer}, still inside total_matching`,
    );

    // ⭐ The accounting bar: every lead in the base is either sending or in
    // exactly one bucket. This is what makes the buckets trustworthy — it goes
    // red both if a bucket double-counts and if one silently drops a lead.
    const bucketSum = Object.values(ex).reduce((a, b) => a + b, 0);
    const base = (
      await all<{ n: string }>(
        sql`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${org}`,
      )
    )[0];
    bar(
      "F10 audience + every bucket = the whole base, counted once each",
      r.total_matching + bucketSum === Number(base.n),
      `${r.total_matching} in audience + ${bucketSum} excluded = ${r.total_matching + bucketSum} of ${base.n}`,
    );
    const sumOn = Object.values(rOn.lifecycle!.excluded).reduce(
      (a, b) => a + b,
      0,
    );
    bar(
      "F10b the identity still holds with exclude_in_use ON",
      rOn.total_matching + sumOn === Number(base.n),
      `${rOn.total_matching} + ${sumOn} = ${rOn.total_matching + sumOn} of ${base.n}`,
    );

    // ── the legacy shape is untouched ──────────────────────────────────────
    const legacy = await previewAudience({
      orgId,
      segmentIds: [segId],
      filters: { include_no_status: true },
      offerId: offer.id,
    });
    bar(
      "F11 a legacy campaign gets NO lifecycle key at all",
      legacy.lifecycle === undefined && !("lifecycle" in legacy),
      legacy.lifecycle === undefined ? "absent" : "PRESENT",
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
        await db.execute(
          sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`,
        );
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM conversion_events WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
