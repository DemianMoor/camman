import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// BUYERS ARE REMOVED BEFORE THE CAP SAMPLES — against the PREVIEW DB.
//
// ⭐ N2 IS THE BAR THAT KEEPS THE CHANGE INSIDE ITS SCOPE. PR 4b decided
// deliberately that `bought_offer` is a SEND-TIME overlay: buyers stay in the
// pool and the drain skips them. This change is an exception for CAPPED
// campaigns only, where a buyer surviving the sample occupies a slot nobody
// else can use. A test that only checked the capped case would pass just as
// happily if the exclusion leaked into every campaign — which would freeze a
// decision PR 4b argued must stay at send time.
//
// Every snapshot runs inside a transaction that is ALWAYS rolled back, so no
// campaign_audience_pool rows survive. The pool is read INSIDE that
// transaction, because after the rollback there is nothing to read.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-bought-offer-cap.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__BOUGHT_OFFER_CAP_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

class Rollback extends Error {}

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { snapshotAudience } = await import("@/lib/audience-snapshot");
  type SnapshotInput = Parameters<typeof snapshotAudience>[0];
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `boc-${Date.now()}`;
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
    // A SECOND offer, so "bought something" and "bought THIS offer" differ.
    const other = await one<{ id: number }>(sql`
      INSERT INTO offers (org_id, offer_id, network_id, name)
      VALUES (${org}, ${`o2-${tag}`}, ${net.id}, ${`O2 ${tag}`}) RETURNING id`);
    const etSale = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);

    const mkCampaign = async (slug: string, offerId: number | null) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
          VALUES (${org}, ${`${slug}-${tag}`}, ${`${slug} ${tag}`}, 'completed',
                  'manual', ${brand.id}, ${offerId})
          RETURNING id`)
      ).id;
    const campBuy = await mkCampaign("buy", offer.id);
    const campOther = await mkCampaign("oth", other.id);
    const campUnder = await mkCampaign("under", offer.id);

    // 10 contacts, all 'cold' so one chip selects them all.
    const N = 10;
    const phones = fictionalPhones(N);
    await refuseIfPhonesInUse(db, phones);
    const contacts: string[] = [];
    for (let i = 0; i < N; i++) {
      contacts.push(
        (
          await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number, line_type, lifecycle_status)
            VALUES (${org}, ${phones[i]}, 'mobile', 'cold') RETURNING id`)
        ).id,
      );
    }

    const seg = await one<{ id: number }>(sql`
      INSERT INTO segments (org_id, segment_id, name)
      VALUES (${org}, ${`s-${tag}`}, ${`S ${tag}`}) RETURNING id`);
    for (const cid of contacts) {
      await db.execute(sql`
        INSERT INTO segment_contacts (org_id, segment_id, contact_id)
        VALUES (${org}, ${seg.id}, ${cid}::uuid)`);
    }

    // Contacts 0,1,2 bought THIS offer. Contact 3 bought the OTHER offer — a
    // buyer, but not of this campaign's offer, so they must stay.
    const buy = async (i: number, campaignId: number, suffix: string) =>
      db.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
           campaign_id, event_type_id, status, revenue, occurred_at)
        VALUES (${org}, ${`${tag}-${suffix}`}, 'sale', 'sale', ${contacts[i]}::uuid,
                ${campaignId}, ${etSale.id}, 'approved', '10.0000', now())`);
    await buy(0, campBuy, "b0");
    await buy(1, campBuy, "b1");
    await buy(2, campBuy, "b2");
    await buy(3, campOther, "b3");

    const baseInput = (over: Partial<SnapshotInput>): SnapshotInput =>
      ({
        orgId,
        campaignId: campBuy,
        lifecycleRules: true,
        segmentIds: [seg.id],
        contactGroupIds: [],
        filters: { lifecycle_statuses: ["cold"] },
        offerId: offer.id,
        excludePriorOffer: false,
        offerRulesEnabled: false,
        offerCooldownDays: 7,
        offerLimitTimes: 5,
        excludeInUse: false,
        ...over,
      }) as SnapshotInput;

    // Snapshot, read the pool INSIDE the tx, then roll back.
    const pooled = async (input: SnapshotInput) => {
      let ids: string[] = [];
      let total = 0;
      try {
        await db.transaction(async (tx) => {
          const snap = await snapshotAudience(input, tx);
          total = snap.total_matching;
          const rows = (await tx.execute(sql`
            SELECT contact_id::text AS contact_id FROM campaign_audience_pool
            WHERE campaign_id = ${input.campaignId}`)) as unknown as {
            contact_id: string;
          }[];
          ids = rows.map((r) => r.contact_id);
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      return { ids, total };
    };
    const buyersIn = (ids: string[]) =>
      [contacts[0], contacts[1], contacts[2]].filter((c) => ids.includes(c))
        .length;

    console.log("PART N — buyers and the cap");

    const capped = await pooled(baseInput({ cap: 5 }));
    bar(
      "N1 ⭐ capped + lifecycle: no buyer of this offer is in the frozen pool",
      buyersIn(capped.ids) === 0,
      `${buyersIn(capped.ids)} buyer(s) of 3 in a pool of ${capped.ids.length}`,
    );

    const uncapped = await pooled(baseInput({ cap: null }));
    bar(
      "N2 ⭐ UNCAPPED + lifecycle: buyers are STILL IN the pool",
      buyersIn(uncapped.ids) === 3 && uncapped.ids.length === 10,
      `${buyersIn(uncapped.ids)} buyer(s) of 3 in a pool of ${uncapped.ids.length} — PR 4b's send-time overlay, unchanged`,
    );

    const legacy = await pooled(
      baseInput({
        cap: 5,
        lifecycleRules: false,
        filters: { include_no_status: true, include_not_clicked: true },
      }),
    );
    bar(
      "N3 LEGACY campaign with a cap: buyers still in the pool",
      legacy.ids.length === 5 && buyersIn(legacy.ids) > 0,
      `pool ${legacy.ids.length}, ${buyersIn(legacy.ids)} buyer(s) — lifecycle-only change`,
    );

    bar(
      "N4 ⭐ the cap is honoured AFTER the removal: exactly 5, none of them buyers",
      capped.ids.length === 5 && buyersIn(capped.ids) === 0,
      `pool ${capped.ids.length} of a 7-strong non-buyer set; sampling 5 from 10 would waste ~1.5 slots`,
    );
    bar(
      "N4b …and total_matching reports the post-removal pool, not the pre-removal one",
      capped.total === 7,
      `total_matching ${capped.total}, expected 7 (10 − 3 buyers)`,
    );

    const noOffer = await pooled(
      baseInput({ campaignId: campUnder, cap: 5, offerId: null }),
    );
    bar(
      "N5 no offer on the campaign ⇒ no-op, the layer cannot be built",
      noOffer.ids.length === 5 && noOffer.total === 10,
      `pool ${noOffer.ids.length}, total ${noOffer.total}`,
    );

    const bigCap = await pooled(baseInput({ cap: 50 }));
    bar(
      "N6 cap LARGER than the qualified set ⇒ every non-buyer, no error",
      bigCap.ids.length === 7 && buyersIn(bigCap.ids) === 0,
      `pool ${bigCap.ids.length}, expected 7`,
    );

    // ⚠️ The one that says WHICH buyers. Excluding every buyer of any offer
    // would also make N1 green, and would be wrong.
    bar(
      "N7 ⭐ a buyer of a DIFFERENT offer is not excluded",
      bigCap.ids.includes(contacts[3]),
      `contact 3 bought another offer and must stay`,
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
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaign_audience_pool WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM conversion_events WHERE org_id = ${orgId}::uuid)) AS n`);
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
