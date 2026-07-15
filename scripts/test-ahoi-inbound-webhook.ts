// Inbound (STOP-carrying) webhook route: path-token auth, capture only (no
// reconcile, no opt_outs write). Direct handler invocation, no real Ahoi
// network. Writes a real, marker-prefixed row into the new, empty
// ahoi_inbound_events table using the REAL seeded Ahoi credential's real
// token; cleans up in a finally block.
// Run: npx tsx scripts/test-ahoi-inbound-webhook.ts
import "./_env-preload";
import postgres from "postgres";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/webhooks/ahoi/inbound/[token]/route";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function postReq(url: string, body: string, ip = "207.181.190.161"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body,
  });
}

async function main() {
  const marker = `+1zzztest${Date.now().toString().slice(-9)}`;
  try {
    const cred = await sql`
      SELECT pc.inbound_webhook_token AS token
      FROM provider_credentials pc JOIN sms_providers p ON p.id = pc.provider_id
      WHERE p.sms_provider_id = 'ahoi' AND pc.brand_id IS NULL
    `;
    const token = cred[0]?.token as string | undefined;
    if (!token) {
      console.log("SKIP: run scripts/seed-ahoi-webhook-token.ts first (no token set).");
      await sql.end();
      process.exit(0);
    }

    const badRes = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/bogus-token`, `source=${marker}`), {
      params: Promise.resolve({ token: "bogus-token" }),
    });
    check("unknown token -> 401", badRes.status === 401);

    const body = `source=${encodeURIComponent(marker)}&destination=3158359592&message=Stop+please%0Athanks&type=sms&cost=0`;
    const res = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/${token}`, body), {
      params: Promise.resolve({ token }),
    });
    check("valid token -> 200", res.status === 200);

    const row = await sql`SELECT * FROM ahoi_inbound_events WHERE source_number = ${marker}`;
    check("row captured", row.length === 1, JSON.stringify(row));
    check("source='webhook' (channel discriminator)", row[0]?.source === "webhook");
    check("form-encoded message decoded", row[0]?.message === "Stop please\nthanks", JSON.stringify(row[0]?.message));
    check("no reconcile fields set (Section 4's job)", row[0]?.matched_contact_id === null && row[0]?.processed_at === null);
    check("provider_uuid is null (webhook payload has none)", row[0]?.provider_uuid === null);
  } finally {
    await sql`DELETE FROM ahoi_inbound_events WHERE source_number = ${marker}`;
    await sql.end();
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
