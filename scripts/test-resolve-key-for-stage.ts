// scripts/test-resolve-key-for-stage.ts — structural assertions (no live send).
import assert from "node:assert";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { resolveKeyForStage } from "@/lib/sends/provider-credential";

async function run() {
  await db.transaction(async (tx) => {
    const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as any as { id: string }[];
    const orgId = org[0].id;
    // Provider with ONE credential, key stored ENCRYPTED, phone linked to it.
    const prov = (await tx.execute(sql`INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
      VALUES (${"t_" + Math.floor(1)}, ${orgId}, 'T', true) RETURNING id`)) as any as { id: number }[];
    const pid = prov[0].id;
    const cred = (await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
      VALUES (${orgId}, ${pid}, ${encryptSecret("KEY-AAAA")}, 'AAAA', 'acct1') RETURNING id`)) as any as { id: number }[];
    const phone = (await tx.execute(sql`INSERT INTO provider_phones (org_id, provider_id, phone_number, credential_id)
      VALUES (${orgId}, ${pid}, '+15550000001', ${cred[0].id}) RETURNING id`)) as any as { id: number }[];

    // (a) number -> account -> key
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: phone[0].id }), "KEY-AAAA");
    // (b) no phone, single credential -> fallback resolves the same key
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: null }), "KEY-AAAA");

    // Add a SECOND credential -> fallback must NOT fire for a numberless stage.
    await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
      VALUES (${orgId}, ${pid}, ${encryptSecret("KEY-BBBB")}, 'BBBB', 'acct2')`);
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: null }), null,
      "ambiguous provider (2 creds) + no number must not fall back");
    // But the numbered stage still resolves deterministically.
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: phone[0].id }), "KEY-AAAA");

    // Legacy plaintext row still readable via dual-read.
    const prov2 = (await tx.execute(sql`INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
      VALUES (${"t2_" + Math.floor(1)}, ${orgId}, 'T2', true) RETURNING id`)) as any as { id: number }[];
    await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key) VALUES (${orgId}, ${prov2[0].id}, 'PLAIN-CCCC')`);
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: prov2[0].id, brandId: null, providerPhoneId: null }), "PLAIN-CCCC");

    console.log("resolve-key-for-stage: all assertions passed");
    throw new Error("ROLLBACK"); // never persist test rows
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });
}
run();
