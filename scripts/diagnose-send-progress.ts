import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// READ-ONLY snapshot: are in-flight sends still progressing?
// For every stage that has stage_sends rows touched in the last 2 days, shows
// the status breakdown + how recently a send was attempted. Run before/after a
// deploy to confirm the live drain keeps moving. Run: npx tsx scripts/diagnose-send-progress.ts

async function main() {
  const rows = (await db.execute(sql`
    SELECT
      ss.stage_id,
      s.stage_number,
      c.name AS campaign_name,
      c.status AS campaign_status,
      count(*) FILTER (WHERE ss.status = 'pending')::int  AS pending,
      count(*) FILTER (WHERE ss.status = 'sending')::int  AS sending,
      count(*) FILTER (WHERE ss.status = 'sent')::int     AS sent,
      count(*) FILTER (WHERE ss.status = 'failed')::int   AS failed,
      count(*) FILTER (WHERE ss.status = 'filtered')::int AS filtered,
      max(ss.sent_at) AS last_sent_at,
      now() AS db_now
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id
    JOIN campaigns c ON c.id = ss.campaign_id
    WHERE ss.created_at > now() - interval '2 days'
       OR ss.sent_at   > now() - interval '2 days'
    GROUP BY ss.stage_id, s.stage_number, c.name, c.status
    ORDER BY max(ss.sent_at) DESC NULLS LAST
    LIMIT 50
  `)) as unknown as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log("No stage_sends rows touched in the last 2 days.");
    return;
  }

  console.log(`db now(): ${rows[0].db_now}\n`);
  for (const r of rows) {
    const last = r.last_sent_at ? String(r.last_sent_at) : "—never—";
    console.log(
      `Stage #${r.stage_number} "${r.campaign_name}" [${r.campaign_status}] — ` +
        `pending ${r.pending} · sending ${r.sending} · sent ${r.sent} · ` +
        `failed ${r.failed} · filtered ${r.filtered}  | last sent_at: ${last}`,
    );
    if (Number(r.sending) > 0) {
      console.log(`   ⚠ ${r.sending} row(s) in 'sending' — fine if a drain is mid-flight; stuck if it stays`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
