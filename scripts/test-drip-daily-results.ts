import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { LATENCY_EDGES_SEC } from "@/lib/reporting/drip-daily-rollup";
import { getDripDailyResults } from "@/lib/reporting/drip-daily-results";

// The Daily results read layer (lib/reporting/drip-daily-results.ts) on the
// PREVIEW DB, one rolled-back transaction. Cells are written by hand, so every
// expected number below is arithmetic on THESE cells — never a re-run of the code.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-daily-results.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-9;
class Rollback extends Error {}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: SQL) => ((await tx.execute(q)) as unknown as T[])[0];
      const id = async (q: SQL) => (await one<{ id: number }>(q)).id;
      const sfx = Math.random().toString(36).slice(2, 8);
      const org = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES ('__DRIP_DAILY_RESULTS_TEST__') RETURNING id`)).id;
      const partner = await id(sql`INSERT INTO partners (org_id, name, slug) VALUES (${org}::uuid, 'Acme Leads', ${"acme" + sfx}) RETURNING id`);
      const K = await id(sql`
        INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, interest_tag_mode)
        VALUES (${org}::uuid, ${partner}, ${"acme" + sfx}, 'acme-key', ${"t" + sfx}, 'x', 'default') RETURNING id`);
      const C = await id(sql`INSERT INTO campaigns (org_id, slug, name, status, type) VALUES (${org}::uuid, ${"ddres-" + sfx}, 'DDRES', 'paused', 'drip') RETURNING id`);
      const S1 = await id(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, label, window_start_min, window_end_min, drip_active)
        VALUES (${org}::uuid, ${C}, 1, 'Intro', 540, 1020, true) RETURNING id`);
      const LANE = await id(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, parent_stage_id, behavioral_tier, drip_followup_minutes, drip_active)
        VALUES (${org}::uuid, ${C}, 2, ${S1}, 1, 1440, true) RETURNING id`); // 1-day follow-up (the CHECK's max) → maturity 1 + 3 = 4 days

      const hist = (slot: number, n: number) => { const h = new Array(LATENCY_EDGES_SEC.length + 1).fill(0); h[slot] = n; return `{${h.join(",")}}`; };
      const cell = (basis: string, day: string, stage: number | null, key: number | null, v: Record<string, number | string>) => {
        const cols = Object.keys(v);
        return tx.execute(sql`
          INSERT INTO drip_daily_rollup (org_id, campaign_id, basis, day_et, stage_id, partner_key_id, ${sql.raw(cols.join(", "))})
          VALUES (${org}::uuid, ${C}, ${basis}, ${day}::date, ${stage}, ${key}, ${sql.join(cols.map((c) => sql`${v[c]}`), sql`, `)})`);
      };
      // Day A = 2026-10-01, Day B = 2026-10-02 (activity).
      await cell("activity", "2026-10-01", null, K, { leads_admitted: 100, admitted: 100, admitted_carried: 10 });
      await cell("activity", "2026-10-01", S1, K, { first_sends: 90, dlr_sent: 90, delivered: 81, clicks: 9, opt_outs: 3, sales: 3, revenue: "30.0000", send_cost: "0.9300", latency_hist: hist(8, 90) });
      await cell("activity", "2026-10-01", LANE, K, { followup_sends: 10, dlr_sent: 0, clicks: 1, send_cost: "0.1000" });
      await cell("activity", "2026-10-02", S1, null, { followup_sends: 5, dlr_sent: 5, delivered: 5, send_cost: "0.0500" }); // unattributed
      await cell("cohort", "2026-10-01", null, K, { admitted: 100, admitted_carried: 10 });
      await cell("cohort", "2026-10-01", S1, K, { first_sends: 90, revenue: "30.0000", send_cost: "0.9300" });
      await tx.execute(sql`
        INSERT INTO campaign_events (org_id, campaign_id, event_type, summary, created_at)
        VALUES (${org}::uuid, ${C}, 'drip_config_changed', 'Drip settings: carry-over days 0 → 1', '2026-10-02T15:00:00Z')`);
      await tx.execute(sql`
        INSERT INTO campaign_circuit_events (org_id, campaign_id, event, reason, created_at)
        VALUES (${org}::uuid, ${C}, 'paused', 'manual', '2026-10-02T03:30:00Z')`); // 23:30 ET on 10-01
      const rate = { rate: 0.002, source: "ledger" };
      const get = (basis: "activity" | "cohort", breakdown: "none" | "stage" | "partner", from: string, to: string, now = new Date("2026-10-03T16:00:00Z")) =>
        getDripDailyResults(tx, { orgId: org, campaignId: C, basis, breakdown, from, to, lookupRate: rate, now });

      const r = (await get("activity", "none", "2026-10-01", "2026-10-02"))!;
      const t = r.totals;
      bar("R1 two day rows, newest first", r.days.map((d) => d.day).join(",") === "2026-10-02,2026-10-01");
      bar("R2 totals foot: sends 105 = 90 first + 15 follow-ups", t.sends === 105 && t.first_sends === 90 && t.followup_sends === 15);
      bar("R3 admitted 100 = 90 same-day + 10 carried", t.admitted === 100 && t.admitted_same_day === 90 && t.admitted_carried === 10);
      bar("R4 delivered % from summed cells: 86 ÷ 95 (the lane's 10 non-DLR sends excluded)", near(t.delivered_pct, 86 / 95), String(t.delivered_pct));
      bar("R5 clicks per send 10 ÷ 105, conv 3 ÷ 10, opt-outs 3 ÷ 105",
        near(t.ctr, 10 / 105) && near(t.conv_pct, 0.3) && near(t.opt_out_pct, 3 / 105));
      bar("R6 lookup on the total = 100 × $0.002 = $0.20", near(t.lookup_cost, 0.2), String(t.lookup_cost));
      bar("R7 profit = 30 − 1.08 − 0.20 = 28.72; ROI = 28.72 ÷ 1.28", near(t.profit, 28.72) && near(t.roi, 28.72 / 1.28), `${t.profit} / ${t.roi}`);
      bar("R8 median lead→send from the histogram = 75 s", near(t.median_latency_sec, 75), String(t.median_latency_sec));
      bar("R9 activity has no revenue-per-admitted", t.revenue_per_admitted === null);
      const dB = r.days[0], dA = r.days[1];
      bar("R10 a day with sends but no admissions: lookup $0, ROI over send cost only", near(dB.row.lookup_cost, 0) && near(dB.row.roi, -1));
      bar("R11 pause at 23:30 ET lands on 10-01; settings change on 10-02",
        dA.markers.length === 1 && dA.markers[0].kind === "pause" && dB.markers.length === 1 && dB.markers[0].kind === "settings",
        JSON.stringify(r.days.map((d) => d.markers.map((m) => m.kind))));
      bar("R12 activity rows are never 'maturing'", r.days.every((d) => !d.maturing));

      const s = (await get("activity", "stage", "2026-10-01", "2026-10-02"))!;
      const tg = s.totals_groups;
      bar("S1 By stage: parent then its lane, lane nested and named by tier",
        tg.map((g) => `${g.label}/${g.depth}`).join(",") === "Stage 1 · Intro/0,Clicked lane/1", JSON.stringify(tg.map((g) => [g.label, g.depth])));
      bar("S2 stage rows carry NO lookup cost; the total does", tg.every((g) => g.row.lookup_cost === null) && near(s.totals.lookup_cost, 0.2));
      bar("S2b stage rows show no admissions (null, not 0)", tg.every((g) => g.row.admitted === null && g.row.leads_admitted === null));
      bar("S3 stage profit is before lookup: 30 − 0.98 = 29.02", near(tg[0].row.profit, 29.02), String(tg[0].row.profit));
      bar("S4 stage rows sum to the total's sends", tg.reduce((a, g) => a + g.row.sends, 0) === s.totals.sends);

      const p = (await get("activity", "partner", "2026-10-01", "2026-10-02"))!;
      bar("P1 By partner: the partner, then Unattributed last",
        p.totals_groups.map((g) => g.label).join(",") === "Acme Leads,Unattributed", JSON.stringify(p.totals_groups.map((g) => g.label)));
      const un = p.totals_groups[1].row;
      bar("P2 Unattributed = the 5 no-lead sends, no admissions → lookup $0", un.sends === 5 && un.admitted === 0 && near(un.lookup_cost, 0));
      bar("P3 partner row carries lookup (admissions are attributable): 100 × $0.002", near(p.totals_groups[0].row.lookup_cost, 0.2));
      bar("P4 day 10-02 under By partner shows only Unattributed", p.days[0].groups.map((g) => g.label).join(",") === "Unattributed");

      const c = (await get("cohort", "none", "2026-10-01", "2026-10-02"))!;
      bar("C1 cohort revenue per admitted = 30 ÷ 100", near(c.totals.revenue_per_admitted, 0.3));
      bar("C2 maturity = ceil(1440/1440) + 3 = 4 days", c.maturity_days === 4);
      bar("C3 on 10-03 both cohorts (10-01, 10-02) are still maturing", c.days.every((d) => d.maturing));
      const late = (await get("cohort", "none", "2026-10-01", "2026-10-02", new Date("2026-10-05T16:00:00Z")))!;
      bar("C4 on 10-05: 10-01 matured (10-01 + 4 = 10-05), 10-02 still maturing (until 10-06)",
        late.days.find((d) => d.day === "2026-10-01")?.maturing === false && late.days.find((d) => d.day === "2026-10-02")?.maturing === true);

      const all = (await get("activity", "none", "2020-01-01", "2026-10-02"))!;
      bar("K1 'since launch' clamps to the first cell's day", all.from === "2026-10-01" && all.days.length === 2, `${all.from}, ${all.days.length} days`);
      const other = await getDripDailyResults(tx, { orgId: "00000000-0000-0000-0000-000000000000", campaignId: C, basis: "activity", breakdown: "none", from: "2026-10-01", to: "2026-10-02", lookupRate: rate });
      bar("K2 another org cannot read this campaign", other === null);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const left = (await db.execute(sql`SELECT count(*)::int AS n FROM organizations WHERE name = '__DRIP_DAILY_RESULTS_TEST__'`)) as unknown as { n: number }[];
  bar("Z rolled back: no fixture org left", left[0]?.n === 0);
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
