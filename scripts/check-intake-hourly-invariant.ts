// Day-sum invariant for lead_intake_hourly (0199): for each ET day, the hourly
// rows must add up to the lead_intake_daily row, per org x partner x tag, every
// counter column. The hourly digest runs the same check on the digested day
// and appends a warning line when it fails; this script runs it on demand over
// a range. READ-ONLY — safe against production.
//
//   npx tsx --conditions=react-server scripts/check-intake-hourly-invariant.ts [fromDay] [toDay]
//   (days as YYYY-MM-DD ET; default = today ET)
//
// A day that began before hourly tracking did is reported as SKIPPED, not
// passed — its daily row legitimately includes pre-0199 intake.
import "./_env-preload";
import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { checkDaySumInvariant } from "@/lib/drip/intake-digest";

async function main() {
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const from = process.argv[2] ?? today;
  const to = process.argv[3] ?? from;

  const orgs = (await db.execute(sql`
    SELECT org_id, min(hour_et) AS first_hour, count(*)::int AS rows
    FROM lead_intake_hourly GROUP BY org_id
  `)) as unknown as { org_id: string; first_hour: string; rows: number }[];
  console.log(`scope: ${from} → ${to} (ET), ${orgs.length} org(s) with hourly rows`);
  if (orgs.length === 0) {
    console.log("FAIL: no hourly rows at all — nothing was checked");
    process.exit(1);
  }

  let breaks = 0;
  let checked = 0;
  for (const o of orgs) {
    const first = new Date(o.first_hour);
    console.log(`org ${o.org_id}: ${o.rows} hourly rows, tracking began ${first.toISOString()}`);
    for (let d = from; d <= to; ) {
      // Noon ET is safely inside the day on DST days too.
      const noon = fromZonedTime(`${d}T12:00:00`, CAMPAIGN_TIMEZONE);
      const r = await checkDaySumInvariant(db, o.org_id, noon, first);
      if (r == null) console.log(`  ${d}: SKIPPED (tracking began mid-day or later)`);
      else {
        checked++;
        breaks += r.breaks.length;
        console.log(`  ${d}: ${r.breaks.length === 0 ? "OK" : `${r.breaks.length} BREAK(S)`}`);
        for (const b of r.breaks) console.log(`    ${b.partner}/${b.tag || "(untagged)"} ${b.column}: hourly ${b.hourlySum} ≠ daily ${b.daily}`);
      }
      d = formatInCampaignTimezone(new Date(noon.getTime() + 24 * 3600 * 1000), "yyyy-MM-dd");
    }
  }
  console.log(`\n${checked} org-day(s) checked, ${breaks} break(s)`);
  process.exit(breaks > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
