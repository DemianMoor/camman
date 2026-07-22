// READ-ONLY. Lists tracked/API-send stages on ACTIVE campaigns that have no
// provider_phone_id — these would now be blocked by the generalized kickoff
// no_sender_number gate (Task 3). Run BEFORE deploying that change so nothing
// in-flight is stranded. Run: npx tsx scripts/audit-stages-missing-sender.ts
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db } from "@/db/client";

async function main() {
  const rows = (await db.execute(sql`
    SELECT c.id AS campaign_id, c.name AS campaign_name, c.org_id,
           s.id AS stage_id, s.stage_number, p.name AS provider_name,
           p.sms_provider_id AS provider_key
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.status = 'active'
      AND c.link_mode = 'tracked'
      AND p.supports_api_send = true
      AND s.provider_phone_id IS NULL
    ORDER BY c.org_id, c.id, s.stage_number
  `)) as unknown as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log("OK — no active tracked/API-send stages are missing a sender.");
  } else {
    console.log(`WARNING — ${rows.length} stage(s) would be blocked by the new gate:`);
    for (const r of rows) console.log(r);
  }
  process.exit(0);
}
void main();
