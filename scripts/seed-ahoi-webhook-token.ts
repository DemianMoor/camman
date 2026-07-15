// One-time script: mints provider_credentials.inbound_webhook_token for the
// Ahoi provider-default credential (idempotent — no-ops if already set), then
// prints the two webhook URLs the operator must manually paste into the
// Ahoi/api19 portal's DLR + inbound URL settings. No registration API exists
// for this platform (unlike TextHub's registerOptOutCallback / Phase 0
// recon confirmed only /cdrs/download/csv as a documented endpoint beyond
// send/lookup) — pasting these URLs into the portal is a manual runbook step.
//
// The SAME token authenticates BOTH Ahoi webhook paths — the URL PATH
// (/dlr/ vs /inbound/), not the token, distinguishes which handler runs.
//
// Run: npx tsx scripts/seed-ahoi-webhook-token.ts [https://your-prod-origin]
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

async function main() {
  const origin =
    process.argv[2] ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://<your-prod-origin>";

  const prov = await sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahoi'`;
  if (!prov[0]) {
    console.error("No ahoi provider row — run Section 1's seed (scripts/seed-ahoi-number-credential.ts) first.");
    await sql.end();
    process.exit(1);
  }

  const cred = await sql`
    SELECT id, inbound_webhook_token FROM provider_credentials
    WHERE provider_id = ${prov[0].id} AND brand_id IS NULL
  `;
  if (!cred[0]) {
    console.error("No provider-default ahoi credential — run Section 1's seed first.");
    await sql.end();
    process.exit(1);
  }

  let token = cred[0].inbound_webhook_token as string | null;
  if (!token) {
    token = randomBytes(32).toString("hex");
    await sql`
      UPDATE provider_credentials
      SET inbound_webhook_token = ${token}, updated_at = now()
      WHERE id = ${cred[0].id}
    `;
    console.log("Minted a new inbound_webhook_token.");
  } else {
    console.log("Token already set — reusing (idempotent, no-op).");
  }

  console.log(`\nPaste these into the Ahoi/api19 portal's webhook settings:`);
  console.log(`  DLR URL:      ${origin}/api/webhooks/ahoi/dlr/${token}`);
  console.log(`  Inbound URL:  ${origin}/api/webhooks/ahoi/inbound/${token}`);

  await sql.end();
}
main();
