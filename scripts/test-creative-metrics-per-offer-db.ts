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
// Clickers for CTR / Checkout Rate / Sales CR are the Overview tab's: per stage,
// Keitaro clean visits, or CamMan counted clickers for a tracked stage with no
// Keitaro visits that is past the 6-hour maturity gate. sY has no visits (→ its
// 1 counted clicker); sYoung has none either but was sent 1 hour ago (→ 0);
// sOld's visits are dated 40 days ago (lifetime only). EPC stays on counted
// clickers (tracked_clean / lifetime_clean).
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
        visitsRaw?: number; visitsClean?: number;
      }) => {
        const ageHours = a.ageDays * 24;
        const id = await one(tx, sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, created_at, sent_at,
             checkout_click_count, sales_count)
          VALUES (${ORG_ID}::uuid, ${a.campaignId}, ${++stageNo}, ${a.creativeId},
                  now() - (${ageHours} || ' hours')::interval,
                  now() - (${ageHours} || ' hours')::interval,
                  ${a.checkouts}, ${a.manualSales})
          RETURNING id`);
        // stat_date = the stage's own ET send day, so an old stage's visits fall
        // outside the 7/30-day windows.
        await tx.execute(sql`
          INSERT INTO keitaro_stage_results
            (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, sales, revenue, events,
             visit_clicks_raw, visit_clicks_clean)
          VALUES (${ORG_ID}::uuid, ${a.campaignId}, ${id}, ${`${PROBE}-s${id}`},
                  ((now() - (${ageHours} || ' hours')::interval) AT TIME ZONE 'America/New_York')::date,
                  ${a.kSales}, ${String(a.kRevenue)}, '{}'::jsonb,
                  ${a.visitsRaw ?? 0}, ${a.visitsClean ?? 0})`);
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

      const sX = await stage({ campaignId: cX, creativeId: K, ageDays: 2, checkouts: 5, manualSales: 1, kSales: 2, kRevenue: 40, visitsRaw: 12, visitsClean: 10 });
      const sY = await stage({ campaignId: cY, creativeId: K, ageDays: 2, checkouts: 3, manualSales: 0, kSales: 1, kRevenue: 10 });
      const sN = await stage({ campaignId: cN, creativeId: K, ageDays: 2, checkouts: 2, manualSales: 0, kSales: 4, kRevenue: 100, visitsRaw: 6, visitsClean: 5 });
      const sOld = await stage({ campaignId: cX, creativeId: K, ageDays: 40, checkouts: 100, manualSales: 0, kSales: 7, kRevenue: 70, visitsRaw: 3, visitsClean: 3 });
      const sYoung = await stage({ campaignId: cX, creativeId: K, ageDays: 1 / 24, checkouts: 0, manualSales: 0, kSales: 0, kRevenue: 0 });
      await stage({ campaignId: cY, creativeId: M, ageDays: 2, checkouts: 1, manualSales: 0, kSales: 0, kRevenue: 0 });

      for (const x of [a, b, c]) await send(sX, x);
      for (const x of [a, d]) await send(sY, x);
      await send(sN, b);
      await send(sOld, a);
      await send(sYoung, d);
      await click(sYoung, d);
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
        checkouts: 10, sales: 7, payout: 150, tracked_clean: 3,
        lifetime_clean: 4, lifetime_sales: 14, lifetime_payout: 220,
        // sX 10 visits + sY 1 substitute + sN 5 visits + sYoung 0 (too new)
        visit_clickers: 16,
      });
      expectRow("K offer X: only X stages; lifetime includes the 40-day stage", get(K, OFFER_X), {
        checkouts: 5, sales: 2, payout: 40, tracked_clean: 3,
        lifetime_clean: 4, lifetime_sales: 9, lifetime_payout: 110,
        visit_clickers: 10,
      });
      expectRow("K offer Y: only Y stages", get(K, OFFER_Y), {
        checkouts: 3, sales: 1, payout: 10, tracked_clean: 1,
        lifetime_clean: 1, lifetime_sales: 1, lifetime_payout: 10,
        visit_clickers: 1,
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
      // Overview clickers per stage: sX 10 · sY 1 (substitute) · sN 5 · sYoung 0
      // (too new to substitute) · sOld 3 visits dated 40 days ago (lifetime only).
      expectCtr("K all offers: 7 sent / 16 clickers in 30d; 8 sent / 19 all time", K, null, {
        sent_7d: 7, clicks_7d: 16, sent_30d: 7, clicks_30d: 16, sent_lifetime: 8, clicks_lifetime: 19,
      });
      expectCtr("K offer X: 4 sent / 10 clickers in 30d; 5 / 13 all time", K, OFFER_X, {
        sent_7d: 4, clicks_7d: 10, sent_30d: 4, clicks_30d: 10, sent_lifetime: 5, clicks_lifetime: 13,
      });
      expectCtr("K offer Y: 2 sent, 1 clicker (CamMan substitute — no Keitaro visits)", K, OFFER_Y, {
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
