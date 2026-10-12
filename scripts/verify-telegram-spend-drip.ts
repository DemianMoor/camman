// Verifies the Telegram report's Spend (spendInRange) equals the /reports Overview
// Cost with drip ON, per ET day, across all orgs. READ-ONLY. Usage:
//   npx tsx --conditions=react-server scripts/verify-telegram-spend-drip.ts
import "./_env-preload";
import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { etDayRange, spendInRange } from "@/lib/reporting/report-snapshot";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
let fails = 0;
const check = (l: string, ok: boolean, d: string) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}  ${d}`); };
const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
async function main() {
  const orgs = (await db.execute(sql`SELECT id FROM organizations`)) as unknown as { id: string }[];
  for (const day of ["2026-10-11", "2026-10-10", "2026-10-09", "2026-10-06", "2026-10-01"]) {
    const start = fromZonedTime(`${day}T00:00:00`, CAMPAIGN_TIMEZONE), end = fromZonedTime(`${next(day)}T00:00:00`, CAMPAIGN_TIMEZONE);
    const tg = await spendInRange(etDayRange({ start, end }));
    let overview = 0; for (const o of orgs) overview += (await getStageMetricsInRange(o.id, day, day)).grand.cost;
    const [old] = (await db.execute(sql`SELECT coalesce(sum(total_cost),0)::float8 AS v FROM campaign_stages WHERE archived_at IS NULL AND sent_at >= ${start.toISOString()}::timestamptz AND sent_at < ${end.toISOString()}::timestamptz`)) as unknown as { v: number }[];
    check(`${day} Telegram spend = Overview Cost (drip ON)`, Math.abs(tg - overview) < 0.005, `tg $${tg.toFixed(2)}  overview $${overview.toFixed(2)}  (old tg formula $${old.v.toFixed(2)})`);
  }
  console.log(fails ? `${fails} FAIL` : "ALL PASS"); process.exit(fails ? 1 : 0);
}
main();
