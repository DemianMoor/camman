import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY: what Text Request schema is actually APPLIED to the (shared)
// database right now, vs what the migration files declare. The txr branch adds
// migrations that are deliberately NOT applied until the gated go-live step, so
// any DB-backed test has to know which objects exist. No writes.
//
// Run: npx tsx scripts/probe-textrequest-schema-state.ts

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async (label: string, query: ReturnType<typeof sql>) => {
    const r = (await d.execute(query)) as unknown as Record<string, unknown>[];
    console.log(`${label}: ${JSON.stringify(r)}`);
  };

  await q(
    "tables",
    sql`SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('textrequest_dlr_events','textrequest_inbound_events','ahoi_inbound_events')
        ORDER BY table_name`,
  );
  await q(
    "send_attempts.segments_count",
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_name='send_attempts' AND column_name='segments_count'`,
  );
  await q("txr dlr indexes", sql`SELECT indexname FROM pg_indexes WHERE tablename='textrequest_dlr_events'`);
  await q(
    "applied migrations (last 4)",
    sql`SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 4`,
  );
  await q(
    "txr phones",
    sql`SELECT ph.id, ph.phone_number, ph.dashboard_id, ph.credential_id, ph.status, ph.max_sends_per_second
        FROM provider_phones ph JOIN sms_providers p ON p.id = ph.provider_id
        WHERE p.sms_provider_id = 'txr'`,
  );
  await q(
    "txr provider flags",
    sql`SELECT id, sms_provider_id, supports_api_send, send_paused FROM sms_providers WHERE sms_provider_id = 'txr'`,
  );
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
