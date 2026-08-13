// Mints provider_credentials.inbound_webhook_token for the Tells (`tls`)
// credential and prints the two webhook URLs to paste into the Tells dashboard.
// Mirrors scripts/seed-ahoi-webhook-token.ts.
//
// IDEMPOTENT: if a token already exists it is reused and printed, never
// regenerated — re-running this must not silently invalidate a live webhook.
//
// ⚠️ ROTATION ORDER (docs/04-features/tells-runbook.md §3): to ROTATE, update
// the Tells dashboard URL FIRST, then clear the column and re-run this. Doing
// it the other way round refuses every callback in between — and Tells abandons
// a message's remaining statuses after 4 failed attempts, so those events are
// gone for good. There is no reconciliation API to recover them from.
//
// Run: npx tsx scripts/seed-tells-webhook-token.ts [origin]
import "./_env-preload";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

async function main() {
  const origin = (
    process.argv[2] ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://camman.vercel.app"
  ).replace(/\/+$/, "");

  const prov = await sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'tls'`;
  if (!prov[0]) {
    console.error("No `tls` provider row.");
    await sql.end();
    process.exit(1);
  }

  const cred = await sql`
    SELECT id, label, inbound_webhook_token
    FROM provider_credentials WHERE provider_id = ${prov[0].id}
    ORDER BY id
  `;
  if (!cred[0]) {
    console.error("No Tells credential — add one in the UI first.");
    await sql.end();
    process.exit(1);
  }
  if (cred.length > 1) {
    console.error(
      `Found ${cred.length} Tells credentials; this script assumes one. Resolve manually.`,
    );
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
    console.log(`Minted a new inbound_webhook_token for credential ${cred[0].id} (${cred[0].label}).`);
  } else {
    console.log(`Token already set on credential ${cred[0].id} — reusing (idempotent, no-op).`);
  }

  console.log(`\nPaste these into the Tells dashboard's webhook settings:`);
  console.log(`  Delivery status (DLR):  ${origin}/api/webhooks/tells/dlr/${token}`);
  console.log(`  Inbound message:        ${origin}/api/webhooks/tells/inbound/${token}`);
  console.log(
    `\nNote: the DLR route authenticates on this path token ALONE. The inbound route\n` +
      `additionally validates the payload's \`Key\` field against the stored API key,\n` +
      `and redacts it before persisting (spec §4.6).`,
  );

  await sql.end();
}
main();
