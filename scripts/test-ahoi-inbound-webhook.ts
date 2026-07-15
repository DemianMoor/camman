// Inbound (STOP-carrying) webhook route: path-token auth + capture (Section
// 3) + Layer 1 opt-out processing (Section 4, processAhoiInboundOptOut,
// wrapped in its own db.transaction for atomicity). Direct handler
// invocation, no real Ahoi network. Writes real, marker-prefixed rows into
// ahoi_inbound_events (+ contacts/opt_outs for the STOP case) using the REAL
// seeded Ahoi credential's real token; cleans up in a finally block.
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
  const stopDigits = "31558" + Date.now().toString().slice(-5); // 10-digit, valid NANP, unique per run
  const stopE164 = "+1" + stopDigits;
  const ignoreDigits = "31559" + Date.now().toString().slice(-5); // distinct valid NANP, non-keyword message
  const ignoreE164 = "+1" + ignoreDigits;
  try {
    const cred = await sql`
      SELECT pc.inbound_webhook_token AS token, pc.org_id AS org_id
      FROM provider_credentials pc JOIN sms_providers p ON p.id = pc.provider_id
      WHERE p.sms_provider_id = 'ahi' AND pc.brand_id IS NULL
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
    // resolver must scope the join to sms_provider_id = 'ahi', not just
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

    // NOTE: message deliberately does NOT start with a STOP keyword. Section
    // 4's processAhoiInboundOptOut now runs on EVERY captured+parsed row, and
    // a STOP-classified message would run `marker` (a non-numeric string)
    // through ahoiSourceToE164 — which is self-contained (NOT via
    // validatePhone/libphonenumber). The prior risk was that stripping ALL
    // non-digit characters from a junk string like "+1zzztest138438531"
    // coincidentally leaves a 10-digit sequence ("1138438531"), which the old
    // implementation would then treat as a "valid" NANP number and
    // materialize a REAL contact/opt_out row outside this test's cleanup.
    // ahoiSourceToE164 now rejects any input containing non-numeric,
    // non-formatting characters (i.e. anything but digits/+/space/-/()/.) up
    // front, so this can't happen. Keeping this fixture's message non-STOP
    // still sends it down the early `ignored` branch (before any phone
    // parsing happens), so it only ever tests capture + multi-line
    // form-decoding, never opt-out processing (see the dedicated STOP/ignore
    // fixtures below, which use genuinely valid 10-digit NANP numbers).
    const body = `source=${encodeURIComponent(marker)}&destination=3158359592&message=Hello+there%0Athanks&type=sms&cost=0`;
    const res = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/${token}`, body), {
      params: Promise.resolve({ token }),
    });
    check("valid token -> 200", res.status === 200);

    const row = await sql`SELECT * FROM ahoi_inbound_events WHERE source_number = ${marker}`;
    check("row captured", row.length === 1, JSON.stringify(row));
    check("source='webhook' (channel discriminator)", row[0]?.source === "webhook");
    check("form-encoded message decoded", row[0]?.message === "Hello there\nthanks", JSON.stringify(row[0]?.message));
    // Section 4: Layer 1 now processes EVERY captured+parsed row — a
    // non-STOP message is marked 'ignored' (processed_at stamped) without
    // ever reaching phone normalization (matched_contact_id stays null).
    check(
      "Section 4 processes this row -> ignored (non-STOP, no phone parsing attempted)",
      row[0]?.result === "ignored" && row[0]?.matched_contact_id === null && row[0]?.processed_at !== null,
      JSON.stringify(row[0]),
    );
    check("provider_uuid is null (webhook payload has none)", row[0]?.provider_uuid === null);

    // ---- NEW (Section 4, Task 4): a real STOP end-to-end through the route
    // must produce a suppressed contact + an opt_outs row, not just a
    // captured ahoi_inbound_events row. ----
    const stopBody = `source=${stopDigits}&destination=3158359592&message=STOP&type=sms&cost=0`;
    const stopRes = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/${token}`, stopBody), {
      params: Promise.resolve({ token }),
    });
    check("STOP through the route -> 200", stopRes.status === 200);
    const stopEventRow = await sql`SELECT * FROM ahoi_inbound_events WHERE source_number = ${stopDigits}`;
    check("STOP event row captured + processed", stopEventRow.length === 1 && stopEventRow[0]?.result === "suppressed", JSON.stringify(stopEventRow[0]));
    const stopContact = await sql`SELECT id FROM contacts WHERE org_id = ${orgId} AND phone_number = ${stopE164}`;
    check("contact materialized in E.164 form", stopContact.length === 1);
    const stopOptOut = await sql`SELECT * FROM opt_outs WHERE contact_id = ${stopContact[0]?.id} AND source = 'ahoi_inbound_webhook'`;
    check("opt_outs row written with source='ahoi_inbound_webhook'", stopOptOut.length === 1);

    // ---- NEW: a non-keyword reply through the route -> 200 + row 'ignored',
    // no contact/opt_out written (processAhoiInboundOptOut's ignored path). ----
    const ignoreBody = `source=${ignoreDigits}&destination=3158359592&message=Hello+there&type=sms&cost=0`;
    const ignoreRes = await POST(postReq(`https://x/api/webhooks/ahoi/inbound/${token}`, ignoreBody), {
      params: Promise.resolve({ token }),
    });
    check("non-keyword through the route -> 200", ignoreRes.status === 200);
    const ignoreEventRow = await sql`SELECT * FROM ahoi_inbound_events WHERE source_number = ${ignoreDigits}`;
    check("non-keyword event row processed -> result='ignored'", ignoreEventRow.length === 1 && ignoreEventRow[0]?.result === "ignored", JSON.stringify(ignoreEventRow[0]));
    const ignoreContact = await sql`SELECT id FROM contacts WHERE org_id = ${orgId} AND phone_number = ${ignoreE164}`;
    check("no contact materialized for a non-keyword reply", ignoreContact.length === 0);
  } finally {
    await sql`DELETE FROM ahoi_inbound_events WHERE source_number LIKE ${marker + "%"}`;
    await sql`DELETE FROM ahoi_inbound_events WHERE source_number = ${stopDigits}`;
    await sql`DELETE FROM ahoi_inbound_events WHERE source_number = ${ignoreDigits}`;
    await sql`DELETE FROM contacts WHERE phone_number = ${stopE164}`; // cascades opt_outs
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
