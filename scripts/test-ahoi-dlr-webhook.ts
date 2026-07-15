// DLR webhook route: path-token auth, raw+parsed capture. Invokes the
// exported POST handler directly with a synthetic NextRequest (no real Ahoi
// network, no dev server). Writes a real row into the new, empty, append-only
// ahoi_dlr_events table using the REAL seeded Ahoi credential's real token
// (scripts/seed-ahoi-webhook-token.ts must have run) — every row this test
// creates carries a "zzz-test-" prefixed provider_uuid marker and is deleted
// in a finally block. Never touches contacts/opt_outs/campaigns.
// Run: npx tsx scripts/test-ahoi-dlr-webhook.ts
import "./_env-preload";
import postgres from "postgres";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/webhooks/ahoi/dlr/[token]/route";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function postReq(url: string, body: string, ip = "207.181.190.156"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body,
  });
}

async function main() {
  const marker = `zzz-test-dlr-${Date.now()}`;
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

    // Unknown token -> 401, nothing written.
    const badRes = await POST(postReq(`https://x/api/webhooks/ahoi/dlr/bogus-token`, `uuid=${marker}-bad`), {
      params: Promise.resolve({ token: "bogus-token" }),
    });
    check("unknown token -> 401", badRes.status === 401);

    // Real token, well-formed DLR body -> 200 + row captured with parsed fields.
    const body = `uuid=${marker}&source=3158359592&destination=5642155963&send_status=carrier_sent&status=sent&smpp_status=sent&error=000`;
    const res = await POST(postReq(`https://x/api/webhooks/ahoi/dlr/${token}`, body), {
      params: Promise.resolve({ token }),
    });
    check("valid token -> 200", res.status === 200);

    const row = await sql`SELECT * FROM ahoi_dlr_events WHERE provider_uuid = ${marker}`;
    check("row captured", row.length === 1, JSON.stringify(row));
    check("send_status parsed", row[0]?.send_status === "carrier_sent");
    check("smpp_status parsed", row[0]?.smpp_status === "sent");
    check("raw_body stored verbatim", row[0]?.raw_body === body);
    check("source archived (fields, not DlrEvent)", row[0]?.source === "3158359592");
    check("destination archived", row[0]?.destination === "5642155963");
  } finally {
    await sql`DELETE FROM ahoi_dlr_events WHERE provider_uuid LIKE ${marker + "%"}`;
    await sql.end();
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
