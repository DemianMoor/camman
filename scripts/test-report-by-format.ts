// P6: the By Format report dimension. Groups on the STAGE's format (name, or
// "Custom"); the per-send stamp is audit only. A throwaway org on the preview DB
// (exact numbers), torn down by id.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-report-by-format.ts
//
//   F1 a T1 stage and a custom-text stage ⇒ exactly two rows: "T1 — Brand prefix", "Custom"
//   F2 the format rows' additive metrics sum to the report totals
//   F3 …and to the Overview totals for the same window (getStageMetricsInRange,
//      drip included — the Overview's default)
//   F4 distinct counted clickers: report totals == Overview total
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { getPerformanceReport } from "@/lib/reporting/performance-report";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];
const ADDITIVE = ["sent", "opt_outs", "sales", "revenue", "cost"] as const;

async function main() {
  const tag = `p6-${Date.now().toString(36)}`;
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${"P6 by-format " + tag}) RETURNING id`)).id;
    await db.execute(sql`SELECT ensure_message_formats(${orgId}::uuid)`);
    const cre = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${tag}, ${orgId}, 'Hi', 'active') RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode) VALUES (${orgId}, ${tag}, 'P6', 'active', 'manual') RETURNING id`);
    // T1 stage: the BEFORE INSERT trigger stamps the org default (T1).
    await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, sent_at, sms_count, total_cost)
      VALUES (${orgId}, ${camp.id}, 1, ${cre.id}, now(), 10, 1.5)`);
    await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, sent_at, sms_count, total_cost, message_format_id, custom_text)
      VALUES (${orgId}, ${camp.id}, 2, ${cre.id}, now(), 20, 3.25, NULL, 'Hey {creative_text} {url} {stop_text}')`);

    const day = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
    const report = await getPerformanceReport(orgId, "format", { from: day, to: day, providerPhoneId: null });
    const labels = report.rows.map((r) => r.label).sort();
    bar("F1 two rows: 'Custom' and 'T1 — Brand prefix'", JSON.stringify(labels) === JSON.stringify(["Custom", "T1 — Brand prefix"]), JSON.stringify(report.rows.map((r) => [r.label, r.sent, r.cost])));

    const sum = Object.fromEntries(ADDITIVE.map((k) => [k, report.rows.reduce((a, r) => a + Number(r[k] ?? 0), 0)]));
    bar("F2 rows sum to the report totals (sent, opt_outs, sales, revenue, cost)",
      ADDITIVE.every((k) => Math.abs(sum[k] - Number(report.totals[k] ?? 0)) < 1e-9), JSON.stringify({ sum, totals: ADDITIVE.map((k) => report.totals[k]) }));

    const ov = await getStageMetricsInRange(orgId, day, day, { excludeDrip: false });
    const overview = { sent: ov.grandTotalSent, opt_outs: ov.grandOptOuts, sales: ov.grand.sales, revenue: ov.grand.revenue, cost: ov.grand.cost };
    bar("F3 rows sum to the Overview totals for the same window", ADDITIVE.every((k) => Math.abs(sum[k] - Number(overview[k])) < 1e-9),
      JSON.stringify({ sum, overview }));
    bar("F4 counted clickers: report total == Overview total", report.totals.counted_clickers === ov.clickers.periodTotal,
      `${report.totals.counted_clickers} vs ${ov.clickers.periodTotal}`);
  } finally {
    if (orgId) await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    const left = orgId ? await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM campaign_stages WHERE org_id = ${orgId}::uuid`) : { n: 0 };
    console.log(`  (teardown: ${left.n} fixture stages left)`);
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
