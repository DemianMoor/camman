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
  let foreignProviderId: number | null = null;
  try {
    const cred = await sql`
      SELECT pc.inbound_webhook_token AS token, pc.org_id AS org_id
      FROM provider_credentials pc JOIN sms_providers p ON p.id = pc.provider_id
      WHERE p.sms_provider_id = 'ahoi' AND pc.brand_id IS NULL
    `;
    const token = cred[0]?.token as string | undefined;
    const orgId = cred[0]?.org_id as string | undefined;
    if (!token || !orgId) {
      console.log("SKIP: run scripts/seed-ahoi-webhook-token.ts first (no token set).");
      await sql.end();
      process.exit(0);
    }

    const badRes = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/bogus-token`, `source=${marker}`), {
      params: Promise.resolve({ token: "bogus-token" }),
    });
    check("unknown token -> 401", badRes.status === 401);

    // Token that resolves, but to a NON-ahoi provider's credential (e.g.
    // TextHub) -> 401, nothing written. Guards provider mis-attribution: the
    // resolver must scope the join to sms_provider_id = 'ahoi', not just
    // "provider_id is non-null".
    const foreignToken = `${marker}-foreign-token`;
    const foreignMarker = `${marker}9`; // still starts with marker -> caught by the marker cleanup below
    const foreignProvider = await sql`
      INSERT INTO sms_providers (sms_provider_id, org_id, name)
      VALUES (${marker + "-foreign-provider"}, ${orgId}, 'zzz-test foreign provider')
      RETURNING id
    `;
    foreignProviderId = foreignProvider[0].id as number;
    await sql`
      INSERT INTO provider_credentials (org_id, provider_id, api_key, inbound_webhook_token)
      VALUES (${orgId}, ${foreignProviderId}, 'zzz-test-key', ${foreignToken})
    `;
    const foreignRes = await POST(
      postReq(`https://x/api/webhooks/ahoi/inbound/${foreignToken}`, `source=${foreignMarker}`),
      { params: Promise.resolve({ token: foreignToken }) },
    );
    check("token belonging to non-ahoi provider -> 401", foreignRes.status === 401);
    const foreignRow = await sql`SELECT * FROM ahoi_inbound_events WHERE source_number = ${foreignMarker}`;
    check("no row captured for non-ahoi provider token", foreignRow.length === 0);

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
    await sql`DELETE FROM ahoi_inbound_events WHERE source_number LIKE ${marker + "%"}`;
    if (foreignProviderId !== null) {
      await sql`DELETE FROM provider_credentials WHERE provider_id = ${foreignProviderId}`;
      await sql`DELETE FROM sms_providers WHERE id = ${foreignProviderId}`;
    }
    await sql.end();
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
