import "./_env-preload";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { formatLatency, leadToSendLatency } from "@/lib/drip/lead-latency";

// Per-ET-day drip lead-to-send (p50 / p95 and hop medians) — READ-ONLY.
//
//   npx tsx --conditions=react-server scripts/lead-to-send-latency.ts [days=7]
//
// Same definition as the alert, the per-minute log and the hourly digest
// (lib/drip/lead-latency.ts): leads routed on arrival only. Today is so far.

async function main() {
  const days = Math.max(1, Number(process.argv[2] ?? 7));
  const orgs = (await db.execute(sql`
    SELECT os.org_id, o.name FROM org_settings os JOIN organizations o ON o.id = os.org_id
    WHERE os.drip_enabled = true
  `)) as unknown as { org_id: string; name: string }[];
  const now = new Date();
  for (const org of orgs) {
    console.log(`\n${org.name}`);
    console.log("ET day       n      p50     p95     lookup  route   queue   send");
    let bounds = campaignDayBoundsUtc(now);
    for (let i = 0; i < days; i++) {
      const to = bounds.end < now ? bounds.end : now;
      const l = await leadToSendLatency(db, { orgId: org.org_id, from: bounds.start, to });
      const s = l.stepP50Sec;
      const day = bounds.start.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      console.log(
        [day, String(l.n).padStart(6), formatLatency(l.p50Sec).padStart(7), formatLatency(l.p95Sec).padStart(7),
         formatLatency(s.lookup).padStart(7), formatLatency(s.route).padStart(7),
         formatLatency(s.queue).padStart(7), formatLatency(s.send).padStart(7)].join(" "),
      );
      bounds = campaignDayBoundsUtc(new Date(bounds.start.getTime() - 1000));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
