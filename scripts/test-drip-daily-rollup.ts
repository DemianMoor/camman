import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { dailyMoney } from "@/lib/reporting/drip-daily-money";
import {
  diffDripDailyRollup,
  histogramMedian,
  LATENCY_EDGES_SEC,
  nightlyDue,
  reconcileRange,
  refreshDripDailyRollup,
  rollupScope,
  sumHistograms,
} from "@/lib/reporting/drip-daily-rollup";

// drip_daily_rollup refresh (lib/reporting/drip-daily-rollup.ts) on the PREVIEW
// DB, in ONE transaction that is rolled back (no residue). A small isolated
// world whose every expected cell is derived BY HAND below — never by re-running
// the code under test. Sends straddle ET midnight (D1 23:59 / D2 00:01).
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-daily-rollup.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
class Rollback extends Error {}

const D1 = "2026-04-13"; // ET (EDT, UTC−4): 04:00Z on the 13th … 04:00Z on the 14th
const D2 = "2026-04-14";
const z = (s: string) => `2026-04-${s}Z`;

function pure() {
  console.log("Pure:");
  const now = new Date("2026-10-12T14:00:00Z"); // 10:00 ET
  const s1 = rollupScope(now, null);
  bar("P1 never settled (and past 05 UTC) → settle, 14 ET days", s1.settle && s1.range.from === "2026-09-29" && s1.range.to === "2026-10-12",
    JSON.stringify(s1));
  const s2 = rollupScope(now, new Date("2026-10-12T05:07:00Z"));
  bar("P2 settled this UTC day → fresh tier: today + yesterday", !s2.settle && s2.range.from === "2026-10-11" && s2.range.to === "2026-10-12",
    JSON.stringify(s2));
  bar("P3 bad stamp → settle", rollupScope(now, new Date("nope")).settle);
  const rr = reconcileRange(now);
  bar("P4 reconcile window = days 15–21 back, frozen", rr.from === "2026-09-22" && rr.to === "2026-09-28", JSON.stringify(rr));
  bar("P5 nothing nightly before 05 UTC, even if never run", !nightlyDue(new Date("2026-10-12T04:59:00Z"), null) &&
    !rollupScope(new Date("2026-10-12T04:59:00Z"), null).settle);
  bar("P6 nightly runs once per UTC day",
    nightlyDue(new Date("2026-10-12T05:01:00Z"), new Date("2026-10-11T05:01:00Z")) &&
      !nightlyDue(new Date("2026-10-12T09:00:00Z"), new Date("2026-10-12T05:01:00Z")));
  const h = new Array(LATENCY_EDGES_SEC.length + 1).fill(0);
  h[8] = 1; // one value in [60, 90)
  bar("P7 median of one sample in [60,90) = 75 (bucket midpoint)", histogramMedian(h) === 75, String(histogramMedian(h)));
  bar("P8 empty histogram → null", histogramMedian(sumHistograms([null, undefined])) === null);
  const last = new Array(LATENCY_EDGES_SEC.length + 1).fill(0);
  last[LATENCY_EDGES_SEC.length] = 3;
  bar("P9 open-ended last bucket → its floor (48 h)", histogramMedian(last) === 172800);
  // Owner Q1/Q3: lookup = admitted × rate; profit and ROI include it; rev/admitted.
  const m = dailyMoney({ revenue: 30, send_cost: 4, admitted: 100 }, 0.0016);
  bar("M1 lookup cost = 100 admitted × $0.0016 = $0.16", Math.abs(m.lookup_cost_usd - 0.16) < 1e-12, String(m.lookup_cost_usd));
  bar("M2 profit = 30 − 4 − 0.16 = 25.84", Math.abs(m.profit_usd - 25.84) < 1e-9, String(m.profit_usd));
  bar("M3 ROI = 25.84 ÷ 4.16", m.roi !== null && Math.abs(m.roi - 25.84 / 4.16) < 1e-12, String(m.roi));
  bar("M4 revenue per admitted lead = 30 ÷ 100", m.revenue_per_admitted_usd === 0.3);
  const z0 = dailyMoney({ revenue: 5, send_cost: 0, admitted: 0 }, 0.0016);
  bar("M5 zero cost → ROI null (not 0); zero admitted → rev/admitted null", z0.roi === null && z0.revenue_per_admitted_usd === null);
  const lossy = dailyMoney({ revenue: 0, send_cost: 2, admitted: 50 }, 0.002);
  bar("M6 no revenue → negative profit, ROI −100%", lossy.profit_usd === -2.1 && lossy.roi === -1, `${lossy.profit_usd} / ${lossy.roi}`);
}

async function dbBars() {
  console.log(`\nDB (${requirePreviewDb().label}, rolled back):`);
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: SQL) => ((await tx.execute(q)) as unknown as T[])[0];
      const id = async (q: SQL) => (await one<{ id: number }>(q)).id;
      const uid = async (q: SQL) => (await one<{ id: string }>(q)).id;
      const sfx = Math.random().toString(36).slice(2, 8);

      const org = await uid(sql`INSERT INTO organizations (name) VALUES ('__DRIP_DAILY_ROLLUP_TEST__') RETURNING id`);
      // DLR capability is keyed by sms_provider_id, which is GLOBALLY unique:
      // reuse the preview's 'txr' row when it exists (rolled back either way).
      const txrProv =
        (await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'txr'`))?.id ??
        (await id(sql`INSERT INTO sms_providers (sms_provider_id, org_id, name) VALUES ('txr', ${org}::uuid, 'txr') RETURNING id`));
      const plainProv = await id(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name) VALUES (${"ddr-" + sfx}, ${org}::uuid, 'plain') RETURNING id`);
      const phoneTxr = await id(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, cost_per_sms)
        VALUES (${org}::uuid, ${txrProv}, ${"+1900555" + sfx.slice(0, 4)}, 0.0120) RETURNING id`);
      const phonePlain = await id(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, cost_per_sms)
        VALUES (${org}::uuid, ${plainProv}, ${"+1900556" + sfx.slice(0, 4)}, 0.0100) RETURNING id`);
      const brand = await id(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}::uuid, ${"DDR-" + sfx}, 'DDR') RETURNING id`);
      const sd = await id(sql`INSERT INTO short_domains (org_id, brand_id, domain) VALUES (${org}::uuid, ${brand}, ${"ddr-" + sfx + ".test"}) RETURNING id`);
      const dest = await id(sql`INSERT INTO link_destinations (org_id, url, url_hash) VALUES (${org}::uuid, 'https://example.test/o', ${"h-" + sfx}) RETURNING id`);
      const partner = await id(sql`INSERT INTO partners (org_id, name, slug) VALUES (${org}::uuid, 'DDR', ${"ddr" + sfx}) RETURNING id`);
      const K1 = await id(sql`
        INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, interest_tag_mode)
        VALUES (${org}::uuid, ${partner}, ${"ddr" + sfx}, 'K1', ${"t-" + sfx}, 'x', 'default') RETURNING id`);
      const purchase = await id(sql`
        INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
        VALUES (${org}::uuid, 'purchase', 'Purchase', true, true) RETURNING id`);
      const C = await id(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type) VALUES (${org}::uuid, ${"ddr-" + sfx}, 'DDR', 'paused', 'drip') RETURNING id`);
      const A = await id(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
        VALUES (${org}::uuid, ${C}, 1, 0, 1440, true) RETURNING id`);
      const B = await id(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, parent_stage_id, behavioral_tier, drip_followup_minutes, drip_active)
        VALUES (${org}::uuid, ${C}, 2, ${A}, 0, 1440, true) RETURNING id`);

      let n = 0;
      const contact = () => uid(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${org}::uuid, ${"+1555" + sfx.slice(0, 3) + String(++n).padStart(4, "0")}) RETURNING id`);
      const lead = async (receivedZ: string, sandbox = false) => {
        const c = await contact();
        const inbox = await uid(sql`
          INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, raw, status, received_at)
          VALUES (${org}::uuid, ${K1}, ${"ddr" + sfx}, '{}'::jsonb, 'processed', ${z(receivedZ)}::timestamptz) RETURNING id`);
        const ev = await uid(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at, inbox_id, sandbox)
          VALUES (${org}::uuid, ${c}::uuid, ${K1}, ${"ddr" + sfx}, 'ddr', ${z(receivedZ)}::timestamptz, ${inbox}::uuid, ${sandbox}) RETURNING id`);
        return { c, ev };
      };
      const journey = (l: { c: string; ev: string }, routedZ: string, carried: number) => uid(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
        VALUES (${org}::uuid, ${C}, ${l.c}::uuid, ${l.ev}::uuid, 'routed', ${z(routedZ)}::timestamptz, '{}'::jsonb, ${carried}) RETURNING id`);
      const send = async (o: { c: string; stage: number; atZ: string; phone: number; cost: string | null }) => {
        const link = await id(sql`
          INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id, contact_id, send_token, campaign_tracking_id, stage_tracking_id)
          VALUES (${org}::uuid, ${"ddr-" + sfx + "-" + ++n}, ${sd}, ${dest}, ${C}, ${o.stage}, ${o.c}::uuid, ${"tok-" + sfx + n}, 'ct', 'st') RETURNING id`);
        const ss = await uid(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, created_at, sent_at, provider_phone_id, cost_per_sms, link_id)
          VALUES (${org}::uuid, ${C}, ${o.stage}, ${o.c}::uuid, '+15550000000', 'hi', 'sent', ${z(o.atZ)}::timestamptz, ${z(o.atZ)}::timestamptz,
                  ${o.phone}, ${o.cost}::numeric, ${link}) RETURNING id`);
        return { ss, link };
      };
      const firstSend = (j: string, s: string, atZ: string) => tx.execute(sql`
        UPDATE drip_journeys SET state = 'active', first_send_id = ${s}::uuid, first_send_at = ${z(atZ)}::timestamptz, first_stage_id = ${A}
        WHERE id = ${j}::uuid`);
      const click = (link: number, atZ: string, cls: string) => tx.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification, clicked_at) VALUES (${org}::uuid, ${link}, ${cls}, ${z(atZ)}::timestamptz)`);
      const receipt = (s: string, status: string, atZ: string) => tx.execute(sql`
        INSERT INTO textrequest_dlr_events (org_id, method, status, stage_send_id, matched_stage_send_id, received_at)
        VALUES (${org}::uuid, 'POST', ${status}, ${s}::uuid, ${s}::uuid, ${z(atZ)}::timestamptz)`);
      const conversion = (s: string, c: string, stage: number, status: string, revenue: string, createdZ: string) => tx.execute(sql`
        INSERT INTO conversion_events (keitaro_event_id, org_id, keitaro_status, keitaro_type, event_type_id, status, revenue,
                                       stage_send_id, contact_id, campaign_id, stage_id, occurred_at, created_at)
        VALUES (${"ddr-" + sfx + "-" + ++n}, ${org}::uuid, 'sale', 'sale', ${purchase}, ${status}, ${revenue}::numeric,
                ${s}::uuid, ${c}::uuid, ${C}, ${stage}, ${z("13T20:00:00")}::timestamptz, ${z(createdZ)}::timestamptz)`);

      // ── the world (times UTC; ET = UTC−4) ───────────────────────────────
      // L1 (K1): received D1 14:00, routed D1 14:00:30, first send S1 60 s after arrival.
      const L1 = await lead("13T14:00:00");
      const J1 = await journey(L1, "13T14:00:30", 0);
      const S1 = await send({ c: L1.c, stage: A, atZ: "13T14:01:00", phone: phoneTxr, cost: "0.0100" });
      await firstSend(J1, S1.ss, "13T14:01:00");
      await receipt(S1.ss, "delivered", "13T14:01:30");
      // S2: lane B, D1 23:59 ET — no snapshot → the number's rate 0.0120; no receipt.
      await send({ c: L1.c, stage: B, atZ: "14T03:59:00", phone: phoneTxr, cost: null });
      // S3: lane B, D2 00:01 ET — non-DLR provider.
      const S3 = await send({ c: L1.c, stage: B, atZ: "14T04:01:00", phone: phonePlain, cost: "0.0100" });
      await click(S1.link, "13T15:00:00", "human");   // D1
      await click(S1.link, "14T04:30:00", "human");   // D2
      await click(S1.link, "14T04:31:00", "bot");     // excluded
      // STOP answering S3 on D2, billed at S3's rate.
      const oo = await uid(sql`
        INSERT INTO opt_outs (org_id, contact_id, phone_number, created_at)
        SELECT ${org}::uuid, id, phone_number, ${z("14T05:00:00")}::timestamptz FROM contacts WHERE id = ${L1.c}::uuid RETURNING id`);
      await tx.execute(sql`
        INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
        VALUES (${org}::uuid, ${oo}, ${S3.ss}::uuid, ${B}, ${C}, ${z("14T05:00:00")}::timestamptz)`);
      // Two purchases on S1 DETECTED on D2 (occurred on D1): approved $30 + pending $10.
      await conversion(S1.ss, L1.c, A, "approved", "30.0000", "14T06:00:00");
      await conversion(S1.ss, L1.c, A, "pending", "10.0000", "14T06:05:00");
      await conversion(S1.ss, L1.c, A, "rejected", "99.0000", "14T06:10:00"); // nothing

      // L2 (K1): received D1, admitted D2 (carried 1). First send S4 D2, undelivered.
      const L2 = await lead("13T20:00:00");
      const J2 = await journey(L2, "14T13:00:00", 1);
      const S4 = await send({ c: L2.c, stage: A, atZ: "14T13:01:00", phone: phoneTxr, cost: "0.0100" });
      await firstSend(J2, S4.ss, "14T13:01:00");
      await receipt(S4.ss, "undelivered", "14T13:02:00");

      // L3: SANDBOX lead, received + routed + first-sent D2 → the NULL partner bucket.
      const L3 = await lead("14T14:00:00", true);
      const J3 = await journey(L3, "14T14:00:10", 0);
      const S5 = await send({ c: L3.c, stage: A, atZ: "14T14:00:40", phone: phoneTxr, cost: "0.0100" });
      await firstSend(J3, S5.ss, "14T14:00:40");

      // S6: a send with NO journey at all (D1) → NULL partner, counted as a follow-up.
      const c6 = await contact();
      await send({ c: c6, stage: A, atZ: "13T16:00:00", phone: phoneTxr, cost: "0.0100" });

      // ── run ───────────────────────────────────────────────────────────────
      const range = { from: D1, to: D2 };
      const ra = await refreshDripDailyRollup(tx, org, "activity", range);
      const rc = await refreshDripDailyRollup(tx, org, "cohort", range);

      type Cell = Record<string, unknown>;
      const cells = async (basis: string) =>
        (await tx.execute(sql`
          SELECT stage_id, partner_key_id, day_et::text AS d, leads_admitted, admitted, admitted_carried,
                 first_sends, followup_sends, dlr_sent, delivered, clicks, opt_outs, sales,
                 revenue::text AS revenue, send_cost::text AS send_cost, latency_hist
          FROM drip_daily_rollup WHERE campaign_id = ${C} AND basis = ${basis}`)) as unknown as Cell[];
      const L = "lead";
      const find = (rows: Cell[], stage: number | string, pk: number | null, d: string) =>
        rows.find((r) => (stage === L ? r.stage_id === null : r.stage_id === stage) && r.partner_key_id === pk && r.d === d);
      const zero = { leads_admitted: 0, admitted: 0, admitted_carried: 0, first_sends: 0, followup_sends: 0, dlr_sent: 0,
        delivered: 0, clicks: 0, opt_outs: 0, sales: 0, revenue: "0.0000", send_cost: "0.0000" };
      const hist8 = (() => { const h = new Array(LATENCY_EDGES_SEC.length + 1).fill(0); h[8] = 1; return h; })();
      const expectCell = (rows: Cell[], label: string, stage: number | string, pk: number | null, d: string,
                          exp: Partial<typeof zero> & { latency_hist?: number[] | null }) => {
        const got = find(rows, stage, pk, d);
        const want = { ...zero, latency_hist: null, ...exp };
        const diffs = got
          ? Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v)).map(([k, v]) => `${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(v)}`)
          : ["cell missing"];
        bar(label, diffs.length === 0, diffs.join("; "));
      };

      const act = await cells("activity");
      bar("A0 activity: exactly 9 cells", act.length === 9, `${act.length} (refresh said ${ra.cells})`);
      expectCell(act, "A1 lead K1 D1: 2 leads admitted (L1, L2 received D1), 1 admitted (J1)", L, K1, D1,
        { leads_admitted: 2, admitted: 1 });
      expectCell(act, "A2 lead K1 D2: 1 admitted, carried (J2)", L, K1, D2, { admitted: 1, admitted_carried: 1 });
      expectCell(act, "A3 lead sandbox D2 → NULL key", L, null, D2, { leads_admitted: 1, admitted: 1 });
      expectCell(act, "A4 A/K1/D1: S1 first+delivered, 1 human click, 60 s latency", A, K1, D1,
        { first_sends: 1, dlr_sent: 1, delivered: 1, clicks: 1, send_cost: "0.0100", latency_hist: hist8 });
      expectCell(act, "A5 A/K1/D2: S4 first (undelivered, carried → no latency), click, 2 sales $30 on DETECTION day", A, K1, D2,
        { first_sends: 1, dlr_sent: 1, clicks: 1, sales: 2, revenue: "30.0000", send_cost: "0.0100" });
      expectCell(act, "A6 A/∅/D1: journey-less S6 → follow-up, unattributed", A, null, D1,
        { followup_sends: 1, dlr_sent: 1, send_cost: "0.0100" });
      expectCell(act, "A7 A/∅/D2: sandbox S5 first send, no latency", A, null, D2,
        { first_sends: 1, dlr_sent: 1, send_cost: "0.0100" });
      expectCell(act, "A8 B/K1/D1: S2 at 23:59 ET on D1, number's rate 0.0120", B, K1, D1,
        { followup_sends: 1, dlr_sent: 1, send_cost: "0.0120" });
      expectCell(act, "A9 B/K1/D2: S3 at 00:01 ET non-DLR + STOP at S3's rate", B, K1, D2,
        { followup_sends: 1, opt_outs: 1, send_cost: "0.0200" });

      const coh = await cells("cohort");
      bar("C0 cohort: exactly 7 cells", coh.length === 7, `${coh.length} (refresh said ${rc.cells})`);
      expectCell(coh, "C1 cohort D1 lead K1: J1", L, K1, D1, { admitted: 1 });
      expectCell(coh, "C2 cohort D1 A/K1: S1 + BOTH human clicks + both sales (late, D2)", A, K1, D1,
        { first_sends: 1, dlr_sent: 1, delivered: 1, clicks: 2, sales: 2, revenue: "30.0000", send_cost: "0.0100", latency_hist: hist8 });
      expectCell(coh, "C3 cohort D1 B/K1: S2 + S3 across midnight + the STOP", B, K1, D1,
        { followup_sends: 2, dlr_sent: 1, opt_outs: 1, send_cost: "0.0320" });
      expectCell(coh, "C4 cohort D2 lead K1: J2 carried", L, K1, D2, { admitted: 1, admitted_carried: 1 });
      expectCell(coh, "C5 cohort D2 A/K1: S4", A, K1, D2, { first_sends: 1, dlr_sent: 1, send_cost: "0.0100" });
      expectCell(coh, "C6 cohort D2 lead sandbox", L, null, D2, { admitted: 1 });
      expectCell(coh, "C7 cohort D2 A/∅: S5", A, null, D2, { first_sends: 1, dlr_sent: 1, send_cost: "0.0100" });

      // Totals foot: Σ activity == Σ cohort for everything the journey-less S6 is not in.
      const tot = (rows: Cell[], k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
      bar("F1 Σ sent: activity 6 = cohort 5 + the journey-less S6",
        tot(act, "first_sends") + tot(act, "followup_sends") === 6 && tot(coh, "first_sends") + tot(coh, "followup_sends") === 5);
      bar("F2 Σ revenue / sales / opt-outs equal across bases",
        tot(act, "revenue") === tot(coh, "revenue") && tot(act, "sales") === tot(coh, "sales") && tot(act, "opt_outs") === tot(coh, "opt_outs"));

      // ── idempotence, change, vanish, range bound ──────────────────────────
      const again = await refreshDripDailyRollup(tx, org, "activity", range);
      bar("R1 second refresh rewrites nothing", again.written === 0 && again.deleted === 0, JSON.stringify(again));
      await tx.execute(sql`DELETE FROM clicks WHERE link_id = ${S1.link} AND classification = 'human' AND clicked_at = ${z("13T15:00:00")}::timestamptz`);
      await tx.execute(sql`DELETE FROM drip_daily_rollup WHERE campaign_id = ${C} AND basis = 'activity' AND day_et = ${D2}::date AND stage_id IS NULL AND partner_key_id IS NULL`);
      await tx.execute(sql`UPDATE textrequest_dlr_events SET status = 'delivered' WHERE matched_stage_send_id = ${S4.ss}::uuid`);
      const d1only = await refreshDripDailyRollup(tx, org, "activity", { from: D1, to: D1 });
      const act2 = await cells("activity");
      expectCell(act2, "R2 D1-only refresh: the removed click leaves A/K1/D1", A, K1, D1,
        { first_sends: 1, dlr_sent: 1, delivered: 1, send_cost: "0.0100", latency_hist: hist8 });
      bar("R3 D1-only refresh does not touch D2 (deleted cell stays gone, late receipt not picked up)",
        !find(act2, L, null, D2) && find(act2, A, K1, D2)?.delivered === 0, `written ${d1only.written}`);
      await refreshDripDailyRollup(tx, org, "activity", range);
      const act3 = await cells("activity");
      bar("R4 full refresh restores the deleted cell and picks up the late receipt",
        !!find(act3, L, null, D2) && find(act3, A, K1, D2)?.delivered === 1);
      await tx.execute(sql`DELETE FROM stage_sends WHERE id = ${S5.ss}::uuid`);
      const vanished = await refreshDripDailyRollup(tx, org, "activity", range);
      bar("R5 a cell whose only send left 'sent' is deleted", vanished.deleted === 1 && !find(await cells("activity"), A, null, D2),
        JSON.stringify(vanished));

      // ── reconciliation diff ───────────────────────────────────────────────
      const clean = await diffDripDailyRollup(tx, org, "activity", range);
      bar("X1 stored == live right after a refresh (0 diffs)", clean.diffs.length === 0 && clean.cells === act3.length - 1,
        `${clean.cells} cells, ${clean.diffs.length} diffs`);
      await tx.execute(sql`UPDATE drip_daily_rollup SET clicks = 999999 WHERE campaign_id = ${C} AND basis = 'activity' AND stage_id = ${A} AND partner_key_id = ${K1} AND day_et = ${D2}::date`);
      const poisoned = await diffDripDailyRollup(tx, org, "activity", range);
      bar("X2 a poisoned stored cell is reported (red proof)", poisoned.diffs.length === 1 &&
        poisoned.diffs[0].key === `${C}/${D2}/${A}/${K1}`, JSON.stringify(poisoned.diffs.map((d) => d.key)));
      const cdiff = await diffDripDailyRollup(tx, org, "cohort", range);
      // The cohort was refreshed once, BEFORE the click delete, the receipt flip and
      // the S5 delete — so exactly those three cohort cells must now differ.
      const want = [`${C}/${D1}/${A}/${K1}`, `${C}/${D2}/${A}/${K1}`, `${C}/${D2}/${A}/unattributed`].sort().join(",");
      bar("X3 un-refreshed cohort: exactly the 3 cells whose sources changed differ",
        cdiff.diffs.map((d) => d.key).sort().join(",") === want, JSON.stringify(cdiff.diffs.map((d) => d.key)));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM organizations WHERE name = '__DRIP_DAILY_ROLLUP_TEST__'`)) as unknown as { n: number }[];
  bar("Z rolled back: no fixture org left", left[0]?.n === 0);
}

async function main() {
  pure();
  await dbBars();
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
