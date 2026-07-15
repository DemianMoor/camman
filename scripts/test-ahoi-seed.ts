// Verifies the Ahoi provider/number/credential seed is present + idempotent.
// Run: npx tsx scripts/test-ahoi-seed.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const prov = await sql`SELECT id, supports_api_send FROM sms_providers WHERE sms_provider_id = 'ahi'`;
  check("ahi provider row exists", prov.length === 1);
  check("supports_api_send = true", prov[0]?.supports_api_send === true);
  const cred = await sql`SELECT 1 FROM provider_credentials WHERE provider_id = ${prov[0]?.id ?? null} AND brand_id IS NULL`;
  check("provider-default credential exists", cred.length === 1);
  const ph = await sql`SELECT 1 FROM provider_phones WHERE provider_id = ${prov[0]?.id ?? null}`;
  check("at least one provider_phone", ph.length >= 1);
  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
