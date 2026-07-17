// Healthcheck round-trip for the SimpleTexting adapter. SKIPPED (exit 0) when no
// smpl credential is seeded — the token is entered via the UI, not env, so a
// clean checkout has nothing to test. When a credential exists, resolves its
// token and calls SimpleTexting's GET /api/phones for real, printing the result.
//
// Run: npx tsx scripts/test-simpletexting-healthcheck.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

import { decryptCredentialKey } from "@/lib/sends/provider-credential";
import { simpletextingHealthcheck } from "@/lib/sends/providers/simpletexting";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const sql = postgres(dbUrl, { prepare: false, max: 1 });

  try {
    const rows = await sql<
      { id: number; api_key_encrypted: string | null; api_key: string | null }[]
    >`
      SELECT pc.id, pc.api_key_encrypted, pc.api_key
      FROM provider_credentials pc
      JOIN sms_providers p ON p.id = pc.provider_id
      WHERE p.sms_provider_id = 'smpl'
      ORDER BY pc.id
      LIMIT 1
    `;

    if (rows.length === 0) {
      console.log("SKIP: no SimpleTexting (smpl) credential seeded — nothing to round-trip.");
      console.log("      Add one via /providers/[id] → Accounts → Add account, then re-run.");
      return;
    }

    const token = decryptCredentialKey(rows[0]);
    if (!token) {
      console.log(`SKIP: smpl credential ${rows[0].id} has no resolvable key.`);
      return;
    }

    console.log(`Calling SimpleTexting GET /api/phones with credential ${rows[0].id}…`);
    const result = await simpletextingHealthcheck(token);
    console.log(`  ok:      ${result.ok}`);
    console.log(`  status:  ${result.status}`);
    console.log(`  numbers: ${result.numbers.length > 0 ? result.numbers.join(", ") : "(none)"}`);
    if (result.error) console.log(`  error:   ${result.error}`);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await sql.end();
  }
}

main();
