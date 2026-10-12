import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { getDripFunnel } from "@/lib/drip/funnel";

import { seedConversionEvent } from "./_conversion-fixture";

// Journey funnel same-day vs carried split (carry-over spec §8). Runs in one
// rolled-back transaction on the preview DB.

let failures = 0;
function bar(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
}

class Rollback extends Error {}

async function main() {
  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[]
      )[0].id;
      const sfx = String(Date.now()).slice(-7);
      const campId = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
          VALUES (${orgId}, ${"fs-" + sfx}, 'funnel split probe', 'active', 'drip', 'tracked')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const stageId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
          VALUES (${orgId}, ${campId}, 1, 0, 1440, true) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;

      let seq = 0;
      async function newContact(): Promise<string> {
        const n = seq++;
        return (
          (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1997" + n + sfx})
            RETURNING id`)) as unknown as { id: string }[]
        )[0].id;
      }
      async function leadEvent(cid: string): Promise<string> {
        const n = seq++;
        const pk = (await createPartnerWithKey(tx, {
          orgId, slug: "fs" + sfx + n, name: "probe", token: "fstok" + sfx + n,
        })).keyId;
        return (
          (await tx.execute(sql`
            INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
            VALUES (${orgId}, ${cid}, ${pk}, 'probe', now()) RETURNING id`)) as unknown as { id: string }[]
        )[0].id;
      }
      async function journey(cid: string, carriedDays: number, sent: boolean, hoursAgo = 2, closed = false) {
        const le = await leadEvent(cid);
        const hrs = sql.raw(String(hoursAgo));
        if (closed) {
          await tx.execute(sql`
            INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state,
                                       close_reason, closed_at, routed_at, first_send_at,
                                       first_stage_id, carried_days)
            VALUES (${orgId}, ${campId}, ${cid}, ${le}, 'completed', 'all_stages_sent',
                    now() - interval '1 hour' * ${hrs} + interval '30 minutes',
                    now() - interval '1 hour' * ${hrs}, now() - interval '1 hour' * ${hrs},
                    ${stageId}, ${carriedDays})`);
          return;
        }
        await tx.execute(sql`
          INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state,
                                     routed_at, first_send_at, first_stage_id, carried_days)
          VALUES (${orgId}, ${campId}, ${cid}, ${le}, ${sent ? "active" : "routed"},
                  now() - interval '1 hour' * ${hrs}, ${sent ? sql`now()` : null},
                  ${sent ? stageId : null}, ${carriedDays})`);
      }
      const buy = (cid: string, hoursAgo = 0) =>
        seedConversionEvent(tx, {
          orgId, eventKey: "purchase", contactId: cid, campaignId: campId,
          occurredAt: new Date(Date.now() - hoursAgo * 3600_000),
        });

      // fixtures for a clean click (tier 1) without any purchase
      const brandId = (
        (await tx.execute(sql`
          INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}::uuid, ${"FS-" + sfx}, ${"FS " + sfx})
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const shortDomainId = (
        (await tx.execute(sql`
          INSERT INTO short_domains (org_id, brand_id, domain)
          VALUES (${orgId}::uuid, ${brandId}::int, ${"fs-" + sfx + ".test"}) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const destId = (
        (await tx.execute(sql`
          INSERT INTO link_destinations (org_id, url, url_hash)
          VALUES (${orgId}::uuid, ${"https://example.test/offer"}, ${"fshash-" + sfx}) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      async function click(cid: string) {
        const link = (
          (await tx.execute(sql`
            INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
                               contact_id, send_token, campaign_tracking_id, stage_tracking_id)
            VALUES (${orgId}::uuid, ${"fs-" + sfx + "-" + seq++}, ${shortDomainId}::int, ${destId}::int,
                    ${campId}::int, ${stageId}::int, ${cid}::uuid, ${randomUUID()},
                    ${"ct-" + sfx}, ${"st-" + sfx})
            RETURNING id`)) as unknown as { id: number }[]
        )[0].id;
        await tx.execute(sql`
          INSERT INTO clicks (org_id, link_id, classification)
          VALUES (${orgId}::uuid, ${link}::bigint, 'human')`);
      }

      // 6 journeys: 4 same-day (3 sent), 2 carried (both sent)
      const sd = [await newContact(), await newContact(), await newContact(), await newContact()];
      const co = [await newContact(), await newContact()];
      await journey(sd[0], 0, true);
      await journey(sd[1], 0, true);
      await journey(sd[2], 0, true);
      await journey(sd[3], 0, false);
      await journey(co[0], 1, true);
      await journey(co[1], 1, true);
      // K: same-day, sent, one clean click, no purchase (tier 1)
      const k = await newContact();
      await journey(k, 0, true);
      await click(k);
      // M: TWO journeys — older same-day (closed, routed 10h ago) and newer carried
      // (routed 5h ago). A sale 7h ago falls between => same-day; a sale now => carried.
      const m = await newContact();
      await journey(m, 0, true, 10, true);
      await journey(m, 1, true, 5);
      await buy(m, 7);
      await buy(m, 0);
      // purchases: 2 same-day, 1 carried, 1 on a contact with no journey
      await buy(sd[0]);
      await buy(sd[1]);
      await buy(co[0]);
      await buy(await newContact());

      const f = await getDripFunnel(orgId, campId, tx);
      bar("S1 split present", f.split !== null);
      const s = f.split!;
      bar("S2 routed halves sum", s.same_day.routed + s.carried.routed === f.progression.routed, JSON.stringify(s));
      bar("S3 sent halves sum", s.same_day.sent + s.carried.sent === f.progression.sent);
      bar("S4 clicked halves sum", s.same_day.clicked + s.carried.clicked === f.progression.clicked);
      bar("S5 sales + unmatched = converted",
        s.same_day.sales + s.carried.sales + s.unmatched_sales === f.progression.converted);
      bar("S6 exact: same-day 6/5/4 clicked/3 sales; carried 3/3/2/2; unmatched 1",
        s.same_day.routed === 6 && s.same_day.sent === 5 && s.same_day.clicked === 4 && s.same_day.sales === 3 &&
        s.carried.routed === 3 && s.carried.sent === 3 && s.carried.clicked === 2 && s.carried.sales === 2 &&
        s.unmatched_sales === 1 && f.progression.converted === 6,
        JSON.stringify(s));
      // S7: with no carried journeys the split is null
      await tx.execute(sql`UPDATE drip_journeys SET carried_days = 0 WHERE campaign_id = ${campId}`);
      bar("S7 no carried journeys → split null", (await getDripFunnel(orgId, campId, tx)).split === null);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  await pgConn.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end().catch(() => {});
  process.exit(1);
});
