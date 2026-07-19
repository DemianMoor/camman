import { config } from "dotenv"; import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { fromZonedTime } from "date-fns-tz";

const TZ = "America/New_York";
const boundsUtc = (from: string, toExclusive: string) => ({
  fromUtc: fromZonedTime(`${from}T00:00:00`, TZ).toISOString(),
  toUtc: fromZonedTime(`${toExclusive}T00:00:00`, TZ).toISOString(),
  providerPhoneId: null as number | null,
});

async function main() {
  // dynamic import AFTER env is loaded so @/db/client picks up DATABASE_URL
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { getPerformanceReport, getReportProviderOptions } =
    await import("@/lib/reporting/performance-report");
  const { REPORT_DIMENSIONS } = await import("@/lib/reporting/report-dimensions");

  const orgRows = (await db.execute(sql`select org_id from report_stage_hour limit 1`)) as any[];
  const orgId = orgRows[0].org_id as string;
  const b = boundsUtc("2026-06-01", "2026-07-20");
  let fail = 0;
  for (const dim of REPORT_DIMENSIONS) {
    const r = await getPerformanceReport(orgId, dim, b);
    const sumRows = r.rows.reduce((a: number, x: any) => a + x.sent, 0);
    console.log(`${dim.padEnd(9)} rows=${String(r.rows.length).padStart(3)} totals.sent=${r.totals.sent} totals.rev=$${r.totals.revenue.toFixed(0)} rowSent=${sumRows} refreshed=${r.refreshedAt ? "yes" : "no"}`);
    if (r.totals.sent < 967000) { console.log(`  x ${dim} totals.sent too low`); fail++; }
    if (dim !== "group" && sumRows !== r.totals.sent) { console.log(`  x ${dim} rows dont sum to total (${sumRows} vs ${r.totals.sent})`); fail++; }
    if (dim === "group" && sumRows <= r.totals.sent) { console.log(`  x group should fan out above total`); fail++; }
    if (r.rows.length === 0) { console.log(`  x ${dim} no rows`); fail++; }
  }
  const provs = await getReportProviderOptions(orgId);
  console.log(`providers: ${provs.length} -> ${provs.map((p: any) => `${p.provider_name}:${p.phone_number}`).join(", ")}`);
  const num = await getPerformanceReport(orgId, "number", b);
  console.log("sample number row:", JSON.stringify({ label: num.rows[0].label, provider: num.rows[0].provider_name, color: num.rows[0].provider_color, sent: num.rows[0].sent }));
  const hourly = await getPerformanceReport(orgId, "hourly", boundsUtc("2026-07-01", "2026-07-02"));
  console.log("hourly (Jul 1):", hourly.rows.map((r: any) => `${r.label}:${r.sent}`).join(", ") || "(none)");
  console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
