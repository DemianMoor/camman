// DB checks for getOfferSplits (lib/reporting/offer-splits.ts) on the PREVIEW DB.
//
//   D1 returns only the moved rows (offer differs from the campaign offer), per (stage, offer)
//   D2 amounts: sales / approved revenue / pending revenue / events by key
//   D3 the ET date window: inclusive, dated by occurred_at in ET (a 23:30 ET row is that ET day, not the UTC one)
//   D4 null range = lifetime
//   D5 org isolation: another org's stage id and rows are never returned
//   D6 empty stage list => []
//
// getOfferSplits uses the shared db client, so fixtures are COMMITTED and removed by id in `finally`.
//
// Run (preview DB only):
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2- | tr -d '\r\"')" \
//     npx tsx --conditions=react-server scripts/test-offer-splits-db.ts
import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__OFFER_SPLITS_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { getOfferSplits } = await import("@/lib/reporting/offer-splits");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const tag = `ofs-${Date.now()}`;
  const orgs: string[] = [];
  const ceIds: number[] = [];

  try {
    const mkOrg = async (s: string) => {
      const id = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag} ${s}`}) RETURNING id`)).id;
      orgs.push(id);
      return id;
    };
    const orgId = await mkOrg("main");
    const otherOrg = await mkOrg("other");

    const mkOffer = async (org: string, s: string) => {
      const net = await one<{ id: number }>(
        sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}::uuid, ${`n${s}-${tag}`}, ${`N${s} ${tag}`}) RETURNING id`,
      );
      return (
        await one<{ id: number }>(sql`
          INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}::uuid, ${`o${s}-${tag}`}, ${net.id}, ${`O${s} ${tag}`}) RETURNING id`)
      ).id;
    };
    const offerA = await mkOffer(orgId, "a");
    const offerB = await mkOffer(orgId, "b");
    const offerC = await mkOffer(orgId, "c");
    const offerX = await mkOffer(otherOrg, "x");
    const offerY = await mkOffer(otherOrg, "y");

    const mkEt = async (org: string, key: string, isPurchase: boolean, revenue: boolean) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
          VALUES (${org}::uuid, ${key}, ${key}, ${isPurchase}, ${revenue}) RETURNING id`)
      ).id;
    const etSale = await mkEt(orgId, "sale", true, true);
    const etLead = await mkEt(orgId, "lead", false, false);
    const etOther = await mkEt(otherOrg, "sale", true, true);

    const mkStage = async (org: string, offer: number, s: string) => {
      const brand = await one<{ id: number }>(
        sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}::uuid, ${`b${s}-${tag}`}, ${`B${s} ${tag}`}) RETURNING id`,
      );
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
        VALUES (${org}::uuid, ${`c${s}-${tag}`}, ${`C${s} ${tag}`}, 'active', 'manual', ${brand.id}, ${offer}) RETURNING id`);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
        VALUES (${org}::uuid, ${camp.id}, 1, 'STOP') RETURNING id`);
      return { camp: camp.id, stage: stage.id };
    };
    const main = await mkStage(orgId, offerA, "m");
    const other = await mkStage(otherOrg, offerX, "o");

    let seq = 0;
    const ce = async (
      org: string, s: { camp: number; stage: number }, offer: number | null, et: number,
      status: string, revenue: string, occurredAt: string,
    ) => {
      const id = (
        await one<{ id: number }>(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, campaign_id, stage_id, offer_id,
             event_type_id, status, revenue, occurred_at)
          VALUES (${org}::uuid, ${`${tag}-${++seq}`}, 'sale', 'sale', ${s.camp}, ${s.stage}, ${offer},
                  ${et}, ${status}, ${revenue}::numeric, ${occurredAt}::timestamptz)
          RETURNING id`)
      ).id;
      ceIds.push(id);
      return id;
    };
    // ET is UTC-5 in January (EST). 2027-01-10 04:30Z = 2027-01-09 23:30 ET.
    await ce(orgId, main, offerA, etSale, "approved", "100", "2027-01-09T15:00:00Z"); // on campaign offer: not a split
    await ce(orgId, main, offerB, etSale, "approved", "30", "2027-01-09T15:00:00Z"); // split B, 9th
    await ce(orgId, main, offerB, etSale, "pending", "12", "2027-01-10T04:30:00Z"); // split B, 9th ET (10th UTC)
    await ce(orgId, main, offerB, etLead, "approved", "0", "2027-01-10T16:00:00Z"); // split B lead, 10th
    await ce(orgId, main, offerB, etSale, "rejected", "99", "2027-01-10T16:00:00Z"); // rejected: counts nowhere
    await ce(orgId, main, offerC, etSale, "approved", "7", "2027-01-11T16:00:00Z"); // split C, 11th
    await ce(orgId, main, null, etSale, "approved", "50", "2027-01-09T15:00:00Z"); // null offer: not a split
    await ce(otherOrg, other, offerY, etOther, "approved", "1000", "2027-01-09T15:00:00Z"); // other org split
    // Cross-org defence: an other-org row stamped with main's stage id must not leak into main.
    await ce(otherOrg, main, offerY, etOther, "approved", "5", "2027-01-09T15:00:00Z");

    // D1/D2 lifetime
    const life = await getOfferSplits(orgId, [main.stage], null);
    const b = life.find((x) => x.offer_id === offerB);
    const c = life.find((x) => x.offer_id === offerC);
    console.log("D1/D2/D4 lifetime");
    bar("only offers B and C (not the campaign offer, not null-offer, not the other org)", life.length === 2 && !!b && !!c, JSON.stringify(life));
    bar("B: sales 2 (approved + pending count, rejected does not), revenue 30, pending 12",
      b?.sales === 2 && b.revenue === 30 && b.pending_revenue === 12, JSON.stringify(b));
    bar("B events: sale {n1, pending_n1, rev30, prev12}, lead {n1}",
      b?.events.sale?.n === 2 && b.events.sale.pending_n === 1 && b.events.sale.revenue === 30 &&
        b.events.sale.pending_revenue === 12 && b.events.lead?.n === 1 && Object.keys(b.events).length === 2,
      JSON.stringify(b?.events));
    bar("C: sales 1, revenue 7", c?.sales === 1 && c.revenue === 7, JSON.stringify(c));

    // D3 ET window
    console.log("\nD3 ET window");
    const d9 = await getOfferSplits(orgId, [main.stage], { fromEt: "2027-01-09", toEt: "2027-01-09" });
    bar("2027-01-09 only: B's two sale rows (the 23:30 ET one is the 9th), no lead, no C",
      d9.length === 1 && d9[0].offer_id === offerB && d9[0].revenue === 30 && d9[0].pending_revenue === 12 && !d9[0].events.lead,
      JSON.stringify(d9));
    const d10 = await getOfferSplits(orgId, [main.stage], { fromEt: "2027-01-10", toEt: "2027-01-10" });
    bar("2027-01-10 only: B lead only (the 04:30Z row is NOT the 10th ET)",
      d10.length === 1 && d10[0].offer_id === offerB && d10[0].sales === 0 && d10[0].revenue === 0 && d10[0].events.lead?.n === 1 && !d10[0].events.sale,
      JSON.stringify(d10));
    const d1011 = await getOfferSplits(orgId, [main.stage], { fromEt: "2027-01-10", toEt: "2027-01-11" });
    bar("10th..11th inclusive: B and C", d1011.length === 2, JSON.stringify(d1011));
    const none = await getOfferSplits(orgId, [main.stage], { fromEt: "2027-02-01", toEt: "2027-02-02" });
    bar("a window with no rows => []", none.length === 0);

    // D5 org isolation
    console.log("\nD5 org isolation");
    const cross = await getOfferSplits(orgId, [other.stage], null);
    bar("main org asking for the other org's stage => []", cross.length === 0, JSON.stringify(cross));
    const otherOwn = await getOfferSplits(otherOrg, [other.stage, main.stage], null);
    bar("other org sees its own split, and none of main's stage rows via a foreign stage join",
      otherOwn.length === 1 && otherOwn[0].offer_id === offerY && otherOwn[0].revenue === 1000, JSON.stringify(otherOwn));

    // D6
    bar("D6 empty stage list => []", (await getOfferSplits(orgId, [], null)).length === 0);
  } finally {
    // Remove by id, children first.
    if (ceIds.length) {
      await db.execute(sql`DELETE FROM conversion_events WHERE id IN (${sql.join(ceIds.map((i) => sql`${i}`), sql`, `)})`);
    }
    for (const o of orgs) {
      await db.execute(sql`DELETE FROM campaign_stages WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM brands WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM event_types WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM offers WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM affiliate_networks WHERE org_id = ${o}::uuid`);
      await db.execute(sql`DELETE FROM organizations WHERE id = ${o}::uuid`);
    }
    const left = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`${MARKER} ${tag}%`}`);
    bar("teardown left no fixture org", left.n === 0);
  }

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
