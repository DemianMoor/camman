import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { computeCreativeCtr } from "@/lib/creatives/ctr-rollup";
import { computeCreativeMetrics, type CreativeMetricsRow } from "@/lib/creatives/metrics-cache";

// Per-offer creative metrics (/creatives offer filter + stage creative picker).
// Known-answer fixture inside a transaction that ALWAYS rolls back.
//
// Creative K runs on offer X, offer Y and a campaign with NO offer; contact `a`
// clicks K under both X and Y, `b` under X and the no-offer campaign. So:
//   - the all-offers row counts a and b ONCE (2), while X (2) + Y (1) = 3 —
//     the total must not be a sum of the offer rows;
//   - the no-offer campaign feeds the total but gets no row of its own;
//   - a 40-day-old X stage feeds only X's and the total's lifetime numbers.
// Creative M runs only on Y, so it has no X row (→ "—" under an X filter).
//
// Run: npx tsx --env-file=C:/AFF/camman/.env.demo scripts/test-creative-metrics-per-offer-db.ts

const ORG_ID = "ad37fb88-497f-4cd1-89d1-bd3dfec1ddbc"; // CamMan Demo (preview)
const OFFER_X = 5;
const OFFER_Y = 6;
const PROBE = "per-offer-creative-metrics";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} — ${JSON.stringify(detail)}`);
  }
}

class Rollback extends Error {}
type Exec = Parameters<Parameters<typeof db.transaction>[0]>[0];

const one = async (tx: Exec, q: ReturnType<typeof sql>) =>
  Number(((await tx.execute(q)) as unknown as { id: number }[])[0].id);

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const campaign = (offerId: number | null, tag: string) =>
        one(tx, sql`
          INSERT INTO campaigns (org_id, slug, name, offer_id, link_mode)
          VALUES (${ORG_ID}::uuid, ${`${PROBE}-${tag}`}, ${`${PROBE} ${tag}`}, ${offerId}, 'tracked')
          RETURNING id`);
      const creative = (tag: string) =>
        one(tx, sql`
          INSERT INTO creatives (org_id, slug, text, status)
          VALUES (${ORG_ID}::uuid, ${`${PROBE}-${tag}`}, ${`fixture ${tag}`}, 'active')
          RETURNING id`);
      const contact = (n: number) =>
        tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${ORG_ID}::uuid, ${`+1555000${String(9000 + n)}`})
          RETURNING id`).then((r) => (r as unknown as { id: string }[])[0].id);
      let stageNo = 0;
      const stage = async (a: {
        campaignId: number; creativeId: number; ageDays: number; checkouts: number;
        manualSales: number; kSales: number; kRevenue: number;
      }) => {
        const id = await one(tx, sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, created_at, sent_at,
             checkout_click_count, sales_count)
          VALUES (${ORG_ID}::uuid, ${a.campaignId}, ${++stageNo}, ${a.creativeId},
                  now() - (${a.ageDays} || ' days')::interval,
                  now() - (${a.ageDays} || ' days')::interval,
                  ${a.checkouts}, ${a.manualSales})
          RETURNING id`);
        await tx.execute(sql`
          INSERT INTO keitaro_stage_results
            (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue, events)
          VALUES (${ORG_ID}::uuid, ${a.campaignId}, ${id}, ${`${PROBE}-s${id}`},
                  current_date, ${a.kSales}, ${String(a.kRevenue)}, '{}'::jsonb)`);
        return { id, campaignId: a.campaignId, ageDays: a.ageDays };
      };
      type St = Awaited<ReturnType<typeof stage>>;
      const send = (s: St, contactId: string) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          VALUES (${ORG_ID}::uuid, ${s.campaignId}, ${s.id}, ${contactId}::uuid, '+15550000000', 'x', 'sent',
                  now() - (${s.ageDays} || ' days')::interval)`);
      const click = (s: St, contactId: string) =>
        tx.execute(sql`
          INSERT INTO counted_clickers (org_id, campaign_id, stage_id, creative_id, contact_id, first_click_at)
          SELECT ${ORG_ID}::uuid, ${s.campaignId}, ${s.id}, cs.creative_id, ${contactId}::uuid,
                 now() - (${s.ageDays} || ' days')::interval
            FROM campaign_stages cs WHERE cs.id = ${s.id}`);

      const cX = await campaign(OFFER_X, "x");
      const cY = await campaign(OFFER_Y, "y");
      const cN = await campaign(null, "no-offer");
      const K = await creative("k");
      const M = await creative("m");
      const [a, b, c, d] = [await contact(1), await contact(2), await contact(3), await contact(4)];

      const sX = await stage({ campaignId: cX, creativeId: K, ageDays: 2, checkouts: 5, manualSales: 1, kSales: 2, kRevenue: 40 });
      const sY = await stage({ campaignId: cY, creativeId: K, ageDays: 2, checkouts: 3, manualSales: 0, kSales: 1, kRevenue: 10 });
      const sN = await stage({ campaignId: cN, creativeId: K, ageDays: 2, checkouts: 2, manualSales: 0, kSales: 4, kRevenue: 100 });
      const sOld = await stage({ campaignId: cX, creativeId: K, ageDays: 40, checkouts: 100, manualSales: 0, kSales: 7, kRevenue: 70 });
      await stage({ campaignId: cY, creativeId: M, ageDays: 2, checkouts: 1, manualSales: 0, kSales: 0, kRevenue: 0 });

      for (const x of [a, b, c]) await send(sX, x);
      for (const x of [a, d]) await send(sY, x);
      await send(sN, b);
      await send(sOld, a);
      await click(sX, a);
      await click(sX, b);
      await click(sY, a);
      await click(sN, b);
      await click(sOld, c);

      console.log("A. computeCreativeMetrics");
      const rows = await computeCreativeMetrics(ORG_ID, tx);
      const get = (cr: number, offer: number | null) =>
        rows.find((r) => r.creative_id === cr && r.offer_id === offer);
      type Want = Partial<Record<keyof CreativeMetricsRow, number>>;
      const expectRow = (label: string, got: CreativeMetricsRow | undefined, want: Want) => {
        const diffs = Object.entries(want).filter(
          ([k, v]) => Number(got?.[k as keyof CreativeMetricsRow]) !== v,
        );
        check(label, got !== undefined && diffs.length === 0, {
          diffs: diffs.map(([k, v]) => `${k}: got ${got?.[k as keyof CreativeMetricsRow]}, want ${v}`),
        });
      };
      expectRow("K all offers: 30d sums over X+Y+no-offer, clickers a,b counted once", get(K, null), {
        checkouts: 10, sales: 7, payout: 150, tracked_clean: 2,
        lifetime_clean: 3, lifetime_sales: 14, lifetime_payout: 220,
      });
      expectRow("K offer X: only X stages; lifetime includes the 40-day stage", get(K, OFFER_X), {
        checkouts: 5, sales: 2, payout: 40, tracked_clean: 2,
        lifetime_clean: 3, lifetime_sales: 9, lifetime_payout: 110,
      });
      expectRow("K offer Y: only Y stages", get(K, OFFER_Y), {
        checkouts: 3, sales: 1, payout: 10, tracked_clean: 1,
        lifetime_clean: 1, lifetime_sales: 1, lifetime_payout: 10,
      });
      check(
        "K: exactly three grains (all, X, Y) — the no-offer campaign has no row of its own",
        rows.filter((r) => r.creative_id === K).length === 3,
        rows.filter((r) => r.creative_id === K).map((r) => r.offer_id),
      );
      check("M: no offer-X row (→ '—' under an X filter)", get(M, OFFER_X) === undefined);
      check("M: has its offer-Y row and its all-offers row", !!get(M, OFFER_Y) && !!get(M, null));
      check(
        "every creative has an all-offers row (the 'Any offer' view keeps every creative)",
        new Set(rows.map((r) => r.creative_id)).size === rows.filter((r) => r.offer_id === null).length,
      );

      console.log("\nB. computeCreativeCtr");
      const ctr = await computeCreativeCtr(tx, ORG_ID);
      const getCtr = (cr: number, offer: number | null) =>
        ctr.find((r) => r.creative_id === cr && r.offer_id === offer);
      const expectCtr = (label: string, cr: number, offer: number | null, want: Record<string, number>) => {
        const got = getCtr(cr, offer) as unknown as Record<string, number> | undefined;
        const diffs = Object.entries(want).filter(([k, v]) => got?.[k] !== v);
        check(label, got !== undefined && diffs.length === 0, { got, want });
      };
      expectCtr("K all offers: 6 sent in 30d (7 all time), clickers a,b once (2; 3 all time)", K, null, {
        sent_7d: 6, clicks_7d: 2, sent_30d: 6, clicks_30d: 2, sent_lifetime: 7, clicks_lifetime: 3,
      });
      expectCtr("K offer X: 3 sent in 30d (4 all time), clickers a,b (+c all time)", K, OFFER_X, {
        sent_7d: 3, clicks_7d: 2, sent_30d: 3, clicks_30d: 2, sent_lifetime: 4, clicks_lifetime: 3,
      });
      expectCtr("K offer Y: 2 sent, 1 clicker", K, OFFER_Y, {
        sent_7d: 2, clicks_7d: 1, sent_30d: 2, clicks_30d: 1, sent_lifetime: 2, clicks_lifetime: 1,
      });
      check(
        "CTR: K has exactly three grains, no row for the no-offer campaign",
        ctr.filter((r) => r.creative_id === K).length === 3,
        ctr.filter((r) => r.creative_id === K).map((r) => r.offer_id),
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    rolledBack = true;
  }
  check("fixture rolled back", rolledBack);
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaigns WHERE slug LIKE ${`${PROBE}%`}`)) as unknown as { n: number }[];
  check("no fixture rows left behind", left[0].n === 0, left[0].n);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pgConn.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
