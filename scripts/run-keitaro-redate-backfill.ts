// One-time backfill: re-run the Keitaro aggregate poll over a wide window so every
// stored keitaro_stage_results row is re-dated under the conversion-day attribution
// fix (sales bucketed by the conversion's own day, not the click day).
// Idempotent — safe to re-run. Run: npx tsx scripts/run-keitaro-redate-backfill.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { pollKeitaro } from "@/lib/keitaro/poll";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";

async function snapshot(db: ReturnType<typeof drizzle>, label: string, today: string) {
  const total = (await db.execute(sql`
    SELECT coalesce(sum(sales),0)::int AS sales, coalesce(sum(revenue),0)::numeric(12,4)::text AS revenue
    FROM keitaro_stage_results
    WHERE stat_date >= (current_date - interval '45 days')
  `)) as unknown as Array<{ sales: number; revenue: string }>;
  const todayRow = (await db.execute(sql`
    SELECT coalesce(sum(sales),0)::int AS sales
    FROM keitaro_stage_results WHERE stat_date = ${today}
  `)) as unknown as Array<{ sales: number }>;
  console.log(
    `[${label}]  45d total sales=${total[0]?.sales}  revenue=${total[0]?.revenue}  |  today(${today}) sales=${todayRow[0]?.sales}`,
  );
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  try {
    await snapshot(db, "BEFORE", today);
    console.log("\nRe-polling Keitaro with windowDays=45 (writes keitaro_stage_results)...");
    const r = await pollKeitaro(db, { windowDays: 45 });
    console.log(JSON.stringify(r, null, 2));
    console.log("");
    await snapshot(db, "AFTER ", today);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("backfill failed:", e);
  process.exit(1);
});
