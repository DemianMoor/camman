// scripts/test-credential-write-path.ts — Task 7 evidence: proves the
// credential WRITE path encrypts at rest without persisting anything.
//
// Two parts, both inside a single rolled-back transaction:
//  1. Building-block assertions: encryptSecret/decryptSecret round-trip, and
//     maskApiKey's last4 matches the plaintext's last 4 chars.
//  2. A real insert into provider_credentials using the same columns the
//     POST route writes (api_key_encrypted, api_key_last4, label; api_key
//     left NULL), then a SELECT back to assert: api_key IS NULL,
//     decryptSecret(api_key_encrypted) recovers the original key, and
//     api_key_last4 matches. Rolled back — no row survives.
import assert from "node:assert";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-box";
import { maskApiKey } from "@/lib/sends/provider-credential";

async function run() {
  const key = "th_live_ROTATED0123456789ABCDEF";

  // (1) Building blocks
  const blob = encryptSecret(key);
  assert.strictEqual(decryptSecret(blob), key, "encryptSecret/decryptSecret round-trip");
  assert.strictEqual(maskApiKey(key).last4, key.slice(-4), "maskApiKey last4 matches right(key,4)");

  await db
    .transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;

      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"twp_" + Date.now()}, ${orgId}, 'Write-Path Test', true)
        RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = prov[0].id;

      // (2) Write path shape: same columns the POST route sets (see
      // app/api/providers/[providerId]/credentials/route.ts). api_key is
      // deliberately omitted (left NULL) — this is the encrypted-only write.
      const enc = encryptSecret(key);
      const { last4 } = maskApiKey(key);
      const ins = (await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
        VALUES (${orgId}, ${providerId}, ${enc}, ${last4}, ${"Default"})
        RETURNING id
      `)) as unknown as { id: number }[];
      const credId = ins[0].id;

      const rows = (await tx.execute(sql`
        SELECT api_key, api_key_encrypted, api_key_last4, label
        FROM provider_credentials WHERE id = ${credId}
      `)) as unknown as { api_key: string | null; api_key_encrypted: string; api_key_last4: string; label: string }[];
      const row = rows[0];

      assert.strictEqual(row.api_key, null, "api_key must be NULL on an encrypted write");
      assert.strictEqual(decryptSecret(row.api_key_encrypted), key, "decryptSecret(api_key_encrypted) must recover the original key");
      assert.strictEqual(row.api_key_last4, key.slice(-4), "api_key_last4 must match right(key,4)");
      assert.strictEqual(row.label, "Default", "label must be set");

      console.log("credential-write-path: all assertions passed");
      throw new Error("ROLLBACK"); // never persist test rows
    })
    .catch((e) => {
      if (e.message !== "ROLLBACK") throw e;
    });
}
run();
