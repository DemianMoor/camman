// One-off operator action: move provider_phone 294 (+18558358457) from
// provider 499 (txh2, "Texthub - 621637+TFN") to provider 2 (txh, "TextHub").
//
// Context: the number was registered in CamMan under txh2, but TextHub rejects
// every send from it on that account with HTTP 403
// {"response":"Sender not assigned to your account"} (incident 2026-09-09,
// which latched the txh2 provider breaker and froze the whole account). The
// operator has determined the number actually belongs to the txh account.
//
// Semantics are copied EXACTLY from the product's own move path, PATCH
// /api/providers/[providerId]/phones/[phoneId] (see that route's "Move to
// another provider" block):
//   1. provider_id  -> target (in place; (org_id, phone_number) is unchanged so
//      the unique constraint is never re-triggered).
//   2. credential_id -> NULL   (the old link belonged to the OLD provider;
//      leaving 462 in place would send txh2's key on a txh number and reproduce
//      the very mismatch that caused the outage). Provider 2 holds exactly one
//      credential, so resolveKeyForStage's single-credential legacy fallback
//      resolves the key from (provider, brand)/default — verified below.
//
// The route would return 409 move_needs_confirmation here because stage 4108 is
// still 'pending' and references this number; that stage belongs to the
// CANCELLED + latched campaign 1262, so the move is intentional (equivalent to
// the UI's confirm_move: true).
//
// KNOWN SIDE EFFECT (same as the UI path): number-level reports resolve a
// send's provider from the phone's CURRENT provider_id, so this number's past
// sends re-attribute from txh2 to txh.
//
// Idempotent. Dry-run by default; pass --apply to write.
import "./_env-preload";

import postgres from "postgres";

const PHONE_ID = 294;
const EXPECTED_PHONE_NUMBER = "+18558358457";
const FROM_PROVIDER_ID = 499;
const TO_PROVIDER_KEY = "txh";
const APPLY = process.argv.includes("--apply");

const conn = process.env.DATABASE_URL;
if (!conn) throw new Error("DATABASE_URL is not set (is .env.local present?)");
const sql = postgres(conn, { max: 2, prepare: false });

async function main() {
  // ---- Guard: prove we are pointed at the right row before writing. ----
  const rows = (await sql`
    SELECT ph.id, ph.org_id, ph.phone_number, ph.provider_id, ph.credential_id,
           ph.brand_id, ph.number_type, ph.status, ph.max_sends_per_second,
           p.sms_provider_id AS pkey, p.name AS pname
    FROM provider_phones ph
    JOIN sms_providers p ON p.id = ph.provider_id
    WHERE ph.id = ${PHONE_ID}
  `) as unknown as {
    id: number; org_id: string; phone_number: string; provider_id: number;
    credential_id: number | null; brand_id: number | null; number_type: string;
    status: string; max_sends_per_second: number | null; pkey: string; pname: string;
  }[];
  if (rows.length === 0) throw new Error(`provider_phone ${PHONE_ID} not found`);
  const ph = rows[0];
  if (ph.phone_number !== EXPECTED_PHONE_NUMBER) {
    throw new Error(
      `REFUSING: phone ${PHONE_ID} is ${ph.phone_number}, expected ${EXPECTED_PHONE_NUMBER}`,
    );
  }

  console.log(`Phone ${ph.id}  ${ph.phone_number}  (${ph.number_type}, status=${ph.status})`);
  console.log(`  currently on provider ${ph.provider_id} [${ph.pkey}] "${ph.pname}"`);
  console.log(`  credential_id=${ph.credential_id}  brand_id=${ph.brand_id}  mps=${ph.max_sends_per_second}`);

  if (ph.provider_id !== FROM_PROVIDER_ID) {
    console.log(`\nAlready moved off provider ${FROM_PROVIDER_ID} — nothing to do.`);
    return;
  }

  // ---- Target provider must exist in the SAME org (route's check). ----
  const target = (await sql`
    SELECT id, sms_provider_id, name, supports_api_send, sends_enabled, send_paused,
           (SELECT count(*)::int FROM provider_credentials pc
             WHERE pc.org_id = ${ph.org_id} AND pc.provider_id = p.id) AS cred_count
    FROM sms_providers p
    WHERE p.org_id = ${ph.org_id} AND p.sms_provider_id = ${TO_PROVIDER_KEY}
  `) as unknown as {
    id: number; sms_provider_id: string; name: string; supports_api_send: boolean;
    sends_enabled: boolean; send_paused: boolean; cred_count: number;
  }[];
  if (target.length !== 1) {
    throw new Error(`REFUSING: expected exactly 1 provider with key '${TO_PROVIDER_KEY}' in org, got ${target.length}`);
  }
  const t = target[0];
  console.log(`\nTarget provider ${t.id} [${t.sms_provider_id}] "${t.name}"`);
  console.log(`  supports_api_send=${t.supports_api_send} sends_enabled=${t.sends_enabled} send_paused=${t.send_paused}`);
  console.log(`  credentials on this provider: ${t.cred_count}`);

  // credential_id is cleared by the move, so the key must still be reachable
  // via the single-credential legacy fallback. If the target has 0 or >1
  // credentials, resolveKeyForStage returns NULL and sends refuse with
  // no_credentials — surface that instead of silently creating it.
  if (t.cred_count !== 1) {
    console.log(
      `\n  ⚠ WARNING: target has ${t.cred_count} credentials. The move clears credential_id,\n` +
        `    and resolveKeyForStage's legacy fallback only fires when the provider has\n` +
        `    EXACTLY ONE credential. A stage on this number would refuse with\n` +
        `    'no_credentials' until credential_id is set explicitly.`,
    );
  }
  const brandMatch = (await sql`
    SELECT count(*)::int AS n FROM provider_credentials
    WHERE org_id = ${ph.org_id} AND provider_id = ${t.id}
      AND (brand_id = ${ph.brand_id} OR brand_id IS NULL)
  `) as unknown as { n: number }[];
  console.log(
    `  credentials matching (brand_id=${ph.brand_id} OR NULL): ${brandMatch[0]?.n ?? 0}` +
      ((brandMatch[0]?.n ?? 0) === 0 ? "   ⚠ key would NOT resolve" : ""),
  );

  // ---- Stages still referencing this number (route's 409 warning set). ----
  const liveStages = (await sql`
    SELECT s.id AS stage_id, s.campaign_id, c.tracking_id AS campaign_tracking_id,
           s.stage_number, s.status, c.name AS campaign_name,
           c.status AS campaign_status, c.send_paused AS campaign_send_paused,
           s.sms_provider_id
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.org_id = ${ph.org_id} AND s.provider_phone_id = ${PHONE_ID}
      AND s.status IN ('draft', 'pending')
    ORDER BY s.campaign_id, s.stage_number
    LIMIT 50
  `) as unknown as Record<string, unknown>[];
  console.log(`\nUnsent stages referencing this number: ${liveStages.length}`);
  for (const s of liveStages) {
    console.log(
      `  stage ${s.stage_id} (campaign ${s.campaign_id} ${s.campaign_tracking_id}, ` +
        `stage status=${s.status}, campaign status=${s.campaign_status}, ` +
        `send_paused=${s.campaign_send_paused}, stage.sms_provider_id=${s.sms_provider_id})`,
    );
  }
  if (liveStages.length > 0) {
    console.log(
      `  NOTE: these keep sms_provider_id=${FROM_PROVIDER_ID} while the number now lives on\n` +
        `  provider ${t.id}. The product allows this (warn-only) — but do NOT reuse such a\n` +
        `  stage for a real send; build a fresh stage on the new provider instead.`,
    );
  }

  console.log(
    `\nMode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes; pass --apply to commit)"}`,
  );
  console.log(
    `Would set: provider_id ${ph.provider_id} -> ${t.id}, credential_id ${ph.credential_id} -> NULL`,
  );

  if (!APPLY) {
    console.log("\nDry run - nothing written.");
    return;
  }

  const updated = (await sql`
    UPDATE provider_phones
    SET provider_id = ${t.id}, credential_id = NULL
    WHERE id = ${PHONE_ID}
      AND org_id = ${ph.org_id}
      AND provider_id = ${FROM_PROVIDER_ID}
    RETURNING id, phone_number, provider_id, credential_id
  `) as unknown as Record<string, unknown>[];

  if (updated.length !== 1) {
    throw new Error(`Expected 1 row updated, got ${updated.length} (concurrent change?)`);
  }
  console.log("\nCommitted:", JSON.stringify(updated[0]));

  const after = (await sql`
    SELECT ph.id, ph.phone_number, ph.provider_id, ph.credential_id, ph.brand_id,
           p.sms_provider_id AS pkey, p.name AS pname
    FROM provider_phones ph JOIN sms_providers p ON p.id = ph.provider_id
    WHERE ph.id = ${PHONE_ID}
  `) as unknown as Record<string, unknown>[];
  console.log("AFTER:", JSON.stringify(after[0], null, 2));
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("\nFAILED:", e);
    await sql.end();
    process.exit(1);
  });
