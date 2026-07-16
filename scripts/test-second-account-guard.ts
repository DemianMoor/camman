// scripts/test-second-account-guard.ts — Task 10 evidence: proves
// countNumberlessSendEligibleStages (lib/providers/second-account-guard.ts)
// blocks a 2nd-account add exactly when a send-eligible stage on the
// provider has no provider_phone_id, that assigning a number un-blocks it,
// that a non-send-eligible status (e.g. 'cancelled') never blocks, and that
// the count is org-scoped.
//
// Everything runs inside a single transaction that is ALWAYS rolled back —
// no fixture data persists.
//
// Run (inline env, Git Bash):
//   PROVIDER_CREDENTIALS_KEY="..." DATABASE_URL="..." npx tsx scripts/test-second-account-guard.ts
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { countNumberlessSendEligibleStages } from "@/lib/providers/second-account-guard";
import { maskApiKey } from "@/lib/sends/provider-credential";

async function run() {
  await db
    .transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const sfx = Date.now().toString().slice(-9); // collision-safe unique suffix

      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"tg_" + sfx}, ${orgId}, ${"Second-Account-Guard Test"}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = prov[0].id;

      // One existing credential on the provider — the realistic precondition
      // for the "2nd account" scenario the guard protects. The helper itself
      // only counts stages; it doesn't inspect provider_credentials.
      const key = "tg_live_TESTKEY0123456789";
      const enc = encryptSecret(key);
      const { last4 } = maskApiKey(key);
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
        VALUES (${orgId}, ${providerId}, ${enc}, ${last4}, ${"Main account"})
      `);

      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"guard-camp-" + sfx}, ${"Guard test"}, 'draft', 'manual')
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;

      // Minimal tracked stage: send-eligible status ('pending'), no phone.
      const stage = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, sms_provider_id, status, provider_phone_id)
        VALUES (${orgId}, ${campaignId}, ${providerId}, 'pending', NULL)
        RETURNING id
      `)) as unknown as { id: number }[];
      const stageId = stage[0].id;

      // (1) Numberless + send-eligible ('pending') -> blocks.
      const n1 = await countNumberlessSendEligibleStages(tx, { orgId, providerId });
      assert.strictEqual(n1, 1, `expected 1 numberless send-eligible stage, got ${n1}`);
      console.log("PASS: numberless pending stage blocks (count=1)");

      // (2) Org isolation: a different org sees 0, even though org1's stage
      // is still numberless + pending right now.
      const otherOrgId = randomUUID();
      const nOther = await countNumberlessSendEligibleStages(tx, { orgId: otherOrgId, providerId });
      assert.strictEqual(nOther, 0, `expected 0 for a different org, got ${nOther}`);
      console.log("PASS: org isolation — different org sees count=0 while org1's stage is numberless+pending");

      // (3) Assign a number to the stage -> no longer numberless -> allows.
      const phone = (await tx.execute(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number)
        VALUES (${orgId}, ${providerId}, ${"+1555" + sfx})
        RETURNING id
      `)) as unknown as { id: number }[];
      const phoneId = phone[0].id;
      await tx.execute(sql`
        UPDATE campaign_stages SET provider_phone_id = ${phoneId} WHERE id = ${stageId}
      `);
      const n2 = await countNumberlessSendEligibleStages(tx, { orgId, providerId });
      assert.strictEqual(n2, 0, `expected 0 once the stage has a number, got ${n2}`);
      console.log("PASS: stage with a number assigned allows (count=0)");

      // (4) Flip to a non-send-eligible status ('cancelled') and null the
      // phone again -> still allows (status, not the phone, excludes it).
      await tx.execute(sql`
        UPDATE campaign_stages SET status = 'cancelled', provider_phone_id = NULL WHERE id = ${stageId}
      `);
      const n3 = await countNumberlessSendEligibleStages(tx, { orgId, providerId });
      assert.strictEqual(n3, 0, `expected 0 for a cancelled numberless stage, got ${n3}`);
      console.log("PASS: non-send-eligible status (cancelled) does not block (count=0)");

      console.log("\nsecond-account-guard: all assertions passed");
      throw new Error("ROLLBACK"); // never persist fixtures
    })
    .catch((e) => {
      if (e.message !== "ROLLBACK") throw e;
    });
}
run();
