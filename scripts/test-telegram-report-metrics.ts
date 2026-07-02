import { resolve } from "node:path";

import { config } from "dotenv";
import { sql } from "drizzle-orm";

config({ path: resolve(process.cwd(), ".env.local") });

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { etDayRange, type EtDayRange } from "@/lib/reporting/report-snapshot";
import { salesRevenueTotals } from "@/lib/reporting/attribution";

// Ground-truth metric computation for a given ET-day range, run SEQUENTIALLY
// (one query at a time) to avoid the concurrent-cold-login failures a standalone
// script hits against the transaction pooler. Mirrors computeReportMetrics —
// the difference is Promise.all vs. serial, not the SQL — so the numbers here
// equal what the route sends. Lets us eyeball vs. the Telegram message.
async function metrics(range: EtDayRange) {
  const orgs = (await db.execute(sql`
    select id::text as id from organizations
  `)) as unknown as { id: string }[];

  let sales = 0;
  let revenue = 0;
  for (const { id } of orgs) {
    const t = await salesRevenueTotals({
      orgId: id,
      statDateFrom: range.statDateFrom,
      statDateToExclusive: range.statDateToExclusive,
      manualFromUtc: range.fromUtc,
      manualToExclusiveUtc: range.toExclusiveUtc,
    });
    sales += t.sales;
    revenue += Number(t.revenue);
  }

  const [spendRow] = (await db.execute(sql`
    select coalesce(sum(cs.total_cost),0)::numeric(12,4)::text as v
    from campaign_stages cs
    where cs.archived_at is null
      and cs.sent_at >= ${range.fromUtc.toISOString()}::timestamptz
      and cs.sent_at <  ${range.toExclusiveUtc.toISOString()}::timestamptz
  `)) as unknown as { v: string }[];
  const spend = Number(spendRow.v);

  const [ooRow] = (await db.execute(sql`
    select count(*)::int as n from opt_outs
    where reason='opt_out'
      and created_at >= ${range.fromUtc.toISOString()}::timestamptz
      and created_at <  ${range.toExclusiveUtc.toISOString()}::timestamptz
  `)) as unknown as { n: number }[];

  const [sentRow] = (await db.execute(sql`
    select count(*)::int as n from stage_sends
    where status='sent'
      and sent_at >= ${range.fromUtc.toISOString()}::timestamptz
      and sent_at <  ${range.toExclusiveUtc.toISOString()}::timestamptz
  `)) as unknown as { n: number }[];

  return {
    sales,
    revenue,
    spend,
    optOuts: Number(ooRow.n),
    delivered: Number(sentRow.n),
    roiPct: spend > 0 ? ((revenue - spend) / spend) * 100 : null,
  };
}

async function main() {
  const now = new Date();
  const today = campaignDayBoundsUtc(now);
  const yesterday = campaignDayBoundsUtc(new Date(today.start.getTime() - 1000));

  const yRange = etDayRange(yesterday);
  const tRange = etDayRange(today);
  console.log("Yesterday ET:", yRange.statDateFrom, "| Today ET:", tRange.statDateFrom);

  const yМ = await metrics(yRange);
  const tМ = await metrics(tRange);

  console.log("\n=== DAILY (yesterday, final) ===");
  console.log(yМ);
  console.log("=== HOURLY basis (today so far) ===");
  console.log(tМ);
  console.log("Yesterday spend (hourly footer):", yМ.spend);

  console.log(
    "\nROI n/a branch:",
    yМ.spend === 0 ? "yesterday spend==0 ⇒ roi=" + yМ.roiPct : "yesterday spend>0",
    "|",
    tМ.spend === 0 ? "today spend==0 ⇒ roi=" + tМ.roiPct : "today spend>0",
  );
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
