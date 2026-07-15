// Verifies the Ahoi provider-default credential has inbound_webhook_token
// set. Read-only. Run AFTER scripts/seed-ahoi-webhook-token.ts.
// Run: npx tsx scripts/test-ahoi-webhook-token.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const rows = await sql`
    SELECT pc.inbound_webhook_token AS token
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id
    WHERE p.sms_provider_id = 'ahoi' AND pc.brand_id IS NULL
  `;
  check("ahoi provider-default credential exists", rows.length === 1, JSON.stringify(rows));
  check(
    "inbound_webhook_token is set (>=32 hex chars)",
    typeof rows[0]?.token === "string" && rows[0].token.length >= 32,
    JSON.stringify(rows[0]),
  );
  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
