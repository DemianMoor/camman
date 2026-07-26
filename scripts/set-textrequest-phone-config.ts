import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// One-off data repair for the Text Request sending number.
//
// WHY A SCRIPT: provider_phones.max_sends_per_second and dashboard_id could not
// be set through the UI for an already-created number — the Edit dialog dropped
// both fields before the fetch (fixed in this branch). Phone 114 was created
// 2026-07-24 with both NULL, so the number paces at the built-in 10/s default
// instead of Text Request's 25/s TFN rate, and has no dashboard binding at all.
// TR is dashboard-scoped 1:1 per number and resolves stage->phone->dashboard at
// send time, so a NULL dashboard_id blocks the `txr` supports_api_send flip.
//
// Idempotent: the UPDATE is a no-op when the row already carries these values.
// Dry-run by default. Apply with:  npx tsx scripts/set-textrequest-phone-config.ts --apply

const PHONE_ID = 114;
const MAX_SENDS_PER_SECOND = 25;
const DASHBOARD_ID = "68093";

async function main() {
  const apply = process.argv.includes("--apply");
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);

  const before = (await d.execute(sql`
    SELECT pp.id, pp.phone_number, pp.number_type, pp.status,
           pp.max_sends_per_second, pp.dashboard_id,
           pp.provider_id, p.sms_provider_id, p.supports_api_send
    FROM provider_phones pp
    JOIN sms_providers p ON p.id = pp.provider_id
    WHERE pp.id = ${PHONE_ID}
  `)) as unknown as Record<string, unknown>[];

  if (before.length === 0) {
    console.error(`Phone ${PHONE_ID} not found — aborting.`);
    await c.end();
    process.exit(1);
  }

  console.log("BEFORE:", JSON.stringify(before[0], null, 2));

  // Guard: refuse to touch a number that isn't the Text Request one, in case
  // ids differ between environments.
  if (before[0].sms_provider_id !== "txr") {
    console.error(
      `Phone ${PHONE_ID} belongs to provider '${before[0].sms_provider_id}', not 'txr' — aborting.`,
    );
    await c.end();
    process.exit(1);
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — would set max_sends_per_second=${MAX_SENDS_PER_SECOND}, ` +
        `dashboard_id='${DASHBOARD_ID}' on phone ${PHONE_ID}.\n` +
        `Re-run with --apply to write.`,
    );
    await c.end();
    return;
  }

  await d.execute(sql`
    UPDATE provider_phones
    SET max_sends_per_second = ${MAX_SENDS_PER_SECOND},
        dashboard_id = ${DASHBOARD_ID}
    WHERE id = ${PHONE_ID}
  `);

  const after = (await d.execute(sql`
    SELECT id, phone_number, max_sends_per_second, dashboard_id
    FROM provider_phones WHERE id = ${PHONE_ID}
  `)) as unknown as Record<string, unknown>[];
  console.log("AFTER:", JSON.stringify(after[0], null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
