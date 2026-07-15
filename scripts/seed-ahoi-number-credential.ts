// Idempotent seed of the approved Ahoi sending number + provider-default
// credential. Reads AHOI_API_TOKEN from env. Run AFTER migration 0107 applies.
// Run: npx tsx scripts/seed-ahoi-number-credential.ts <approved-10-digit-number>
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const token = process.env.AHOI_API_TOKEN;
if (!token) throw new Error("AHOI_API_TOKEN not set");
const num10 = process.argv[2];
if (!/^\d{10}$/.test(num10 ?? "")) throw new Error("pass a 10-digit number, e.g. 3158359592");

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
async function main() {
  const [prov] = await sql`SELECT id, org_id FROM sms_providers WHERE sms_provider_id = 'ahoi'`;
  if (!prov) throw new Error("Ahoi provider row missing — apply migration 0107 first");
  const e164 = `+1${num10}`;
  await sql`
    INSERT INTO provider_phones (org_id, provider_id, phone_number, number_type, status)
    VALUES (${prov.org_id}, ${prov.id}, ${e164}, '10dlc', 'active')
    ON CONFLICT (org_id, phone_number) DO NOTHING`;
  await sql`
    INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
    VALUES (${prov.org_id}, ${prov.id}, NULL, ${token!})
    ON CONFLICT (provider_id) WHERE brand_id IS NULL DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now()`;
  await sql.end();
  console.log(`seeded Ahoi number ${e164} + provider-default credential`);
}
main();
