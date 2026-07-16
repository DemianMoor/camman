// scripts/test-credential-phone-links.ts — Task 9 evidence: proves
// applyCredentialPhoneLinks (lib/providers/credential-phone-links.ts) syncs
// provider_phones.credential_id to the COMPLETE desired membership set —
// links added phones, unlinks removed phones, allows moving a phone from one
// credential to another, and confirms the FK's ON DELETE SET NULL auto-
// unlinks when a credential row is deleted (what the route's DELETE handler
// relies on).
//
// Runs entirely inside one rolled-back transaction against the shared DB
// (established pattern — see scripts/test-credential-write-path.ts). Never
// commits, never logs a secret.
import assert from "node:assert";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { applyCredentialPhoneLinks } from "@/lib/providers/credential-phone-links";

async function run() {
  await db
    .transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;

      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"tpl_" + Date.now()}, ${orgId}, 'Phone-Links Test', true)
        RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = prov[0].id;

      async function insertCredential(key: string, label: string): Promise<number> {
        const row = (await tx.execute(sql`
          INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
          VALUES (${orgId}, ${providerId}, ${encryptSecret(key)}, ${key.slice(-4)}, ${label})
          RETURNING id
        `)) as unknown as { id: number }[];
        return row[0].id;
      }
      const credA = await insertCredential("K-TEST-AAAA", "Account A");
      const credB = await insertCredential("K-TEST-BBBB", "Account B");

      const uniq = Date.now().toString().slice(-6);
      async function insertPhone(suffix: string): Promise<number> {
        const row = (await tx.execute(sql`
          INSERT INTO provider_phones (org_id, provider_id, phone_number)
          VALUES (${orgId}, ${providerId}, ${"+1555" + uniq + suffix})
          RETURNING id
        `)) as unknown as { id: number }[];
        return row[0].id;
      }
      const p1 = await insertPhone("1");
      const p2 = await insertPhone("2");
      const p3 = await insertPhone("3");

      async function credOf(phoneId: number): Promise<number | null> {
        const row = (await tx.execute(
          sql`SELECT credential_id FROM provider_phones WHERE id = ${phoneId}`,
        )) as unknown as { credential_id: number | null }[];
        return row[0].credential_id;
      }

      // (1) Link p1,p2 to A. p3 stays untouched.
      let r = await applyCredentialPhoneLinks(tx, { orgId, credentialId: credA, phoneIds: [p1, p2] });
      assert.strictEqual(r.linked, 2, "(1) linked count");
      assert.strictEqual(r.unlinked, 0, "(1) unlinked count");
      assert.strictEqual(await credOf(p1), credA, "(1) p1 -> A");
      assert.strictEqual(await credOf(p2), credA, "(1) p2 -> A");
      assert.strictEqual(await credOf(p3), null, "(1) p3 untouched (NULL)");

      // (2) Desired set becomes [p2,p3]: p1 drops off (unlinked), p2 stays
      // (unchanged, so it must NOT count toward `linked`), p3 joins.
      r = await applyCredentialPhoneLinks(tx, { orgId, credentialId: credA, phoneIds: [p2, p3] });
      assert.strictEqual(r.linked, 1, "(2) linked count (p3 only)");
      assert.strictEqual(r.unlinked, 1, "(2) unlinked count (p1 only)");
      assert.strictEqual(await credOf(p1), null, "(2) p1 unlinked");
      assert.strictEqual(await credOf(p2), credA, "(2) p2 unchanged on A");
      assert.strictEqual(await credOf(p3), credA, "(2) p3 -> A");

      // (3) Explicit move: p2 currently on A is re-linked to B — allowed.
      r = await applyCredentialPhoneLinks(tx, { orgId, credentialId: credB, phoneIds: [p2] });
      assert.strictEqual(r.linked, 1, "(3) p2 moved to B");
      assert.strictEqual(await credOf(p2), credB, "(3) p2 -> B");

      // (3b) Empty phoneIds unlinks everything currently on A (just p3 now).
      r = await applyCredentialPhoneLinks(tx, { orgId, credentialId: credA, phoneIds: [] });
      assert.strictEqual(r.linked, 0, "(3b) linked count is 0 for an empty set");
      assert.strictEqual(r.unlinked, 1, "(3b) p3 unlinked");
      assert.strictEqual(await credOf(p3), null, "(3b) p3 -> NULL");

      // (4) FK ON DELETE SET NULL: deleting credential B must auto-unlink p2
      // without any application-level cleanup — this is what the route's
      // DELETE handler relies on.
      await tx.execute(sql`DELETE FROM provider_credentials WHERE id = ${credB}`);
      assert.strictEqual(await credOf(p2), null, "(4) p2 unlinked after credential B deleted (FK ON DELETE SET NULL)");

      console.log("credential-phone-links: all assertions passed");
      throw new Error("ROLLBACK"); // never persist test rows
    })
    .catch((e) => {
      if (e.message !== "ROLLBACK") throw e;
    });
}
run();
